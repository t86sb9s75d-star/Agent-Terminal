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
const { CAPABILITIES } = require('./permissions');
const { workspaceProgress } = require('./progress');
const { AppError, Codes } = require('./errors');

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
    res.json({ agents: CATALOG, recommendations: STAGE_RECOMMENDATIONS, capabilities: CAPABILITIES });
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
      const agents = CATALOG.map((a) => ({ ...a, settings: byId[a.id] || null }));
      res.json({ agents, recommended: recommendationsForStage(ws.stage).map((a) => a.id) });
    } catch (err) { sendError(res, err, req); }
  });

  app.put('/api/workspaces/:workspaceId/agents/:agentId', (req, res) => {
    try {
      const wsId = requireWorkspace(req);
      const row = agentSettings.upsert(wsId, req.params.agentId, req.body || {});
      audit(req, { action: 'workspace_agent.updated', entityType: 'workspace_agent', entityId: `${wsId}:${req.params.agentId}`, details: { enabled: row.enabled } });
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
