// Feature Onboard persistence stores — unit tests against a scratch data dir.
// The centerpiece is cross-workspace isolation: a record in one workspace must
// never be reachable through another. Run with: node test/workspaceStores.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every store at a throwaway data directory BEFORE requiring them
// (each store captures RUCKER_DATA_DIR at module load).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-ws-stores-'));
process.env.RUCKER_DATA_DIR = SCRATCH;

const workspaces = require('../src/workspacesStore');
const records = require('../src/workspaceRecordsStore');
const founderProfile = require('../src/founderProfileStore');
const onboarding = require('../src/onboardingStore');
const yc = require('../src/ycStore');
const agentSettings = require('../src/workspaceAgentSettingsStore');

// Clean up the scratch directory however this process exits — including when
// an assertion throws. Cleaning up only at the end of the file leaked a temp
// directory on every failing run (found during the Phase 6 baseline sweep).
function cleanupScratch() {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanupScratch);
process.on('uncaughtException', (err) => { cleanupScratch(); console.error(err); process.exit(1); });

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// ---- workspacesStore ----

let wsA, wsB;
check('create workspace validates name and stage; defaults are sane', () => {
  wsA = workspaces.create({ name: 'Apparel Co', stage: 'idea_validation' });
  assert.ok(wsA.id);
  assert.strictEqual(wsA.stage, 'idea_validation');
  assert.strictEqual(wsA.archived, false);
  assert.throws(() => workspaces.create({ name: '' }), /name/);
  assert.throws(() => workspaces.create({ name: 'X', stage: 'bogus' }), /stage/);
});

check('second workspace is independent', () => {
  wsB = workspaces.create({ name: 'Contractor Software' });
  assert.notStrictEqual(wsA.id, wsB.id);
  assert.strictEqual(wsB.stage, 'problem_discovery'); // default
  assert.strictEqual(workspaces.list().length, 2);
});

check('update rejects unknown workspace and bad targetDate', () => {
  assert.throws(() => workspaces.update('no-such-id', { name: 'x' }), /not found/);
  assert.throws(() => workspaces.update(wsA.id, { targetDate: 'not-a-date' }), /targetDate/);
});

// ---- workspaceRecordsStore: the isolation guarantee ----

check('a record cannot be created under a non-existent workspace', () => {
  assert.throws(() => records.goals.create('no-such-workspace', { title: 'x' }), /workspace not found/);
});

let goalA;
check('records are scoped: listForWorkspace returns only that workspace', () => {
  goalA = records.goals.create(wsA.id, { title: 'Ten interviews' });
  records.goals.create(wsB.id, { title: 'Ship MVP' });
  const aGoals = records.goals.listForWorkspace(wsA.id);
  const bGoals = records.goals.listForWorkspace(wsB.id);
  assert.strictEqual(aGoals.length, 1);
  assert.strictEqual(bGoals.length, 1);
  assert.strictEqual(aGoals[0].title, 'Ten interviews');
  assert.strictEqual(bGoals[0].title, 'Ship MVP');
});

check('CROSS-WORKSPACE READ IS IMPOSSIBLE: get with the wrong workspace returns null', () => {
  // goalA belongs to A. Asking for it under B must not find it.
  assert.ok(records.goals.getForWorkspace(wsA.id, goalA.id));
  assert.strictEqual(records.goals.getForWorkspace(wsB.id, goalA.id), null);
});

check('CROSS-WORKSPACE WRITE IS IMPOSSIBLE: update/remove with the wrong workspace throws', () => {
  assert.throws(() => records.goals.updateForWorkspace(wsB.id, goalA.id, { title: 'hijack' }), /not found in this workspace/);
  assert.throws(() => records.goals.removeForWorkspace(wsB.id, goalA.id), /not found in this workspace/);
  // and A's goal is untouched
  assert.strictEqual(records.goals.getForWorkspace(wsA.id, goalA.id).title, 'Ten interviews');
});

check('records require an explicit workspaceId on every read path', () => {
  assert.throws(() => records.goals.listForWorkspace(''), /workspaceId/);
  assert.throws(() => records.goals.create(undefined, { title: 'x' }), /workspaceId/);
});

check('workstreamId is optional and stored as null when absent', () => {
  const g = records.goals.create(wsA.id, { title: 'no workstream' });
  assert.strictEqual(g.workstreamId, null);
  const g2 = records.goals.create(wsA.id, { title: 'with workstream', workstreamId: 'ws-123' });
  assert.strictEqual(g2.workstreamId, 'ws-123');
});

// ---- per-type validation ----

check('required fields are enforced ON CREATE for every record type', () => {
  // Regression: the create path must reject a record with no required field,
  // not silently store title/statement/summary as undefined.
  assert.throws(() => records.goals.create(wsA.id, {}), /title is required/);
  assert.throws(() => records.tasks.create(wsA.id, {}), /title is required/);
  assert.throws(() => records.assumptions.create(wsA.id, {}), /statement is required/);
  assert.throws(() => records.experiments.create(wsA.id, {}), /title is required/);
  assert.throws(() => records.decisions.create(wsA.id, {}), /decision must be a non-empty string/);
  assert.throws(() => records.evidence.create(wsA.id, { evidenceKind: 'customer_statement' }), /summary is required/);
});

check('goal status enum enforced; milestones validated', () => {
  assert.throws(() => records.goals.create(wsA.id, { title: 'x', status: 'not_a_status' }), /status/);
  assert.throws(() => records.goals.create(wsA.id, { title: 'x', milestones: [{ label: 'm', weight: -1 }] }), /weight/);
  const g = records.goals.create(wsA.id, { title: 'weighted', milestones: [{ label: 'a', done: true }, { label: 'b' }] });
  assert.strictEqual(g.milestones.length, 2);
});

check('decision text and reasoning are immutable; only status may change', () => {
  const d = records.decisions.create(wsA.id, { decision: 'Use JSON files', reasoning: 'single operator' });
  assert.strictEqual(d.status, 'proposed');
  const moved = records.decisions.updateForWorkspace(wsA.id, d.id, { status: 'accepted' });
  assert.strictEqual(moved.status, 'accepted');
  assert.throws(() => records.decisions.updateForWorkspace(wsA.id, d.id, { decision: 'Use Postgres' }), /immutable/);
});

check('assumption keeps confidence and status as SEPARATE fields', () => {
  const a = records.assumptions.create(wsA.id, { statement: 'Buyers want X', status: 'weak_evidence', confidence: 'low' });
  assert.strictEqual(a.status, 'weak_evidence');
  assert.strictEqual(a.confidence, 'low');
  // risk uses its own status vocabulary
  const r = records.assumptions.create(wsA.id, { kind: 'risk', statement: 'Key supplier fails', status: 'mitigating', confidence: 'medium' });
  assert.strictEqual(r.status, 'mitigating');
  assert.throws(() => records.assumptions.create(wsA.id, { statement: 'x', status: 'mitigating' }), /status/); // assumption can't use a risk status
});

check('evidence requires the say-vs-do kind and validates it', () => {
  assert.throws(() => records.evidence.create(wsA.id, { summary: 'said they liked it' }), /evidenceKind/);
  const e = records.evidence.create(wsA.id, { summary: 'paid a deposit', evidenceKind: 'transaction', sourceType: 'email' });
  assert.strictEqual(e.evidenceKind, 'transaction');
  assert.throws(() => records.evidence.create(wsA.id, { summary: 'x', evidenceKind: 'vibes' }), /evidenceKind/);
});

// ---- founder profile (singleton, partial merge) ----

check('founder profile starts null, saves partially, and merges', () => {
  assert.strictEqual(founderProfile.get(), null);
  founderProfile.save({ skills: ['sales'], hoursPerWeek: 20 });
  founderProfile.save({ riskTolerance: 'medium' }); // merge, not overwrite
  const p = founderProfile.get();
  assert.deepStrictEqual(p.skills, ['sales']);
  assert.strictEqual(p.hoursPerWeek, 20);
  assert.strictEqual(p.riskTolerance, 'medium');
  assert.throws(() => founderProfile.save({ hoursPerWeek: -5 }), /hoursPerWeek/);
});

// ---- onboarding (first-run, resume, complete) ----

check('onboarding is first-run (null) until started, then resumable and completable', () => {
  assert.strictEqual(onboarding.get(), null); // first run
  onboarding.start();
  onboarding.save({ currentStep: 'profile', operatingModes: ['validate'], draft: { workspaceName: 'Apparel' } });
  const mid = onboarding.get();
  assert.strictEqual(mid.currentStep, 'profile');
  assert.strictEqual(mid.completed, false);
  assert.deepStrictEqual(mid.operatingModes, ['validate']);
  assert.strictEqual(mid.draft.workspaceName, 'Apparel');
  assert.throws(() => onboarding.save({ currentStep: 'not_a_step' }), /currentStep/);
  assert.throws(() => onboarding.save({ operatingModes: ['telepathy'] }), /operating mode/);
  onboarding.complete({ skipped: false });
  assert.strictEqual(onboarding.get().completed, true);
});

// ---- YC progress (deterministic, transparent) ----

check('YC starts at 0 with all four sections and computes as items are checked', () => {
  const before = yc.computeForWorkspace(wsA.id);
  assert.strictEqual(before.overall, 0);
  assert.strictEqual(before.sections.length, 4);
  const labels = before.sections.map((s) => s.label);
  for (const req of ['YC Startup School Progress', 'YC Business Process', 'YC Partner Search', 'YC Application Process']) {
    assert.ok(labels.includes(req), `missing YC section: ${req}`);
  }
  // Every section must expose its items with done state — the UI renders the
  // checklist from these, and computeForWorkspace must not drop them.
  for (const s of before.sections) {
    assert.ok(Array.isArray(s.items) && s.items.length > 0, `section ${s.id} must include its items`);
    assert.ok(s.items.every((it) => typeof it.done === 'boolean'), 'each item carries a done flag');
  }
  yc.setItem(wsA.id, 'ss_enrolled', true);
  const after = yc.computeForWorkspace(wsA.id);
  assert.ok(after.overall > 0, 'checking an item should raise overall');
  // startup_school section has 3 items; one done => 33 => * weight 20 / 100 total
  const ss = after.sections.find((s) => s.id === 'startup_school');
  assert.strictEqual(ss.completedItems, 1);
  assert.strictEqual(ss.totalItems, 3);
  assert.strictEqual(ss.items.find((i) => i.id === 'ss_enrolled').done, true);
});

check('YC rejects unknown checklist items and is workspace-scoped', () => {
  assert.throws(() => yc.setItem(wsA.id, 'made_up_item', true), /unknown YC checklist item/);
  // wsB is independent of wsA's checkmarks
  assert.strictEqual(yc.computeForWorkspace(wsB.id).overall, 0);
});

// ---- workspace agent settings (global agents, per-workspace state) ----

check('agent settings default to least authority and reject unknown agents', () => {
  assert.throws(() => agentSettings.upsert(wsA.id, 'not_a_real_agent', { enabled: true }), /unknown catalog agent/);
  const row = agentSettings.upsert(wsA.id, 'interview_agent', { enabled: true });
  assert.strictEqual(row.enabled, true);
  // consequential caps default off even when enabled
  assert.strictEqual(row.permissions.spend_money, false);
  assert.strictEqual(row.permissions.paid_model_calls, false);
  assert.strictEqual(row.permissions.read_workspace_data, true);
  assert.throws(() => agentSettings.upsert(wsA.id, 'interview_agent', { permissions: { made_up: true } }), /unknown permission/);
  assert.throws(() => agentSettings.upsert(wsA.id, 'interview_agent', { config: ['not', 'an', 'object'] }), /config must be an object/);
});

check('agent settings are workspace-scoped', () => {
  agentSettings.upsert(wsA.id, 'interview_agent', { enabled: true });
  assert.strictEqual(agentSettings.listForWorkspace(wsA.id).length >= 1, true);
  assert.strictEqual(agentSettings.listForWorkspace(wsB.id).length, 0);
});

// ---- R-007: ONE optional-date contract, applied everywhere (see errors.optionalDate)
//
// Before this, workspaces.targetDate was validated and goal.targetDate /
// assumption.reviewDate were not — two contracts for one concept in one repo.
// The loose half accepted objects, arrays and junk strings. These cases run
// against every date-semantics field so a third one cannot quietly diverge.

// Every (label, write) pair that accepts an optional date. Adding a new
// date field without adding it here is the drift this list exists to catch.
const DATE_FIELDS = [
  ['workspace.targetDate', (v) => workspaces.update(wsA.id, { targetDate: v }), () => workspaces.get(wsA.id).targetDate],
  ['goal.targetDate', (v) => records.goals.create(wsA.id, { title: 'dated', targetDate: v }), null],
  ['assumption.reviewDate', (v) => records.assumptions.create(wsA.id, { statement: 'dated', reviewDate: v }), null],
];

check('every optional-date field rejects objects, arrays and malformed strings', () => {
  // Non-strings must be rejected, not stringified. An object previously
  // survived into storage and rendered to the operator as "[object Object]".
  const rejected = [{ evil: true }, [1, 2, 3], 'not-a-date', '2026-13-45', 123, true];
  // Impossible calendar dates that Date.parse ACCEPTS by rolling them over:
  // 2026-02-31 -> Mar 3, 2026-04-31 -> May 1, 2026-02-29 -> Mar 1 (not a leap
  // year). A shape check plus Date.parse stores a string meaning a different
  // day than the one written. Caught in live-runtime verification, not by the
  // original version of this test — which only tried 2026-13-45, where the
  // month itself is out of range and parse genuinely fails.
  rejected.push('2026-02-31', '2026-04-31', '2026-02-29', '2026-06-31');
  for (const [label, write] of DATE_FIELDS) {
    for (const bad of rejected) {
      assert.throws(
        () => write(bad),
        (err) => err.code === 'VALIDATION_ERROR' && /must be/.test(err.message),
        `${label} must reject ${JSON.stringify(bad)} with a stable VALIDATION_ERROR`
      );
    }
  }
});

check('every optional-date field rejects ambiguous coercions Date.parse would accept', () => {
  // Date.parse('garbage 2024') and Date.parse('5') both succeed. A bare
  // Date.parse check is therefore not a date validator; the contract is an
  // ISO calendar date (what <input type="date"> emits), optionally with time.
  const ambiguous = ['garbage 2024', '5', '0', 'Jan 5 2026'];
  for (const [label, write] of DATE_FIELDS) {
    for (const bad of ambiguous) {
      assert.throws(() => write(bad), /must be/, `${label} must reject the ambiguous value ${JSON.stringify(bad)}`);
    }
  }
});

check('every optional-date field accepts ISO dates and an explicit clear', () => {
  for (const [label, write, read] of DATE_FIELDS) {
    assert.doesNotThrow(() => write('2026-07-31'), `${label} must accept an ISO date`);
    // A real leap day must still be accepted — the rollover check must reject
    // impossible dates without rejecting unusual valid ones.
    assert.doesNotThrow(() => write('2024-02-29'), `${label} must accept a real leap day`);
    assert.doesNotThrow(() => write('2026-12-31'), `${label} must accept the last day of a month`);
    assert.doesNotThrow(() => write('2026-07-31T12:00:00Z'), `${label} must accept an ISO date-time`);
    // null and '' are the two ways the API/UI express "clear this field".
    assert.doesNotThrow(() => write(null), `${label} must accept null as a clear`);
    assert.doesNotThrow(() => write(''), `${label} must accept '' as a clear`);
    if (read) assert.strictEqual(read(), null, `${label} clears to null, not '' or undefined`);
  }
});

check('a valid stored date survives an update that does not mention it', () => {
  workspaces.update(wsA.id, { targetDate: '2026-07-31' });
  workspaces.update(wsA.id, { name: 'Apparel Co renamed' });
  assert.strictEqual(workspaces.get(wsA.id).targetDate, '2026-07-31');

  const g = records.goals.create(wsA.id, { title: 'keeps its date', targetDate: '2026-01-15' });
  const after = records.goals.updateForWorkspace(wsA.id, g.id, { status: 'in_progress' });
  assert.strictEqual(after.targetDate, '2026-01-15');
});

// cleanup
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} passed`);
