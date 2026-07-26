// Append-only, hash-chained log (Phase 5.1). Used for the audit trail and
// (Phase 7) security events — anything where losing the ability to detect
// "a line was edited or deleted" would defeat the point of keeping the log
// at all.
//
// Each line is one JSON record plus `previousHash` (the chain hash of the
// line before it) and `recordHash` (hash of this record + previousHash).
// Deleting or editing any single line breaks the chain from that point
// forward — verify() reports exactly where, not just "something is wrong
// somewhere."
//
// This is NOT cryptographic proof against a fully privileged attacker who
// can recompute the whole chain from scratch (see docs/SECURITY_MODEL.md).
// It reliably catches anything that doesn't go through THIS module,
// including hand edits, unrelated bugs, and bad migrations.

const fs = require('fs');
const path = require('path');
const { ensureDir, cleanupStaleTempFiles } = require('./atomicJsonFile');
const { chainRecordHash, verifyChain } = require('./integrityChain');
const { writeBackup } = require('./backup');

function readAllLines(filePath) {
  if (!fs.existsSync(filePath)) return { records: [], truncatedTrailingLine: false };
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  let truncatedTrailingLine = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      // A partial trailing line is the expected shape of "process died mid-
      // append" — everything before it is still fully intact. A partial
      // line anywhere OTHER than the very end is a stronger corruption
      // signal, but either way we don't silently drop or hide it — we
      // report it and stop parsing further lines from that point.
      truncatedTrailingLine = i === lines.length - 1;
      break;
    }
  }
  return { records, truncatedTrailingLine };
}

function createChainedLog({ storeName, filePath, dataDir }) {
  ensureDir(filePath);
  cleanupStaleTempFiles(dataDir);

  function readAll() {
    return readAllLines(filePath);
  }

  function verify() {
    const { records, truncatedTrailingLine } = readAll();
    const brokenAtIndex = verifyChain(records);
    return { ok: brokenAtIndex === -1 && !truncatedTrailingLine, brokenAtIndex, truncatedTrailingLine, recordCount: records.length };
  }

  // Appends one record durably. Each append opens, writes, fsyncs, and
  // closes its own file descriptor — slower than buffering, but a crash
  // between appends can never corrupt anything already written, only
  // possibly leave the CURRENT append incomplete (caught by
  // truncatedTrailingLine above on next read).
  function append(payload) {
    const { records } = readAll();
    const previousHash = records.length > 0 ? records[records.length - 1].recordHash : null;
    const withoutHash = { ...payload, previousHash };
    const recordHash = chainRecordHash(withoutHash, previousHash);
    const record = { ...withoutHash, recordHash };
    const line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  // Coarser-grained than the snapshot stores' per-write backups (an
  // append-only log would be wasteful to fully re-copy on every single
  // append). Called at startup, capturing the state before this session's
  // new events are appended.
  function backupNow() {
    if (!fs.existsSync(filePath)) return null;
    try {
      return writeBackup(storeName, dataDir, fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  return { readAll, verify, append, backupNow };
}

module.exports = { createChainedLog, readAllLines };
