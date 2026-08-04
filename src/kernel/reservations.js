// Phase 9 — budget reservations.
//
// Fixes the read-then-act race in src/budget.js: assertWithinBudget() reads
// today's total, compares it to the cap, and returns, holding nothing. Two
// concurrent starts read the same total, both pass, and both run. Cost only
// lands at finishRun. At one operator with a handful of agents the overshoot
// is small; with event-driven wake across a fleet it is the difference
// between a cap and a suggestion.
//
// A reservation holds the ESTIMATED MAXIMUM cost between the check and the
// settle, so concurrent transactions see each other's holds.
//
// What this does NOT do, and what the docs must never claim it does: make the
// cap exact. Actual cost is only knowable after the call. A single call can
// still overshoot within its own estimate. Reservation converts an unbounded
// overshoot (N concurrent runs) into one bounded by a single estimate.

const crypto = require('crypto');

function createReservationLedger({ capUsd = null, spentUsd = 0 } = {}) {
  // reservationId -> { txId, amountUsd, createdAt, sessionId }
  const held = new Map();
  let settled = spentUsd;

  function heldTotal() {
    let sum = 0;
    for (const r of held.values()) sum += r.amountUsd;
    return sum;
  }

  function committed() {
    return settled;
  }

  function available() {
    if (capUsd === null) return Infinity;
    return capUsd - settled - heldTotal();
  }

  // Reserve or refuse. The check and the hold happen in the same synchronous
  // block with no await between them — that is the entire fix. Node's single
  // threaded execution makes this atomic against other transactions in this
  // process; it is NOT atomic against a second process, which is why the
  // instance lock (src/instanceLock.js) is load-bearing for this guarantee and
  // not merely a data-safety convenience.
  function reserve({ txId, sessionId, amountUsd }) {
    const amount = Number(amountUsd) || 0;
    if (capUsd !== null && amount > available()) {
      return {
        ok: false,
        reason: `budget cap reached: reserving $${amount.toFixed(4)} would exceed the remaining $${Math.max(0, available()).toFixed(4)}`,
      };
    }
    const reservationId = crypto.randomUUID();
    held.set(reservationId, { txId, sessionId, amountUsd: amount, createdAt: Date.now() });
    return { ok: true, reservationId, amountUsd: amount };
  }

  // Settle with the ACTUAL cost and release the hold. Called on success and on
  // failure alike — a failed transaction that consumed real provider tokens
  // still spent money, so `actualUsd` is whatever was really incurred, which
  // for most failures is zero but must not be ASSUMED zero.
  function settle(reservationId, actualUsd = 0) {
    const r = held.get(reservationId);
    if (!r) return { ok: false, reason: 'unknown or already-settled reservation' };
    held.delete(reservationId);
    settled += Number(actualUsd) || 0;
    return { ok: true, releasedUsd: r.amountUsd, chargedUsd: Number(actualUsd) || 0 };
  }

  // Boot-time recovery: a crash mid-session leaves holds that no live
  // transaction owns. Without this they leak budget permanently — the cap
  // silently shrinks every crash until nothing can run. Same shape as the
  // existing Phase 3.5 in-flight-run recovery.
  function releaseOrphans(liveTxIds = new Set()) {
    const released = [];
    for (const [id, r] of held.entries()) {
      if (!liveTxIds.has(r.txId)) {
        held.delete(id);
        released.push({ reservationId: id, txId: r.txId, amountUsd: r.amountUsd });
      }
    }
    return released;
  }

  // The observable the "no orphaned reservations" invariant reads. Deliberately
  // a snapshot of real ledger state rather than a counter the kernel maintains:
  // a counter would agree with the kernel's belief, which is precisely what the
  // invariant is trying to falsify.
  function outstanding() {
    return [...held.entries()].map(([reservationId, r]) => ({ reservationId, ...r }));
  }

  return { reserve, settle, releaseOrphans, outstanding, available, heldTotal, committed };
}

module.exports = { createReservationLedger };
