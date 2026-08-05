// Phase 9 — SPECIFICATION LAYER: the invariants.
//
// Pure functions over an ObservationBundle. No require of src/. No knowledge
// of how a kernel is built, only of what must be true after it runs.
//
// Each invariant is INDEPENDENT by design: the mutant suite asserts that each
// deliberately-broken kernel trips the SPECIFIC invariant it was built to
// violate. That check is only meaningful if one defect cannot masquerade as
// another, so overlapping responsibilities between invariants are bugs in the
// specification. (Phase 8, R-016: a contract that passes for the wrong reason
// is not a passing contract, it is an absent one.)

const terminals = (b) => b.records.filter((r) => r.terminal === true);
const recorded = (b) => b.records.filter((r) => r.state === 'recorded');

// --- 1 -------------------------------------------------------------------
function auditChainIntact(b) {
  const v = b.chainVerification;
  return {
    id: 'audit_chain_intact',
    ok: v.ok,
    violations: v.ok ? [] : [`chain broken at record ${v.brokenAtIndex}, truncatedTrailing=${v.truncatedTrailingLine}`],
  };
}

// --- 2 -------------------------------------------------------------------
function noOrphanedReservations(b) {
  const out = b.outstandingReservations;
  return {
    id: 'no_orphaned_reservations',
    ok: out.length === 0,
    violations: out.map((r) => `reservation ${r.reservationId} for tx ${r.txId} still holds $${r.amountUsd}`),
  };
}

// --- 3 -------------------------------------------------------------------
function noDoubleAudits(b) {
  const seen = new Map();
  for (const r of terminals(b)) seen.set(r.txId, (seen.get(r.txId) || 0) + 1);
  const violations = [...seen.entries()].filter(([, n]) => n > 1).map(([txId, n]) => `tx ${txId} has ${n} terminal records`);
  return { id: 'no_double_audits', ok: violations.length === 0, violations };
}

// --- 4 -------------------------------------------------------------------
function noDuplicateExecution(b) {
  const counts = new Map();
  for (const c of b.effectorCalls) counts.set(c.txId, (counts.get(c.txId) || 0) + 1);
  const violations = [...counts.entries()].filter(([, n]) => n > 1).map(([txId, n]) => `tx ${txId} invoked its effector ${n} times`);
  return { id: 'no_duplicate_execution', ok: violations.length === 0, violations };
}

// --- 5 -------------------------------------------------------------------
// Rests on the log contents as they were ON DISK at the instant of the call,
// not on the order the kernel believes its stages ran in.
function recordBeforeEffect(b) {
  const violations = [];
  for (const c of b.effectorCalls) {
    const prior = c.logSnapshotAtCall.find((r) => r.txId === c.txId && r.state === 'recorded');
    if (!prior) violations.push(`tx ${c.txId} invoked its effector with no prior 'recorded' entry on disk`);
  }
  return { id: 'record_before_effect', ok: violations.length === 0, violations };
}

// --- 6 -------------------------------------------------------------------
// Compares the effect against the authorization INPUT, never against the
// decision the kernel recorded. An earlier draft read record.decision, which a
// kernel that forces its own decision back to "allow" would satisfy — the
// subject grading its own work. Only building the mutants exposed that.
function noPermissionLeakage(b) {
  const granted = new Set(b.grantedCapabilities);
  const violations = [];
  for (const c of b.effectorCalls) {
    if (!granted.has(c.capability)) violations.push(`tx ${c.txId} executed "${c.capability}", which was never granted`);
  }
  return { id: 'no_permission_leakage', ok: violations.length === 0, violations };
}

// --- 7 -------------------------------------------------------------------
// A transaction must reach a terminal state: sealed, or — when the log itself
// could not be written — DECLARED unsealable through the out-of-band event
// channel. Silence is the only unacceptable outcome. Fault injection at the
// audit stage is what surfaced this: the kernel could previously be recorded,
// execute, and then leave a permanent hole in the trail with no signal.
//
// This is not an escape hatch. Declaring a seal failure requires the audit
// stage to actually throw; a kernel that simply skips sealing emits nothing
// and is still caught (mutant: skip_seal_on_failure).
function deterministicRollback(b) {
  const sealed = new Set(terminals(b).map((r) => r.txId));
  const declared = new Set(b.sealFailures);
  const settledOk = (txId) => sealed.has(txId) || declared.has(txId);
  const violations = [];
  for (const r of recorded(b)) if (!settledOk(r.txId)) violations.push(`tx ${r.txId} was recorded but neither sealed nor declared unsealable`);
  for (const c of b.effectorCalls) if (!settledOk(c.txId)) violations.push(`tx ${c.txId} executed but neither sealed nor declared unsealable`);
  return { id: 'deterministic_rollback', ok: violations.length === 0, violations };
}

// --- 8 -------------------------------------------------------------------
function workspaceBinding(b) {
  const byTx = new Map();
  for (const r of b.records) byTx.set(r.txId, r);
  const violations = [];
  for (const c of b.effectorCalls) {
    const rec = byTx.get(c.txId);
    if (rec && c.workspaceId !== rec.workspaceId) {
      violations.push(`tx ${c.txId} recorded workspace ${rec.workspaceId} but executed against ${c.workspaceId}`);
    }
  }
  return { id: 'workspace_binding', ok: violations.length === 0, violations };
}

// --- 9 -------------------------------------------------------------------
function admissionReleased(b) {
  const violations = [];
  for (const [ws, n] of Object.entries(b.activeAdmissions)) {
    if (n !== 0) violations.push(`workspace ${ws} still shows ${n} active admissions after quiesce`);
  }
  return { id: 'admission_released', ok: violations.length === 0, violations };
}

// --- 10 ------------------------------------------------------------------
// Negative capability. Registered so it is reachable, never granted, and
// required never to execute under any fault, race, replay or adversarial
// kernel. If it ever runs, the kernel has failed — no further analysis needed.
function forbiddenNeverExecutes(b) {
  const forbidden = new Set(b.forbiddenCapabilities);
  const violations = b.effectorCalls
    .filter((c) => forbidden.has(c.capability))
    .map((c) => `FORBIDDEN capability "${c.capability}" executed in tx ${c.txId}`);
  return { id: 'forbidden_never_executes', ok: violations.length === 0, violations };
}

// A `no_forged_transaction_ids` invariant was drafted here and REMOVED. It
// asserted that every executed txId appears in the log — but every kernel that
// forges an id also fails record_before_effect, and no mutant could be built
// that tripped one without the other. It was the same property wearing a
// second hat, and a specification with two names for one check makes the
// mutant-independence proof weaker, not stronger. Forgery is covered:
// record_before_effect requires a 'recorded' entry for the executing txId to
// exist ON DISK at the moment of the call, which a forged id cannot satisfy.

// --- 11 ------------------------------------------------------------------
// Adversarial: replay / stale authorization. An approval recorded for one
// capability must not be spent on a different one.
function authorizationMatchesEffect(b) {
  const recordedByTx = new Map(recorded(b).map((r) => [r.txId, r]));
  const violations = [];
  for (const c of b.effectorCalls) {
    const rec = recordedByTx.get(c.txId);
    if (rec && rec.capability !== c.capability) {
      violations.push(`tx ${c.txId} was authorized for "${rec.capability}" but executed "${c.capability}"`);
    }
  }
  return { id: 'authorization_matches_effect', ok: violations.length === 0, violations };
}

const ALL = [
  auditChainIntact,
  noOrphanedReservations,
  noDoubleAudits,
  noDuplicateExecution,
  recordBeforeEffect,
  noPermissionLeakage,
  deterministicRollback,
  workspaceBinding,
  admissionReleased,
  forbiddenNeverExecutes,
  authorizationMatchesEffect,
];

const ALL_IDS = [
  'audit_chain_intact', 'no_orphaned_reservations', 'no_double_audits',
  'no_duplicate_execution', 'record_before_effect', 'no_permission_leakage',
  'deterministic_rollback', 'workspace_binding', 'admission_released',
  'forbidden_never_executes', 'authorization_matches_effect',
];

function checkAll(bundle) {
  const results = ALL.map((fn) => fn(bundle));
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    failed,
    failedIds: failed.map((f) => f.id),
    summary: failed.length === 0 ? 'all invariants hold' : failed.map((f) => `${f.id}: ${f.violations.join('; ')}`).join(' | '),
  };
}

module.exports = { checkAll, ALL, ALL_IDS };
