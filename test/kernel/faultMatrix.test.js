// Phase 9 — the fault matrix: every stage × every fault.
//
// The cases are DERIVED from src/kernel/stages.js and the fault list, not
// hand-enumerated. Adding a stage to the kernel therefore adds seven fault
// cases automatically, with nobody remembering to write them. A hand-kept list
// is a second source of truth and drifts silently — the exact failure mode the
// route-coverage and audit-coverage contracts were built to eliminate in
// Phase 8.
//
// The requirement for every cell: whatever the injected failure, EVERY
// invariant still holds afterwards. Not "the call returned an error" — the
// system is left consistent. A kernel that fails a cell has a real defect.
//
// Run with: node test/kernel/faultMatrix.test.js

const assert = require('assert');

const { STAGE_IDS } = require('../../src/kernel/stages');
const { checkAll } = require('./spec/invariants');
const { buildWorld, WORKSPACE_A } = require('./harness/world');
const { FAULT_IDS, inject, makeBarrier } = require('./harness/faults');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.log(`NOT OK - ${name}\n    ${err.message}`);
  }
}

async function runCell(stageId, faultId) {
  const controller = new AbortController();
  // Two participants for the concurrency fault so the barrier releases.
  const barrier = makeBarrier(2);
  const overrides = inject(stageId, faultId, { controller, barrier });

  const world = buildWorld({ __stageOverrides: overrides });

  try {
    if (faultId === 'concurrent') {
      // Both transactions block at the faulted stage until both arrive, so the
      // overlap is guaranteed to occur exactly there.
      await Promise.all([
        world.kernel.execute(world.intent(), { signal: controller.signal }),
        world.kernel.execute(world.intent(), { signal: controller.signal }),
      ]);
    } else {
      await world.kernel.execute(world.intent(), { signal: controller.signal });
      await world.kernel.execute(world.intent({ capability: 'fixture.metered' }), { signal: controller.signal });
    }
  } catch (err) {
    // The kernel is not permitted to throw out of execute(); a fault must be
    // absorbed into a denied/failed transaction. Surfacing here IS a defect.
    return { world, threw: err };
  }
  return { world, threw: null };
}

(async () => {
  console.log(`fault matrix: ${STAGE_IDS.length} stages x ${FAULT_IDS.length} faults = ${STAGE_IDS.length * FAULT_IDS.length} cells\n`);

  for (const stageId of STAGE_IDS) {
    for (const faultId of FAULT_IDS) {
      const label = `${stageId} + ${faultId}`;
      const { world, threw } = await runCell(stageId, faultId);

      check(`${label}: execute() absorbs the fault instead of throwing`, () => {
        assert.strictEqual(
          threw, null,
          `kernel.execute() threw out to the caller: ${threw && threw.message}. A fault must become a denied or failed transaction, never an exception the caller has to know about.`
        );
      });

      check(`${label}: all invariants hold afterwards`, () => {
        const report = checkAll(world.observe());
        assert.ok(report.ok, report.summary);
      });

      world.cleanup();
    }
  }

  // A guard against the matrix silently shrinking to nothing: if the stage or
  // fault list were emptied, every check above would vacuously pass.
  check('the matrix is non-trivial', () => {
    assert.ok(STAGE_IDS.length >= 10, `expected at least 10 stages, got ${STAGE_IDS.length}`);
    assert.ok(FAULT_IDS.length === 7, `expected 7 fault kinds, got ${FAULT_IDS.length}`);
    assert.strictEqual(
      passed + failed, STAGE_IDS.length * FAULT_IDS.length * 2 + 0,
      'the number of executed checks does not match the matrix size — cells were skipped'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
