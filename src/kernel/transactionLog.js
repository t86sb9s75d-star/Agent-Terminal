// Phase 9 — the transaction log.
//
// Same chain format as events.jsonl (chainRecordHash / verifyChain), but a
// different write strategy, for a measured reason: persistence/chainedLog
// re-reads the whole file on every append to find the previous hash, which is
// O(n) per append and O(n^2) over a session. Measured in Phase 8: ~7.6ms per
// append at 1000 records, and rising. Audit events are operator-paced and can
// afford that; transactions are machine-paced — one per tool call, memory
// read, and loop iteration across a fleet — and cannot.
//
// This log keeps the chain head in memory and appends without re-reading. The
// on-disk format is byte-identical to the existing chained logs, so the same
// verifier proves the same property. The head is established by one full read
// at open, where the chain is also verified; if that verification fails the
// log opens SEALED and every append throws, because appending onto a chain
// you cannot trust manufactures the appearance of integrity.

const fs = require('fs');
const path = require('path');

const { chainRecordHash, verifyChain } = require('../persistence/integrityChain');
const { readAllLines } = require('../persistence/chainedLog');

function createTransactionLog({ filePath }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let headHash = null;
  let count = 0;
  let sealed = false;
  let sealReason = null;

  function open() {
    const { records, truncatedTrailingLine } = readAllLines(filePath);
    const brokenAtIndex = verifyChain(records);
    if (brokenAtIndex !== -1 || truncatedTrailingLine) {
      sealed = true;
      sealReason = brokenAtIndex !== -1 ? `chain broken at record ${brokenAtIndex}` : 'truncated trailing record';
      return { ok: false, reason: sealReason, recordCount: records.length };
    }
    headHash = records.length > 0 ? records[records.length - 1].recordHash : null;
    count = records.length;
    return { ok: true, recordCount: count };
  }

  function append(payload) {
    if (sealed) {
      // Fail-closed. The kernel turns this into a denied transaction: if it
      // cannot be recorded, it may not happen.
      const err = new Error(`transaction log is sealed (${sealReason}) — refusing to append`);
      err.code = 'LOG_SEALED';
      throw err;
    }
    const withoutHash = { ...payload, previousHash: headHash };
    const recordHash = chainRecordHash(withoutHash, headHash);
    const record = { ...withoutHash, recordHash };
    const line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Head advances only after the write is durable. If the write throws, the
    // in-memory head still matches what is actually on disk, so a caller that
    // catches and retries cannot fork the chain.
    headHash = recordHash;
    count += 1;
    return record;
  }

  function readAll() {
    return readAllLines(filePath).records;
  }

  function verify() {
    const { records, truncatedTrailingLine } = readAllLines(filePath);
    const brokenAtIndex = verifyChain(records);
    return {
      ok: brokenAtIndex === -1 && !truncatedTrailingLine,
      brokenAtIndex,
      truncatedTrailingLine,
      recordCount: records.length,
    };
  }

  function isSealed() {
    return sealed;
  }

  // Test/recovery affordance: re-open after the operator has repaired or
  // rotated the file. Deliberately explicit — there is no automatic unseal,
  // because "it started working again" must be an operator decision with an
  // audit trail, not a side effect of a retry.
  function reopen() {
    sealed = false;
    sealReason = null;
    headHash = null;
    count = 0;
    return open();
  }

  return { open, append, readAll, verify, isSealed, reopen, get length() { return count; } };
}

module.exports = { createTransactionLog };
