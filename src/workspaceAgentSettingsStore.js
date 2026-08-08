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
const { defaultPermissionsFor, resolveEffectivePermissions, applyPermissionPatch } = require('./permissions');

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

// Do two permission maps describe the same authority?
//
// Compared over the UNION of keys, not one map's keys, so a row stored before
// a capability was added to the vocabulary is treated as differing from a map
// that names it — rather than comparing only the older, shorter key set and
// concluding nothing changed.
function samePermissions(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (Boolean(a && a[k]) !== Boolean(b && b[k])) return false;
  }
  return true;
}

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
// A-002 — permission lost update.
//
// THE DEFECT: this function used to REPLACE the stored permission map with
// whatever map the caller supplied. The frontend built that map by spreading a
// client-side snapshot, so two mutations derived from the same snapshot
// silently erased one another — measured: grant edit_files, then a stale grant
// of run_commands, and edit_files was back to false with a 200 OK.
//
// WHY A MERGE-PATCH ALONE IS NOT ENOUGH, and this is the load-bearing point:
// a stale caller that names every capability is asserting a value for every
// capability. The server cannot tell "stale false" from "deliberate false", so
// merging cannot rescue it. The authority has to be a CONFLICT CHECK, not a
// merge rule.
//
// THE AUTHORITATIVE BOUNDARY: every settings row carries a `revision`. A
// permission write must declare the revision it was derived from. A mismatch
// is an explicit 409 — never a silent overwrite. Non-permission fields
// (enabled/config) are unaffected, so the toggle path is untouched.
function upsert(workspaceId, agentId, { enabled, permissions, config, recommendedStage, expectedRevision } = {}) {
  const wsId = requireString(workspaceId, 'workspaceId');
  if (!isValidCatalogAgent(agentId)) {
    throw new AppError(Codes.VALIDATION_ERROR, `unknown catalog agent: ${agentId}`);
  }
  const records = readAll();
  const idx = records.findIndex((r) => r.workspaceId === wsId && r.agentId === agentId);
  const existing = idx === -1 ? null : records[idx];
  const now = new Date().toISOString();
  const currentRevision = existing ? (existing.revision || 0) : 0;

  // THE ONE effective-authority reading, used for the comparison below and as
  // the base the patch is applied to. Deriving it here rather than reading the
  // raw stored map is what keeps this path and GET .../agents in agreement
  // about what an old row means under the current vocabulary.
  const currentEffective = resolveEffectivePermissions(existing ? existing.permissions : null);

  // Vocabulary and value types BEFORE concurrency, deliberately. A caller who
  // misspells a capability or sends the string "false" has a bug in the
  // request, not a conflict with another writer; telling them "revision 3 is
  // current" would send them to re-read state that was never the problem and
  // retry forever. Both paths refuse the write, so ordering costs no safety —
  // it only decides which sentence the operator reads.
  const nextPermissions = permissions !== undefined
    ? applyPermissionPatch(permissions, currentEffective)
    : null;

  // Does this write actually change the granted authority? Keyed on the
  // resulting effective state, never on the request's shape — a patch that
  // re-states values already in force, or an empty patch, must not age another
  // client's snapshot. For an agent with no stored row the comparison base is
  // the least-authority default, which is exactly what GET already reported,
  // so creating the row is not itself an authority change.
  const permissionsChanged = nextPermissions !== null && !samePermissions(nextPermissions, currentEffective);

  // The conflict check. Read and write happen in this one synchronous block
  // with no await between them, so within this process the check-then-write is
  // atomic — which is why src/instanceLock.js is load-bearing here and not
  // merely a data-safety convenience.
  //
  // WHICH GUARD ACTUALLY ENFORCES THIS (measured by mutation, not assumed):
  // the equality check below is the whole enforcement. `undefined` and `null`
  // are never equal to a number, so a caller that omits the revision is
  // refused by it even with both checks above deleted — deleting the presence
  // check alone changes only the message (400 -> a different 400), and
  // deleting both only changes it to a 409. The two checks above are message
  // quality: they turn "computed against revision undefined" into a sentence
  // that names the fix. The mutation that actually reintroduces the defect is
  // making this whole block conditional on a revision having been supplied —
  // the "legacy compatibility" fallback — and that one is caught.
  //
  // The revision is scoped to this one (workspaceId, agentId) row. Widening
  // that scope to the workspace or to the agent is caught by the ISOLATION
  // cases in test/permissionConcurrency.test.js.
  if (permissions !== undefined) {
    if (expectedRevision === undefined || expectedRevision === null) {
      throw new AppError(
        Codes.VALIDATION_ERROR,
        'a permission write must declare expectedRevision (read it from GET .../agents). ' +
        'Writing without it would let a stale client silently overwrite newer state.'
      );
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new AppError(Codes.VALIDATION_ERROR, 'expectedRevision must be a non-negative integer');
    }
    if (expectedRevision !== currentRevision) {
      throw new AppError(
        Codes.PERMISSION_REVISION_CONFLICT,
        `this permission change was computed against revision ${expectedRevision}, but revision ` +
        `${currentRevision} is current — re-read the agent and reapply. Refusing rather than ` +
        'silently discarding the change that happened in between.',
        409
      );
    }
  }

  const row = {
    workspaceId: wsId,
    agentId,
    enabled: enabled !== undefined ? Boolean(enabled) : (existing ? existing.enabled : false),
    // Always a complete, resolved map for the CURRENT vocabulary: the patch
    // applied on top of the resolved current authority, or — when this write
    // does not touch permissions — the resolved current authority itself. That
    // second branch is what quietly drops a key the vocabulary no longer
    // defines instead of carrying it forward as ghost authority.
    permissions: nextPermissions !== null ? nextPermissions : currentEffective,
    config: config !== undefined ? normalizeConfig(config) : (existing ? existing.config : {}),
    recommendedStage: recommendedStage !== undefined ? recommendedStage : (existing ? existing.recommendedStage : null),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    // Advances only when the granted authority actually changes.
    //
    // Keyed on the RESULTING STATE, not on the request's shape. Advancing for
    // every permission-shaped write would let a request that changes nothing
    // age another client's snapshot: A and B both read revision R, A re-submits
    // the map already stored, and B's real change is then refused as stale by
    // an operation that granted and revoked nothing. Unrelated writes
    // (enabling an agent, editing config) never advance it either.
    revision: permissionsChanged ? currentRevision + 1 : currentRevision,
  };

  if (idx === -1) records.push(row); else records[idx] = row;
  writeAll(records);
  return row;
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, listForWorkspace, getForWorkspace, upsert, recover };
