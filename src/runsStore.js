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
// see test/runsStore.pricing.test.js.
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
  const successCount = finished.filter((r) => r.status === 'completed').length;
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

module.exports = { startRun, finishRun, listForAgent, summarize, summarizeForAgent, aggregateCost, executionSuccessRate };
