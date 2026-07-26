// Phase 7 (scoped) — "Sentinel" defensive foundation.
//
// What this IS: a deterministic rule engine that turns existing, already-
// logged system events (repeated run failures, integrity tamper/corruption,
// budget-cap breaches) into a distinct, triaged security-event record with
// an evidence snapshot and an explicit, operator-driven containment
// workflow. Every rule here is a plain conditional over data this system
// already collects — nothing probabilistic, nothing that "decides" on its
// own.
//
// What this explicitly is NOT (per the safety-foundation directive):
//   - NOT an autonomous offensive-security agent. There is no scanning,
//     probing, or "hack back" capability here or planned.
//   - NOT an LLM/AI classifier. Detection is 100% deterministic rules; an
//     AI-assisted triage/summary layer may be added later, but only as an
//     ADVISORY interface an operator reads — never as the thing deciding
//     severity or taking action. analyzeWithAi() below is a stub that
//     documents this boundary and does nothing yet.
//   - NOT autonomous containment. containEvent() only ever runs when an
//     operator calls the API — Sentinel proposes (via `suggestedAction`),
//     it never acts on its own initiative.
//
// Findings are stored via the same versioned-store foundation as every
// other store (tamper-detected, backed up, schema-versioned) and mirrored
// into eventLog as a flagged event, so a security finding always shows up
// in the existing Activity feed even before any dedicated Security UI
// exists to browse them directly.

const path = require('path');
const crypto = require('crypto');
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes } = require('./errors');
const systemState = require('./systemState');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

const SEVERITIES = ['info', 'warning', 'critical'];
// A finding's lifecycle. Every transition is operator-initiated (via the
// API) except the initial 'open', which a rule creates.
const STATUSES = ['open', 'acknowledged', 'contained', 'resolved'];

let versionedStore = null;
let registeredOnEvent = null;
let registeredEventLogRecord = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'security_events',
      filePath: path.join(DATA_DIR, 'security_events.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent: registeredOnEvent,
    });
  }
  return versionedStore;
}

// eventLogRecord: eventLog.record, so findings also land in the existing
// Activity/audit feed. onEvent: same corruption/tamper emitter every other
// store uses, so THIS store's own integrity is monitored the same way.
function init({ onEvent, eventLogRecord }) {
  registeredOnEvent = onEvent;
  registeredEventLogRecord = eventLogRecord;
  versionedStore = null;
  getStore();
}

function readAll() {
  const { records, state } = getStore().read();
  if (state === 'corrupt') {
    throw new AppError(Codes.STORE_DEGRADED, 'security event log is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function writeAll(events) {
  getStore().write(events);
}

function list({ status = null } = {}) {
  const events = readAll().slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return status ? events.filter((e) => e.status === status) : events;
}

function get(id) {
  return readAll().find((e) => e.id === id) || null;
}

// Creates a finding. `evidence` is a plain snapshot object — whatever data
// justified the finding, captured at detection time so it can't drift out
// from under an operator reviewing it later (e.g. the exact run IDs and
// timestamps that crossed a threshold, not a live query that could change).
function createFinding({ ruleId, severity, category, summary, entityType, entityId, evidence, suggestedAction }) {
  if (!SEVERITIES.includes(severity)) throw new AppError(Codes.VALIDATION_ERROR, `severity must be one of: ${SEVERITIES.join(', ')}`);
  const events = readAll();
  const finding = {
    id: crypto.randomUUID(),
    ruleId,
    severity,
    category,
    summary,
    entityType,
    entityId,
    evidence: evidence || {},
    suggestedAction: suggestedAction || null,
    status: 'open',
    statusHistory: [{ status: 'open', actor: { actorType: 'security_monitor', actorId: ruleId }, at: new Date().toISOString(), note: null }],
    createdAt: new Date().toISOString(),
  };
  events.push(finding);
  writeAll(events);

  if (registeredEventLogRecord) {
    registeredEventLogRecord({
      actor: { actorType: 'security_monitor', actorId: ruleId, triggerType: 'rule_match', requestId: null },
      action: 'sentinel.finding_created',
      entityType,
      entityId,
      details: { findingId: finding.id, ruleId, severity, category, summary },
      flagged: true,
      flagReason: `Sentinel rule "${ruleId}" matched: ${summary}`,
    });
  }
  return finding;
}

// Operator-driven status transition — this is the ONLY way a finding's
// status changes. `action` beyond the status itself (e.g. actually
// stopping an agent) is the caller's responsibility (server.js), not
// something this module does on the caller's behalf, so the consequential
// action and the record of who authorized it stay in the same request.
function transition(id, { status, actor, note }) {
  if (!STATUSES.includes(status)) throw new AppError(Codes.VALIDATION_ERROR, `status must be one of: ${STATUSES.join(', ')}`);
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new AppError(Codes.NOT_FOUND, 'security finding not found', 404);
  const finding = events[idx];
  finding.status = status;
  finding.statusHistory.push({ status, actor: actor || { actorType: 'system' }, at: new Date().toISOString(), note: note || null });
  events[idx] = finding;
  writeAll(events);
  return finding;
}

// ---------------- Deterministic rules ----------------
// Each rule is a pure function over data already collected elsewhere. Rules
// are invoked inline at the moment their triggering condition could newly
// be true (after a run finishes, after a tamper/corruption event) rather
// than on a polling loop — deterministic and immediately testable, no
// background timer whose timing itself would need to be verified.

const REPEATED_FAILURE_THRESHOLD = 3;
const REPEATED_FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const BUDGET_PRESSURE_THRESHOLD = 3;
const BUDGET_PRESSURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// Call after any run finishes (completed/error/cancelled/timed_out).
// Detects a burst of failures for one agent — the kind of pattern that,
// left running unattended, silently repeats a broken action instead of
// surfacing it as something worth a human's attention.
function evaluateAfterRun({ agentId, agentName, status, runsForAgent }) {
  if (status !== 'error' && status !== 'timed_out') return null;
  const now = Date.now();
  const recentFailures = runsForAgent.filter(
    (r) => (r.status === 'error' || r.status === 'timed_out') && now - r.startedAt <= REPEATED_FAILURE_WINDOW_MS
  );
  if (recentFailures.length < REPEATED_FAILURE_THRESHOLD) return null;

  return createFinding({
    ruleId: 'repeated_run_failure',
    severity: 'warning',
    category: 'reliability',
    summary: `${agentName || agentId} failed ${recentFailures.length} times in the last ${Math.round(REPEATED_FAILURE_WINDOW_MS / 60000)} minutes`,
    entityType: 'agent',
    entityId: agentId,
    evidence: { runIds: recentFailures.map((r) => r.id), windowMs: REPEATED_FAILURE_WINDOW_MS, threshold: REPEATED_FAILURE_THRESHOLD },
    suggestedAction: 'Review recent run errors for this agent; consider stopping it until the underlying cause is fixed.',
  });
}

// Call after agentManager records an over-per-run-cap run. Detects a
// pattern (not just a single expensive run, which is only a per-run flag)
// of repeatedly exceeding the configured spending cap.
function evaluateBudgetPressure({ agentId, agentName, overCapRunsForAgent }) {
  const now = Date.now();
  const recent = overCapRunsForAgent.filter((r) => now - r.startedAt <= BUDGET_PRESSURE_WINDOW_MS);
  if (recent.length < BUDGET_PRESSURE_THRESHOLD) return null;

  return createFinding({
    ruleId: 'budget_pressure',
    severity: 'warning',
    category: 'cost',
    summary: `${agentName || agentId} exceeded the per-run spending cap ${recent.length} times in the last 24h`,
    entityType: 'agent',
    entityId: agentId,
    evidence: { runIds: recent.map((r) => r.id), windowMs: BUDGET_PRESSURE_WINDOW_MS, threshold: BUDGET_PRESSURE_THRESHOLD },
    suggestedAction: 'Review this agent\'s task scope or lower its configured spending cap.',
  });
}

// Call right after any store reports tamper/corruption (versionedStore's
// onEvent already fires an eventLog entry; this promotes it to a tracked,
// containment-workflow-eligible finding rather than a log line that scrolls
// away).
function evaluateIntegrityEvent({ storeName, reason, detail }) {
  return createFinding({
    ruleId: 'store_integrity_failure',
    severity: 'critical',
    category: 'integrity',
    summary: `${storeName} store integrity check failed: ${reason}`,
    entityType: 'system',
    entityId: storeName,
    evidence: { reason, detail },
    suggestedAction: 'Review the store via the recovery endpoint — accept the current file only after confirming the change was legitimate, or restore the last known-good backup.',
  });
}

// Explicit interface boundary (see module comment). This is intentionally
// unimplemented — wiring an actual model call here is future work, and per
// the safety-foundation directive must remain advisory-only: it may
// SUMMARIZE or suggest triage priority for a human to read, but must never
// set severity, status, or trigger containment itself.
async function analyzeWithAi(/* finding */) {
  throw new AppError(Codes.NOT_FOUND, 'AI-assisted analysis is not implemented — Sentinel findings are reviewed by the operator', 501);
}

// Phase 5.2's "explicit operator recovery action" — see versionedStore.recover.
function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = {
  init,
  list,
  get,
  createFinding,
  transition,
  recover,
  evaluateAfterRun,
  evaluateBudgetPressure,
  evaluateIntegrityEvent,
  analyzeWithAi,
  SEVERITIES,
  STATUSES,
  REPEATED_FAILURE_THRESHOLD,
  REPEATED_FAILURE_WINDOW_MS,
  BUDGET_PRESSURE_THRESHOLD,
  BUDGET_PRESSURE_WINDOW_MS,
};
