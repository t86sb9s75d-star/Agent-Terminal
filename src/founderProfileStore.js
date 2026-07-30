// Feature Onboard — the founder profile (singleton).
//
// One trusted operator, so this is a single record, not a per-user table. The
// profile is optional and partial by design: the system is usable before it is
// filled in, and every field is editable later. We deliberately collect no
// more than the operator provides and never require a field to proceed.
//
// Stored via createVersionedStore like everything else; the single profile
// object lives as the sole element of the store's records array.

const path = require('path');
const { createVersionedStore } = require('./persistence/versionedStore');
const { AppError, Codes } = require('./errors');

const DATA_DIR = process.env.RUCKER_DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 1;

// Known profile fields. Unknown keys are ignored rather than stored, so the
// shape stays predictable. All optional; strings and arrays only.
const STRING_FIELDS = ['preferredRole', 'cofounderStatus', 'geographic', 'riskTolerance', 'revenuePreference', 'communicationPrefs', 'constraints'];
const ARRAY_FIELDS = ['skills', 'industries', 'priorities', 'networkAdvantages'];
const NUMBER_FIELDS = ['hoursPerWeek', 'availableCapital'];

let versionedStore = null;
let registeredOnEvent = null;
function getStore() {
  if (!versionedStore) {
    versionedStore = createVersionedStore({
      storeName: 'founder_profile',
      filePath: path.join(DATA_DIR, 'founder_profile.json'),
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
    throw new AppError(Codes.STORE_DEGRADED, 'founder profile is degraded (corrupt with no valid backup) — operator recovery required', 503);
  }
  return records;
}

// Returns the profile object, or null if none has been saved yet.
function get() {
  const records = readRecords();
  return records[0] || null;
}

function normalize(input) {
  const out = {};
  for (const f of STRING_FIELDS) {
    if (input[f] !== undefined) {
      if (typeof input[f] !== 'string') throw new AppError(Codes.VALIDATION_ERROR, `${f} must be a string`);
      out[f] = input[f];
    }
  }
  for (const f of ARRAY_FIELDS) {
    if (input[f] !== undefined) {
      if (!Array.isArray(input[f])) throw new AppError(Codes.VALIDATION_ERROR, `${f} must be an array`);
      out[f] = input[f].map((x) => String(x));
    }
  }
  for (const f of NUMBER_FIELDS) {
    if (input[f] !== undefined && input[f] !== null && input[f] !== '') {
      const n = Number(input[f]);
      if (!Number.isFinite(n) || n < 0) throw new AppError(Codes.VALIDATION_ERROR, `${f} must be a non-negative number`);
      out[f] = n;
    }
  }
  return out;
}

// Partial upsert: merges the provided fields over whatever exists, so the
// operator can fill the profile in incrementally across sessions.
function save(input) {
  if (input === null || typeof input !== 'object') {
    throw new AppError(Codes.VALIDATION_ERROR, 'profile must be an object');
  }
  const existing = get() || { createdAt: new Date().toISOString() };
  const merged = {
    ...existing,
    ...normalize(input),
    updatedAt: new Date().toISOString(),
  };
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  getStore().write([merged]);
  return merged;
}

function recover(resolution) {
  return getStore().recover(resolution);
}

module.exports = { init, get, save, recover, STRING_FIELDS, ARRAY_FIELDS, NUMBER_FIELDS };
