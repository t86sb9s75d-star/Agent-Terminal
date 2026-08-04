// Slice 0 — executable-agent → workspace + capability binding.
//
// This is the join that was never made (docs/PHASE9_ARCHITECTURE.md F3):
// permissions lived on catalog agents, which cannot execute; executable agents
// had neither permissions nor a workspace. Nothing was enforceable because
// there was nothing authoritative to read.
//
// FAIL CLOSED, per the operator's decision on legacy agents:
//   - no synthetic workspace is created
//   - authorization is NEVER inferred from workstreamId
//   - no authorization state is silently migrated
//   - an unbound agent is refused, with a specific reason, and the attempt is
//     audited
//   - binding requires an intentional, owner-authenticated action
//
// The temptation here was real and worth naming: `workstreamId` already exists
// on every executable agent, and mapping workstream→workspace would have made
// every legacy agent "just work". That mapping would be an authorization
// context nobody granted — precisely the unearned authority this phase exists
// to remove.

const path = require('path');

const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString } = require('./errors');
const { CAPABILITY_KEYS } = require('./permissions');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

let store = null;
let registeredOnEvent = null;

function getStore() {
  if (!store) {
    store = createVersionedStore({
      storeName: 'agent_bindings',
      filePath: path.join(DATA_DIR, 'agent_bindings.json'),
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      emptyValue: [],
      onEvent: registeredOnEvent,
    });
  }
  return store;
}

function init(onEvent) {
  registeredOnEvent = onEvent;
  store = null;
  getStore();
}

function readAll() {
  const { records, state } = getStore().read();
  if (state === 'corrupt') {
    // A degraded binding store must not degrade OPEN. If we cannot read who is
    // bound to what, nothing is bound as far as governed execution is
    // concerned.
    throw new AppError(Codes.STORE_DEGRADED, 'agent binding store is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function get(agentId) {
  const id = requireString(agentId, 'agentId');
  return readAll().find((b) => b.agentId === id) || null;
}

function list() {
  return readAll();
}

// Bind an executable agent to a workspace and an explicit capability set.
// The caller must already have proven owner authentication (server route);
// this refuses to record a binding with no owner actor, so a caller that
// skipped the check cannot produce a valid binding either.
function bind(agentId, { workspaceId, capabilities = [], actor }) {
  const id = requireString(agentId, 'agentId');
  const wsId = requireString(workspaceId, 'workspaceId');

  if (!actor || actor.actorType !== 'owner') {
    throw new AppError(Codes.UNAUTHORIZED, 'binding an agent to a workspace requires an authenticated owner', 401);
  }
  if (!Array.isArray(capabilities)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'capabilities must be an array of capability keys');
  }
  for (const cap of capabilities) {
    if (!CAPABILITY_KEYS.includes(cap)) {
      throw new AppError(Codes.VALIDATION_ERROR, `unknown capability: ${cap}`);
    }
  }

  const records = readAll();
  const idx = records.findIndex((b) => b.agentId === id);
  const now = new Date().toISOString();
  const row = {
    agentId: id,
    workspaceId: wsId,
    // An explicit grant. Empty is a legitimate, meaningful value: bound to a
    // workspace but permitted nothing — which is the correct starting posture
    // and is NOT the same as unbound.
    capabilities: [...new Set(capabilities)],
    boundBy: { actorType: actor.actorType, actorId: actor.actorId ?? null },
    boundAt: idx === -1 ? now : records[idx].boundAt,
    updatedAt: now,
  };
  if (idx === -1) records.push(row); else records[idx] = row;
  getStore().write(records);
  return row;
}

function unbind(agentId, { actor }) {
  const id = requireString(agentId, 'agentId');
  if (!actor || actor.actorType !== 'owner') {
    throw new AppError(Codes.UNAUTHORIZED, 'unbinding an agent requires an authenticated owner', 401);
  }
  const records = readAll();
  const idx = records.findIndex((b) => b.agentId === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  getStore().write(records);
  return removed;
}

// The authoritative governed-execution context for an agent, or a refusal.
//
// Returns { ok: false, code, reason } rather than throwing, because the caller
// needs to AUDIT the refusal before returning it — a thrown error tends to
// escape through a generic handler that records nothing.
function resolveContext(agentId) {
  const binding = get(agentId);
  if (!binding) {
    return {
      ok: false,
      code: Codes.GOVERNANCE_CONTEXT_MISSING,
      reason: `agent ${agentId} has no workspace binding — an owner must assign one before it can run under governance`,
      migrationPath: `POST /api/governance/agents/${agentId}/binding with an owner token, naming a workspaceId and the capabilities to grant`,
    };
  }
  return { ok: true, workspaceId: binding.workspaceId, capabilities: binding.capabilities, boundBy: binding.boundBy };
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, get, list, bind, unbind, resolveContext, recover };
