const path = require('path');
const crypto = require('crypto');

const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes } = require('./errors');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;
const MAX_RUNS = 5000;

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'runs',
      filePath: path.join(DATA_DIR, 'runs.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent: registeredOnEvent,
    });
  }
  return versionedStore;
}

function init(onEvent) {
  registeredOnEvent = onEvent;
  versionedStore = null;
  getStore();
}

function readAll() {
  const { records, state } = getStore().read();
  if (state === 'corrupt') {
    throw new AppError(Codes.STORE_DEGRADED, 'run history is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function writeAll(runs) {
  const trimmed = runs.length > MAX_RUNS ? runs.slice(runs.length - MAX_RUNS) : runs;
  getStore().write(trimmed);
}

function startRun({ agentId, provider, model, workstreamId, requestId }) {
  const runs = readAll();
  const run = {
    id: crypto.randomUUID(),
    agentId,
    provider,
    model: model || null,
    // Snapshotted at start time, permanently. If the agent is later moved
    // to a different workstream (or removed from one), this run's
    // attribution does not change — history stays accurate to what was
    // true when the work actually happened.
    workstreamId: workstreamId || null,
    requestId: requestId || null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    status: 'running', // running | completed | error | cancelled | interrupted | timed_out
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    error: null,
    outputTruncated: false,
    overBudgetCap: false,
  };
  runs.push(run);
  writeAll(runs);
  return run;
}

function finishRun(runId, { status, inputTokens, outputTokens, cachedTokens, costUsd, error, outputTruncated, overBudgetCap }) {
  const runs = readAll();
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx === -1) return null;
  const run = runs[idx];
  run.endedAt = Date.now();
  run.durationMs = run.endedAt - run.startedAt;
  run.status = status;
  run.inputTokens = inputTokens ?? null;
  run.outputTokens = outputTokens ?? null;
  run.cachedTokens = cachedTokens ?? null;
  run.costUsd = costUsd ?? null;
  run.error = error || null;
  if (outputTruncated) run.outputTruncated = true;
  if (overBudgetCap) run.overBudgetCap = true;
  runs[idx] = run;
  writeAll(runs);
  return run;
}

// Phase 3.5 — boot-time recovery for runs left `running` when the process
// died (crash, kill, host reboot). Nothing survives a restart to say "this
// was actually still in progress," so these are resolved to a distinct
// terminal state rather than left stuck as `running` forever, which would
// otherwise permanently inflate "active" counts and never resolve.
// Explicitly NOT labeled `error` — an interruption is not a known failure.
function recoverInterruptedRuns({ actor, instanceId } = {}) {
  const runs = readAll();
  let recoveredCount = 0;
  const recovered = [];
  for (const run of runs) {
    if (run.status === 'running') {
      run.status = 'interrupted';
      run.endedAt = Date.now();
      run.durationMs = run.endedAt - run.startedAt;
      run.error = 'server_restart_detected';
      run.recovery = {
        previousStatus: 'running',
        recoveredAt: new Date().toISOString(),
        instanceId: instanceId || null,
        actor: actor || { actorType: 'system_recovery', actorId: null },
      };
      recoveredCount += 1;
      recovered.push({ id: run.id, agentId: run.agentId });
    }
  }
  if (recoveredCount > 0) writeAll(runs);
  return { recoveredCount, recovered };
}

function listForAgent(agentId, limit = 50) {
  return readAll()
    .filter((r) => r.agentId === agentId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

function listAll() {
  return readAll();
}

function isToday(ts) {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Structured, truthful cost aggregation over a set of finished runs.
//
// `custom`-provider runs have no cost concept at all and are excluded from
// the pricing population entirely (they are not "unpriced", cost simply
// does not apply to them). Among billed-provider runs (anthropic/openai):
//   - "priced"   = pricing.estimateCostUsd found a rate for the model
//   - "unpriced" = the model isn't in the documented pricing table
//
// pricingStatus:
//   'empty'       — no billed-provider runs in the set (nothing to price)
//   'complete'    — every billed-provider run has a known price
//   'partial'     — some priced, some not — knownCost is a PARTIAL total,
//                    never presented as if it were the full total
//   'unavailable' — billed-provider runs exist but none could be priced
//
// This must never collapse back into a single silently-partial number —
// see test/runsStore.pricing.test.js. UNCHANGED by the safety-foundation
// work — this function's contract is load-bearing for existing tests.
function aggregateCost(finishedRuns) {
  const priceable = finishedRuns.filter((r) => r.provider !== 'custom');
  const priced = priceable.filter((r) => r.costUsd !== null && r.costUsd !== undefined);
  const unpriced = priceable.filter((r) => r.costUsd === null || r.costUsd === undefined);
  const knownCost = priced.reduce((sum, r) => sum + r.costUsd, 0);

  let pricingStatus;
  if (priceable.length === 0) pricingStatus = 'empty';
  else if (unpriced.length === 0) pricingStatus = 'complete';
  else if (priced.length === 0) pricingStatus = 'unavailable';
  else pricingStatus = 'partial';

  return {
    knownCost,
    pricedRunCount: priced.length,
    unpricedRunCount: unpriced.length,
    totalRunCount: priceable.length,
    pricingStatus,
  };
}

// Execution success is scored only over runs that actually ran to a system
// outcome (completed or error). A `cancelled` run was stopped by the
// operator on purpose — that's neither a success nor a failure of
// execution, and must not drag the rate down as if the system had failed.
// `interrupted`/`timed_out` runs are also excluded from this rate for the
// same reason: neither reflects the execution itself succeeding or failing
// on its own terms. UNCHANGED contract — see test/runsStore.executionSuccess.test.js.
function executionSuccessRate(finishedRuns) {
  const scored = finishedRuns.filter((r) => r.status === 'completed' || r.status === 'error');
  if (scored.length === 0) return null;
  const successCount = scored.filter((r) => r.status === 'completed').length;
  return (successCount / scored.length) * 100;
}

function summarize() {
  const runs = readAll();
  const todayRuns = runs.filter((r) => isToday(r.startedAt) && r.status !== 'running');
  const finished = runs.filter((r) => r.status !== 'running');
  const completedToday = todayRuns.filter((r) => r.status === 'completed').length;
  return {
    cost: aggregateCost(todayRuns),
    completedToday,
    runsToday: todayRuns.length,
    executionSuccessRate: executionSuccessRate(finished),
    totalRuns: finished.length,
  };
}

function summarizeForAgent(agentId) {
  const runs = readAll().filter((r) => r.agentId === agentId);
  const todayRuns = runs.filter((r) => isToday(r.startedAt) && r.status !== 'running');
  const finished = runs.filter((r) => r.status !== 'running');
  const successCount = finished.filter((r) => r.status === 'completed').length;
  return {
    cost: aggregateCost(todayRuns),
    runsCompleted: successCount,
    totalRuns: finished.length,
    executionSuccessRate: executionSuccessRate(finished),
  };
}

module.exports = {
  init,
  startRun,
  finishRun,
  recoverInterruptedRuns,
  listForAgent,
  listAll,
  summarize,
  summarizeForAgent,
  aggregateCost,
  executionSuccessRate,
};
