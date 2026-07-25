const fs = require('fs');
const path = require('path');

const store = require('./store');
const runAnthropic = require('./workers/anthropic');
const runOpenAI = require('./workers/openai');
const runCustom = require('./workers/custom');

const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');
const MAX_BUFFER_LINES = 2000;

// id -> { status, startedAt, abortController, child, buffer: [] }
const runtime = new Map();

let broadcast = () => {};

function init(broadcastFn) {
  broadcast = broadcastFn;
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getRuntime(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { status: 'idle', startedAt: null, abortController: null, child: null, buffer: [] });
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

function logFilePath(id) {
  return path.join(LOGS_DIR, `${id}.log`);
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

async function start(id) {
  const agent = store.get(id);
  if (!agent) throw new Error('agent not found');

  const rt = getRuntime(id);
  if (rt.status === 'running') throw new Error('agent is already running');

  rt.startedAt = Date.now();
  rt.abortController = new AbortController();
  setStatus(id, 'running');
  appendLog(id, `--- starting "${agent.name}" (${agent.provider}) ---\n`);

  const onLog = (chunk) => appendLog(id, chunk);

  const ABORT_ERROR_NAMES = new Set(['AbortError', 'APIUserAbortError']);
  const finish = (err) => {
    rt.abortController = null;
    rt.child = null;
    if (err && !ABORT_ERROR_NAMES.has(err.name)) {
      appendLog(id, `\n[error] ${err.message}\n`);
      setStatus(id, 'error');
    } else if (err && ABORT_ERROR_NAMES.has(err.name)) {
      appendLog(id, `\n--- stopped ---\n`);
      setStatus(id, 'idle');
    } else {
      appendLog(id, `\n--- finished ---\n`);
      setStatus(id, 'idle');
    }
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

  runPromise.then(() => finish(null)).catch((err) => finish(err));
}

function stop(id) {
  const rt = getRuntime(id);
  if (rt.status !== 'running') throw new Error('agent is not running');
  if (rt.child) rt.child.kill('SIGTERM');
  if (rt.abortController) rt.abortController.abort();
}

function discard(id) {
  const rt = runtime.get(id);
  if (rt && rt.status === 'running') throw new Error('stop the agent before deleting it');
  runtime.delete(id);
  const filePath = logFilePath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { init, start, stop, discard, getStatus, getAllStatuses, getLogs };
