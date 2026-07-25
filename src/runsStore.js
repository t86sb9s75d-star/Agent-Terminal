const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const MAX_RUNS = 5000;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, '[]', 'utf8');
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(runs) {
  ensureFile();
  const trimmed = runs.length > MAX_RUNS ? runs.slice(runs.length - MAX_RUNS) : runs;
  fs.writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

function startRun({ agentId, provider, model }) {
  const runs = readAll();
  const run = {
    id: crypto.randomUUID(),
    agentId,
    provider,
    model: model || null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    status: 'running', // running | completed | error | cancelled
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    error: null,
  };
  runs.push(run);
  writeAll(runs);
  return run;
}

function finishRun(runId, { status, inputTokens, outputTokens, cachedTokens, costUsd, error }) {
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
  runs[idx] = run;
  writeAll(runs);
  return run;
}

function listForAgent(agentId, limit = 50) {
  return readAll()
    .filter((r) => r.agentId === agentId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
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

function summarize() {
  const runs = readAll();
  const todayRuns = runs.filter((r) => isToday(r.startedAt) && r.status !== 'running');
  const finished = runs.filter((r) => r.status !== 'running');
  const costToday = todayRuns.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const completedToday = todayRuns.filter((r) => r.status === 'completed').length;
  const successCount = finished.filter((r) => r.status === 'completed').length;
  const executionSuccessRate = finished.length ? (successCount / finished.length) * 100 : null;
  return {
    costToday,
    completedToday,
    runsToday: todayRuns.length,
    executionSuccessRate,
    totalRuns: finished.length,
  };
}

function summarizeForAgent(agentId) {
  const runs = readAll().filter((r) => r.agentId === agentId);
  const todayRuns = runs.filter((r) => isToday(r.startedAt) && r.status !== 'running');
  const finished = runs.filter((r) => r.status !== 'running');
  const costToday = todayRuns.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const successCount = finished.filter((r) => r.status === 'completed').length;
  const executionSuccessRate = finished.length ? (successCount / finished.length) * 100 : null;
  return {
    costToday,
    runsCompleted: successCount,
    totalRuns: finished.length,
    executionSuccessRate,
  };
}

module.exports = { startRun, finishRun, listForAgent, summarize, summarizeForAgent };
