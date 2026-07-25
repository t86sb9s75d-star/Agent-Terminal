const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { aggregateCost, executionSuccessRate } = require('./runsStore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORKSTREAMS_FILE = path.join(DATA_DIR, 'workstreams.json');

// Statuses a human can explicitly set. 'Archived' is not in this list — it's
// a separate boolean flag (`archived`), not a lifecycle status, so archiving
// a workstream doesn't collide with whatever status it was last set to.
const OVERRIDABLE_STATUSES = ['Planning', 'Active', 'Blocked', 'Review', 'Completed'];

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKSTREAMS_FILE)) fs.writeFileSync(WORKSTREAMS_FILE, '[]', 'utf8');
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(WORKSTREAMS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(workstreams) {
  ensureFile();
  fs.writeFileSync(WORKSTREAMS_FILE, JSON.stringify(workstreams, null, 2), 'utf8');
}

function list() {
  return readAll();
}

function get(id) {
  return readAll().find((w) => w.id === id) || null;
}

function create(data) {
  if (!data.name || !data.name.trim()) throw new Error('name is required');
  if (data.statusOverride && !OVERRIDABLE_STATUSES.includes(data.statusOverride)) {
    throw new Error(`statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
  }
  const workstreams = readAll();
  const workstream = {
    id: crypto.randomUUID(),
    name: data.name.trim(),
    description: data.description || '',
    owner: data.owner || '',
    color: data.color || null,
    statusOverride: data.statusOverride || null,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  workstreams.push(workstream);
  writeAll(workstreams);
  return workstream;
}

function update(id, data) {
  const workstreams = readAll();
  const idx = workstreams.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error('workstream not found');
  const existing = workstreams[idx];

  let statusOverride = existing.statusOverride;
  if (data.statusOverride !== undefined) {
    if (data.statusOverride === null || data.statusOverride === '') {
      statusOverride = null; // clears override, back to computed ("Auto")
    } else if (OVERRIDABLE_STATUSES.includes(data.statusOverride)) {
      statusOverride = data.statusOverride;
    } else {
      throw new Error(`statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
    }
  }

  const updated = {
    ...existing,
    name: data.name !== undefined ? data.name.trim() : existing.name,
    description: data.description !== undefined ? data.description : existing.description,
    owner: data.owner !== undefined ? data.owner : existing.owner,
    color: data.color !== undefined ? data.color : existing.color,
    statusOverride,
    updatedAt: new Date().toISOString(),
  };
  workstreams[idx] = updated;
  writeAll(workstreams);
  return updated;
}

function setArchived(id, archived) {
  const workstreams = readAll();
  const idx = workstreams.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error('workstream not found');
  workstreams[idx].archived = archived;
  workstreams[idx].updatedAt = new Date().toISOString();
  writeAll(workstreams);
  return workstreams[idx];
}

// Derived status: manual override (or 'Archived') always wins. Otherwise,
// only the states we can actually observe are auto-assigned. 'Review' and
// 'Completed' are judgment calls about whether work is *good enough* to ship
// or call done — the system has no way to know that honestly, so those two
// only ever appear via manual override, never computed.
function computeEffectiveStatus(workstream, { agentCount, runningRuns, hasUnresolvedFailure }) {
  if (workstream.archived) return 'Archived';
  if (workstream.statusOverride) return workstream.statusOverride;
  if (agentCount === 0) return 'Planning';
  if (runningRuns > 0) return 'Active';
  if (hasUnresolvedFailure) return 'Blocked';
  return 'Active';
}

// Metrics are computed from runs snapshotted with this workstream's id at
// the time each run started (see runsStore.startRun) — NOT from agents'
// current workstreamId. This is what makes history permanent: reassigning
// an agent to a different workstream later does not retroactively change
// which workstream its past runs belonged to.
function computeMetrics(workstreamId, { agents, runs }) {
  const memberAgents = agents.filter((a) => (a.workstreamId || null) === workstreamId);
  const ownRuns = runs.filter((r) => (r.workstreamId || null) === workstreamId);
  const finishedRuns = ownRuns.filter((r) => r.status !== 'running');

  const agentCount = memberAgents.length;
  const runningRuns = ownRuns.filter((r) => r.status === 'running').length;
  const completedRuns = ownRuns.filter((r) => r.status === 'completed').length;
  const failedRuns = ownRuns.filter((r) => r.status === 'error').length;
  const cancelledRuns = ownRuns.filter((r) => r.status === 'cancelled').length;

  // "Unresolved failure": an agent in this workstream whose most recent run
  // ended in error, with nothing since to supersede it.
  const hasUnresolvedFailure = memberAgents.some((agent) => {
    const agentRuns = finishedRuns
      .filter((r) => r.agentId === agent.id)
      .sort((a, b) => b.startedAt - a.startedAt);
    return agentRuns.length > 0 && agentRuns[0].status === 'error';
  });

  const lastActivity = ownRuns.reduce((max, r) => (r.startedAt > max ? r.startedAt : max), 0) || null;

  return {
    agentCount,
    runCount: ownRuns.length,
    completedRuns,
    failedRuns,
    runningRuns,
    cancelledRuns,
    cost: aggregateCost(finishedRuns),
    executionSuccessRate: executionSuccessRate(finishedRuns),
    // Progress requires a defined scope of planned work (a task/subtask
    // breakdown) that this system does not track. Rather than approximate
    // it with a success-rate or run-count ratio — which would answer a
    // different question and mislead under the label "progress" — this is
    // always left unavailable until real scope tracking exists.
    progress: null,
    lastActivity,
    hasUnresolvedFailure,
  };
}

module.exports = {
  list,
  get,
  create,
  update,
  setArchived,
  computeEffectiveStatus,
  computeMetrics,
  OVERRIDABLE_STATUSES,
};
