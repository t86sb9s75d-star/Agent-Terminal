const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_IN_MEMORY = 500;

const recent = [];
let broadcast = () => {};

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
    action,
    entityType,
    entityId,
    details: details || {},
    flagged,
    flagReason,
  };
  recent.push(event);
  if (recent.length > MAX_IN_MEMORY) recent.shift();
  fs.appendFile(EVENTS_FILE, JSON.stringify(event) + '\n', () => {});
  broadcast({ type: 'event', event });
  return event;
}

function list({ limit = 100, agentId = null } = {}) {
  let events = recent;
  if (agentId) events = events.filter((e) => e.entityId === agentId);
  return events.slice(-limit).reverse();
}

module.exports = { init, record, list };
