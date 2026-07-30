// Feature Onboard — YC readiness checklist and progress (per workspace).
//
// The YC tab shows an overall score out of 100 derived from four required,
// transparently-weighted sections (handoff §6.10). The section DEFINITIONS
// (labels, weights, checklist items) are a fixed template below; the store
// holds only per-workspace completion state (which item ids are done), so the
// overall score is always recomputed deterministically from the template plus
// the operator's checkmarks — never a stored, client-supplied total.
//
// A 100 means the configured preparation checklist is complete. It is NOT an
// acceptance probability and is never presented as one, and the four section
// labels describe the operator's own preparation, not any official YC scoring.

const path = require('path');
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes, requireString } = require('./errors');
const { ycOverall } = require('./progress');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

// The four required sections and their weights. Weights sum to 100 for an
// intuitive display, but the math (progress.ycOverall) normalizes by total
// weight regardless, so they need not.
const YC_TEMPLATE = [
  { id: 'startup_school', label: 'YC Startup School Progress', weight: 20, items: [
    { id: 'ss_enrolled', label: 'Enrolled in Startup School' },
    { id: 'ss_curriculum', label: 'Worked through the core curriculum' },
    { id: 'ss_weekly_updates', label: 'Posting weekly progress updates' },
  ] },
  { id: 'business_process', label: 'YC Business Process', weight: 30, items: [
    { id: 'bp_problem', label: 'Problem clearly articulated' },
    { id: 'bp_customers', label: 'Talked to real customers' },
    { id: 'bp_traction', label: 'Some traction or usage evidence' },
    { id: 'bp_metrics', label: 'Core metrics defined and tracked' },
  ] },
  { id: 'partner_search', label: 'YC Partner Search', weight: 15, items: [
    { id: 'ps_cofounder', label: 'Cofounder situation resolved (or solo rationale)' },
    { id: 'ps_roles', label: 'Founder roles and equity understood' },
  ] },
  { id: 'application_process', label: 'YC Application Process', weight: 35, items: [
    { id: 'ap_draft', label: 'Application draft written' },
    { id: 'ap_video', label: 'Founder video recorded' },
    { id: 'ap_reviewed', label: 'Application reviewed by someone else' },
    { id: 'ap_submitted', label: 'Application submitted' },
  ] },
];

// Flat set of every legal item id, for validation.
const ALL_ITEM_IDS = new Set(YC_TEMPLATE.flatMap((s) => s.items.map((i) => i.id)));

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'yc_progress',
      filePath: path.join(DATA_DIR, 'yc_progress.json'),
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
    throw new AppError(Codes.STORE_DEGRADED, 'YC progress store is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}
function writeAll(records) { getStore().write(records); }

function rawForWorkspace(workspaceId) {
  return readAll().find((r) => r.workspaceId === workspaceId) || null;
}

// Compute the fully-scored YC structure for a workspace: template + which items
// this workspace has completed, run through the deterministic scorer. Every
// component (section score, weight, completed/total, missing items, overall)
// is returned so the UI can show exactly what raises or lowers the number.
function computeForWorkspace(workspaceId) {
  const wsId = requireString(workspaceId, 'workspaceId');
  const record = rawForWorkspace(wsId);
  const done = new Set(record ? record.completedItemIds : []);
  const sections = YC_TEMPLATE.map((s) => ({
    id: s.id,
    label: s.label,
    weight: s.weight,
    items: s.items.map((i) => ({ id: i.id, label: i.label, done: done.has(i.id) })),
  }));
  const scored = ycOverall(sections);
  return {
    workspaceId: wsId,
    overall: scored.overall, // 0..100; a preparation-completeness measure, not an acceptance probability
    sections: scored.sections,
    updatedAt: record ? record.updatedAt : null,
  };
}

// Mark a single checklist item done/undone for a workspace. Validates the item
// id against the template so a typo can't create a phantom completion that
// silently inflates the score.
function setItem(workspaceId, itemId, done) {
  const wsId = requireString(workspaceId, 'workspaceId');
  if (!ALL_ITEM_IDS.has(itemId)) {
    throw new AppError(Codes.VALIDATION_ERROR, `unknown YC checklist item: ${itemId}`);
  }
  const records = readAll();
  let record = records.find((r) => r.workspaceId === wsId);
  if (!record) {
    record = { workspaceId: wsId, completedItemIds: [], createdAt: new Date().toISOString(), updatedAt: null };
    records.push(record);
  }
  const set = new Set(record.completedItemIds);
  if (done) set.add(itemId); else set.delete(itemId);
  record.completedItemIds = [...set];
  record.updatedAt = new Date().toISOString();
  writeAll(records);
  return computeForWorkspace(wsId);
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, computeForWorkspace, setItem, recover, YC_TEMPLATE, ALL_ITEM_IDS };
