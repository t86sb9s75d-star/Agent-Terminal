const path = require('path');
const crypto = require('crypto');

const { createChainedLog } = require('./persistence/chainedLog');
const systemState = require('./systemState');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_IN_MEMORY = 500;

const recent = [];
let broadcast = () => {};
let log = null;

// Actor vocabulary (Phase 5.3). Every event now carries WHO/WHAT caused it
// in a structured, queryable form, replacing the old flat 'operator' string
// that made every action — human-initiated or automated — indistinguishable
// in the audit trail. This matters most for a system meant to eventually
// run unattended: an incident review needs to answer "did a human do this,
// or did something automated do this while nobody was watching," and the
// old schema could never answer that even in principle.
const ACTOR_TYPES = [
  // 'owner' is distinct from 'human_operator' on purpose: human_operator means
  // "arrived over HTTP without a client header", which a local curl also
  // satisfies. 'owner' means ownerAuth verified a token. Only the second is
  // evidence of authority (Slice 0).
  'owner',
  'human_operator', 'system', 'system_recovery', 'scheduler',
  'policy_engine', 'agent', 'security_monitor', 'api_client', 'migration',
];

function normalizeActor(actor) {
  if (typeof actor === 'string') {
    // Backward-compatible shim for any caller not yet migrated to the
    // structured shape — should not happen post-refactor, but fails safe.
    return { actorType: actor === 'operator' ? 'human_operator' : 'system', actorId: null, triggerType: null, requestId: null };
  }
  if (actor && typeof actor === 'object') {
    return {
      actorType: ACTOR_TYPES.includes(actor.actorType) ? actor.actorType : 'system',
      actorId: actor.actorId ?? null,
      triggerType: actor.triggerType ?? null,
      requestId: actor.requestId ?? null,
    };
  }
  return { actorType: 'system', actorId: null, triggerType: null, requestId: null };
}

function init(broadcastFn) {
  broadcast = broadcastFn;
  log = createChainedLog({ storeName: 'events', filePath: path.join(DATA_DIR, 'events.jsonl'), dataDir: DATA_DIR });
  log.backupNow();

  const verification = log.verify();
  if (!verification.ok) {
    systemState.markDegraded('events', 'chain_broken', {
      brokenAtIndex: verification.brokenAtIndex,
      truncatedTrailingLine: verification.truncatedTrailingLine,
    });
    // Deliberately not calling record() here — if the chain is broken, we
    // don't want the very first thing we do to be appending onto a chain
    // we just determined we can't trust. Surfaced via systemState/Security
    // UI instead; console as a last-resort operator-visible signal.
    // eslint-disable-next-line no-console
    console.error(`[eventLog] audit chain integrity check FAILED at record ${verification.brokenAtIndex} — see Security view.`);
  }

  const { records } = log.readAll();
  for (const event of records.slice(-MAX_IN_MEMORY)) recent.push(event);
}

function record({ actor, action, entityType, entityId, details, flagged = false, flagReason = null }) {
  const payload = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    actor: normalizeActor(actor),
    action,
    entityType,
    entityId,
    details: details || {},
    flagged,
    flagReason,
  };
  const event = log ? log.append(payload) : payload;
  recent.push(event);
  if (recent.length > MAX_IN_MEMORY) recent.shift();
  broadcast({ type: 'event', event });
  return event;
}

function list({ limit = 100, agentId = null } = {}) {
  let events = recent;
  if (agentId) events = events.filter((e) => e.entityId === agentId);
  return events.slice(-limit).reverse();
}

// Re-checks the on-disk chain on demand (Security view "verify now" action),
// independent of the in-memory `recent` buffer.
function verifyIntegrity() {
  if (!log) return { ok: true, recordCount: 0 };
  const result = log.verify();
  if (result.ok) systemState.clearDegraded('events');
  else systemState.markDegraded('events', 'chain_broken', { brokenAtIndex: result.brokenAtIndex });
  return result;
}

module.exports = { init, record, list, verifyIntegrity, ACTOR_TYPES };
