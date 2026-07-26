<<<<<<< HEAD
=======
const fs = require('fs');
>>>>>>> origin/main
const path = require('path');
const crypto = require('crypto');

const { aggregateCost, executionSuccessRate } = require('./runsStore');
<<<<<<< HEAD
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString } = require('./errors');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;
=======

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORKSTREAMS_FILE = path.join(DATA_DIR, 'workstreams.json');
>>>>>>> origin/main

// Statuses a human can explicitly set. 'Archived' is not in this list — it's
// a separate boolean flag (`archived`), not a lifecycle status, so archiving
// a workstream doesn't collide with whatever status it was last set to.
const OVERRIDABLE_STATUSES = ['Planning', 'Active', 'Blocked', 'Review', 'Completed'];

<<<<<<< HEAD
let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'workstreams',
      filePath: path.join(DATA_DIR, 'workstreams.json'),
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
    throw new AppError(Codes.STORE_DEGRADED, 'workstream registry is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

function writeAll(workstreams) {
  getStore().write(workstreams);
=======
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
>>>>>>> origin/main
}

function list() {
  return readAll();
}

function get(id) {
  return readAll().find((w) => w.id === id) || null;
}

<<<<<<< HEAD
// Phase 6.2 — archive enforcement. Historical visibility and existing
// attribution are untouched; this only blocks NEW commitments into an
// archived workstream. Reassignment AWAY from an archived workstream
// remains allowed (an agent leaving a closed objective is always fine).
function assertNotArchived(id) {
  if (!id) return;
  const ws = get(id);
  if (ws && ws.archived) {
    throw new AppError(Codes.WORKSTREAM_ARCHIVED, 'this workstream is archived and cannot accept new agent assignments or runs', 409);
  }
}

function create(data) {
  const name = requireString(data.name, 'name');
  if (data.statusOverride && !OVERRIDABLE_STATUSES.includes(data.statusOverride)) {
    throw new AppError(Codes.VALIDATION_ERROR, `statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
=======
function create(data) {
  if (!data.name || !data.name.trim()) throw new Error('name is required');
  if (data.statusOverride && !OVERRIDABLE_STATUSES.includes(data.statusOverride)) {
    throw new Error(`statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
>>>>>>> origin/main
  }
  const workstreams = readAll();
  const workstream = {
    id: crypto.randomUUID(),
<<<<<<< HEAD
    name,
    description: typeof data.description === 'string' ? data.description : '',
    owner: typeof data.owner === 'string' ? data.owner : '',
    color: data.color || null,
    statusOverride: data.statusOverride || null,
    archived: false,
    resolvedFailureRunIds: [],
=======
    name: data.name.trim(),
    description: data.description || '',
    owner: data.owner || '',
    color: data.color || null,
    statusOverride: data.statusOverride || null,
    archived: false,
>>>>>>> origin/main
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
<<<<<<< HEAD
  if (idx === -1) throw new AppError(Codes.WORKSTREAM_NOT_FOUND, 'workstream not found', 404);
=======
  if (idx === -1) throw new Error('workstream not found');
>>>>>>> origin/main
  const existing = workstreams[idx];

  let statusOverride = existing.statusOverride;
  if (data.statusOverride !== undefined) {
    if (data.statusOverride === null || data.statusOverride === '') {
      statusOverride = null; // clears override, back to computed ("Auto")
    } else if (OVERRIDABLE_STATUSES.includes(data.statusOverride)) {
      statusOverride = data.statusOverride;
    } else {
<<<<<<< HEAD
      throw new AppError(Codes.VALIDATION_ERROR, `statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
=======
      throw new Error(`statusOverride must be one of: ${OVERRIDABLE_STATUSES.join(', ')}`);
>>>>>>> origin/main
    }
  }

  const updated = {
    ...existing,
<<<<<<< HEAD
    name: data.name !== undefined ? requireString(data.name, 'name') : existing.name,
=======
    name: data.name !== undefined ? data.name.trim() : existing.name,
>>>>>>> origin/main
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
<<<<<<< HEAD
  if (idx === -1) throw new AppError(Codes.WORKSTREAM_NOT_FOUND, 'workstream not found', 404);
=======
  if (idx === -1) throw new Error('workstream not found');
>>>>>>> origin/main
  workstreams[idx].archived = archived;
  workstreams[idx].updatedAt = new Date().toISOString();
  writeAll(workstreams);
  return workstreams[idx];
}

<<<<<<< HEAD
// Phase 6.3, Option B (documented choice — see docs/ARCHITECTURE.md):
// a failure stays attached to the WORKSTREAM it happened in, and stays
// "unresolved" even if the responsible agent is later reassigned away,
// until an operator explicitly resolves that specific run's incident.
// (Option A — status auto-clears the moment the agent leaves — was
// rejected: it lets a real unresolved failure quietly disappear from view
// just because the agent moved, which is the wrong default for long-term
// incident accountability.)
function resolveIncident(workstreamId, runId) {
  const workstreams = readAll();
  const idx = workstreams.findIndex((w) => w.id === workstreamId);
  if (idx === -1) throw new AppError(Codes.WORKSTREAM_NOT_FOUND, 'workstream not found', 404);
  const existing = workstreams[idx];
  const resolvedFailureRunIds = existing.resolvedFailureRunIds || [];
  if (!resolvedFailureRunIds.includes(runId)) {
    workstreams[idx] = {
      ...existing,
      resolvedFailureRunIds: [...resolvedFailureRunIds, runId],
      updatedAt: new Date().toISOString(),
    };
    writeAll(workstreams);
  }
  return workstreams[idx];
}

=======
>>>>>>> origin/main
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
<<<<<<< HEAD
function computeMetrics(workstreamId, { agents, runs, resolvedFailureRunIds }) {
  const memberAgents = agents.filter((a) => (a.workstreamId || null) === workstreamId);
  const ownRuns = runs.filter((r) => (r.workstreamId || null) === workstreamId);
  const finishedRuns = ownRuns.filter((r) => r.status !== 'running');
  const resolved = new Set(resolvedFailureRunIds || []);
=======
function computeMetrics(workstreamId, { agents, runs }) {
  const memberAgents = agents.filter((a) => (a.workstreamId || null) === workstreamId);
  const ownRuns = runs.filter((r) => (r.workstreamId || null) === workstreamId);
  const finishedRuns = ownRuns.filter((r) => r.status !== 'running');
>>>>>>> origin/main

  const agentCount = memberAgents.length;
  const runningRuns = ownRuns.filter((r) => r.status === 'running').length;
  const completedRuns = ownRuns.filter((r) => r.status === 'completed').length;
  const failedRuns = ownRuns.filter((r) => r.status === 'error').length;
  const cancelledRuns = ownRuns.filter((r) => r.status === 'cancelled').length;

<<<<<<< HEAD
  // Option B (see resolveIncident doc comment above): scan every agent that
  // has EVER run in this workstream's history, not just current members.
  // A failure is unresolved if it's that agent's most recent run *within
  // this workstream* and hasn't been explicitly resolved.
  const agentIdsEverInWorkstream = new Set(ownRuns.map((r) => r.agentId));
  const unresolvedFailureRunIds = [];
  for (const agentId of agentIdsEverInWorkstream) {
    const agentRuns = finishedRuns
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt);
    const latest = agentRuns[0];
    if (latest && latest.status === 'error' && !resolved.has(latest.id)) {
      unresolvedFailureRunIds.push(latest.id);
    }
  }
  const hasUnresolvedFailure = unresolvedFailureRunIds.length > 0;
=======
  // "Unresolved failure": an agent in this workstream whose most recent run
  // ended in error, with nothing since to supersede it.
  const hasUnresolvedFailure = memberAgents.some((agent) => {
    const agentRuns = finishedRuns
      .filter((r) => r.agentId === agent.id)
      .sort((a, b) => b.startedAt - a.startedAt);
    return agentRuns.length > 0 && agentRuns[0].status === 'error';
  });
>>>>>>> origin/main

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
<<<<<<< HEAD
    unresolvedFailureRunIds,
  };
}

// Phase 5.2's "explicit operator recovery action" — see versionedStore.recover.
function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = {
  init,
=======
  };
}

module.exports = {
>>>>>>> origin/main
  list,
  get,
  create,
  update,
  setArchived,
<<<<<<< HEAD
  resolveIncident,
  assertNotArchived,
  recover,
=======
>>>>>>> origin/main
  computeEffectiveStatus,
  computeMetrics,
  OVERRIDABLE_STATUSES,
};
