<<<<<<< HEAD
const path = require('path');
const crypto = require('crypto');

const { createChainedLog } = require('./persistence/chainedLog');
const systemState = require('./systemState');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
=======
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
>>>>>>> origin/main
const MAX_IN_MEMORY = 500;

const recent = [];
let broadcast = () => {};
<<<<<<< HEAD
let log = null;

// Actor vocabulary (Phase 5.3). Every event now carries WHO/WHAT caused it
// in a structured, queryable form, replacing the old flat 'operator' string
// that made every action — human-initiated or automated — indistinguishable
// in the audit trail. This matters most for a system meant to eventually
// run unattended: an incident review needs to answer "did a human do this,
// or did something automated do this while nobody was watching," and the
// old schema could never answer that even in principle.
const ACTOR_TYPES = [
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
=======

function init(broadcastFn) {
  broadcast = broadcastFn;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(EVENTS_FILE)) {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_IN_MEMORY)) {
      try {
        recent.push(JSON.parse(line));
      } catch {}
    }
  }
}

// actor: 'operator' (via the UI/API) or 'system' (background/automatic)
function record({ actor, action, entityType, entityId, details, flagged = false, flagReason = null }) {
  const event = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    actor,
>>>>>>> origin/main
    action,
    entityType,
    entityId,
    details: details || {},
    flagged,
    flagReason,
  };
<<<<<<< HEAD
  const event = log ? log.append(payload) : payload;
  recent.push(event);
  if (recent.length > MAX_IN_MEMORY) recent.shift();
=======
  recent.push(event);
  if (recent.length > MAX_IN_MEMORY) recent.shift();
  fs.appendFile(EVENTS_FILE, JSON.stringify(event) + '\n', () => {});
>>>>>>> origin/main
  broadcast({ type: 'event', event });
  return event;
}

function list({ limit = 100, agentId = null } = {}) {
  let events = recent;
  if (agentId) events = events.filter((e) => e.entityId === agentId);
  return events.slice(-limit).reverse();
}

<<<<<<< HEAD
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
=======
module.exports = { init, record, list };
>>>>>>> origin/main
