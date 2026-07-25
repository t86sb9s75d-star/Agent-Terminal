require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const agentManager = require('./agentManager');
const eventLog = require('./eventLog');
const workstreamsStore = require('./workstreamsStore');
const runsStore = require('./runsStore');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

eventLog.init(broadcast);
agentManager.init(broadcast);

const integrity = store.checkIntegrity();
if (integrity.tampered) {
  eventLog.record({
    actor: 'system',
    action: 'registry.external_modification_detected',
    entityType: 'system',
    entityId: 'agents.json',
    details: { message: 'agents.json changed on disk outside the API since last known-good state' },
    flagged: true,
    flagReason: 'modified outside the system',
  });
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
  if (!ws) return res.status(404).json({ error: 'workstream not found' });
  const agents = store.list();
  const runs = runsStore.listAll();
  res.json(decorateWorkstream(ws, agents, runs));
});

app.post('/api/workstreams', (req, res) => {
  try {
    const ws = workstreamsStore.create(req.body || {});
    eventLog.record({
      actor: 'operator',
      action: 'workstream.created',
      entityType: 'workstream',
      entityId: ws.id,
      details: { name: ws.name },
    });
    res.status(201).json(ws);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/workstreams/:id', (req, res) => {
  try {
    const ws = workstreamsStore.update(req.params.id, req.body || {});
    eventLog.record({
      actor: 'operator',
      action: 'workstream.updated',
      entityType: 'workstream',
      entityId: ws.id,
      details: { name: ws.name, statusOverride: ws.statusOverride },
    });
    res.json(ws);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/workstreams/:id/archive', (req, res) => {
  try {
    const ws = workstreamsStore.setArchived(req.params.id, true);
    eventLog.record({
      actor: 'operator', action: 'workstream.archived', entityType: 'workstream', entityId: ws.id,
      details: { name: ws.name },
    });
    res.json(ws);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/workstreams/:id/unarchive', (req, res) => {
  try {
    const ws = workstreamsStore.setArchived(req.params.id, false);
    eventLog.record({
      actor: 'operator', action: 'workstream.unarchived', entityType: 'workstream', entityId: ws.id,
      details: { name: ws.name },
    });
    res.json(ws);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const runSummary = agentManager.getAgentRuns(agent.id).summary;
  res.json(withWorkstreamName({ ...agent, status: agentManager.getStatus(agent.id), ...runSummary }));
});

app.get('/api/agents/:id/runs', (req, res) => {
  if (!store.get(req.params.id)) return res.status(404).json({ error: 'agent not found' });
  res.json(agentManager.getAgentRuns(req.params.id));
});

app.post('/api/agents', (req, res) => {
  try {
    const agent = store.create(req.body || {});
    eventLog.record({
      actor: 'operator',
      action: 'agent.created',
      entityType: 'agent',
      entityId: agent.id,
      details: { name: agent.name, provider: agent.provider },
    });
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/agents/:id', (req, res) => {
  try {
    if (agentManager.getStatus(req.params.id) === 'running') {
      return res.status(409).json({ error: 'stop the agent before editing it' });
    }
    const before = store.get(req.params.id);
    const agent = store.update(req.params.id, req.body || {});
    eventLog.record({
      actor: 'operator',
      action: 'agent.updated',
      entityType: 'agent',
      entityId: agent.id,
      details: { name: agent.name, provider: agent.provider },
    });
    if (before && before.workstreamId !== agent.workstreamId) {
      const fromWs = before.workstreamId ? workstreamsStore.get(before.workstreamId) : null;
      const toWs = agent.workstreamId ? workstreamsStore.get(agent.workstreamId) : null;
      eventLog.record({
        actor: 'operator',
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
    res.json(withWorkstreamName(agent));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    const agent = store.get(req.params.id);
    agentManager.discard(req.params.id);
    store.remove(req.params.id);
    eventLog.record({
      actor: 'operator',
      action: 'agent.deleted',
      entityType: 'agent',
      entityId: req.params.id,
      details: { name: agent?.name },
    });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Lifecycle ---
app.post('/api/agents/:id/start', async (req, res) => {
  try {
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'agent not found' });
    await agentManager.start(req.params.id);
    res.status(202).json({ status: agentManager.getStatus(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:id/stop', (req, res) => {
  try {
    agentManager.stop(req.params.id);
    res.status(202).json({ status: agentManager.getStatus(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:id/logs', (req, res) => {
  if (!store.get(req.params.id)) return res.status(404).json({ error: 'agent not found' });
  res.type('text/plain').send(agentManager.getLogs(req.params.id));
});

const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`Rucker Park running at http://${HOST}:${PORT}`);
});
