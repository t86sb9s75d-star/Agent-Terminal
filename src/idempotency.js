// Phase 8.2 — idempotency keys. A client (the dashboard on a flaky
// connection, or a future automated caller) that times out waiting for a
// response has no way to know whether the request actually landed. Retrying
// blindly is exactly how a "start this agent" click becomes two runs, or a
// "create this agent" submit becomes two agents. An `Idempotency-Key`
// header lets the retry ask for "the result of that same request," not "do
// it again."
//
// In-memory only — a duplicate request during the brief window right after
// a crash and before restart is a smaller, better-understood risk than the
// cross-process coordination a persisted idempotency store would need, and
// this system is single-instance by design (see instanceLock.js).
//
// Each cache entry is keyed by (method, path, key); the request's payload
// hash is stored on that entry and checked on lookup, not folded into the
// key itself. Without that check, a client that reused an Idempotency-Key
// value with a genuinely DIFFERENT body (a stale key left over from a
// previous form, a UUID collision, a client bug) would silently get back
// the FIRST request's response instead of either executing the new
// request or being told the key was reused incompatibly — a real
// correctness hazard, not just a missed optimization: the client would
// see a 201 and believe ITS payload was what got created. Reusing the
// same key with the SAME payload still replays cleanly; reusing it with
// a DIFFERENT payload is now a clear 409 IDEMPOTENCY_CONFLICT.

const crypto = require('crypto');
const { AppError, Codes } = require('./errors');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — long enough to cover realistic retry/backoff windows
const MAX_ENTRIES = 1000; // bound memory growth; oldest entries evicted first

const cache = new Map(); // `${method} ${path} ${key}` -> { status, body, storedAt, payloadHash }

function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.storedAt > CACHE_TTL_MS) cache.delete(k);
  }
}

function hashPayload(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

function idempotencyMiddleware(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key || req.method === 'GET' || req.method === 'HEAD') return next();

  pruneExpired();
  const cacheKey = `${req.method} ${req.path} ${key}`;
  const payloadHash = hashPayload(req.body);
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.payloadHash !== payloadHash) {
      const err = new AppError(
        Codes.IDEMPOTENCY_CONFLICT,
        'this Idempotency-Key was already used with a different request body',
        409
      );
      return res.status(err.status).json({ error: err.message, code: err.code, requestId: req.requestId || null });
    }
    res.set('Idempotent-Replay', 'true');
    return res.status(cached.status).json(cached.body);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) { // don't cache transient server errors — a retry SHOULD re-attempt those
      if (cache.size >= MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
      cache.set(cacheKey, { status: res.statusCode, body, storedAt: Date.now(), payloadHash });
    }
    return originalJson(body);
  };
  next();
}

module.exports = { idempotencyMiddleware };
