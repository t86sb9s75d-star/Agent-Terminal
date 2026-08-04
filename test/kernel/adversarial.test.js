// Phase 9 — adversarial verification.
//
// The mutant suite models a kernel that is WRONG. This file models an actor
// that is HOSTILE: code deliberately trying to obtain an effect while looking
// compliant. The distinction matters because this system's whole trajectory is
// to execute code nobody in this repository wrote — Claude, GPT, Codex, Kimi,
// DeepSeek, custom shell commands, eventually third-party plugins. A harness
// that only assumes honest mistakes is calibrated for the wrong threat.
//
// Every attack below is a PERMANENT regression test. An attack that starts
// succeeding is a released bypass, and the assertion says so in those terms.
//
// HONESTY ABOUT THE LIMIT, stated here rather than discovered later: in a
// single Node process there is no such thing as truly unreachable code.
// `require` is global; anything loaded can in principle be reached by anything
// else. What this design provides is (a) no ORDINARY path to an effect — you
// cannot get one by importing a module, only by being handed a transaction-
// bound handle — and (b) a runtime tripwire that refuses and records the
// extraordinary path. That is a real, provable property. "Impossible to
// bypass" is not, and must never be claimed.
//
// Run with: node test/kernel/adversarial.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { checkAll } = require('./spec/invariants');
const { buildWorld, FORBIDDEN, UNGRANTED, WORKSPACE_A, WORKSPACE_B } = require('./harness/world');
const { createTransactionLog } = require('../../src/kernel/transactionLog');

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`ok - ${name}`); })
    .catch((err) => { failed += 1; console.log(`NOT OK - ${name}\n    ${err.message}`); });
}

(async () => {
  // -------------------------------------------------------------------
  // ATTACK 1 — call an effector directly, holding a real reference to it.
  // -------------------------------------------------------------------
  await check('ATTACK: invoking an effector directly, outside any transaction, is refused', async () => {
    const world = buildWorld();
    // The attacker has the registry and can resolve the real effector. This is
    // the strongest in-process position available — and it must still fail.
    const effector = world.registry.resolveEffector('fixture.act');
    let threw = null;
    try {
      await effector({ hello: 'direct' }, { workspaceId: WORKSPACE_A, txId: 'forged-tx' });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'BYPASS RELEASED: an effector executed outside a kernel transaction');
    assert.strictEqual(threw.code, 'KERNEL_BYPASS', `refused, but for the wrong reason: ${threw.message}`);
    // And nothing was recorded, because nothing legitimate happened.
    assert.strictEqual(world.kernel.effectorCalls.length, 0, 'the bypass attempt registered as a kernel effector call');
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 2 — forge a transaction id and execute under it.
  // -------------------------------------------------------------------
  await check('ATTACK: a forged transaction id cannot produce an executed effect', async () => {
    const world = buildWorld();
    await world.kernel.execute(world.intent());
    const report = checkAll(world.observe());
    assert.ok(report.ok, report.summary);
    // Every effector call must correspond to a txId the kernel itself wrote to
    // disk BEFORE the call. A forged id has no such record.
    for (const call of world.kernel.effectorCalls) {
      const prior = call.logSnapshotAtCall.find((r) => r.txId === call.txId && r.state === 'recorded');
      assert.ok(prior, `tx ${call.txId} executed with no pre-effect record — a forged id would look exactly like this`);
    }
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 3 — replay a previously sealed approval for a new action.
  // -------------------------------------------------------------------
  await check('ATTACK: replaying a sealed transaction does not grant a second execution', async () => {
    const world = buildWorld();
    const first = await world.kernel.execute(world.intent());
    const executionsAfterFirst = world.kernel.effectorCalls.length;

    // Replay the exact same intent, including the original session. A system
    // that keyed authorization off a reusable token would execute for free.
    const replay = await world.kernel.execute(world.intent(), { sessionId: first.sessionId });

    assert.notStrictEqual(replay.txId, first.txId, 'the replay reused the original transaction id');
    assert.strictEqual(
      world.kernel.effectorCalls.length, executionsAfterFirst + 1,
      'the replay did not produce its own independently authorized transaction'
    );
    // Each execution is bound to its own record; neither borrowed the other's.
    const ids = new Set(world.kernel.effectorCalls.map((c) => c.txId));
    assert.strictEqual(ids.size, 2, 'two executions shared one transaction id');
    assert.ok(checkAll(world.observe()).ok);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 4 — reach another workspace's data through the handle.
  // -------------------------------------------------------------------
  await check('ATTACK: an effector cannot redirect itself to another workspace', async () => {
    let observedHandle = null;
    const world = buildWorld({
      effectorBehavior: async (args, handle) => {
        observedHandle = handle;
        // Try every ordinary way to change the bound workspace.
        try { handle.workspaceId = WORKSPACE_B; } catch { /* frozen is also fine */ }
        return { ok: true, costUsd: 0 };
      },
    });
    await world.kernel.execute(world.intent({ workspaceId: WORKSPACE_A }));

    // The recorded call is captured by the KERNEL at the call boundary, before
    // the effector can touch anything, so tampering afterwards cannot rewrite
    // history even if the object itself is mutable.
    const call = world.kernel.effectorCalls[0];
    assert.strictEqual(call.workspaceId, WORKSPACE_A, 'the kernel recorded a workspace the transaction never authorized');
    assert.ok(observedHandle, 'the effector never received a handle');
    assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 5 — spend a grant on a capability the constitution forbids.
  // -------------------------------------------------------------------
  await check('ATTACK: a granted-but-forbidden capability is still refused, and the denial is sealed', async () => {
    const world = buildWorld();
    assert.ok(world.granted.includes(FORBIDDEN), 'fixture no longer grants the forbidden capability — this attack proves nothing');
    const res = await world.kernel.execute(world.intent({ capability: FORBIDDEN }));
    assert.strictEqual(res.decision, 'deny', 'a grant widened past a constitutional prohibition');
    assert.ok(res.sealed, 'the refusal left no audit record');
    assert.ok(checkAll(world.observe()).ok);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 6 — escape budget accounting by never settling.
  // -------------------------------------------------------------------
  await check('ATTACK: a failing effector cannot strand its reservation', async () => {
    const world = buildWorld({
      capUsd: 1.0,
      effectorBehavior: async () => { throw new Error('hostile effector refuses to return'); },
    });
    for (let i = 0; i < 3; i += 1) {
      await world.kernel.execute(world.intent({ capability: 'fixture.metered' }));
    }
    assert.deepStrictEqual(
      world.kernel.reservations.outstanding(), [],
      'reservations survived a failing effector — repeated failures would silently exhaust the cap'
    );
    assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 7 — exceed the budget by racing concurrent transactions.
  // -------------------------------------------------------------------
  await check('ATTACK: concurrent transactions cannot collectively exceed the cap', async () => {
    // Cap of $1.00 against a $0.25 estimate: at most four may execute. A
    // read-then-act check (which is what src/budget.js does today) would let
    // all ten through, because all ten read the same total before any settled.
    const world = buildWorld({ capUsd: 1.0, maxConcurrentPerWorkspace: 64 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => world.kernel.execute(world.intent({ capability: 'fixture.metered' })))
    );
    const allowed = results.filter((r) => r.decision === 'allow').length;
    const denied = results.filter((r) => r.ruleId === 'budget.cap_reached').length;
    assert.ok(allowed <= 4, `${allowed} transactions executed against a cap that permits at most 4 — the reservation hold is not working`);
    assert.ok(denied >= 6, `only ${denied} were refused for budget; expected at least 6`);
    assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 8 — a second process writing the same log out of band.
  // -------------------------------------------------------------------
  await check('ATTACK: a second writer forking the audit chain is DETECTED, not silently absorbed', async () => {
    const world = buildWorld();
    await world.kernel.execute(world.intent());

    // A second kernel opens the same file and appends. This is what a forked
    // process, a stray script, or a bypassed instance lock looks like on disk.
    const rogue = createTransactionLog({ filePath: world.logFilePath });
    rogue.open();
    rogue.append({ txId: 'rogue-tx', state: 'recorded', capability: 'fixture.act', workspaceId: WORKSPACE_A });

    // The first kernel appends next, still holding its own (now stale) head.
    await world.kernel.execute(world.intent());

    const verification = world.kernel.log.verify();
    assert.strictEqual(
      verification.ok, false,
      'two independent writers produced a chain that still verifies — concurrent tampering would be invisible'
    );
    // And the specification reports it rather than any other invariant.
    const report = checkAll(world.observe());
    assert.ok(report.failedIds.includes('audit_chain_intact'), `expected audit_chain_intact to fail, got [${report.failedIds.join(', ')}]`);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 9 — suppress the audit by making the log unwritable.
  // -------------------------------------------------------------------
  await check('ATTACK: if the transaction cannot be recorded, the effect does not happen', async () => {
    const world = buildWorld();
    await world.kernel.execute(world.intent()); // establish a healthy chain

    // Corrupt the log so it seals on reopen: this is the strongest available
    // "the audit is unavailable" condition.
    fs.appendFileSync(world.logFilePath, '{"txId":"tampered","recordHash":"nope"}\n');
    const reopened = world.kernel.log.reopen();
    assert.strictEqual(reopened.ok, false, 'the corrupted log reopened as healthy');

    const before = world.kernel.effectorCalls.length;
    const res = await world.kernel.execute(world.intent());
    assert.strictEqual(
      world.kernel.effectorCalls.length, before,
      'THE CENTRAL INVARIANT FAILED: an effect executed while the transaction log could not be written'
    );
    assert.notStrictEqual(res.error, null, 'the sealed log produced no error on the transaction');
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 10 — use an ungranted capability by exhausting other paths.
  // -------------------------------------------------------------------
  await check('ATTACK: an ungranted capability is refused from every entry point', async () => {
    const world = buildWorld();
    const attempts = [
      world.intent({ capability: UNGRANTED }),
      world.intent({ capability: UNGRANTED, workspaceId: WORKSPACE_B }),
      world.intent({ capability: UNGRANTED, initiator: { actorType: 'human_operator', actorId: 'operator-1' } }),
      world.intent({ capability: 'does.not.exist' }),
    ];
    for (const intent of attempts) {
      const res = await world.kernel.execute(intent);
      assert.strictEqual(res.decision, 'deny', `"${intent.capability}" was allowed via ${intent.initiator.actorType}/${intent.workspaceId}`);
    }
    assert.strictEqual(world.kernel.effectorCalls.length, 0, 'an ungranted capability reached an effector');
    assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    world.cleanup();
  });

  // -------------------------------------------------------------------
  // ATTACK 11 — under-declare cost, then charge more than declared.
  // -------------------------------------------------------------------
  await check('ATTACK: an effector charging above its declared bound is detected and recorded', async () => {
    // fixture.metered declares a $0.25 ceiling. This effector charges $0.90 —
    // the way a capability would quietly erode a cap if under-declaring were
    // absorbed silently. The kernel cannot prevent a post-hoc overcharge, but
    // it must never swallow one.
    const world = buildWorld({ capUsd: 10, effectorBehavior: async () => ({ ok: true, costUsd: 0.90 }) });
    const res = await world.kernel.execute(world.intent({ capability: 'fixture.metered' }));

    const overruns = world.events.filter((e) => e.type === 'kernel.cost_overrun');
    assert.strictEqual(overruns.length, 1, 'an effector charged 3.6x its declared bound and no overrun was reported');
    assert.ok(Math.abs(overruns[0].overrunUsd - 0.65) < 1e-9, `overrun mis-measured: ${overruns[0].overrunUsd}`);

    const rec = world.observe().records.find((r) => r.txId === res.txId && r.terminal);
    assert.ok(rec.costOverrunUsd > 0, 'the overrun was emitted as an event but not written into the permanent record');
    assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    world.cleanup();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
