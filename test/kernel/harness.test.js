// Phase 9 — THE HARNESS'S OWN ACCEPTANCE TEST.
//
// This is the test that makes every other kernel test worth reading. It
// proves the harness can DETECT failure, by running deliberately broken
// kernels and requiring each to be caught — on the specific invariant it was
// built to violate, and on no other.
//
// Without this, a green kernel suite would mean only "no invariant happened to
// fire", which is indistinguishable from "the invariants cannot fire." Phase 8
// produced three separate instances of exactly that (A-001: a test that could
// not fail; R-013: assertions equal to the defaults; R-016: a contract green
// for the wrong reason). A harness asserted to work is not a harness that
// works.
//
// Run with: node test/kernel/harness.test.js

const assert = require('assert');

const { checkAll, ALL_IDS } = require('./spec/invariants');
const { buildWorld } = require('./harness/world');
const { MUTANTS } = require('./harness/mutants');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`NOT OK - ${name}\n    ${err.message}`);
  }
}

async function runScenario(world, { intentOverride = {}, count = 2 } = {}) {
  for (let i = 0; i < count; i += 1) {
    await world.kernel.execute(world.intent(intentOverride));
  }
}

(async () => {
  // ---------------------------------------------------------------------
  // 1. Baseline: the CORRECT kernel satisfies every invariant.
  //
  // This runs first and is load-bearing in a way that is easy to miss: if the
  // baseline failed, every mutant would "be detected" for reasons having
  // nothing to do with the mutation, and the whole suite would be theatre.
  // ---------------------------------------------------------------------
  {
    const world = buildWorld();
    await runScenario(world, { count: 3 });
    await world.kernel.execute(world.intent({ capability: 'fixture.metered' }));
    const report = checkAll(world.observe());
    check('baseline: an unmutated kernel satisfies all 11 invariants', () => {
      assert.ok(report.ok, `baseline kernel violated invariants — every mutant result below is meaningless until this passes: ${report.summary}`);
    });
    world.cleanup();
  }

  // The negative capability, exercised properly. A first draft asserted on it
  // inside the block above, whose scenario never attempted it — the assertion
  // then failed with "it was never attempted, so nothing was proven", which is
  // the check correctly refusing to pass vacuously rather than an
  // implementation defect. Kept as a separate block so the attempt is explicit.
  {
    const world = buildWorld();
    const res = await world.kernel.execute(world.intent({ capability: 'fixture.forbidden' }));
    const report = checkAll(world.observe());
    check('negative capability: attempting it is denied, audited, and never executed', () => {
      assert.strictEqual(res.decision, 'deny', 'forbidden capability was not denied');
      assert.strictEqual(res.ruleId, 'fixture.forbidden_always', `denied by the wrong rule: ${res.ruleId}`);
      assert.ok(res.sealed, 'the denial was not sealed into the audit trail');
      assert.ok(report.ok, report.summary);
    });
    world.cleanup();
  }

  // ---------------------------------------------------------------------
  // 2. Every mutant is caught, on its own invariant and no other.
  // ---------------------------------------------------------------------
  for (const mutant of MUTANTS) {
    const box = {};
    const world = buildWorld({
      __stageOverrides: mutant.overrides(box),
      effectorBehavior: mutant.failingEffector
        ? async () => { throw new Error('effector failed'); }
        : null,
    });
    box.world = world;

    await runScenario(world, { intentOverride: mutant.intent || {}, count: 2 });
    if (mutant.postRun) mutant.postRun(world);

    const report = checkAll(world.observe());

    check(`mutant "${mutant.id}" is detected — ${mutant.description}`, () => {
      assert.ok(
        !report.ok,
        `MUTANT SURVIVED. The kernel was deliberately broken (${mutant.description}) and every invariant still passed. ` +
        `This means "${mutant.violates}" cannot fail and is providing no protection.`
      );
    });

    check(`mutant "${mutant.id}" trips exactly "${mutant.violates}" and nothing else`, () => {
      assert.deepStrictEqual(
        report.failedIds.slice().sort(),
        [mutant.violates],
        `expected only "${mutant.violates}" to fail, got [${report.failedIds.join(', ')}]. ` +
        `Overlapping invariants cannot be proven independent, and one can then mask another's blind spot.`
      );
    });

    world.cleanup();
  }

  // ---------------------------------------------------------------------
  // 3. Coverage contract: no invariant may exist without a mutant proving it
  //    can fail. An unproven invariant is decoration.
  // ---------------------------------------------------------------------
  check('every invariant has a mutant proving it can fail', () => {
    const proven = new Set(MUTANTS.map((m) => m.violates));
    const unproven = ALL_IDS.filter((id) => !proven.has(id));
    assert.deepStrictEqual(
      unproven, [],
      `these invariants have no mutant and are therefore unproven — they may be incapable of failing: ${unproven.join(', ')}`
    );
  });

  check('every mutant names a real invariant', () => {
    const known = new Set(ALL_IDS);
    const bogus = MUTANTS.filter((m) => !known.has(m.violates)).map((m) => `${m.id} -> ${m.violates}`);
    assert.deepStrictEqual(bogus, [], `mutants naming nonexistent invariants: ${bogus.join(', ')}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
