// Feature Onboard — onboarding flow state (singleton).
//
// Tracks a resumable, skippable, re-openable onboarding session for the one
// operator. First-run detection is simply: get() returns null (no state saved
// yet) => the operator has never been through onboarding. The flow can be
// resumed (currentStep + accumulated draft data), skipped (completed with
// skipped: true), and reopened later (reset back to step 1 without destroying
// anything else in the system).
//
// This store holds ONLY the onboarding session's own progress and scratch
// data. It never creates workspaces/agents itself — the API layer does that on
// completion. So a refresh mid-onboarding cannot corrupt real data: the worst
// case is a half-filled draft that resumes.

const path = require('path');
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes } = require('./errors');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

// The ordered onboarding steps. currentStep is one of these ids; the UI maps
// them to screens. Kept as data so the flow can be reordered without hunting
// through conditionals.
const STEPS = ['welcome', 'profile', 'operating_mode', 'workspace', 'agents', 'permissions', 'yc', 'review', 'done'];
const OPERATING_MODES = ['explore', 'validate', 'build', 'sell', 'operate', 'fundraise', 'yc'];

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'onboarding_state',
      filePath: path.join(DATA_DIR, 'onboarding_state.json'),
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

function readRecords() {
  const { records, state } = getStore().read();
  if (state === 'corrupt') {
    throw new AppError(Codes.STORE_DEGRADED, 'onboarding state is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

// null => never started (first run).
function get() {
  return readRecords()[0] || null;
}

function isValidStep(step) {
  return STEPS.includes(step);
}

function write(state) {
  getStore().write([state]);
  return state;
}

// Start (or restart) onboarding at the first step. Non-destructive: this only
// resets the onboarding session's own progress, not any workspaces/agents.
function start() {
  const now = new Date().toISOString();
  const existing = get();
  return write({
    startedAt: existing?.startedAt || now,
    updatedAt: now,
    completed: false,
    skipped: false,
    currentStep: 'welcome',
    operatingModes: [],
    draft: {},
  });
}

// Save progress: advance/rewind the step and merge accumulated draft data.
// Creates the session if it doesn't exist yet (so a resumed refresh works).
function save({ currentStep, operatingModes, draft } = {}) {
  const existing = get() || {
    startedAt: new Date().toISOString(), completed: false, skipped: false, currentStep: 'welcome', operatingModes: [], draft: {},
  };
  if (currentStep !== undefined && !isValidStep(currentStep)) {
    throw new AppError(Codes.VALIDATION_ERROR, `currentStep must be one of: ${STEPS.join(', ')}`);
  }
  let modes = existing.operatingModes;
  if (operatingModes !== undefined) {
    if (!Array.isArray(operatingModes)) throw new AppError(Codes.VALIDATION_ERROR, 'operatingModes must be an array');
    for (const m of operatingModes) {
      if (!OPERATING_MODES.includes(m)) throw new AppError(Codes.VALIDATION_ERROR, `unknown operating mode: ${m}`);
    }
    modes = operatingModes;
  }
  return write({
    ...existing,
    currentStep: currentStep !== undefined ? currentStep : existing.currentStep,
    operatingModes: modes,
    draft: draft !== undefined ? { ...existing.draft, ...draft } : existing.draft,
    updatedAt: new Date().toISOString(),
  });
}

// Mark onboarding finished. `skipped` distinguishes "completed the flow" from
// "chose to skip"; either way the operator won't be forced back into it.
function complete({ skipped = false } = {}) {
  const existing = get() || { startedAt: new Date().toISOString(), operatingModes: [], draft: {} };
  return write({
    ...existing,
    completed: true,
    skipped: Boolean(skipped),
    currentStep: 'done',
    updatedAt: new Date().toISOString(),
  });
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, get, start, save, complete, recover, STEPS, OPERATING_MODES, isValidStep };
