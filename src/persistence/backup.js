// Rolling backup retention for critical JSON stores (Phase 3.3).
//
// Policy (documented, not just implemented — verified against real file
// contents in test/integration.test.js and by direct inspection: two
// writes in sequence, corrupt the primary file, restore_backup, confirm
// the SECOND write's content comes back, not the first):
//   - A backup is written immediately AFTER every successful atomic write
//     of a new version, capturing the version that was JUST written (not
//     the one it replaced) — see versionedStore.js's persist(). Backing up
//     the outgoing version instead would mean the most recently written
//     state is never itself backed up, so a corruption immediately after a
//     legitimate write could roll back further than the operator expects.
//     (This was an actual bug, caught and fixed before this comment was —
//     this file's header previously described the pre-fix, backwards
//     behavior even though the code had already been corrected.)
//   - Retention: current live file + up to `retainCount` (default 5) most
//     recent timestamped backups. Older ones are pruned automatically.
//   - Backups live in data/backups/<storeName>/ as
//     <storeName>.<ISO-timestamp>.json
//   - Restore is NEVER automatic during normal operation. It is only
//     attempted by the recovery path when the primary file is found
//     corrupt at startup (see versionedStore.js), and even then only a
//     backup that itself parses and passes the schema check is used.
//   - Restoring does not delete the corrupt file that triggered recovery —
//     see readJsonWithState's 'corrupt' handling in versionedStore.js,
//     which preserves it for operator inspection under a .corrupt-* name.

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync, ensureDir } = require('./atomicJsonFile');

const DEFAULT_RETAIN_COUNT = 5;

function backupDirFor(storeName, dataDir) {
  return path.join(dataDir, 'backups', storeName);
}

function writeBackup(storeName, dataDir, content, retainCount = DEFAULT_RETAIN_COUNT) {
  const dir = backupDirFor(storeName, dataDir);
  ensureDir(path.join(dir, 'x')); // ensureDir works off dirname(filePath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${storeName}.${timestamp}.json`);
  atomicWriteFileSync(backupPath, content);
  pruneBackups(storeName, dataDir, retainCount);
  return backupPath;
}

function listBackups(storeName, dataDir) {
  const dir = backupDirFor(storeName, dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${storeName}.`) && f.endsWith('.json'))
    .sort() // ISO timestamps sort chronologically as strings
    .map((f) => path.join(dir, f));
}

function pruneBackups(storeName, dataDir, retainCount) {
  const backups = listBackups(storeName, dataDir);
  const excess = backups.length - retainCount;
  if (excess <= 0) return;
  for (const oldPath of backups.slice(0, excess)) {
    try { fs.unlinkSync(oldPath); } catch {}
  }
}

// Returns the most recent backup that parses as valid JSON and passes the
// caller-supplied shape check, or null if none qualify. Never throws.
function findLatestValidBackup(storeName, dataDir, isValidShape) {
  const backups = listBackups(storeName, dataDir).reverse(); // newest first
  for (const backupPath of backups) {
    try {
      const raw = fs.readFileSync(backupPath, 'utf8');
      const data = JSON.parse(raw);
      if (!isValidShape || isValidShape(data)) {
        return { path: backupPath, raw, data };
      }
    } catch {
      // This backup is itself corrupt — skip it and try the next-oldest.
    }
  }
  return null;
}

module.exports = { writeBackup, listBackups, findLatestValidBackup, backupDirFor, DEFAULT_RETAIN_COUNT };
