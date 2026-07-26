const path = require('path');
const crypto = require('crypto');

const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString, optionalString } = require('./errors');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;
const VALID_PROVIDERS = ['anthropic', 'openai', 'custom'];

let versionedStore = null;
function getStore(onEvent) {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'agents',
      filePath: path.join(DATA_DIR, 'agents.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent,
    });
  }
  return versionedStore;
}

// Optional: callers (server.js) can register the audit emitter once at
// startup so corruption/tamper events discovered on any later read get
// recorded, not just the ones discovered at boot.
let registeredOnEvent = null;
function init(onEvent) {
  registeredOnEvent = onEvent;
  versionedStore = null; // force re-creation with the emitter wired in
  getStore(onEvent);
}

function readAll() {
  const { records, state } = getStore(registeredOnEvent).read();
  if (state === 'corrupt') {
    throw new AppError(Codes.STORE_DEGRADED, 'agent registry is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function writeAll(agents) {
  getStore(registeredOnEvent).write(agents);
}

// Preserved for compatibility with the pre-Phase-5 boot check in server.js.
// Integrity is now checked on every read (see versionedStore), not just once
// at boot, and tampering is never auto-accepted — this just surfaces the
// current state for a one-time startup log line.
function checkIntegrity() {
  const systemState = require('./systemState');
  try {
    readAll();
  } catch {
    return { checked: true, tampered: false, degraded: true };
  }
  const degraded = systemState.getDegraded('agents');
  return { checked: true, tampered: degraded?.reason === 'tampered', degraded: Boolean(degraded) };
}

function list() {
  return readAll();
}

function get(id) {
  return readAll().find((a) => a.id === id) || null;
}

function assertWorkstreamExists(workstreamId) {
  if (!workstreamId) return;
  // Required lazily to avoid a module-load-order dependency; workstreamsStore
  // itself never requires store.js, so this isn't circular, just deferred.
  const workstreamsStore = require('./workstreamsStore');
  const ws = workstreamsStore.get(workstreamId);
  if (!ws) {
    throw new AppError(Codes.WORKSTREAM_NOT_FOUND, 'the selected workstream does not exist', 400);
  }
}

// Phase 6.2 wiring — an archived workstream is a closed objective; assigning
// a new agent to it would let "finished" work quietly grow again with no
// visible signal that it's not actually closed.
function assertNotArchived(workstreamId) {
  if (!workstreamId) return;
  const workstreamsStore = require('./workstreamsStore');
  workstreamsStore.assertNotArchived(workstreamId);
}

function validateAgentShape(data, { partial }) {
  if (!partial || data.provider !== undefined) {
    const provider = partial ? data.provider : data.provider;
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new AppError(Codes.VALIDATION_ERROR, `provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
    }
  }
}

function create(data) {
  if (typeof data !== 'object' || data === null) {
    throw new AppError(Codes.VALIDATION_ERROR, 'request body must be an object');
  }
  const name = requireString(data.name, 'name');
  if (!VALID_PROVIDERS.includes(data.provider)) {
    throw new AppError(Codes.VALIDATION_ERROR, `provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  if (data.provider === 'custom' && !optionalString(data.command, 'command')) {
    throw new AppError(Codes.VALIDATION_ERROR, 'command is required for custom agents');
  }
  if (data.provider !== 'custom' && !optionalString(data.task, 'task')) {
    throw new AppError(Codes.VALIDATION_ERROR, 'task is required for anthropic/openai agents');
  }
  const role = optionalString(data.role, 'role');
  const workstreamId = data.workstreamId || null;
  assertWorkstreamExists(workstreamId);
  assertNotArchived(workstreamId);

  const agents = readAll();
  const agent = {
    id: crypto.randomUUID(),
    name,
    role: role ? role.trim() : '',
    provider: data.provider,
    model: data.model || null,
    systemPrompt: data.systemPrompt || '',
    task: data.task || '',
    command: data.command || '',
    maxTokens: data.maxTokens ? Number(data.maxTokens) : 1024,
    workstreamId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  agents.push(agent);
  writeAll(agents);
  return agent;
}

function update(id, data) {
  if (typeof data !== 'object' || data === null) {
    throw new AppError(Codes.VALIDATION_ERROR, 'request body must be an object');
  }
  const agents = readAll();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
  const existing = agents[idx];

  const name = data.name !== undefined ? requireString(data.name, 'name') : existing.name;
  const role = data.role !== undefined ? optionalString(data.role, 'role') : existing.role;
  const provider = data.provider !== undefined ? data.provider : existing.provider;
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new AppError(Codes.VALIDATION_ERROR, `provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  const workstreamId = data.workstreamId !== undefined ? (data.workstreamId || null) : existing.workstreamId;
  if (data.workstreamId !== undefined && workstreamId !== existing.workstreamId) {
    assertWorkstreamExists(workstreamId);
    assertNotArchived(workstreamId); // moving INTO an archived workstream is blocked; leaving one is always fine
  }

  const updated = {
    ...existing,
    name,
    role: role !== undefined ? (typeof role === 'string' ? role.trim() : role) : existing.role,
    provider,
    model: data.model !== undefined ? data.model : existing.model,
    systemPrompt: data.systemPrompt !== undefined ? data.systemPrompt : existing.systemPrompt,
    task: data.task !== undefined ? data.task : existing.task,
    command: data.command !== undefined ? data.command : existing.command,
    maxTokens: data.maxTokens !== undefined ? Number(data.maxTokens) : existing.maxTokens,
    workstreamId,
    updatedAt: new Date().toISOString(),
  };
  agents[idx] = updated;
  writeAll(agents);
  return { before: existing, after: updated };
}

function remove(id) {
  const agents = readAll();
  const existing = agents.find((a) => a.id === id);
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
  writeAll(next);
  return existing;
}

module.exports = { init, list, get, create, update, remove, checkIntegrity, VALID_PROVIDERS };
