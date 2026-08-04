// Phase 9 — HARNESS LAYER: the adapter.
//
// The ONLY place that knows both a concrete kernel and the ObservationBundle
// shape. Every implementation detail the specification would otherwise have to
// know is absorbed here, so a change to how the kernel stores things is a
// change to this file alone.
//
// Everything below is read from an artifact:
//   records                  <- the log file, re-read from disk
//   chainVerification        <- re-hashing that file
//   outstandingReservations  <- the ledger's real holds, not a counter
//   effectorCalls            <- captured at the call boundary by the kernel,
//                               not self-reported by the effector
//   activeAdmissions         <- live admission counts
//
// Nothing here asks the kernel whether it thinks it behaved.

const { assertWellFormed } = require('../spec/observation');

function observe(kernel, { workspaces = [], grantedCapabilities = [], forbiddenCapabilities = [] } = {}) {
  const activeAdmissions = {};
  for (const ws of workspaces) activeAdmissions[ws] = kernel.activeCount(ws);

  return assertWellFormed({
    records: kernel.log.readAll(),
    chainVerification: kernel.log.verify(),
    outstandingReservations: kernel.reservations.outstanding(),
    effectorCalls: kernel.effectorCalls.map((c) => ({
      txId: c.txId,
      capability: c.capability,
      workspaceId: c.workspaceId,
      logSnapshotAtCall: c.logSnapshotAtCall,
    })),
    activeAdmissions,
    sealFailures: kernel.sealFailures.map((f) => f.txId),
    grantedCapabilities,
    forbiddenCapabilities,
  });
}

module.exports = { observe };
