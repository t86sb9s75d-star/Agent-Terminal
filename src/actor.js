// Phase 5.3 wiring — turns an incoming HTTP request into a structured actor
// object instead of the old flat 'operator' string. Rucker Park has exactly
// one human operator and no auth system yet, so this cannot (and does not
// try to) identify WHICH human — what it can honestly distinguish is HOW the
// action arrived: the browser dashboard vs. some other API caller vs. the
// system acting on its own (recovery, policy enforcement, etc). That
// distinction is what an incident review actually needs.
const crypto = require('crypto');

// The dashboard's own frontend sends this header (see public/app.js). Any
// other value, or its absence, means the request came from somewhere else —
// a script, curl, a future integration — which is worth knowing during an
// audit even though this system has no per-caller authentication yet.
const DASHBOARD_CLIENT_ID = 'rucker-dashboard';

function requestIdMiddleware(req, res, next) {
  req.requestId = req.get('X-Request-Id') || crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

function actorFromRequest(req) {
  const client = req.get('X-Rucker-Client');
  const actorType = client && client !== DASHBOARD_CLIENT_ID ? 'api_client' : 'human_operator';
  return {
    actorType,
    actorId: client || DASHBOARD_CLIENT_ID,
    triggerType: 'http_request',
    requestId: req.requestId || null,
  };
}

// Slice 0 — the OWNER actor.
//
// actorFromRequest() above returns 'human_operator' for any request that
// arrives without an X-Rucker-Client header — including a bare curl from a
// shell agent on the same host. That is fine for describing HOW a request
// arrived, which is all it ever claimed to do, but it must never be mistaken
// for proof of WHO sent it.
//
// This actor type is different: it is only ever produced here, and every call
// site is downstream of ownerAuth.assertOwner(). Governance writes require
// actorType === 'owner' specifically, so an unauthenticated caller cannot
// manufacture one even if it reaches the store function directly.
function ownerActor(req) {
  return {
    actorType: 'owner',
    actorId: 'owner',
    triggerType: 'authenticated_owner_action',
    requestId: (req && req.requestId) || null,
  };
}

const SYSTEM_ACTOR = { actorType: 'system', actorId: null, triggerType: 'boot', requestId: null };
const RECOVERY_ACTOR = { actorType: 'system_recovery', actorId: null, triggerType: 'boot', requestId: null };
const POLICY_ACTOR = { actorType: 'policy_engine', actorId: null, triggerType: 'enforcement', requestId: null };

module.exports = { requestIdMiddleware, actorFromRequest, ownerActor, SYSTEM_ACTOR, RECOVERY_ACTOR, POLICY_ACTOR, DASHBOARD_CLIENT_ID };
