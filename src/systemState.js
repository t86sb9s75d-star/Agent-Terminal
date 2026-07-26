// Cross-cutting system health state: which subsystems (if any) are
// currently degraded and why. This is what Command/Security surface, and
// what mutating routes check before allowing writes against a store whose
// integrity could not be confirmed.
//
// A subsystem enters degraded state when its store is found corrupt at
// startup with no valid backup to recover from, or when tampering is
// detected and NOT automatically accepted (Phase 5.2 — tampering is never
// silently re-baselined; it stays flagged until an operator explicitly
// resolves it via the recovery endpoint).

const degraded = new Map(); // subsystem -> { reason, detail, since }

function markDegraded(subsystem, reason, detail = {}) {
  if (!degraded.has(subsystem)) {
    degraded.set(subsystem, { reason, detail, since: new Date().toISOString() });
  }
  return degraded.get(subsystem);
}

function clearDegraded(subsystem) {
  degraded.delete(subsystem);
}

function isDegraded(subsystem) {
  return degraded.has(subsystem);
}

function getDegraded(subsystem) {
  return degraded.get(subsystem) || null;
}

function listDegraded() {
  return [...degraded.entries()].map(([subsystem, info]) => ({ subsystem, ...info }));
}

function isSystemHealthy() {
  return degraded.size === 0;
}

module.exports = { markDegraded, clearDegraded, isDegraded, getDegraded, listDegraded, isSystemHealthy };
