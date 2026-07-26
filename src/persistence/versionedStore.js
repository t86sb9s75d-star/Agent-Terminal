// The shared persistence layer every store (agents, runs, workstreams,
// config history, security events) is built on. Ties together atomic
// writes (3.1), corruption-vs-empty distinction (3.2), backup rotation
// (3.3), schema versioning (3.4), and tamper detection (5.1/5.2) into one
// consistent API, so each store implements its own business logic without
// re-implementing (and subtly re-diverging on) any of this.
//
// Deliberately NOT a database. This is still one JSON file per store,
// still whole-file-rewrite on every write, still single-process-only (see
// docs/ARCHITECTURE.md for why that's an accepted, documented boundary
// rather than an oversight).

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync, readJsonWithState, cleanupStaleTempFiles } = require('./atomicJsonFile');
const { writeBackup, findLatestValidBackup } = require('./backup');
const { checkSnapshotIntegrity, recordSnapshotHash } = require('./integrityChain');
const systemState = require('../systemState');

// storeName: short identifier used for backups/subsystem naming, e.g. 'agents'
// filePath: full path to the primary JSON file
// dataDir: the data/ directory (for backups)
// schemaVersion: current schema version this code expects
// emptyValue: the default `records` value for a brand-new store (usually [])
// migrate(envelope): optional — given an old envelope, return an upgraded
//   one, or throw/return null if it can't be migrated (schema too old/new)
// onEvent(event): optional callback for audit/security events raised by
//   recovery or tamper detection — injected rather than imported, so this
//   module has no dependency on eventLog (which itself uses this module).
function createVersionedStore({ storeName, filePath, dataDir, schemaVersion, emptyValue, migrate, onEvent }) {
  const hashFilePath = path.join(dataDir, `.${storeName}.hash.json`);
  const emit = onEvent || (() => {});

  function isValidEnvelope(data) {
    return data && typeof data === 'object' && Array.isArray(data.records) && typeof data.schemaVersion === 'number';
  }

  function freshEnvelope() {
    return { schemaVersion, updatedAt: new Date().toISOString(), records: emptyValue };
  }

  function persist(envelope) {
    const serialized = JSON.stringify(envelope, null, 2);
    atomicWriteFileSync(filePath, serialized);
    recordSnapshotHash(hashFilePath, serialized, { atomicWrite: atomicWriteFileSync });
    // Back up the version that was JUST written successfully — not the one
    // it replaced. A backup must exist for the most recent good state, or
    // recovery from corruption immediately after a write would silently
    // roll back to an older version and lose the latest legitimate change.
    try {
      writeBackup(storeName, dataDir, serialized);
    } catch (err) {
      // Backup failure must not block the write itself, but it's worth
      // surfacing — a store with no working backups is running with a
      // weaker safety net than the operator likely believes it has.
      emit({
        action: `${storeName}.backup_write_failed`,
        entityType: 'system',
        entityId: storeName,
        details: { message: err.message },
        flagged: true,
        flagReason: 'backup could not be written',
      });
    }
    return envelope;
  }

  function preserveCorruptFile() {
    const stamped = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.copyFileSync(filePath, stamped);
      return stamped;
    } catch {
      return null;
    }
  }

  // Reads and returns { state, records }.
  //   state: 'missing' | 'populated' | 'empty' | 'recovered' | 'corrupt'
  // 'corrupt' means records is null and the caller MUST treat this store as
  // degraded — see systemState.markDegraded, applied here automatically.
  function read() {
    const result = readJsonWithState(filePath, { isValidShape: isValidEnvelope });

    if (result.state === 'missing') {
      const envelope = freshEnvelope();
      persist(envelope);
      systemState.clearDegraded(storeName);
      return { state: 'missing', records: envelope.records };
    }

    if (result.state === 'corrupt') {
      const preservedPath = preserveCorruptFile();
      const backup = findLatestValidBackup(storeName, dataDir, isValidEnvelope);
      if (backup) {
        // Safe recovery: only because the backup itself proves valid. Not
        // a guess — a previously-verified state written by this same code.
        persist(backup.data);
        systemState.clearDegraded(storeName);
        emit({
          action: `${storeName}.recovered_from_backup`,
          entityType: 'system',
          entityId: storeName,
          details: { corruptFilePreserved: preservedPath, restoredFrom: backup.path },
          flagged: true,
          flagReason: 'primary store file was corrupt; restored from last known-good backup',
        });
        return { state: 'recovered', records: backup.data.records };
      }
      systemState.markDegraded(storeName, 'corrupt_no_backup', { preservedPath });
      emit({
        action: `${storeName}.corrupt_no_backup`,
        entityType: 'system',
        entityId: storeName,
        details: { corruptFilePreserved: preservedPath },
        flagged: true,
        flagReason: 'primary store file was corrupt and no valid backup exists — operator recovery required',
      });
      return { state: 'corrupt', records: null };
    }

    let envelope = result.data;
    if (envelope.schemaVersion !== schemaVersion) {
      if (migrate) {
        try {
          envelope = migrate(envelope);
        } catch {
          envelope = null;
        }
      } else {
        envelope = null;
      }
      if (!envelope || !isValidEnvelope(envelope)) {
        systemState.markDegraded(storeName, 'unsupported_schema', { foundVersion: result.data.schemaVersion, expected: schemaVersion });
        emit({
          action: `${storeName}.unsupported_schema`,
          entityType: 'system',
          entityId: storeName,
          details: { foundVersion: result.data.schemaVersion, expectedVersion: schemaVersion },
          flagged: true,
          flagReason: 'store schema version is not supported by this build — operator action required',
        });
        return { state: 'corrupt', records: null };
      }
      // Migration succeeded — persist the upgraded shape so this doesn't
      // re-run every boot, and treat it as a fresh known-good baseline.
      persist(envelope);
    }

    const integrity = checkSnapshotIntegrity(hashFilePath, result.raw);
    if (integrity.tampered) {
      // Deliberately NOT re-baselined here (Phase 5.2). The hash record is
      // only ever updated by persist(), which only runs on a write made
      // through this module. Reading tampered content is still returned to
      // the caller (the operator needs to see it), but the store is marked
      // degraded until an explicit recovery action clears it.
      systemState.markDegraded(storeName, 'tampered', { expected: integrity.expected, actual: integrity.actual });
      emit({
        action: `${storeName}.tamper_detected`,
        entityType: 'system',
        entityId: storeName,
        details: { expectedHash: integrity.expected, actualHash: integrity.actual },
        flagged: true,
        flagReason: 'store file was modified outside the application',
      });
    } else {
      systemState.clearDegraded(storeName);
    }

    return { state: result.state, records: envelope.records };
  }

  function write(records) {
    const envelope = { schemaVersion, updatedAt: new Date().toISOString(), records };
    persist(envelope);
    systemState.clearDegraded(storeName); // a successful write through the app re-establishes trust
    return envelope;
  }

  // Manual recovery (Phase 5.2's "explicit operator recovery action").
  // `resolution` is 'accept_current' (treat whatever is on disk right now
  // as the new known-good baseline — used when the operator has reviewed
  // the diff and confirms it's an intentional/acceptable change) or
  // 'restore_backup' (discard the current file, restore the newest valid
  // backup).
  function recover(resolution) {
    if (resolution === 'restore_backup') {
      const backup = findLatestValidBackup(storeName, dataDir, isValidEnvelope);
      if (!backup) throw new Error('no valid backup available to restore');
      persist(backup.data);
      systemState.clearDegraded(storeName);
      return { resolution, records: backup.data.records };
    }
    if (resolution === 'accept_current') {
      const raw = fs.readFileSync(filePath, 'utf8');
      const envelope = JSON.parse(raw); // caller is asserting they've reviewed it
      recordSnapshotHash(hashFilePath, raw, { atomicWrite: atomicWriteFileSync });
      systemState.clearDegraded(storeName);
      return { resolution, records: envelope.records };
    }
    throw new Error(`unknown recovery resolution: ${resolution}`);
  }

  cleanupStaleTempFiles(dataDir);

  return { read, write, recover, hashFilePath, filePath };
}

module.exports = { createVersionedStore };
