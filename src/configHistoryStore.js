// Phase 5.4 — narrow, append-only configuration version history. NOT full
// event sourcing: this only tracks agent configuration changes (created,
// edited, provider changed, command changed, workstream reassigned,
// archived/deleted), as a redacted before/after diff, so "what was this
// agent configured to do six months ago" is answerable even though the
// live agent record only holds its current state.
//
// If a field that can hold a secret is ever added to the agent schema
// (e.g. per-agent environment variables, per PHASE 4.1's future extension),
// its name MUST be added to REDACTED_FIELDS below before it ships — this
// history is retained indefinitely and is not access-controlled beyond
// whatever protects the rest of data/.

const path = require('path');
const { createVersionedStore } = require('./persistence/versionedStore');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;
const TRACKED_FIELDS = ['name', 'role', 'workstreamId', 'provider', 'model', 'systemPrompt', 'task', 'command', 'maxTokens'];
const REDACTED_FIELDS = new Set([]); // see module comment — add secret-bearing fields here before they ship

let store = null;
function getStore(onEvent) {
  if (!store) {
    store = createVersionedStore({
      storeName: 'config_history',
      filePath: path.join(DATA_DIR, 'config_history.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent,
    });
  }
  return store;
}

function redact(value, field) {
  return REDACTED_FIELDS.has(field) ? '[redacted]' : value;
}

function diffFields(before, after) {
  const diff = {};
  for (const field of TRACKED_FIELDS) {
    const beforeVal = before ? before[field] : undefined;
    const afterVal = after ? after[field] : undefined;
    if (beforeVal !== afterVal) {
      diff[field] = { from: redact(beforeVal, field), to: redact(afterVal, field) };
    }
  }
  return diff;
}

// action: 'created' | 'updated' | 'archived' | 'deleted' | 'workstream_reassigned'
function record({ agentId, action, actor, before, after }, onEvent) {
  const s = getStore(onEvent);
  const { records } = s.read();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    action,
    actor: actor || { actorType: 'system', actorId: null },
    changes: diffFields(before, after),
    ts: new Date().toISOString(),
  };
  s.write([...records, entry]);
  return entry;
}

function listForAgent(agentId, onEvent) {
  const s = getStore(onEvent);
  const { records } = s.read();
  return (records || []).filter((r) => r.agentId === agentId).sort((a, b) => b.ts.localeCompare(a.ts));
}

module.exports = { record, listForAgent, TRACKED_FIELDS };
