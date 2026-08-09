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

function registerFeatureOnboardRoutes(app, { eventLog, actorFromRequest, sendError }) {
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
      if (delta.changed || enabledChanged || configChanged || stageChanged) {
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
module.exports = { registerFeatureOnboardRoutes, STORES };
