// Feature Onboard — HTTP API surface.
//
// Kept in its own module (registered onto the app by server.js) rather than
// inlined, because it adds a large, self-contained set of routes and server.js
// is already sizeable. Everything here follows the existing conventions:
// stable AppError codes via the shared sendError, structured actors via
// actorFromRequest, and an audit event on every meaningful mutation.
//
// The load-bearing rule enforced here: every workspace-scoped route resolves
// and validates its :workspaceId FIRST (requireWorkspace), returns 404 for an
// unknown workspace, and the underlying stores additionally key every record
// operation on (workspaceId, id) — so the API can never read or mutate one
// workspace's data under another's id. Progress is always computed
// server-side; a client-supplied progress/total is never trusted.

const workspacesStore = require('./workspacesStore');
const records = require('./workspaceRecordsStore');
const founderProfile = require('./founderProfileStore');
const onboarding = require('./onboardingStore');
const yc = require('./ycStore');
const agentSettings = require('./workspaceAgentSettingsStore');
const { STAGES } = require('./businessStages');
const { CATALOG, STAGE_RECOMMENDATIONS, recommendationsForStage } = require('./agentCatalog');
const { CAPABILITIES, RUNTIME_ENFORCEMENT_SUMMARY, resolveEffectivePermissions, diffPermissions } = require('./permissions');
const { workspaceProgress } = require('./progress');
const { AppError, Codes } = require('./errors');
const { isDeepStrictEqual } = require('node:util');
const { sha256 } = require('./persistence/integrityChain');

// Aggregate every milestone across every goal in a workspace into one
// deterministic progress number (see progress.workspaceProgress). Null when
// there are no milestones yet — never a fabricated 0. Computed here, never
// read from the client.
function progressFromGoals(goals) {
  return workspaceProgress((goals || []).flatMap((g) => g.milestones || []));
}

function decorateWorkspace(ws) {
  return { ...ws, progress: progressFromGoals(records.goals.listForWorkspace(ws.id)) };
}

// The list endpoint's decorator. Reads the goals store ONCE for the whole
// request and groups it, instead of calling listForWorkspace() per workspace.
//
// This is not a latency optimization. Every versionedStore.read() is an
// integrity checkpoint that emits an audit event and a Sentinel finding when
// the file has been tampered with, so a per-workspace read turned one
// out-of-band edit into N identical critical findings per page load, growing
// without bound (R-006). Fixing it here stops the duplicates being generated;
// deduplicating them in Sentinel instead would have suppressed a real signal
// rather than stopped manufacturing it.
function decorateWorkspaces(workspaces) {
  const goalsByWorkspace = records.goals.groupByWorkspace();
  return workspaces.map((ws) => ({ ...ws, progress: progressFromGoals(goalsByWorkspace[ws.id]) }));
}

// THE AUDIT SIDE OF THE WRITE CONTRACT.
//
// One declaration, not two. These keys ARE the set of dimensions this route
// claims to audit — there is no separate hand-maintained list to drift from,
// and assertAuditCoversWriteContract below checks this map against the store's
// declared semantic dimensions by SET EQUALITY in both directions.
//
// Each detector answers one question about the ACCEPTED TRANSITION: did this
// dimension move between the persisted before and the persisted after? The
// emission guard is derived from these, so a dimension cannot be dropped from
// the condition while still appearing in the map.
const CHANGE_DETECTORS = Object.freeze({
  permissions: (c) => c.delta.changed,
  enabled: (c) => c.enabledChanged,
  config: (c) => c.configChanged,
  recommendedStage: (c) => c.stageChanged,
});

// Fail closed at ROUTE REGISTRATION — the server refuses to boot rather than
// serving writes whose audit coverage is incomplete. Checked in both
// directions: an uncovered dimension is the defect that produced three separate
// findings in this PR; a phantom detector means the route believes it audits
// something the store no longer persists, which would make the completeness
// claim false in the other direction.
function assertAuditCoversWriteContract(audited, semantic) {
  const a = [...audited].sort();
  const s = [...semantic].sort();
  const uncovered = s.filter((k) => !a.includes(k));
  const phantom = a.filter((k) => !s.includes(k));
  if (uncovered.length > 0 || phantom.length > 0) {
    const parts = [];
    if (uncovered.length > 0) {
      parts.push(
        'the settings write can persist semantic dimension(s) the audit contract does not cover: ' +
        `${uncovered.join(', ')} — a change to those would be an accepted state transition with no ` +
        'audit record. Add a detector to CHANGE_DETECTORS and decide what evidence the event carries.'
      );
    }
    if (phantom.length > 0) {
      parts.push(
        'the audit contract claims dimension(s) the write contract does not declare semantic: ' +
        `${phantom.join(', ')} — remove the detector, or fix the classification in WRITE_CONTRACT.`
      );
    }
    throw new Error(`workspace_agent.updated audit contract is incomplete: ${parts.join(' ALSO ')}`);
  }
}

function registerFeatureOnboardRoutes(app, { eventLog, actorFromRequest, sendError }) {
  // Before a single route is mounted. An incomplete audit contract is a boot
  // failure, not a runtime surprise on whichever write happens to hit it first.
  assertAuditCoversWriteContract(Object.keys(CHANGE_DETECTORS), agentSettings.SEMANTIC_DIMENSIONS);

  const audit = (req, event) => eventLog.record({ actor: actorFromRequest(req), ...event });

  // Resolve and validate :workspaceId. Throws 404 for an unknown workspace,
  // so no downstream handler ever operates on a non-existent one.
  function requireWorkspace(req) {
    const id = req.params.workspaceId;
    workspacesStore.assertExists(id); // throws WORKSPACE_NOT_FOUND (404)
    return id;
  }

  // --- Reference data (read-only) ---

  app.get('/api/stages', (req, res) => res.json(STAGES));

  app.get('/api/catalog', (req, res) => {
    // runtimeEnforcementSummary is shipped so the UI renders the enforcement
    // claim verbatim from src/permissions.js instead of writing its own
    // version of it — one sentence, one source, no drift.
    res.json({
      agents: CATALOG,
      recommendations: STAGE_RECOMMENDATIONS,
      capabilities: CAPABILITIES,
      runtimeEnforcementSummary: RUNTIME_ENFORCEMENT_SUMMARY,
    });
  });

  // --- Founder profile (singleton) ---

  app.get('/api/profile', (req, res) => res.json(founderProfile.get()));

  app.put('/api/profile', (req, res) => {
    try {
      const profile = founderProfile.save(req.body || {});
      audit(req, { action: 'founder_profile.saved', entityType: 'founder_profile', entityId: 'operator', details: {} });
      res.json(profile);
    } catch (err) { sendError(res, err, req); }
  });

  // --- Onboarding flow ---

  app.get('/api/onboarding', (req, res) => res.json(onboarding.get()));

  app.post('/api/onboarding/start', (req, res) => {
    try {
      const state = onboarding.start();
      audit(req, { action: 'onboarding.started', entityType: 'onboarding', entityId: 'operator', details: {} });
      res.status(201).json(state);
    } catch (err) { sendError(res, err, req); }
  });

  app.put('/api/onboarding', (req, res) => {
    try {
      res.json(onboarding.save(req.body || {}));
    } catch (err) { sendError(res, err, req); }
  });

  app.post('/api/onboarding/complete', (req, res) => {
    try {
      const state = onboarding.complete(req.body || {});
      audit(req, { action: 'onboarding.completed', entityType: 'onboarding', entityId: 'operator', details: { skipped: state.skipped } });
      res.json(state);
    } catch (err) { sendError(res, err, req); }
  });

  // --- Workspaces ---

  app.get('/api/workspaces', (req, res) => {
    res.json(decorateWorkspaces(workspacesStore.list()));
  });

  app.get('/api/workspaces/:workspaceId', (req, res) => {
    try {
      const id = requireWorkspace(req);
      res.json(decorateWorkspace(workspacesStore.get(id)));
    } catch (err) { sendError(res, err, req); }
  });

  app.post('/api/workspaces', (req, res) => {
    try {
      const ws = workspacesStore.create(req.body || {});
      audit(req, { action: 'workspace.created', entityType: 'workspace', entityId: ws.id, details: { name: ws.name, stage: ws.stage } });
      res.status(201).json(decorateWorkspace(ws));
    } catch (err) { sendError(res, err, req); }
  });

  app.put('/api/workspaces/:workspaceId', (req, res) => {
    try {
      const id = requireWorkspace(req);
      const ws = workspacesStore.update(id, req.body || {});
      audit(req, { action: 'workspace.updated', entityType: 'workspace', entityId: ws.id, details: {} });
      res.json(decorateWorkspace(ws));
    } catch (err) { sendError(res, err, req); }
  });

  app.post('/api/workspaces/:workspaceId/archive', (req, res) => {
    try {
      const id = requireWorkspace(req);
      const archived = req.body?.archived !== false; // default true; pass {archived:false} to unarchive
      const ws = workspacesStore.setArchived(id, archived);
      audit(req, { action: archived ? 'workspace.archived' : 'workspace.unarchived', entityType: 'workspace', entityId: ws.id, details: {}, flagged: false });
      res.json(decorateWorkspace(ws));
    } catch (err) { sendError(res, err, req); }
  });

  // --- Workspace-owned records: goals/tasks/decisions/assumptions/experiments/evidence ---
  // Registered once via a shared helper so all six share identical scoping,
  // validation error handling, and audit behavior.

  function registerRecordRoutes(segment, store, entity) {
    const base = `/api/workspaces/:workspaceId/${segment}`;

    app.get(base, (req, res) => {
      try { res.json(store.listForWorkspace(requireWorkspace(req))); }
      catch (err) { sendError(res, err, req); }
    });

    app.get(`${base}/:id`, (req, res) => {
      try {
        const wsId = requireWorkspace(req);
        const rec = store.getForWorkspace(wsId, req.params.id);
        if (!rec) throw new AppError(Codes.RECORD_NOT_FOUND, `${entity} not found in this workspace`, 404);
        res.json(rec);
      } catch (err) { sendError(res, err, req); }
    });

    app.post(base, (req, res) => {
      try {
        const wsId = requireWorkspace(req);
        const rec = store.create(wsId, req.body || {}, actorFromRequest(req));
        audit(req, { action: `${entity}.created`, entityType: entity, entityId: rec.id, details: { workspaceId: wsId } });
        res.status(201).json(rec);
      } catch (err) { sendError(res, err, req); }
    });

    app.put(`${base}/:id`, (req, res) => {
      try {
        const wsId = requireWorkspace(req);
        const rec = store.updateForWorkspace(wsId, req.params.id, req.body || {}, actorFromRequest(req));
        audit(req, { action: `${entity}.updated`, entityType: entity, entityId: rec.id, details: { workspaceId: wsId } });
        res.json(rec);
      } catch (err) { sendError(res, err, req); }
    });

    app.delete(`${base}/:id`, (req, res) => {
      try {
        const wsId = requireWorkspace(req);
        const removed = store.removeForWorkspace(wsId, req.params.id);
        audit(req, { action: `${entity}.deleted`, entityType: entity, entityId: removed.id, details: { workspaceId: wsId }, flagged: true, flagReason: `${entity} deleted` });
        res.json({ deleted: true, id: removed.id });
      } catch (err) { sendError(res, err, req); }
    });
  }

  registerRecordRoutes('goals', records.goals, 'goal');
  registerRecordRoutes('tasks', records.tasks, 'task');
  registerRecordRoutes('decisions', records.decisions, 'decision');
  registerRecordRoutes('assumptions', records.assumptions, 'assumption');
  registerRecordRoutes('experiments', records.experiments, 'experiment');
  registerRecordRoutes('evidence', records.evidence, 'evidence');

  // --- Per-workspace agent settings + recommendations ---

  app.get('/api/workspaces/:workspaceId/agents', (req, res) => {
    try {
      const wsId = requireWorkspace(req);
      const ws = workspacesStore.get(wsId);
      const settings = agentSettings.listForWorkspace(wsId);
      const byId = Object.fromEntries(settings.map((s) => [s.agentId, s]));
      // Merge the global catalog with this workspace's per-agent settings, and
      // surface the stage-based recommendation set (advisory, not a lock).
      //
      // `settings` stays null for an agent that has never been configured —
      // that distinction is real and worth keeping. `effectivePermissions` is
      // what would apply right now, resolved through the same
      // resolveEffectivePermissions() the store writes against. The permission
      // UI must render resolved values, not re-derive defaults client-side: a
      // second copy of the rule would show one thing while the store held
      // another.
      const agents = CATALOG.map((a) => ({
        ...a,
        settings: byId[a.id] || null,
        // The SAME resolver the write path uses. Returning the raw stored map
        // here is what made a newly-added capability render unchecked and then
        // appear granted after an unrelated write: read and write disagreed
        // about what an old row meant under the current vocabulary.
        effectivePermissions: resolveEffectivePermissions(byId[a.id] ? byId[a.id].permissions : null),
        // A-002: the revision a permission write must declare. 0 means "no row
        // stored yet", which is the correct expectation for a first write.
        permissionRevision: byId[a.id] ? (byId[a.id].revision || 0) : 0,
      }));
      res.json({ agents, recommended: recommendationsForStage(ws.stage).map((a) => a.id) });
    } catch (err) { sendError(res, err, req); }
  });

  // WHAT THE AUDIT RECORD MAY SAY ABOUT `config`, and why it stops there.
  //
  // Every other dimension of this row records its transition in full: the
  // permission delta names each capability and direction, recommendedStage and
  // enabled name both sides. config deliberately does NOT record values.
  //
  // The reason is not squeamishness, it is that the project's own convention
  // for configuration history cannot be applied here. configHistoryStore.js
  // does record before/after values — but only over a fixed TRACKED_FIELDS
  // list, with a curated REDACTED_FIELDS allowlist, under the rule stated in
  // its module comment: a field that can hold a secret MUST be registered
  // there before it ships, because that history is retained indefinitely and
  // is not access-controlled. That discipline depends on a KNOWN SCHEMA. This
  // config is a free-form bag whose keys the caller invents at write time, so
  // there is no field list to curate and no moment at which a secret-bearing
  // key could have been registered in advance. events.jsonl is append-only and
  // hash-chained, so a value written into it can never be redacted without
  // breaking the chain — the mistake would be permanent.
  //
  // So the record identifies WHICH top-level keys moved, by name only, and
  // pins each side with a canonical fingerprint. An auditor holding a candidate
  // config can then prove or disprove that it was the state at that moment,
  // which is the verification property that matters, without the log itself
  // ever holding the data. Key NAMES are disclosed; that is a deliberate and
  // much weaker exposure than values, and it is what makes the record able to
  // answer "what changed" at all.
  //
  // The fingerprint is computed over a canonical, recursively key-sorted
  // serialisation. That is required for coherence, not neatness: object key
  // order is not state here (see configChanged below), so a fingerprint that
  // was sensitive to it would report two different values for a transition the
  // same route just decided was not a change.
  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }
  const configFingerprint = (cfg) => sha256(canonicalJson(cfg || {}));

  // Top-level key granularity. A change nested inside a key is reported as that
  // key having changed, which is truthful and is as deep as this can go without
  // disclosing structure that may itself be sensitive.
  function diffConfigKeys(before, after) {
    const b = before || {};
    const a = after || {};
    const added = []; const removed = []; const changed = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      if (!inB && inA) added.push(k);
      else if (inB && !inA) removed.push(k);
      else if (!isDeepStrictEqual(b[k], a[k])) changed.push(k);
    }
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
  }

  // AUDIT INTEGRITY. The evidence for a permission change must describe the
  // transition that actually happened, and an event must not exist for a
  // transition that did not.
  //
  // Measured on the previous implementation: granting edit_files recorded
  // `details: {"enabled":false}` — naming neither the capability nor the
  // direction, so the authority transition could not be reconstructed from the
  // trail. Worse, a write whose requested state already equalled the stored
  // state still emitted `workspace_agent.updated`, so the trail asserted an
  // update that provably never occurred. Rejected writes (409 stale, 400
  // malformed, 400 unknown capability) already emitted nothing, and still do.
  //
  // The BEFORE snapshot is read here rather than inside the store because the
  // delta must be derived from the accepted transition — the persisted state on
  // each side — not from the submitted request, which may name capabilities
  // whose values did not change. Both the read and the write happen in this one
  // synchronous block with no await between them, so nothing can interleave;
  // that is the same single-threaded argument the store's own read-check-write
  // already depends on.
  app.put('/api/workspaces/:workspaceId/agents/:agentId', (req, res) => {
    try {
      const wsId = requireWorkspace(req);
      const agentId = req.params.agentId;
      const before = agentSettings.getForWorkspace(wsId, agentId);
      const row = agentSettings.upsert(wsId, agentId, req.body || {});

      const delta = diffPermissions(before ? before.permissions : null, row.permissions);
      const beforeRevision = before ? (before.revision || 0) : 0;
      const enabledChanged = !before || before.enabled !== row.enabled;
      // Key order is not state. `config` is a free-form bag with no consumer
      // anywhere in src/ or public/ — nothing reads it, so nothing can observe
      // the order its keys happen to serialise in, and a JSON object is an
      // unordered collection by specification. Measured with the old
      // JSON.stringify comparison: storing {a:1,b:2} and then submitting
      // {b:2,a:1} emitted workspace_agent.updated, asserting a configuration
      // change that had not semantically occurred.
      //
      // isDeepStrictEqual is the right instrument rather than a hand-written
      // walk or a new dependency: it is order-INSENSITIVE for object keys and
      // order-SENSITIVE for arrays, which is exactly the distinction wanted —
      // [1,2] -> [2,1] IS a change. Verified for both, nested included.
      const configChanged = !isDeepStrictEqual(before ? before.config : {}, row.config);
      // recommendedStage is the fourth independently mutable dimension of this
      // row, and the one the first version of this route forgot. upsert()
      // accepts and persists it, so a stage-only write changed stored state and
      // emitted NOTHING — measured: null -> "growth", HTTP 200, zero events.
      // Since the pre-#11 route audited every successful upsert unconditionally,
      // that was a regression this PR introduced, not a pre-existing gap.
      const stageBefore = before ? (before.recommendedStage !== undefined ? before.recommendedStage : null) : null;
      const stageChanged = stageBefore !== row.recommendedStage;

      // Emit iff something actually changed. An event in this trail means an
      // accepted change occurred; a request that changed nothing is not one.
      //
      // The four conditions are the COMPLETE set of semantic state this
      // endpoint can move, derived from upsert()'s parameter list rather than
      // assumed: enabled, permissions, config, recommendedStage. The remaining
      // request field, expectedRevision, is concurrency control that is never
      // persisted; the remaining row fields are identity (workspaceId,
      // agentId), immutable (createdAt), derived from the permission delta
      // (revision, already reported below), or write metadata (updatedAt).
      // updatedAt deliberately does NOT appear here: it moves on every accepted
      // write including a pure no-op, so keying emission on it would restore
      // exactly the fabricated no-op event this PR removed.
      // Derived from the detector map, not re-enumerated here. Adding a dimension
      // to CHANGE_DETECTORS automatically extends this condition.
      const ctx = { delta, enabledChanged, configChanged, stageChanged };
      const changed = Object.fromEntries(
        Object.entries(CHANGE_DETECTORS).map(([dim, detect]) => [dim, Boolean(detect(ctx))])
      );
      if (Object.values(changed).some(Boolean)) {
        const details = {
          enabled: row.enabled,
          // Direction is explicit: granted is false -> true, revoked is
          // true -> false. Sorted, so one transition always serialises the
          // same way and consumers diff semantics rather than key order.
          permissionsGranted: delta.granted,
          permissionsRevoked: delta.revoked,
          // The revision transition the delta belongs to, so a reader can
          // place this record in the row's history without guessing.
          permissionRevisionFrom: beforeRevision,
          permissionRevisionTo: row.revision,
        };
        // Present only when it moved, and then as both sides — an event that
        // merely EXISTS for a stage change would satisfy "not invisible" while
        // still failing the invariant this PR is about, which is that a real
        // transition must be reconstructible from the record alone. The
        // permission arrays are always present because permissions are this
        // endpoint's primary audited subject and an empty array is itself the
        // meaningful statement "no authority moved"; a stage field would have
        // no such reading, so absence is the clearer encoding of "unchanged".
        if (stageChanged) {
          details.recommendedStageFrom = stageBefore;
          details.recommendedStageTo = row.recommendedStage;
        }
        // Same rule for config and enabled: present only when that dimension
        // moved, so a reader can answer "did this change?" from the record
        // rather than inferring it from the absence of everything else.
        //
        // `enabled` (the resulting value) stays as it was for compatibility,
        // but it was never evidence of a transition — it appeared identically
        // whether or not enabled had moved, which is exactly the gap this
        // closes. enabledFrom is null when no settings row existed, because
        // there is no previous boolean to name and claiming `false` would
        // invent a transition that never had a false side.
        if (enabledChanged) {
          details.enabledFrom = before ? before.enabled : null;
          details.enabledTo = row.enabled;
        }
        if (configChanged) {
          const ck = diffConfigKeys(before ? before.config : {}, row.config);
          details.configKeysAdded = ck.added;
          details.configKeysRemoved = ck.removed;
          details.configKeysChanged = ck.changed;
          details.configFrom = configFingerprint(before ? before.config : {});
          details.configTo = configFingerprint(row.config);
        }
        audit(req, {
          action: 'workspace_agent.updated',
          entityType: 'workspace_agent',
          entityId: `${wsId}:${agentId}`,
          details,
        });
      }
      res.json(row);
    } catch (err) { sendError(res, err, req); }
  });

  // --- YC progress (computed server-side; item toggles only) ---

  app.get('/api/workspaces/:workspaceId/yc', (req, res) => {
    try { res.json(yc.computeForWorkspace(requireWorkspace(req))); }
    catch (err) { sendError(res, err, req); }
  });

  app.put('/api/workspaces/:workspaceId/yc', (req, res) => {
    try {
      const wsId = requireWorkspace(req);
      const { itemId, done } = req.body || {};
      if (typeof itemId !== 'string') throw new AppError(Codes.VALIDATION_ERROR, 'itemId is required');
      const result = yc.setItem(wsId, itemId, Boolean(done));
      audit(req, { action: 'yc.item_updated', entityType: 'yc', entityId: wsId, details: { itemId, done: Boolean(done), overall: result.overall } });
      res.json(result);
    } catch (err) { sendError(res, err, req); }
  });
}

// The stores that must be init'd at boot and added to the recovery map.
const STORES = { workspacesStore, records, founderProfile, onboarding, yc, agentSettings };

// computeWorkspaceProgress was exported here but had no caller anywhere in
// src/, test/ or public/ — a dead export, removed rather than renamed.
module.exports = {
  registerFeatureOnboardRoutes, STORES,
  CHANGE_DETECTORS, assertAuditCoversWriteContract,
};
