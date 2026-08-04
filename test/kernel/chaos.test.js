// Phase 9 — chaos mode.
//
// The deterministic suites each probe one thing at a time. Interaction bugs
// live in the combinations nobody thought to write down: a cancellation
// arriving while a reservation is held, during a concurrent batch, on a
// session already at its loop limit, against a capability that was denied last
// time. This runs a thousand randomized operations and then requires every
// invariant to hold.
//
// SEEDED, and the seed is printed on every run. A chaos failure you cannot
// reproduce is a rumour, not a bug report — re-run with
// RUCKER_CHAOS_SEED=<seed> to replay the sequence.
//
// PRECISELY WHAT IS AND IS NOT DETERMINISTIC. An earlier version of this note
// claimed "all randomness comes from the seeded generator", which hostile
// review showed to be false: the kernel calls crypto.randomUUID() for every
// transaction and session id, and the world builder calls fs.mkdtempSync().
// Neither is seeded.
//
// What the seed DOES control is the operation sequence — capability, workspace,
// session reuse, batch size, depth, cancellation, and effector behaviour. No
// assertion depends on an identifier's value, so replaying a seed reproduces
// the outcome counts, denial reasons and record totals; verified identical
// across three consecutive runs of seed 424242.
//
// It is still not a hard guarantee: a slice of transactions is cancelled from a
// setTimeout, so when the abort lands relative to async work is wall-clock
// dependent. Replay is reliable in practice and is NOT proof of bit-identical
// behaviour on a loaded machine.
//
// Run with: node test/kernel/chaos.test.js
//           RUCKER_CHAOS_SEED=12345 node test/kernel/chaos.test.js

const assert = require('assert');

const { checkAll } = require('./spec/invariants');
const { buildWorld, WORKSPACE_A, WORKSPACE_B, FORBIDDEN, UNGRANTED } = require('./harness/world');

const SEED = Number(process.env.RUCKER_CHAOS_SEED) || Math.floor(Date.now() % 2147483647);
const OPERATIONS = Number(process.env.RUCKER_CHAOS_OPS) || 1000;

// mulberry32 — small, fast, and fully determined by the seed.
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`NOT OK - ${name}\n    ${err.message}\n    REPRODUCE WITH: RUCKER_CHAOS_SEED=${SEED} RUCKER_CHAOS_OPS=${OPERATIONS} node test/kernel/chaos.test.js`);
  }
}

(async () => {
  console.log(`chaos: ${OPERATIONS} operations, seed=${SEED}\n`);
  const random = makeRandom(SEED);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];

  const CAPABILITIES = ['fixture.act', 'fixture.metered', FORBIDDEN, UNGRANTED, 'does.not.exist'];
  const WORKSPACES = [WORKSPACE_A, WORKSPACE_B];

  const world = buildWorld({
    capUsd: 5.0,
    maxConcurrentPerWorkspace: 4,
    maxTransactionsPerSession: 12,
    // The effector is chaotic but CONTRACT-ABIDING: it succeeds, throws,
    // stalls, or settles at any cost up to — never above — the $0.25 bound
    // fixture.metered declares. An effector that exceeds its declared max is a
    // contract violation and is covered separately, by an adversarial attack.
    // Cost is reported ONLY for the metered capability. A first draft charged
    // for fixture.act too — which declares budgetClass 'none' — and the kernel
    // correctly flagged 20 cost overruns and a breached cap. That was a
    // mis-declared fixture, not a kernel bug: a capability that says it is free
    // and then charges is precisely what overrun detection exists to catch.
    effectorBehavior: async (args, handle) => {
      const roll = random();
      if (roll < 0.15) throw new Error('chaos: effector failed');
      if (roll < 0.25) await new Promise((r) => setTimeout(r, Math.floor(random() * 3)));
      const metered = handle.capability === 'fixture.metered';
      if (metered && roll < 0.75) return { ok: true, costUsd: Number((random() * 0.25).toFixed(4)) };
      return { ok: true, costUsd: 0 };
    },
  });

  const sessions = [];
  const outcomes = { allow: 0, deny: 0, error: 0 };
  const denialReasons = Object.create(null);

  let completed = 0;
  while (completed < OPERATIONS) {
    // Random batch size, so single calls and concurrent bursts interleave.
    const batch = 1 + Math.floor(random() * 4);
    const calls = [];

    for (let i = 0; i < batch && completed + i < OPERATIONS; i += 1) {
      const capability = pick(CAPABILITIES);
      const workspaceId = pick(WORKSPACES);

      // Reuse an existing session sometimes, so loop accounting and cycle
      // detection are genuinely exercised rather than always starting fresh.
      const reuse = sessions.length > 0 && random() < 0.5;
      const sessionId = reuse ? pick(sessions) : null;

      const controller = new AbortController();
      // Cancel a slice of transactions before they start, and another slice
      // asynchronously mid-flight.
      if (random() < 0.05) controller.abort();
      else if (random() < 0.08) setTimeout(() => controller.abort(), Math.floor(random() * 3));

      const depth = Math.floor(random() * 6); // deliberately exceeds maxDelegationDepth sometimes

      calls.push(
        world.kernel
          .execute(
            { capability, workspaceId, initiator: { actorType: 'agent', actorId: `agent-${Math.floor(random() * 5)}` }, args: { n: completed + i } },
            { sessionId, depth, signal: controller.signal }
          )
          .then((res) => {
            if (!reuse && res.sessionId) sessions.push(res.sessionId);
            if (res.error) outcomes.error += 1;
            else if (res.decision === 'allow') outcomes.allow += 1;
            else {
              outcomes.deny += 1;
              denialReasons[res.ruleId] = (denialReasons[res.ruleId] || 0) + 1;
            }
            return res;
          })
      );
    }

    // execute() must never reject; a chaos run that throws here is itself the
    // finding.
    const settled = await Promise.allSettled(calls);
    const rejected = settled.filter((s) => s.status === 'rejected');
    if (rejected.length > 0) {
      check('chaos: kernel.execute() never rejects', () => {
        assert.fail(`${rejected.length} call(s) rejected, first: ${rejected[0].reason && rejected[0].reason.message}`);
      });
      break;
    }

    completed += batch;
  }

  // Let any mid-flight cancellation timers land before observing.
  await new Promise((r) => setTimeout(r, 25));

  const bundle = world.observe();
  const report = checkAll(bundle);

  console.log(`  outcomes: ${outcomes.allow} allowed, ${outcomes.deny} denied, ${outcomes.error} errored`);
  console.log(`  denial reasons: ${Object.entries(denialReasons).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
  console.log(`  transaction records: ${bundle.records.length}, effector calls: ${bundle.effectorCalls.length}\n`);

  check('chaos: every invariant holds after the full run', () => {
    assert.ok(report.ok, report.summary);
  });

  // --- Non-vacuity guards. A chaos run in which nothing interesting happened
  // --- would pass every invariant while proving nothing at all.
  check('chaos: the run actually exercised execution', () => {
    assert.ok(bundle.effectorCalls.length > 50, `only ${bundle.effectorCalls.length} effector calls — the run did not meaningfully execute`);
  });

  check('chaos: the run actually exercised denial', () => {
    assert.ok(outcomes.deny > 50, `only ${outcomes.deny} denials — authorization paths were barely touched`);
  });

  check('chaos: denials came from several different rules, not one dominant path', () => {
    const kinds = Object.keys(denialReasons).length;
    assert.ok(kinds >= 4, `denials came from only ${kinds} rule(s): ${Object.keys(denialReasons).join(', ')}`);
  });

  check('chaos: the forbidden capability was attempted and never once executed', () => {
    const attempted = bundle.records.some((r) => r.capability === FORBIDDEN);
    assert.ok(attempted, 'the forbidden capability was never attempted — its safety was not tested');
    const executed = bundle.effectorCalls.filter((c) => c.capability === FORBIDDEN);
    assert.strictEqual(executed.length, 0, `the forbidden capability executed ${executed.length} time(s)`);
  });

  check('chaos: budget never exceeded the cap despite concurrency and cost variance', () => {
    const committed = world.kernel.reservations.committed();
    assert.ok(committed <= 5.0 + 1e-9, `committed spend $${committed.toFixed(4)} exceeded the $5.00 cap`);
  });

  check('chaos: metered work actually ran, so the cap assertion is not vacuous', () => {
    const metered = bundle.effectorCalls.filter((c) => c.capability === 'fixture.metered');
    assert.ok(metered.length > 10, `only ${metered.length} metered executions — the budget path was barely exercised`);
    assert.ok(world.kernel.reservations.committed() > 0.5, `only $${world.kernel.reservations.committed().toFixed(4)} committed — spend never approached the cap`);
  });

  check('chaos: no contract-abiding effector produced a cost overrun', () => {
    const overruns = world.events.filter((e) => e.type === 'kernel.cost_overrun');
    assert.strictEqual(overruns.length, 0, `${overruns.length} overrun(s) from an effector that stays within its declared bound — the reservation math is wrong`);
  });

  world.cleanup();

  console.log(`\n${passed} passed, ${failed} failed  (seed=${SEED})`);
  if (failed > 0) process.exit(1);
})();
