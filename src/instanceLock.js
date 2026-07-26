// Additional failure mode — single-instance enforcement. Every store in
// this system assumes it's the only process writing to data/: atomic
// rename makes each individual write safe, but two processes both doing
// read-modify-write on the same JSON file can still race and silently drop
// one process's change (last writer wins, with no conflict detection —
// this system has no cross-process locking on individual files, by design,
// because it isn't meant to need it). A stale PID file left behind by a
// crash must not permanently lock the data dir out from a legitimate
// restart, so the lock is verified live, not just "does the file exist."

const fs = require('fs');
const path = require('path');

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0: existence check, doesn't actually signal
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by another user — still alive
  }
}

// Throws if another live process already holds the lock. Otherwise writes
// this process's PID and registers cleanup on exit.
function acquire(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.server.lock');

  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const existingPid = Number(raw);
    if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid && isProcessAlive(existingPid)) {
      throw new Error(
        `another Rucker Park process (pid ${existingPid}) already holds the lock on ${dataDir} — refusing to start a ` +
        `second instance against the same data directory, which is not safe (see docs/ARCHITECTURE.md)`
      );
    }
    // Stale lock (process no longer alive, or unreadable content) — safe to reclaim.
  }

  fs.writeFileSync(lockPath, String(process.pid));

  const release = () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      // Already gone, or owned by someone else now — nothing to do either way.
    }
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquire, isProcessAlive };
