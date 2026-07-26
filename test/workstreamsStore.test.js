// Run with: node test/workstreamsStore.test.js
//
// Covers the two things most likely to regress silently in a future
// refactor: (1) effective-status precedence, and (2) that a workstream's
// historical run attribution is permanent — reassigning an agent must not
// retroactively change which workstream its past runs belonged to.

const assert = require('assert');
const { computeEffectiveStatus, computeMetrics } = require('../src/workstreamsStore');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ---------------- computeEffectiveStatus ----------------

check('archived always wins, even with an override set', () => {
  const ws = { archived: true, statusOverride: 'Active' };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 3, runningRuns: 1, hasUnresolvedFailure: false }), 'Archived');
});

check('manual override wins over computed state', () => {
  const ws = { archived: false, statusOverride: 'Review' };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 2, runningRuns: 1, hasUnresolvedFailure: true }), 'Review');
});

check('no agents -> Planning', () => {
  const ws = { archived: false, statusOverride: null };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 0, runningRuns: 0, hasUnresolvedFailure: false }), 'Planning');
});

check('a run in progress -> Active', () => {
  const ws = { archived: false, statusOverride: null };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 2, runningRuns: 1, hasUnresolvedFailure: false }), 'Active');
});

check('unresolved failure, nothing running -> Blocked', () => {
  const ws = { archived: false, statusOverride: null };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 2, runningRuns: 0, hasUnresolvedFailure: true }), 'Blocked');
});

check('agents present, no failure, nothing running -> Active (default)', () => {
  const ws = { archived: false, statusOverride: null };
  assert.strictEqual(computeEffectiveStatus(ws, { agentCount: 2, runningRuns: 0, hasUnresolvedFailure: false }), 'Active');
});

check('Completed and Review are never computed automatically', () => {
  // Even a "healthy, nothing running, no failures" workstream should not
  // auto-promote to Completed/Review — those require an explicit human call.
  const ws = { archived: false, statusOverride: null };
  const status = computeEffectiveStatus(ws, { agentCount: 5, runningRuns: 0, hasUnresolvedFailure: false });
  assert.notStrictEqual(status, 'Completed');
  assert.notStrictEqual(status, 'Review');
});

// ---------------- computeMetrics ----------------

function agent(id, workstreamId) { return { id, workstreamId }; }
function run(agentId, workstreamId, status, extra = {}) {
  return { agentId, workstreamId, status, startedAt: extra.startedAt ?? Date.now(), ...extra };
}

check('metrics count only runs snapshotted to this workstream, not agents current membership', () => {
  const agents = [agent('a1', 'B')]; // agent currently in workstream B
  const runs = [
    run('a1', 'A', 'completed'), // ran while a1 was in A — permanent history
    run('a1', 'A', 'error'),
  ];
  const forA = computeMetrics('A', { agents, runs });
  const forB = computeMetrics('B', { agents, runs });

  assert.strictEqual(forA.agentCount, 0); // a1 isn't a current member of A anymore
  assert.strictEqual(forA.runCount, 2); // but A's history is untouched
  assert.strictEqual(forA.completedRuns, 1);
  assert.strictEqual(forA.failedRuns, 1);

  assert.strictEqual(forB.agentCount, 1); // a1 is a current member of B
  assert.strictEqual(forB.runCount, 0); // but has no history there yet
});

check('hasUnresolvedFailure true only when the MOST RECENT run for a member agent errored', () => {
  const agents = [agent('a1', 'A')];
  const runs = [
    run('a1', 'A', 'error', { startedAt: 1000 }),
    run('a1', 'A', 'completed', { startedAt: 2000 }), // supersedes the earlier failure
  ];
  const metrics = computeMetrics('A', { agents, runs });
  assert.strictEqual(metrics.hasUnresolvedFailure, false);
});

check('hasUnresolvedFailure true when the latest run for a member agent is still an error', () => {
  const agents = [agent('a1', 'A')];
  const runs = [
    run('a1', 'A', 'completed', { startedAt: 1000 }),
    run('a1', 'A', 'error', { startedAt: 2000 }),
  ];
  const metrics = computeMetrics('A', { agents, runs });
  assert.strictEqual(metrics.hasUnresolvedFailure, true);
});

check('progress is always null — never a fabricated percentage', () => {
  const agents = [agent('a1', 'A')];
  const runs = [run('a1', 'A', 'completed'), run('a1', 'A', 'completed'), run('a1', 'A', 'completed')];
  const metrics = computeMetrics('A', { agents, runs });
  assert.strictEqual(metrics.progress, null);
});

check('no agents or runs for a workstream -> zeroed metrics, not an error', () => {
  const metrics = computeMetrics('empty-ws', { agents: [], runs: [] });
  assert.strictEqual(metrics.agentCount, 0);
  assert.strictEqual(metrics.runCount, 0);
  assert.strictEqual(metrics.lastActivity, null);
  assert.strictEqual(metrics.cost.pricingStatus, 'empty');
  assert.strictEqual(metrics.executionSuccessRate, null);
});

<<<<<<< HEAD
// ---------------- Phase 6.3 Option B: incidents outlive reassignment ----------------
// Documented choice: a failure stays attached to the workstream where it
// happened even after the responsible agent is reassigned elsewhere, until
// an operator explicitly resolves it. This is the opposite of Option A
// (status auto-clears the moment the agent leaves), which was rejected
// because it lets a real unresolved failure quietly vanish from view.

check('Option B: failure stays Blocked-visible after the agent is reassigned away', () => {
  // Agent is now a member of B, but its last run in A was a failure.
  const agents = [agent('a1', 'B')];
  const runs = [run('a1', 'A', 'error', { startedAt: 1000, id: 'run-1' })];
  const metrics = computeMetrics('A', { agents, runs });
  assert.strictEqual(metrics.hasUnresolvedFailure, true);
  assert.deepStrictEqual(metrics.unresolvedFailureRunIds, ['run-1']);
});

check('Option B: explicit resolution clears the failure even without a new run', () => {
  const agents = [agent('a1', 'B')];
  const failingRun = run('a1', 'A', 'error', { startedAt: 1000, id: 'run-to-resolve' });
  const runs = [failingRun];
  const unresolved = computeMetrics('A', { agents, runs });
  assert.strictEqual(unresolved.hasUnresolvedFailure, true);

  const resolved = computeMetrics('A', { agents, runs, resolvedFailureRunIds: ['run-to-resolve'] });
  assert.strictEqual(resolved.hasUnresolvedFailure, false);
  assert.deepStrictEqual(resolved.unresolvedFailureRunIds, []);
});

check('Option B: a later successful run in the SAME workstream supersedes the failure', () => {
  const agents = [agent('a1', 'B')];
  const runs = [
    run('a1', 'A', 'error', { startedAt: 1000 }),
    run('a1', 'A', 'completed', { startedAt: 2000 }),
  ];
  const metrics = computeMetrics('A', { agents, runs });
  assert.strictEqual(metrics.hasUnresolvedFailure, false);
});

=======
>>>>>>> origin/main
console.log(`\n${passed} passed`);
