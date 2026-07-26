// Low-level atomic file primitives shared by every store. Nothing in this
// module knows about agents/runs/workstreams — it only knows how to write a
// file without ever leaving it half-written, and how to tell "no file yet"
// apart from "a file that failed to parse."
//
// Write sequence (Phase 3.1):
//   1. serialize the caller's data (caller's job)
//   2. write to a temp file in the SAME directory as the target
//      (same filesystem is required for rename() to be atomic)
//   3. fsync the temp file's contents to disk
//   4. rename() the temp file over the target — atomic on POSIX filesystems
//   5. best-effort fsync the containing directory (durability of the rename
//      entry itself; skipped where the platform doesn't support it)
//
// A process killed at any point before step 4 completes leaves the ORIGINAL
// file completely untouched. A process killed during/after step 4 leaves
// either the old or the new file intact — never a half-written mix of both.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_PREFIX = '.tmp-';

function tempPathFor(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(dir, `${TEMP_PREFIX}${base}.${unique}`);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Writes `content` to `filePath` atomically. Throws on failure — callers
// must decide how to handle a write failure (e.g. disk full); this function
// never silently pretends a failed write succeeded, and never leaves the
// original file corrupted by a partial write.
function atomicWriteFileSync(filePath, content) {
  ensureDir(filePath);
  const tempPath = tempPathFor(filePath);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try {
      // Best-effort: durability of the rename entry itself. Not supported
      // on every platform/filesystem — failure here does not mean the
      // rename failed, so it is deliberately non-fatal.
      const dirFd = fs.openSync(path.dirname(filePath), 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      // Directory fsync isn't universally supported (e.g. some platforms/
      // filesystems reject opening a directory for fsync). The rename
      // itself already happened; this is a best-effort durability step.
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

// Read states, distinguished explicitly (Phase 3.2) so a corrupt file can
// never be mistaken for "no data yet":
//   'missing'  — file does not exist (legitimately a fresh install)
//   'empty'    — file exists and parses to an empty/default value
//   'populated'— file exists and parses to real data
//   'corrupt'  — file exists but is not valid JSON, or is valid JSON that
//                doesn't match the expected shape (caller-supplied check)
function readJsonWithState(filePath, { isEmpty, isValidShape } = {}) {
  if (!fs.existsSync(filePath)) {
    return { state: 'missing', data: null, raw: null };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', data: null, raw };
  }
  if (isValidShape && !isValidShape(data)) {
    return { state: 'corrupt', data: null, raw };
  }
  if (isEmpty && isEmpty(data)) {
    return { state: 'empty', data, raw };
  }
  return { state: 'populated', data, raw };
}

// Startup hygiene: a process killed mid-write (between opening the temp
// file and completing the rename) can leave an orphaned .tmp-* file behind.
// It was never renamed over anything, so the real data is safe — this just
// cleans up the litter. Only removes files matching our own temp naming
// convention, and only ones old enough that they can't be an in-progress
// write from another concurrently-starting process.
function cleanupStaleTempFiles(dir, { minAgeMs = 60_000 } = {}) {
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  const now = Date.now();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs >= minAgeMs) {
        fs.unlinkSync(fullPath);
        removed.push(entry);
      }
    } catch {
      // File disappeared between readdir and stat/unlink — fine, nothing to do.
    }
  }
  return removed;
}

module.exports = { atomicWriteFileSync, readJsonWithState, cleanupStaleTempFiles, ensureDir };
