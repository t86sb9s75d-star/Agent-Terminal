// Tamper-evidence primitives (Phase 5.1), generalized from the
// agents-only hash check that existed before this phase, and extended to
// every critical store: agents, runs, workstreams, and the audit log
// itself. Previously only agents.json was protected — runs.json,
// workstreams.json, and events.jsonl could be edited directly on disk with
// zero detection. That gap is closed here.
//
// Two shapes, because the two kinds of store are structurally different:
//
// 1. Snapshot stores (agents/runs/workstreams) are whole-file-replaced on
//    every write. Their integrity record is a small sidecar file tracking
//    {version, previousHash, currentHash, updatedAt} — "does the file's
//    actual content match the hash we recorded the last time WE wrote it."
//
// 2. The append-only audit log chains hash-of-record-N into record N+1's
//    `previousHash` field, so deleting or editing any single record breaks
//    the chain at that point and every subsequent record fails to verify —
//    not just "the last write doesn't match," but "here is exactly where
//    history stopped being trustworthy."
//
// Honesty note: this detects tampering by anything that doesn't go through
// this module (a hand edit, a bug in unrelated code, a bad migration). It
// does NOT cryptographically prevent a sufficiently privileged local
// attacker from recomputing a valid-looking chain from scratch — that
// requires a boundary this single-process, filesystem-trusting
// architecture does not have (see docs/SECURITY_MODEL.md). What it reliably
// catches is anything that isn't a deliberate, chain-aware forgery.

const fs = require('fs');
const crypto = require('crypto');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------- Snapshot stores (agents/runs/workstreams) ----------------

function readHashRecord(hashFilePath) {
  if (!fs.existsSync(hashFilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(hashFilePath, 'utf8'));
  } catch {
    // The hash record itself is corrupt. Treat as "no prior known-good
    // record" rather than crashing — the next write re-establishes one.
    return null;
  }
}

// Returns:
//   { checked: false, tampered: false }                — first run, no prior record
//   { checked: true, tampered: false }                  — matches last known-good
//   { checked: true, tampered: true, expected, actual } — mismatch
function checkSnapshotIntegrity(hashFilePath, currentContent) {
  const actual = sha256(currentContent);
  const record = readHashRecord(hashFilePath);
  if (!record) return { checked: false, tampered: false, actual };
  if (record.currentHash !== actual) {
    return { checked: true, tampered: true, expected: record.currentHash, actual };
  }
  return { checked: true, tampered: false, actual };
}

// Call this after a successful write. Chains the new hash onto the old one
// so the record carries its own short history, not just a single value.
function recordSnapshotHash(hashFilePath, newContent, { atomicWrite } = {}) {
  const prior = readHashRecord(hashFilePath);
  const record = {
    version: (prior?.version || 0) + 1,
    previousHash: prior?.currentHash || null,
    currentHash: sha256(newContent),
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(record, null, 2);
  if (atomicWrite) atomicWrite(hashFilePath, serialized);
  else fs.writeFileSync(hashFilePath, serialized, 'utf8');
  return record;
}

// ---------------- Append-only chained log (audit events) ----------------

// Deterministic hash of one record's meaningful content plus the hash of
// whatever came before it. Excludes the record's own `recordHash` field
// (which doesn't exist yet when this is computed).
function chainRecordHash(recordWithoutHash, previousHash) {
  const canonical = JSON.stringify({ ...recordWithoutHash, previousHash: previousHash || null });
  return sha256(canonical);
}

// Verifies an in-order array of chained records. Returns the index of the
// first break (or -1 if the whole chain verifies), so callers can report
// exactly where trust stops rather than a single "something is wrong."
function verifyChain(records) {
  let previousHash = null;
  for (let i = 0; i < records.length; i++) {
    const { recordHash, ...rest } = records[i];
    const expected = chainRecordHash(rest, previousHash);
    if (rest.previousHash !== previousHash || recordHash !== expected) {
      return i;
    }
    previousHash = recordHash;
  }
  return -1;
}

module.exports = {
  sha256,
  checkSnapshotIntegrity,
  recordSnapshotHash,
  chainRecordHash,
  verifyChain,
};
