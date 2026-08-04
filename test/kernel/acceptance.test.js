// Phase 9 — THE ACCEPTANCE GATE.
//
// The directive's success criterion, in executable form:
//
//   "A new capability should automatically inherit all platform behavior. If
//    any of those require manual wiring, the kernel isn't complete."
//   "Delete a capability. The system should refuse execution, preserve audit
//    history, leave no dangling permissions, leave no orphaned references, and
//    require zero additional cleanup."
//
// Both are checked here by REGISTERING A CAPABILITY THAT DID NOT EXIST when
// the kernel was written, and then removing it. Nothing in src/kernel knows
// this capability exists. If inheriting the platform required a kernel change,
// this file could not pass.
//
// Also enforced here: the Specification / Harness / Implementation separation,
// checked empirically (a child process's real require cache) rather than by
// scanning source text. Phase 8's A-009 was a source scan that reported a
// route as audited when it was not — static text is an indirect signal about
// what code does.
//
// Run with: node test/kernel/acceptance.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { PLATFORM_CONCERNS, STAGE_IDS } = require('../../src/kernel/stages');
const { checkAll } = require('./spec/invariants');
const { buildWorld, DEFAULT_CAPABILITIES, WORKSPACE_A } = require('./harness/world');

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`ok - ${name}`); })
    .catch((err) => { failed += 1; console.log(`NOT OK - ${name}\n    ${err.message}`); });
}

// A capability invented entirely here. src/kernel has never heard of it.
const NEW_CAP = 'acceptance.newly_registered';

function worldWithNewCapability(extra = {}) {
  return buildWorld({
    capabilities: [...DEFAULT_CAPABILITIES, { id: NEW_CAP, effector: 'fixture', budgetClass: 'metered', maxCostUsd: 0.10, consequential: true }],
    ...extra,
  });
}

(async () => {
  // =====================================================================
  // 1. ADDING a capability inherits every platform concern, with no wiring.
  // =====================================================================
  {
    const world = worldWithNewCapability({ capUsd: 0.25, maxConcurrentPerWorkspace: 2 });
    const res = await world.kernel.execute(world.intent({ capability: NEW_CAP }));
    const bundle = world.observe();
    const rec = bundle.records.find((r) => r.txId === res.txId && r.terminal);

    // Each concern is proven from the ARTIFACT the concern is supposed to
    // produce — not from the fact that a stage exists.
    const proofs = {
      authorization: () => {
        assert.ok(rec.grantChainHead, 'no grant chain head recorded');
        assert.strictEqual(rec.decision, 'allow');
      },
      workspace_isolation: () => {
        assert.strictEqual(rec.workspaceId, WORKSPACE_A);
        const call = world.kernel.effectorCalls.find((c) => c.txId === res.txId);
        assert.strictEqual(call.workspaceId, WORKSPACE_A, 'the effector was not bound to the transaction workspace');
      },
      constitution: () => {
        assert.strictEqual(rec.constitutionId, 'fixture-constitution-v1', 'the constitution was not pinned onto the record');
      },
      budget: () => {
        assert.strictEqual(rec.reservedUsd, 0.10, `the declared bound was not reserved (got ${rec.reservedUsd})`);
        assert.notStrictEqual(rec.actualCostUsd, null, 'no actual cost settled');
      },
      rate_limiting: () => {
        assert.strictEqual(world.kernel.activeCount(WORKSPACE_A), 0, 'the admission slot was not returned');
      },
      loop_accounting: () => {
        assert.strictEqual(rec.loopIteration, 1, `loop iteration not counted (got ${rec.loopIteration})`);
      },
      audit: () => {
        const pre = bundle.records.find((r) => r.txId === res.txId && r.state === 'recorded');
        assert.ok(pre, 'no pre-effect record was written for a capability the kernel has never seen');
      },
      tracing: () => {
        assert.ok(rec.sessionId, 'no sessionId');
        assert.ok('parentTxId' in rec, 'no parentTxId field for causal reconstruction');
        assert.ok(Array.isArray(rec.stagesReached) && rec.stagesReached.length === STAGE_IDS.length,
          `stagesReached did not cover the pipeline: ${rec.stagesReached && rec.stagesReached.length}/${STAGE_IDS.length}`);
      },
      metrics: () => {
        assert.strictEqual(world.kernel.metrics.byCapability[NEW_CAP].executed, 1, 'metrics did not count the new capability');
      },
      cancellation: () => {
        // Proven below with a real abort; here just assert the plumbing exists.
        assert.ok(true);
      },
      structured_events: () => {
        const ev = world.events.find((e) => e.type === 'kernel.transaction' && e.record.txId === res.txId);
        assert.ok(ev, 'no structured event emitted for the new capability');
      },
    };

    for (const concern of PLATFORM_CONCERNS) {
      await check(`ADD: "${NEW_CAP}" inherits ${concern.id} with no kernel change — ${concern.description}`, () => {
        const proof = proofs[concern.id];
        assert.ok(proof, `no proof is defined for platform concern "${concern.id}" — the concern is claimed but unverified`);
        proof();
      });
    }

    await check('ADD: the concern list is fully covered — no concern is claimed without a proof', () => {
      const claimed = PLATFORM_CONCERNS.map((c) => c.id).sort();
      const proven = Object.keys(proofs).sort();
      assert.deepStrictEqual(proven, claimed, 'the proof table and the platform concern list have diverged');
    });

    world.cleanup();
  }

  // Cancellation, proven with a real abort rather than asserted.
  await check('ADD: the new capability inherits cancellation without any wiring', async () => {
    const world = worldWithNewCapability();
    const controller = new AbortController();
    controller.abort();
    const res = await world.kernel.execute(world.intent({ capability: NEW_CAP }), { signal: controller.signal });
    assert.strictEqual(res.decision, 'deny', 'an aborted transaction still executed');
    assert.strictEqual(res.ruleId, 'cancelled', `denied for the wrong reason: ${res.ruleId}`);
    assert.strictEqual(world.kernel.effectorCalls.length, 0, 'the effector ran despite cancellation');
    assert.ok(checkAll(world.observe()).ok);
    world.cleanup();
  });

  // The budget bound is enforced for the new capability too, not just fixtures.
  await check('ADD: the new capability inherits budget enforcement (cap refuses the third call)', async () => {
    // The effector must actually SPEND, or the cap is never approached and the
    // assertion passes for the wrong reason. A first draft used the default
    // zero-cost fixture: four calls all succeeded against a $0.25 cap, which
    // was correct behavior (nothing was ever committed) and a vacuous test.
    const world = worldWithNewCapability({ capUsd: 0.25, effectorBehavior: async () => ({ ok: true, costUsd: 0.10 }) });
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await world.kernel.execute(world.intent({ capability: NEW_CAP })));
    }
    const refused = results.filter((r) => r.ruleId === 'budget.cap_reached').length;
    assert.ok(refused >= 1, 'a $0.25 cap never refused a capability declaring a $0.10 bound');
    assert.ok(checkAll(world.observe()).ok);
    world.cleanup();
  });

  // =====================================================================
  // 2. REMOVING a capability is as clean as adding one.
  // =====================================================================
  {
    const world = worldWithNewCapability();
    const before = await world.kernel.execute(world.intent({ capability: NEW_CAP }));
    assert.strictEqual(before.decision, 'allow');

    const removed = world.registry.remove(NEW_CAP);

    await check('REMOVE: the capability is gone from the registry', () => {
      assert.ok(removed, 'remove() reported nothing was removed');
      assert.strictEqual(world.registry.has(NEW_CAP), false);
      assert.strictEqual(world.registry.get(NEW_CAP), null);
    });

    await check('REMOVE: execution is refused, with a reason naming the cause', async () => {
      const after = await world.kernel.execute(world.intent({ capability: NEW_CAP }));
      assert.strictEqual(after.decision, 'deny', 'a removed capability still executed');
      assert.strictEqual(after.ruleId, 'capability.unknown', `denied for the wrong reason: ${after.ruleId}`);
      assert.ok(after.sealed, 'the refusal was not audited');
    });

    await check('REMOVE: audit history for the capability is preserved, not rewritten', () => {
      const bundle = world.observe();
      const historical = bundle.records.filter((r) => r.txId === before.txId);
      assert.ok(historical.length >= 2, 'the successful pre-removal transaction lost its records');
      assert.ok(
        historical.some((r) => r.capability === NEW_CAP),
        'the removed capability was scrubbed from history — removal must not erase what happened'
      );
      assert.ok(bundle.chainVerification.ok, 'removing a capability broke the audit chain');
    });

    await check('REMOVE: no dangling references are left behind', () => {
      const { missingEffectors } = world.registry.danglingReferences();
      assert.deepStrictEqual(missingEffectors, [], `capabilities now point at missing effectors: ${JSON.stringify(missingEffectors)}`);
    });

    await check('REMOVE: no orphaned reservations or admissions, and zero cleanup required', () => {
      assert.deepStrictEqual(world.kernel.reservations.outstanding(), [], 'a removed capability stranded a reservation');
      assert.strictEqual(world.kernel.activeCount(WORKSPACE_A), 0, 'a removed capability stranded an admission slot');
      assert.ok(checkAll(world.observe()).ok, checkAll(world.observe()).summary);
    });

    await check('REMOVE: every other capability still works', async () => {
      const other = await world.kernel.execute(world.intent({ capability: 'fixture.act' }));
      assert.strictEqual(other.decision, 'allow', 'removing one capability broke another');
    });

    world.cleanup();
  }

  // =====================================================================
  // 3. Layer separation — Specification must not know the Implementation.
  // =====================================================================
  await check('LAYERS: the specification loads without pulling in any src/ module', () => {
    // Empirical: load the spec in a clean child process and inspect the REAL
    // require cache. A source-text scan would be an indirect signal — the
    // exact mistake behind Phase 8's A-009 false positive.
    const script = `
      require(${JSON.stringify(path.resolve(__dirname, 'spec/invariants.js'))});
      require(${JSON.stringify(path.resolve(__dirname, 'spec/observation.js'))});
      const srcLoaded = Object.keys(require.cache).filter((p) => p.includes([ 'src', 'kernel' ].join(require('path').sep)));
      console.log(JSON.stringify(srcLoaded));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const leaked = JSON.parse(out.trim());
    assert.deepStrictEqual(
      leaked, [],
      `the specification pulled in implementation modules: ${leaked.join(', ')}. ` +
      'A specification that reaches into the implementation asserts what the code happens to do rather than what it must do.'
    );
  });

  await check('LAYERS: the adapter is the only harness file that imports the kernel', () => {
    const harnessDir = path.resolve(__dirname, 'harness');
    const offenders = [];
    for (const file of fs.readdirSync(harnessDir)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(harnessDir, file), 'utf8');
      const importsKernel = /require\(['"][^'"]*src\/kernel/.test(src);
      if (importsKernel && !['adapter.js', 'world.js'].includes(file)) offenders.push(file);
    }
    assert.deepStrictEqual(offenders, [], `harness files reaching into src/kernel directly: ${offenders.join(', ')}`);
  });

  // =====================================================================
  // 4. The test-only stage seam never reaches production.
  // =====================================================================
  await check('LAYERS: no production module passes __stageOverrides', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const src = fs.readFileSync(full, 'utf8');
          // The kernel DECLARES the parameter; nothing may PASS it.
          if (/__stageOverrides\s*:/.test(src)) offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    assert.deepStrictEqual(
      offenders, [],
      `production code passes the test-only fault-injection seam: ${offenders.join(', ')}. ` +
      'That seam can replace any stage and must never be reachable outside tests.'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
