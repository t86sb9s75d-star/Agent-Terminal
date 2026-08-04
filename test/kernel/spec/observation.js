// Phase 9 — SPECIFICATION LAYER: the observation contract.
//
// This file, and spec/invariants.js beside it, must not require anything from
// src/. That is not a style preference — it is enforced empirically by
// test/kernel/layerSeparation.test.js, which loads this module in a child
// process and inspects the real require cache.
//
// The layering:
//
//   SPECIFICATION  (this directory)  — what must be true. Knows only the
//                                      ObservationBundle shape below.
//   HARNESS        (../harness)      — how to observe it. Adapts a concrete
//                                      kernel into an ObservationBundle, and
//                                      supplies faults, mutants, adversaries.
//   IMPLEMENTATION (src/kernel)      — the thing under test. Knows nothing
//                                      about either of the above.
//
// The separation matters because a specification that reaches into the
// implementation ends up asserting what the implementation happens to do,
// which is how a test comes to confirm a bug rather than catch it.

/**
 * ObservationBundle — everything the specification is allowed to look at.
 *
 * Every field must be independently observable. Notably absent: any field
 * reporting the kernel's own conclusion about whether it behaved correctly.
 *
 * @typedef {Object} ObservationBundle
 * @property {Array<Object>} records
 *   Every transaction log record, as read back FROM DISK. Not an in-memory
 *   mirror — the file is the artifact.
 * @property {{ok:boolean, brokenAtIndex:number, truncatedTrailingLine:boolean}} chainVerification
 *   Result of re-verifying the hash chain on disk.
 * @property {Array<{reservationId:string, txId:string, amountUsd:number}>} outstandingReservations
 *   Holds still open in the reservation ledger.
 * @property {Array<{txId:string, capability:string, workspaceId:string, logSnapshotAtCall:Array}>} effectorCalls
 *   Observed AT THE CALL BOUNDARY, so an effector cannot conceal that it ran,
 *   and carrying the log contents as they were at that instant, so ordering
 *   claims rest on disk state rather than on remembered stage order.
 * @property {Object<string, number>} activeAdmissions
 *   Admission slots currently held, per workspace.
 * @property {Array<string>} sealFailures
 *   txIds whose terminal seal could not be written. Distinguishes "the log
 *   broke and the kernel declared it" from "the kernel skipped sealing" — the
 *   second is a defect, the first is an environment failure that must be loud.
 * @property {Array<string>} grantedCapabilities
 *   What the scenario actually granted. The authorization INPUT — compared
 *   against effects, so a kernel cannot vouch for itself.
 * @property {Array<string>} forbiddenCapabilities
 *   Negative capabilities: registered, never granted, and required never to
 *   execute under any circumstance.
 */

// Field names the specification depends on. layerSeparation.test.js asserts
// the adapter produces exactly these, so a rename in the implementation
// surfaces as a failing contract rather than a silently empty invariant.
const REQUIRED_FIELDS = [
  'records',
  'chainVerification',
  'outstandingReservations',
  'effectorCalls',
  'activeAdmissions',
  'sealFailures',
  'grantedCapabilities',
  'forbiddenCapabilities',
];

function assertWellFormed(bundle) {
  const missing = REQUIRED_FIELDS.filter((f) => bundle[f] === undefined);
  if (missing.length > 0) {
    throw new Error(`ObservationBundle is missing required field(s): ${missing.join(', ')}`);
  }
  return bundle;
}

module.exports = { REQUIRED_FIELDS, assertWellFormed };
