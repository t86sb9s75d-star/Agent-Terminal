const fs = require('fs');
const path = require('path');

const store = require('./store');
const runsStore = require('./runsStore');
const eventLog = require('./eventLog');
const workstreamsStore = require('./workstreamsStore');
const { estimateCostUsd } = require('./pricing');
const runAnthropic = require('./workers/anthropic');
const runOpenAI = require('./workers/openai');
const runCustom = require('./workers/custom');
const { terminateProcessGroup } = runCustom;
const { SYSTEM_ACTOR, POLICY_ACTOR } = require('./actor');
const { AppError, Codes } = require('./errors');
const budget = require('./budget');

const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');
const MAX_BUFFER_LINES = 2000;

// id -> { status, startedAt, abortController, child, buffer: [], runId }
const runtime = new Map();

let broadcast = () => {};

function init(broadcastFn) {
  broadcast = broadcastFn;
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getRuntime(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      status: 'idle',
      startedAt: null,
      abortController: null,
      child: null,
      buffer: [],
      runId: null,
      timedOut: false,
      outputTruncated: false,
    });
  }
  return runtime.get(id);
}

function getStatus(id) {
  return getRuntime(id).status;
}

function getAllStatuses() {
  const out = {};
  for (const agent of store.list()) {
    out[agent.id] = { status: getStatus(agent.id), startedAt: getRuntime(agent.id).startedAt };
  }
  return out;
}

// Additional failure mode — path traversal. `id` reaches here from
// req.params.id, an ordinary Express route param with no format
// enforcement; a caller passing e.g. "../../../../tmp/evil" as an agent id
// would otherwise make this resolve OUTSIDE LOGS_DIR entirely (verified:
// path.join(LOGS_DIR, '../../../../tmp/evil.log') escapes LOGS_DIR).
// discard() unlinks whatever this returns, on a caller-supplied id, before
// even checking the agent exists — path.basename strips any directory
// component so the result can never leave LOGS_DIR, regardless of what's
// in `id` or which call site forgot to validate it first.
function logFilePath(id) {
  return path.join(LOGS_DIR, `${path.basename(String(id))}.log`);
}

function appendLog(id, chunk) {
  const rt = getRuntime(id);
  rt.buffer.push(chunk);
  if (rt.buffer.length > MAX_BUFFER_LINES) rt.buffer.shift();
  fs.appendFile(logFilePath(id), chunk, () => {});
  broadcast({ type: 'log', agentId: id, chunk, ts: Date.now() });
}

function setStatus(id, status) {
  getRuntime(id).status = status;
  broadcast({ type: 'status', agentId: id, status, ts: Date.now() });
}

function getLogs(id, tailChars = 20000) {
  const filePath = logFilePath(id);
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - tailChars);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

// Phase 4.3 — hard runtime ceiling. Without this, a hung provider call or a
// runaway custom command runs forever with nothing watching; the run stays
// "running" indefinitely and never resolves to a state anyone can act on.
// Configurable per-agent (agent.maxRuntimeMs), falling back to a system
// default, so most agents need no configuration to get this protection.
const DEFAULT_MAX_RUNTIME_MS = Number(process.env.RUCKER_DEFAULT_RUNTIME_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min

async function start(id, actor = SYSTEM_ACTOR) {
  const agent = store.get(id);
  if (!agent) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);

  const rt = getRuntime(id);
  if (rt.status === 'running') throw new AppError(Codes.RUN_ALREADY_ACTIVE, 'agent is already running', 409);

  // Re-check at run-start, not just at assignment time: a workstream can be
  // archived AFTER an agent was assigned to it, and a stale assignment
  // should not silently let new work land in a closed objective.
  workstreamsStore.assertNotArchived(agent.workstreamId);

  // Phase 4.6 — spending controls, checked before any paid-provider call.
  budget.assertWithinBudget({ agentId: id, provider: agent.provider });

  rt.startedAt = Date.now();
  rt.abortController = new AbortController();
  rt.timedOut = false;
  rt.outputTruncated = false;
  const run = runsStore.startRun({
    agentId: id,
    provider: agent.provider,
    model: agent.model,
    workstreamId: agent.workstreamId,
    requestId: actor.requestId || null,
  });
  rt.runId = run.id;

  setStatus(id, 'running');
  appendLog(id, `--- starting "${agent.name}" (${agent.provider}) ---\n`);
  eventLog.record({
    actor,
    action: 'run.started',
    entityType: 'agent',
    entityId: id,
    details: {
      agentName: agent.name,
      provider: agent.provider,
      model: agent.model,
      runId: run.id,
      workstreamId: agent.workstreamId,
    },
  });

  const onLog = (chunk) => appendLog(id, chunk);

  const maxRuntimeMs = Number(agent.maxRuntimeMs) > 0 ? Number(agent.maxRuntimeMs) : DEFAULT_MAX_RUNTIME_MS;
  const runtimeTimer = setTimeout(() => {
    rt.timedOut = true;
    appendLog(id, `\n[policy] runtime limit of ${maxRuntimeMs}ms exceeded — terminating\n`);
    if (rt.child) terminateProcessGroup(rt.child);
    if (rt.abortController) rt.abortController.abort();
  }, maxRuntimeMs);

  const ABORT_ERROR_NAMES = new Set(['AbortError', 'APIUserAbortError']);
  const finish = (err, usage) => {
    clearTimeout(runtimeTimer);
    rt.abortController = null;
    rt.child = null;

    let status; // completed | error | cancelled | timed_out
    if (rt.timedOut) {
      status = 'timed_out';
      appendLog(id, `\n--- stopped: runtime limit exceeded ---\n`);
      setStatus(id, 'error');
    } else if (err && ABORT_ERROR_NAMES.has(err.name)) {
      status = 'cancelled';
      appendLog(id, `\n--- stopped ---\n`);
      setStatus(id, 'idle');
    } else if (err) {
      status = 'error';
      appendLog(id, `\n[error] ${err.message}\n`);
      setStatus(id, 'error');
    } else {
      status = 'completed';
      appendLog(id, `\n--- finished ---\n`);
      setStatus(id, 'idle');
    }

    const inputTokens = usage?.inputTokens ?? null;
    const outputTokens = usage?.outputTokens ?? null;
    const cachedTokens = usage?.cachedTokens ?? null;
    const costUsd = estimateCostUsd(agent.provider, agent.model, inputTokens, outputTokens);
    const runError = status === 'error' ? err.message : status === 'timed_out' ? `runtime limit exceeded (${maxRuntimeMs}ms)` : null;

    runsStore.finishRun(rt.runId, {
      status,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      error: runError,
      outputTruncated: rt.outputTruncated,
    });

    const actionByStatus = {
      completed: 'run.completed',
      cancelled: 'run.cancelled',
      timed_out: 'run.timed_out',
      error: 'run.failed',
    };

    // Phase 4.6 — the per-run cap can't be checked before the call (cost is
    // only known once usage is reported back), so it's surfaced here as a
    // flagged policy signal for the operator rather than a pre-flight block.
    const overCap = budget.exceededPerRunCap(costUsd);

    eventLog.record({
      // A timeout is enforced by the system, not requested by whoever
      // started the run — attribute it to the policy engine, not them.
      actor: status === 'timed_out' ? POLICY_ACTOR : actor,
      action: actionByStatus[status],
      entityType: 'agent',
      entityId: id,
      details: {
        agentName: agent.name,
        runId: rt.runId,
        workstreamId: agent.workstreamId,
        inputTokens,
        outputTokens,
        costUsd,
        error: runError,
        outputTruncated: rt.outputTruncated,
        overBudgetCap: overCap,
      },
      flagged: status === 'error' || status === 'timed_out' || overCap,
      flagReason: status === 'error' ? 'run failed' : status === 'timed_out' ? 'runtime limit exceeded' : overCap ? 'run exceeded the configured per-run spending cap' : null,
    });

    rt.runId = null;
    rt.timedOut = false;
  };

  let runPromise;
  try {
    if (agent.provider === 'custom') {
      runPromise = runCustom({ agent, onLog, runtime: rt });
    } else if (agent.provider === 'anthropic') {
      runPromise = runAnthropic({ agent, onLog, signal: rt.abortController.signal });
    } else if (agent.provider === 'openai') {
      runPromise = runOpenAI({ agent, onLog, signal: rt.abortController.signal });
    } else {
      throw new Error(`unknown provider "${agent.provider}"`);
    }
  } catch (err) {
    finish(err);
    return;
  }

  runPromise.then((usage) => finish(null, usage)).catch((err) => finish(err));
}

async function stop(id, actor = SYSTEM_ACTOR) {
  const rt = getRuntime(id);
  if (rt.status !== 'running') throw new AppError(Codes.RUN_NOT_ACTIVE, 'agent is not running', 409);
  const agent = store.get(id);
  eventLog.record({
    actor,
    action: 'run.stop_requested',
    entityType: 'agent',
    entityId: id,
    details: { agentName: agent?.name, runId: rt.runId, workstreamId: agent?.workstreamId },
  });
  // Full process-tree termination (Phase 4.2) for custom shell commands —
  // reaches grandchildren the old `.kill('SIGTERM')` on the shell wrapper
  // alone could leave running. Provider calls have no child process; the
  // AbortController is what actually cancels those.
  if (rt.child) await terminateProcessGroup(rt.child);
  if (rt.abortController) rt.abortController.abort();
}

function discard(id) {
  const rt = runtime.get(id);
  if (rt && rt.status === 'running') throw new AppError(Codes.RUN_ALREADY_ACTIVE, 'stop the agent before deleting it', 409);
  runtime.delete(id);
  const filePath = logFilePath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function getSummary() {
  const agents = store.list();
  const statuses = getAllStatuses();
  const active = agents.filter((a) => statuses[a.id]?.status === 'running').length;
  const needsAttention = agents.filter((a) => statuses[a.id]?.status === 'error').length;
  const totals = runsStore.summarize();
  return {
    totalAgents: agents.length,
    active,
    needsAttention,
    ...totals,
  };
}

function getActivity({ limit = 100, agentId = null } = {}) {
  return eventLog.list({ limit, agentId });
}

function getAgentRuns(id, limit = 50) {
  return {
    runs: runsStore.listForAgent(id, limit),
    summary: runsStore.summarizeForAgent(id),
  };
}

module.exports = {
  init,
  start,
  stop,
  discard,
  getStatus,
  getAllStatuses,
  getLogs,
  getSummary,
  getActivity,
  getAgentRuns,
};
