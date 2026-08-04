// Feature Onboard — the business workspace registry.
//
// A workspace is one business, company, or major project (e.g. an apparel
// company, contractor software, a new idea). It is the PARENT of the existing
// Workstream concept: Workspace -> Workstream -> Agents -> Runs. Workstreams
// are unchanged; a workstream may later be attached to a workspace, but this
// store does not touch workstreams or agents, and nothing is auto-migrated —
// existing agents and workstreams stay unassigned until explicitly attached.
//
// Isolation here is workspace SEPARATION inside one trusted operator's
// installation, not security isolation between users. The store still enforces
// that a workspace name is present and its stage is valid, and every
// workspace-owned record elsewhere carries this workspace's id.
//
// Built on the same createVersionedStore seam as every other store (atomic
// writes, corruption/tamper detection, rotating backups, recovery) — no new
// persistence logic.

const path = require('path');
const crypto = require('crypto');

const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString, optionalDate } = require('./errors');
const { isValidStage, DEFAULT_STAGE } = require('./businessStages');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'workspaces',
      filePath: path.join(DATA_DIR, 'workspaces.json'),
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
    throw new AppError(Codes.STORE_DEGRADED, 'workspace registry is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function writeAll(workspaces) {
  getStore().write(workspaces);
}

function list() {
  return readAll();
}

function get(id) {
  return readAll().find((w) => w.id === id) || null;
}

// Existence assertion used by workspace-owned record stores so a record can
// never be filed under a workspace that doesn't exist (a dangling foreign
// reference). Throws WORKSTREAM_NOT_FOUND-style 404, but with a workspace code.
function assertExists(id) {
  if (!get(id)) {
    throw new AppError(Codes.WORKSPACE_NOT_FOUND, 'workspace not found', 404);
  }
}

function validateStage(stage, fallback) {
  if (stage === undefined) return fallback;
  if (!isValidStage(stage)) {
    throw new AppError(Codes.VALIDATION_ERROR, `stage must be a valid business stage`);
  }
  return stage;
}

// targetDate uses the shared optional-date contract (errors.optionalDate) —
// the same one goal.targetDate and assumption.reviewDate use. This used to be
// a local implementation, which is how the record stores came to have no date
// validation at all while this one did.
function validateTargetDate(value, fallback) {
  return optionalDate(value, 'targetDate', fallback);
}

function create(data) {
  const name = requireString(data.name, 'name');
  const stage = validateStage(data.stage, DEFAULT_STAGE);
  const targetDate = validateTargetDate(data.targetDate, null);
  const now = new Date().toISOString();
  const workspace = {
    id: crypto.randomUUID(),
    name,
    description: typeof data.description === 'string' ? data.description : '',
    stage,
    primaryGoal: typeof data.primaryGoal === 'string' ? data.primaryGoal : '',
    targetDate,
    ycEnabled: Boolean(data.ycEnabled),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const workspaces = readAll();
  workspaces.push(workspace);
  writeAll(workspaces);
  return workspace;
}

function update(id, data) {
  const workspaces = readAll();
  const idx = workspaces.findIndex((w) => w.id === id);
  if (idx === -1) throw new AppError(Codes.WORKSPACE_NOT_FOUND, 'workspace not found', 404);
  const existing = workspaces[idx];
  const updated = {
    ...existing,
    name: data.name !== undefined ? requireString(data.name, 'name') : existing.name,
    description: data.description !== undefined ? String(data.description) : existing.description,
    stage: validateStage(data.stage, existing.stage),
    primaryGoal: data.primaryGoal !== undefined ? String(data.primaryGoal) : existing.primaryGoal,
    targetDate: validateTargetDate(data.targetDate, existing.targetDate),
    ycEnabled: data.ycEnabled !== undefined ? Boolean(data.ycEnabled) : existing.ycEnabled,
    updatedAt: new Date().toISOString(),
  };
  workspaces[idx] = updated;
  writeAll(workspaces);
  return updated;
}

function setArchived(id, archived) {
  const workspaces = readAll();
  const idx = workspaces.findIndex((w) => w.id === id);
  if (idx === -1) throw new AppError(Codes.WORKSPACE_NOT_FOUND, 'workspace not found', 404);
  workspaces[idx].archived = Boolean(archived);
  workspaces[idx].updatedAt = new Date().toISOString();
  writeAll(workspaces);
  return workspaces[idx];
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, list, get, assertExists, create, update, setArchived, recover };
