require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const agentManager = require('./agentManager');
const eventLog = require('./eventLog');
const workstreamsStore = require('./workstreamsStore');
const runsStore = require('./runsStore');
const configHistoryStore = require('./configHistoryStore');
const instanceLock = require('./instanceLock');
const { idempotencyMiddleware } = require('./idempotency');
const { AppError, Codes } = require('./errors');
const { requestIdMiddleware, actorFromRequest, SYSTEM_ACTOR, RECOVERY_ACTOR } = require('./actor');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Additional failure mode — refuse to start a second instance against the
// same data directory; every store here assumes single-process ownership
// (see src/instanceLock.js). Must happen before anything touches data/.
try {
  instanceLock.acquire(DATA_DIR);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}

const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1';

// Additional failure mode — CSRF / browser-origin. There is no auth system
// yet, and this server binds to localhost, but "localhost-only" does NOT
// mean "safe from the browser": any webpage the operator has open in the
// same browser can still blind-POST to http://127.0.0.1:PORT — the browser
// only blocks the attacker's JS from READING the response, not from
// sending the request in the first place. /start and /stop take no body,
// so a plain cross-origin `fetch(..., {method:'POST'})` from any tab is a
// "simple" request needing no CORS preflight and would otherwise reach the
// server. Rejecting state-changing requests whose Origin header doesn't
// match this server is a standard, low-cost mitigation that needs no
// session/token infrastructure. Requests with NO Origin header (curl,
// server-to-server, the X-Rucker-Client automation convention) are
// allowed through — browsers reliably send Origin on cross-site
// state-changing requests, so its absence here means a non-browser caller,
// not a gap an attacker page can exploit.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function allowedOrigins() {
  return new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
}
function originCheckMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('Origin');
  if (!origin) return next();
  if (allowedOrigins().has(origin)) return next();
  res.status(403).json({ error: 'cross-origin request rejected', code: 'CROSS_ORIGIN_REJECTED', requestId: req.requestId || null });
}

const app = express();
app.use(requestIdMiddleware);
app.use(originCheckMiddleware);
app.use(express.json());
app.use(idempotencyMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// Every store gets the audit emitter wired in at boot, so corruption/tamper
// events discovered on ANY later read — not just the one-time boot check —
// are actually recorded, not silently dropped (the previous gap: only
// agents.json had a boot-time integrity check at all, and even that never
// reached the audit log for events found after startup).
eventLog.init(broadcast);
store.init(eventLog.record);
runsStore.init(eventLog.record);
workstreamsStore.init(eventLog.record);
agentManager.init(broadcast);

// Phase 3.5 — resolve any run left `running` by a previous process that
// didn't shut down cleanly (crash, kill, host reboot), before anything else
// touches run state. Left unresolved, these would sit as permanently
// "active" forever and never appear in any success/failure accounting.
const INSTANCE_ID = crypto.randomUUID();
const recovery = runsStore.recoverInterruptedRuns({ actor: RECOVERY_ACTOR, instanceId: INSTANCE_ID });
if (recovery.recoveredCount > 0) {
  eventLog.record({
    actor: RECOVERY_ACTOR,
    action: 'runs.recovered_after_restart',
    entityType: 'system',
    entityId: 'runs',
    details: { recoveredCount: recovery.recoveredCount, runs: recovery.recovered, instanceId: INSTANCE_ID },
    flagged: true,
    flagReason: `${recovery.recoveredCount} run(s) were still marked running at boot — likely an unclean previous shutdown`,
  });
}

const integrity = store.checkIntegrity();
if (integrity.tampered) {
  eventLog.record({
    actor: SYSTEM_ACTOR,
    action: 'registry.external_modification_detected',
    entityType: 'system',
    entityId: 'agents.json',
    details: { message: 'agents.json changed on disk outside the API since last known-good state' },
    flagged: true,
    flagReason: 'modified outside the system',
  });
}

// Stable error responses (Phase 8.1) — an AppError's code/status are trusted
// and returned as-is; anything else is an unexpected internal error and is
// deliberately NOT leaked to the client (raw JS exception messages can
// reveal file paths, stack internals, etc.) — only logged server-side.
function sendError(res, err, req) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code, requestId: req?.requestId || null });
  }
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'internal server error', code: 'INTERNAL_ERROR', requestId: req?.requestId || null });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', statuses: agentManager.getAllStatuses() }));
});

// --- Providers ---
app.get('/api/providers', (req, res) => {
  res.json({
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    custom: true,
  });
});

// --- Command summary ---
app.get('/api/summary', (req, res) => {
  res.json(agentManager.getSummary());
});

// --- Activity / audit feed ---
app.get('/api/activity', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const agentId = req.query.agentId || null;
  res.json(agentManager.getActivity({ limit, agentId }));
});

// --- Workstreams ---
function decorateWorkstream(ws, agents, runs) {
  const metrics = workstreamsStore.computeMetrics(ws.id, { agents, runs });
  const status = workstreamsStore.computeEffectiveStatus(ws, metrics);
  return { ...ws, status, ...metrics };
}

app.get('/api/workstreams', (req, res) => {
  const agents = store.list();
  const runs = runsStore.listAll();
  const workstreams = workstreamsStore.list().map((ws) => decorateWorkstream(ws, agents, runs));
  res.json(workstreams);
});

app.get('/api/workstreams/:id', (req, res) => {
  const ws = workstreamsStore.get(req.params.id);
  if (!ws) return sendError(res, new AppError(Codes.WORKSTREAM_NOT_FOUND, 'workstream not found', 404), req);
  const agents = store.list();
  const runs = runsStore.listAll();
  res.json(decorateWorkstream(ws, agents, runs));
});

app.post('/api/workstreams', (req, res) => {
  try {
    const ws = workstreamsStore.create(req.body || {});
    eventLog.record({
      actor: actorFromRequest(req),
      action: 'workstream.created',
      entityType: 'workstream',
      entityId: ws.id,
      details: { name: ws.name },
    });
    res.status(201).json(ws);
  } catch (err) {
    sendError(res, err, req);
  }
});

app.put('/api/workstreams/:id', (req, res) => {
  try {
    const ws = workstreamsStore.update(req.params.id, req.body || {});
    eventLog.record({
      actor: actorFromRequest(req),
      action: 'workstream.updated',
      entityType: 'workstream',
      entityId: ws.id,
      details: { name: ws.name, statusOverride: ws.statusOverride },
    });
    res.json(ws);
  } catch (err) {
    sendError(res, err, req);
  }
});

app.post('/api/workstreams/:id/archive', (req, res) => {
  try {
    const ws = workstreamsStore.setArchived(req.params.id, true);
    eventLog.record({
      actor: actorFromRequest(req), action: 'workstream.archived', entityType: 'workstream', entityId: ws.id,
      details: { name: ws.name },
    });
    res.json(ws);
  } catch (err) {
    sendError(res, err, req);
  }
});

app.post('/api/workstreams/:id/unarchive', (req, res) => {
  try {
    const ws = workstreamsStore.setArchived(req.params.id, false);
    eventLog.record({
      actor: actorFromRequest(req), action: 'workstream.unarchived', entityType: 'workstream', entityId: ws.id,
      details: { name: ws.name },
    });
    res.json(ws);
  } catch (err) {
    sendError(res, err, req);
  }
});

app.post('/api/workstreams/:id/resolve/:runId', (req, res) => {
  try {
    const ws = workstreamsStore.resolveIncident(req.params.id, req.params.runId);
    eventLog.record({
      actor: actorFromRequest(req),
      action: 'workstream.incident_resolved',
      entityType: 'workstream',
      entityId: ws.id,
      details: { name: ws.name, runId: req.params.runId },
    });
    res.json(ws);
  } catch (err) {
    sendError(res, err, req);
  }
});

// --- Agents CRUD ---
function withWorkstreamName(agent) {
  const ws = agent.workstreamId ? workstreamsStore.get(agent.workstreamId) : null;
  return { ...agent, workstreamName: ws ? ws.name : null };
}

app.get('/api/agents', (req, res) => {
  const statuses = agentManager.getAllStatuses();
  const agents = store.list().map((a) => {
    const runSummary = agentManager.getAgentRuns(a.id).summary;
    return withWorkstreamName({ ...a, ...statuses[a.id], ...runSummary });
  });
  res.json(agents);
});

app.get('/api/agents/:id', (req, res) => {
  const agent = store.get(req.params.id);
  if (!agent) return sendError(res, new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404), req);
  const runSummary = agentManager.getAgentRuns(agent.id).summary;
  res.json(withWorkstreamName({ ...agent, status: agentManager.getStatus(agent.id), ...runSummary }));
});

app.get('/api/agents/:id/runs', (req, res) => {
  if (!store.get(req.params.id)) return sendError(res, new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404), req);
  res.json(agentManager.getAgentRuns(req.params.id));
});

app.post('/api/agents', (req, res) => {
  try {
    const agent = store.create(req.body || {});
    const actor = actorFromRequest(req);
    eventLog.record({
      actor,
      action: 'agent.created',
      entityType: 'agent',
      entityId: agent.id,
      details: { name: agent.name, provider: agent.provider },
    });
    configHistoryStore.record({ agentId: agent.id, action: 'created', actor, before: null, after: agent }, eventLog.record);
    res.status(201).json(agent);
  } catch (err) {
    sendError(res, err, req);
  }
});

app.put('/api/agents/:id', (req, res) => {
  try {
    if (agentManager.getStatus(req.params.id) === 'running') {
      throw new AppError(Codes.VALIDATION_ERROR, 'stop the agent before editing it', 409);
    }
    const { before, after: agent } = store.update(req.params.id, req.body || {});
    const actor = actorFromRequest(req);
    eventLog.record({
      actor,
      action: 'agent.updated',
      entityType: 'agent',
      entityId: agent.id,
      details: { name: agent.name, provider: agent.provider },
    });
    if (before && before.workstreamId !== agent.workstreamId) {
      const fromWs = before.workstreamId ? workstreamsStore.get(before.workstreamId) : null;
      const toWs = agent.workstreamId ? workstreamsStore.get(agent.workstreamId) : null;
      eventLog.record({
        actor,
        action: 'agent.workstream_changed',
        entityType: 'agent',
        entityId: agent.id,
        details: {
          agentName: agent.name,
          fromWorkstreamId: before.workstreamId,
          fromWorkstreamName: fromWs ? fromWs.name : null,
          toWorkstreamId: agent.workstreamId,
          toWorkstreamName: toWs ? toWs.name : null,
        },
      });
    }
    configHistoryStore.record({ agentId: agent.id, action: 'updated', actor, before, after: agent }, eventLog.record);
    res.json(withWorkstreamName(agent));
  } catch (err) {
    sendError(res, err, req);
  }
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    const agent = store.get(req.params.id);
    if (!agent) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
    agentManager.discard(req.params.id);
    store.remove(req.params.id);
    const actor = actorFromRequest(req);
    eventLog.record({
      actor,
      action: 'agent.deleted',
      entityType: 'agent',
      entityId: req.params.id,
      details: { name: agent?.name },
    });
    if (agent) configHistoryStore.record({ agentId: agent.id, action: 'deleted', actor, before: agent, after: null }, eventLog.record);
    res.status(204).end();
  } catch (err) {
    sendError(res, err, req);
  }
});

app.get('/api/agents/:id/config-history', (req, res) => {
  if (!store.get(req.params.id)) return sendError(res, new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404), req);
  res.json(configHistoryStore.listForAgent(req.params.id, eventLog.record));
});

// --- Lifecycle ---
app.post('/api/agents/:id/start', async (req, res) => {
  try {
    if (!store.get(req.params.id)) throw new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404);
    await agentManager.start(req.params.id, actorFromRequest(req));
    res.status(202).json({ status: agentManager.getStatus(req.params.id) });
  } catch (err) {
    sendError(res, err, req);
  }
});

app.post('/api/agents/:id/stop', async (req, res) => {
  try {
    await agentManager.stop(req.params.id, actorFromRequest(req));
    res.status(202).json({ status: agentManager.getStatus(req.params.id) });
  } catch (err) {
    sendError(res, err, req);
  }
});

app.get('/api/agents/:id/logs', (req, res) => {
  if (!store.get(req.params.id)) return sendError(res, new AppError(Codes.AGENT_NOT_FOUND, 'agent not found', 404), req);
  res.type('text/plain').send(agentManager.getLogs(req.params.id));
});

server.listen(PORT, HOST, () => {
  console.log(`Rucker Park running at http://${HOST}:${PORT}`);
});
