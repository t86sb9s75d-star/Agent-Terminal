// Feature Onboard — per-workspace agent settings.
//
// Agent DEFINITIONS are global (see agentCatalog.js); this store holds the
// per-workspace state for a catalog agent: whether it is enabled here, its
// permission grant, and any per-workspace configuration. That is why an
// Interview Agent is not duplicated into every workspace — one definition,
// many per-workspace settings rows keyed by (workspaceId, agentId).
//
// Permissions are stored through the shared permissions vocabulary and default
// to least authority (every consequential capability off) unless the operator
// widens them. The enforcement HONESTY rule lives in permissions.js: most of
// these are stored preferences, not yet gates, and the UI must say so.

const path = require('path');
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString } = require('./errors');
const { isValidCatalogAgent } = require('./agentCatalog');
const { defaultPermissionsFor, normalizePermissions } = require('./permissions');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'workspace_agent_settings',
      filePath: path.join(DATA_DIR, 'workspace_agent_settings.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent: registeredOnEvent,
    });
  }
  return versionedStore;
}

function init(onEvent) {
  registeredOnEvent = onEvent;
  versionedStore = null;
  getStore();
}

function readAll() {
  const { records, state } = getStore().read();
  if (state === 'corrupt') {
    throw new AppError(Codes.STORE_DEGRADED, 'workspace agent settings store is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

// config must be a plain object (a key/value bag), not an array or scalar —
// arrays would otherwise be accepted by a bare typeof check and stored as a
// config shape no caller expects.
function normalizeConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'config must be an object');
  }
  return config;
}
function writeAll(records) { getStore().write(records); }

// All settings rows for a workspace (scoped read).
function listForWorkspace(workspaceId) {
  const wsId = requireString(workspaceId, 'workspaceId');
  return readAll().filter((r) => r.workspaceId === wsId);
}

function getForWorkspace(workspaceId, agentId) {
  const wsId = requireString(workspaceId, 'workspaceId');
  return readAll().find((r) => r.workspaceId === wsId && r.agentId === agentId) || null;
}

// Create-or-update the settings row for (workspaceId, catalog agentId).
// Validates the agentId against the catalog and the permissions against the
// vocabulary; unknown capabilities or unknown agents are rejected rather than
// silently stored.
function upsert(workspaceId, agentId, { enabled, permissions, config, recommendedStage } = {}) {
  const wsId = requireString(workspaceId, 'workspaceId');
  if (!isValidCatalogAgent(agentId)) {
    throw new AppError(Codes.VALIDATION_ERROR, `unknown catalog agent: ${agentId}`);
  }
  const records = readAll();
  const idx = records.findIndex((r) => r.workspaceId === wsId && r.agentId === agentId);
  const existing = idx === -1 ? null : records[idx];
  const now = new Date().toISOString();

  const row = {
    workspaceId: wsId,
    agentId,
    enabled: enabled !== undefined ? Boolean(enabled) : (existing ? existing.enabled : false),
    // normalizePermissions rejects unknown keys, coerces to booleans, and
    // fills missing keys from the conservative least-authority default.
    permissions: permissions !== undefined
      ? normalizePermissions(permissions)
      : (existing ? existing.permissions : defaultPermissionsFor()),
    config: config !== undefined ? normalizeConfig(config) : (existing ? existing.config : {}),
    recommendedStage: recommendedStage !== undefined ? recommendedStage : (existing ? existing.recommendedStage : null),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };

  if (idx === -1) records.push(row); else records[idx] = row;
  writeAll(records);
  return row;
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, listForWorkspace, getForWorkspace, upsert, recover };
