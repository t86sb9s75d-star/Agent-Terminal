// Slice 0 — owner authentication for governance actions.
//
// THE HOLE THIS CLOSES (docs/PHASE9_ARCHITECTURE.md §16-B): the server binds
// loopback with no authentication, and `custom` provider agents get a real
// shell with PATH. An agent could therefore `curl` the admin API of its own
// host and amend the very rules meant to constrain it. The env allowlist in
// workers/custom.js — a good control that stopped agents reading
// ANTHROPIC_API_KEY — does not help here, because the admin API needed no
// credential at all.
//
// SCOPE, stated precisely so nobody reads more into this than it does:
// this protects GOVERNANCE STATE — the root Constitution and executable-agent
// bindings. Ordinary product CRUD (agents, workstreams, workspace records)
// remains unauthenticated exactly as before. That is a deliberate Slice 0
// boundary, not an oversight, and it is recorded in the limitations.
//
// WHY A PER-BOOT TOKEN rather than a password or a session: there is one
// operator, no user store, and no password to verify against. A random token
// minted at boot and never persisted in a form the agent environment can read
// gives a real authentication boundary with no user-management machinery. It
// is deliberately NOT added to workers/custom.js ALLOWED_ENV_VARS — that list
// is an allowlist, so the protection here is that nobody adds it, and a test
// asserts nobody has.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { AppError, Codes } = require('./errors');

let activeToken = null;
let tokenSource = null;

// Timing-safe comparison. `crypto.timingSafeEqual` throws on length mismatch,
// which would itself leak length through the error path, so both sides are
// hashed to a fixed width first.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Establishes the token for this process. Env-supplied wins so an operator can
// pin one across restarts; otherwise a fresh one is minted per boot.
function init(dataDir, { log = console } = {}) {
  const fromEnv = process.env.RUCKER_OWNER_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    activeToken = fromEnv.trim();
    tokenSource = 'env';
  } else {
    activeToken = crypto.randomBytes(32).toString('hex');
    tokenSource = 'generated';
  }

  // Written 0600 so the operator can read it back without it being ambient in
  // any process environment. An agent that can already read arbitrary files as
  // this user is outside what an in-process control can defend against — that
  // limit is documented rather than papered over.
  const tokenPath = path.join(dataDir, '.owner-token');
  try {
    fs.writeFileSync(tokenPath, activeToken, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600); // in case the file already existed with looser bits
  } catch {
    // Non-fatal: the token still works in memory for this process.
  }

  if (tokenSource === 'generated' && log && typeof log.error === 'function') {
    log.error(`[owner] governance actions require this token this session: ${activeToken}`);
    log.error(`[owner] also written to ${tokenPath} (mode 0600)`);
  }
  return { tokenPath, source: tokenSource };
}

function currentToken() {
  return activeToken;
}

// Extracts a presented token. Header only — deliberately NOT a query parameter,
// which would land in access logs and browser history.
function presentedToken(req) {
  const header = req.get ? req.get('x-rucker-owner-token') : (req.headers && req.headers['x-rucker-owner-token']);
  if (header) return String(header);
  const auth = req.get ? req.get('authorization') : (req.headers && req.headers.authorization);
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

// Throws AppError(401) unless the caller presents the owner token.
//
// Fails CLOSED if no token was ever established: an uninitialised auth module
// must refuse everything, not allow everything. That direction matters — the
// opposite default turns a boot-order bug into an open admin API.
function assertOwner(req) {
  if (!activeToken) {
    throw new AppError(Codes.UNAUTHORIZED, 'owner authentication is not initialised — refusing governance action', 401);
  }
  const presented = presentedToken(req);
  if (!presented || !tokensMatch(presented, activeToken)) {
    throw new AppError(Codes.UNAUTHORIZED, 'this action requires owner authentication', 401);
  }
  return true;
}

function isOwner(req) {
  try {
    assertOwner(req);
    return true;
  } catch {
    return false;
  }
}

// Test-only reset so a suite can simulate an uninitialised process.
function __resetForTests() {
  activeToken = null;
  tokenSource = null;
}

module.exports = { init, assertOwner, isOwner, currentToken, presentedToken, __resetForTests };
