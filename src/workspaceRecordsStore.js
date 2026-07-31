// Feature Onboard — workspace-owned records: goals, tasks, decisions,
// assumptions/risks, experiments, and evidence.
//
// These records belong DIRECTLY to a workspace (workspaceId is required) and
// may OPTIONALLY reference a workstream (workstreamId, nullable) — so
// business-wide information does not have to invent a throwaway workstream
// just to be filed (the operator's explicit refinement of the architecture).
//
// The single most important property of this module is workspace scoping:
// every read, update, and delete is keyed on (workspaceId, id) together, so a
// record created in workspace A can never be read, updated, or deleted by
// asking for it under workspace B. That guarantee is implemented ONCE here in
// the shared factory and reused by all six record types, rather than copied
// six times — which is exactly what makes it testable and hard to get wrong.
//
// Built on createVersionedStore (atomic writes, corruption/tamper detection,
// rotating backups, recovery); one file per record type so each collection
// recovers independently, but all six share this scoping/validation spine.

const path = require('path');
const crypto = require('crypto');

const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString, optionalDate } = require('./errors');
const workspacesStore = require('./workspacesStore');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new AppError(Codes.VALIDATION_ERROR, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function optionalString(value, field, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new AppError(Codes.VALIDATION_ERROR, `${field} must be a string`);
  return value;
}

// Required non-empty string that behaves correctly for BOTH create and update:
// on create (existing === null) an omitted value is rejected, not silently left
// undefined; on update an omitted value keeps the existing one. Without this,
// the `data.x !== undefined ? requireString(...) : existing?.x` idiom lets a
// record be created with no title/statement/summary at all.
function requiredField(data, existing, key, label) {
  if (data[key] !== undefined) return requireString(data[key], label);
  if (existing) return existing[key];
  throw new AppError(Codes.VALIDATION_ERROR, `${label} is required`);
}

// Milestones drive deterministic workspace progress (see progress.js). Each is
// { id, label, weight, done|fraction }. We validate shape but store as given;
// progress is computed on read, never trusted from a client total.
function validateMilestones(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError(Codes.VALIDATION_ERROR, 'milestones must be an array');
  return value.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new AppError(Codes.VALIDATION_ERROR, `milestone ${i} must be an object`);
    const weight = m.weight === undefined ? 1 : Number(m.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new AppError(Codes.VALIDATION_ERROR, `milestone ${i} weight must be a positive number`);
    const out = { id: m.id || crypto.randomUUID(), label: optionalString(m.label, `milestone ${i} label`), weight, done: Boolean(m.done) };
    if (m.fraction !== undefined) {
      const f = Number(m.fraction);
      if (!Number.isFinite(f) || f < 0 || f > 1) throw new AppError(Codes.VALIDATION_ERROR, `milestone ${i} fraction must be between 0 and 1`);
      out.fraction = f;
    }
    return out;
  });
}

// ---- Per-type validators. Each returns ONLY the type-specific fields; the
// factory owns id/type/workspaceId/workstreamId/actor/timestamps. On update,
// `existing` is provided so a validator can forbid rewriting immutable fields.

const GOAL_STATUSES = ['not_started', 'in_progress', 'blocked', 'done', 'abandoned'];
function validateGoal(data, existing) {
  return {
    title: requiredField(data, existing, 'title', 'title'),
    description: data.description !== undefined ? String(data.description) : (existing?.description ?? ''),
    targetDate: optionalDate(data.targetDate, 'targetDate', existing?.targetDate ?? null),
    status: data.status !== undefined ? assertEnum(data.status, GOAL_STATUSES, 'status') : (existing?.status ?? 'not_started'),
    successCriteria: data.successCriteria !== undefined ? String(data.successCriteria) : (existing?.successCriteria ?? ''),
    milestones: data.milestones !== undefined ? validateMilestones(data.milestones) : (existing?.milestones ?? []),
    blockers: data.blockers !== undefined ? String(data.blockers) : (existing?.blockers ?? ''),
    // Goal-to-goal dependencies (handoff §6.5). Stored as ids; not existence-
    // checked, so removing a depended-on goal can't corrupt this record.
    dependencies: data.dependencies !== undefined ? validateIdList(data.dependencies) : (existing?.dependencies ?? []),
  };
}

const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'];
function validateTask(data, existing) {
  return {
    title: requiredField(data, existing, 'title', 'title'),
    status: data.status !== undefined ? assertEnum(data.status, TASK_STATUSES, 'status') : (existing?.status ?? 'todo'),
    goalId: data.goalId !== undefined ? (data.goalId || null) : (existing?.goalId ?? null),
    notes: data.notes !== undefined ? String(data.notes) : (existing?.notes ?? ''),
  };
}

// Decisions preserve a revision trail: the decision text and reasoning are
// IMMUTABLE once written. Only status may change, and a superseding decision
// references the old one via supersedesId (set at create). This enforces
// "do not rewrite old decisions when they change".
const DECISION_STATUSES = ['proposed', 'accepted', 'rejected', 'reversed', 'superseded'];
function validateDecision(data, existing) {
  if (existing) {
    if (data.decision !== undefined && data.decision !== existing.decision) {
      throw new AppError(Codes.VALIDATION_ERROR, 'a decision\'s text is immutable — record a new decision instead of rewriting it');
    }
    if (data.reasoning !== undefined && data.reasoning !== existing.reasoning) {
      throw new AppError(Codes.VALIDATION_ERROR, 'a decision\'s reasoning is immutable — record a new decision instead of rewriting it');
    }
    return {
      decision: existing.decision,
      reasoning: existing.reasoning,
      alternatives: existing.alternatives,
      reconsiderWhen: existing.reconsiderWhen,
      supersedesId: existing.supersedesId,
      status: data.status !== undefined ? assertEnum(data.status, DECISION_STATUSES, 'status') : existing.status,
    };
  }
  return {
    decision: requireString(data.decision, 'decision'),
    reasoning: optionalString(data.reasoning, 'reasoning'),
    alternatives: optionalString(data.alternatives, 'alternatives'),
    reconsiderWhen: optionalString(data.reconsiderWhen, 'reconsiderWhen'),
    supersedesId: data.supersedesId || null,
    relatedGoalId: data.relatedGoalId || null,           // handoff §6.6: related goal
    evidenceIds: validateIdList(data.evidenceIds ?? []), // handoff §6.6: supporting evidence
    status: data.status !== undefined ? assertEnum(data.status, DECISION_STATUSES, 'status') : 'proposed',
  };
}

// Assumptions and risks share this register. `kind` selects which status
// vocabulary applies. Confidence is a SEPARATE field from status — never
// collapsed into one (handoff §6.7).
const ASSUMPTION_STATUSES = ['untested', 'weak_evidence', 'partially_supported', 'strong_evidence', 'disproved'];
const RISK_STATUSES = ['open', 'mitigating', 'accepted', 'resolved', 'materialized'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
function validateAssumption(data, existing) {
  const kind = data.kind !== undefined ? assertEnum(data.kind, ['assumption', 'risk'], 'kind') : (existing?.kind ?? 'assumption');
  const statuses = kind === 'risk' ? RISK_STATUSES : ASSUMPTION_STATUSES;
  const defaultStatus = kind === 'risk' ? 'open' : 'untested';
  return {
    kind,
    statement: requiredField(data, existing, 'statement', 'statement'),
    category: data.category !== undefined ? String(data.category) : (existing?.category ?? ''),
    status: data.status !== undefined ? assertEnum(data.status, statuses, 'status') : (existing?.status ?? defaultStatus),
    confidence: data.confidence !== undefined ? assertEnum(data.confidence, CONFIDENCE_LEVELS, 'confidence') : (existing?.confidence ?? 'low'),
    plannedTest: data.plannedTest !== undefined ? String(data.plannedTest) : (existing?.plannedTest ?? ''),
    impact: data.impact !== undefined ? String(data.impact) : (existing?.impact ?? ''),
    owner: data.owner !== undefined ? String(data.owner) : (existing?.owner ?? ''),                       // handoff §6.7
    reviewDate: optionalDate(data.reviewDate, 'reviewDate', existing?.reviewDate ?? null), // handoff §6.7
    relatedGoalId: data.relatedGoalId !== undefined ? (data.relatedGoalId || null) : (existing?.relatedGoalId ?? null),
  };
}

const EXPERIMENT_STATUSES = ['planned', 'running', 'concluded', 'abandoned'];
function validateExperiment(data, existing) {
  return {
    title: requiredField(data, existing, 'title', 'title'),
    assumptionId: data.assumptionId !== undefined ? (data.assumptionId || null) : (existing?.assumptionId ?? null),
    researchQuestion: data.researchQuestion !== undefined ? String(data.researchQuestion) : (existing?.researchQuestion ?? ''),
    method: data.method !== undefined ? String(data.method) : (existing?.method ?? ''),
    targetParticipant: data.targetParticipant !== undefined ? String(data.targetParticipant) : (existing?.targetParticipant ?? ''), // §6.8
    successThreshold: data.successThreshold !== undefined ? String(data.successThreshold) : (existing?.successThreshold ?? ''),
    failureThreshold: data.failureThreshold !== undefined ? String(data.failureThreshold) : (existing?.failureThreshold ?? ''),
    timeLimit: data.timeLimit !== undefined ? String(data.timeLimit) : (existing?.timeLimit ?? ''),   // §6.8
    costLimit: data.costLimit !== undefined ? String(data.costLimit) : (existing?.costLimit ?? ''),   // §6.8
    status: data.status !== undefined ? assertEnum(data.status, EXPERIMENT_STATUSES, 'status') : (existing?.status ?? 'planned'),
    results: data.results !== undefined ? String(data.results) : (existing?.results ?? ''),
    conclusion: data.conclusion !== undefined ? String(data.conclusion) : (existing?.conclusion ?? ''),
    nextDecision: data.nextDecision !== undefined ? String(data.nextDecision) : (existing?.nextDecision ?? ''), // §6.8
  };
}

// Evidence preserves the distinction between what people SAY and what they DO.
// evidenceKind is required and validated — a transaction/commitment is not the
// same signal as a stated preference, and the schema must not let them blur.
const EVIDENCE_KINDS = ['founder_belief', 'customer_statement', 'customer_behavior', 'transaction'];
const EVIDENCE_SOURCES = ['interview', 'survey', 'email', 'call', 'usage', 'document', 'other'];
function validateEvidence(data, existing) {
  return {
    sourceType: data.sourceType !== undefined ? assertEnum(data.sourceType, EVIDENCE_SOURCES, 'sourceType') : (existing?.sourceType ?? 'other'),
    evidenceKind: data.evidenceKind !== undefined ? assertEnum(data.evidenceKind, EVIDENCE_KINDS, 'evidenceKind') : (existing?.evidenceKind ?? requireEvidenceKind(existing)),
    summary: requiredField(data, existing, 'summary', 'summary'),
    contact: data.contact !== undefined ? String(data.contact) : (existing?.contact ?? ''),
    rawNotes: data.rawNotes !== undefined ? String(data.rawNotes) : (existing?.rawNotes ?? ''),
    tags: data.tags !== undefined ? validateTags(data.tags) : (existing?.tags ?? []),
    relatedAssumptionIds: data.relatedAssumptionIds !== undefined ? validateIdList(data.relatedAssumptionIds) : (existing?.relatedAssumptionIds ?? []),
    relatedDecisionIds: data.relatedDecisionIds !== undefined ? validateIdList(data.relatedDecisionIds) : (existing?.relatedDecisionIds ?? []), // handoff §6.9
  };
}
function requireEvidenceKind(existing) {
  if (existing) return existing.evidenceKind;
  throw new AppError(Codes.VALIDATION_ERROR, `evidenceKind is required and must be one of: ${EVIDENCE_KINDS.join(', ')}`);
}
function validateTags(value) {
  if (!Array.isArray(value)) throw new AppError(Codes.VALIDATION_ERROR, 'tags must be an array of strings');
  return value.map((t) => String(t));
}
function validateIdList(value) {
  if (!Array.isArray(value)) throw new AppError(Codes.VALIDATION_ERROR, 'expected an array of ids');
  return value.map((t) => String(t));
}

// ---- The shared scoped-store factory ----

function createRecordStore({ type, fileName, storeName, validate }) {
  let versionedStore = null;
  let registeredOnEvent = null;

  function store() {
    if (!versionedStore) {
      versionedStore = createVersionedStore({
        storeName,
        filePath: path.join(DATA_DIR, fileName),
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
    store();
  }

  function readAll() {
    const { records, state } = store().read();
    if (state === 'corrupt') {
      throw new AppError(Codes.STORE_DEGRADED, `${storeName} store is degraded (corrupt with no valid backup) — operator recovery required`, 503);
    }
    return records;
  }
  function writeAll(records) { store().write(records); }

  // workstreamId is optional and only type-checked (not existence-checked):
  // a workstream can be archived or removed independently, and a stale
  // optional reference is far less harmful than a record with no workspace.
  function normalizeWorkstreamId(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new AppError(Codes.VALIDATION_ERROR, 'workstreamId must be a string or null');
    return value;
  }

  function create(workspaceId, data = {}, actor = null) {
    const wsId = requireString(workspaceId, 'workspaceId');
    workspacesStore.assertExists(wsId); // reject a record under a non-existent workspace
    const fields = validate(data, null);
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      type,
      workspaceId: wsId,
      workstreamId: normalizeWorkstreamId(data.workstreamId),
      ...fields,
      actor: actor || { actorType: 'system', actorId: null },
      createdAt: now,
      updatedAt: now,
    };
    const records = readAll();
    records.push(record);
    writeAll(records);
    return record;
  }

  // Scoped read: only records belonging to THIS workspace are ever returned.
  function listForWorkspace(workspaceId) {
    const wsId = requireString(workspaceId, 'workspaceId');
    return readAll().filter((r) => r.workspaceId === wsId);
  }

  // Deliberately UNSCOPED, for the one legitimate cross-workspace case: an
  // aggregate that must cover every workspace in a single request (see
  // featureOnboardApi.decorateWorkspaces). Calling listForWorkspace() in a
  // loop instead re-reads and re-integrity-checks the file once per
  // workspace, which turns one tamper event into N (R-006).
  //
  // This is NOT a scoping hole: the records carry their own workspaceId and
  // the only caller groups by it immediately. Every operator-facing read path
  // still goes through listForWorkspace/getForWorkspace.
  //
  // Group every record by workspaceId in one pass, so a caller that needs
  // all workspaces reads the file exactly once. Returns a plain object with
  // a null prototype so a workspace id like "__proto__" cannot collide with
  // an inherited property.
  function groupByWorkspace() {
    const out = Object.create(null);
    for (const r of readAll()) {
      (out[r.workspaceId] = out[r.workspaceId] || []).push(r);
    }
    return out;
  }

  // Scoped get: matches on BOTH workspaceId and id, so a valid id under a
  // different workspace resolves to null (not a cross-workspace read).
  function getForWorkspace(workspaceId, id) {
    const wsId = requireString(workspaceId, 'workspaceId');
    return readAll().find((r) => r.id === id && r.workspaceId === wsId) || null;
  }

  function updateForWorkspace(workspaceId, id, data = {}, actor = null) {
    const wsId = requireString(workspaceId, 'workspaceId');
    const records = readAll();
    const idx = records.findIndex((r) => r.id === id && r.workspaceId === wsId);
    if (idx === -1) throw new AppError(Codes.RECORD_NOT_FOUND, `${type} not found in this workspace`, 404);
    const existing = records[idx];
    const fields = validate(data, existing);
    records[idx] = {
      ...existing,
      ...fields,
      workstreamId: data.workstreamId !== undefined ? normalizeWorkstreamId(data.workstreamId) : existing.workstreamId,
      actor: actor || existing.actor,
      updatedAt: new Date().toISOString(),
    };
    writeAll(records);
    return records[idx];
  }

  function removeForWorkspace(workspaceId, id) {
    const wsId = requireString(workspaceId, 'workspaceId');
    const records = readAll();
    const idx = records.findIndex((r) => r.id === id && r.workspaceId === wsId);
    if (idx === -1) throw new AppError(Codes.RECORD_NOT_FOUND, `${type} not found in this workspace`, 404);
    const [removed] = records.splice(idx, 1);
    writeAll(records);
    return removed;
  }

  function recover(resolution) { return store().recover(resolution); }

  return { type, init, create, listForWorkspace, groupByWorkspace, getForWorkspace, updateForWorkspace, removeForWorkspace, recover };
}

// The six workspace-owned record stores.
const goals = createRecordStore({ type: 'goal', fileName: 'workspace_goals.json', storeName: 'workspace_goals', validate: validateGoal });
const tasks = createRecordStore({ type: 'task', fileName: 'workspace_tasks.json', storeName: 'workspace_tasks', validate: validateTask });
const decisions = createRecordStore({ type: 'decision', fileName: 'workspace_decisions.json', storeName: 'workspace_decisions', validate: validateDecision });
const assumptions = createRecordStore({ type: 'assumption', fileName: 'workspace_assumptions.json', storeName: 'workspace_assumptions', validate: validateAssumption });
const experiments = createRecordStore({ type: 'experiment', fileName: 'workspace_experiments.json', storeName: 'workspace_experiments', validate: validateExperiment });
const evidence = createRecordStore({ type: 'evidence', fileName: 'workspace_evidence.json', storeName: 'workspace_evidence', validate: validateEvidence });

const ALL = { goals, tasks, decisions, assumptions, experiments, evidence };

function initAll(onEvent) {
  for (const store of Object.values(ALL)) store.init(onEvent);
}

module.exports = {
  goals, tasks, decisions, assumptions, experiments, evidence,
  ALL,
  initAll,
  createRecordStore, // exported for tests
  // status vocabularies exported so the API/UI/tests share one source of truth
  GOAL_STATUSES, TASK_STATUSES, DECISION_STATUSES,
  ASSUMPTION_STATUSES, RISK_STATUSES, CONFIDENCE_LEVELS,
  EXPERIMENT_STATUSES, EVIDENCE_KINDS, EVIDENCE_SOURCES,
};
