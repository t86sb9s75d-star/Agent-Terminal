// The audit contract's COMPLETENESS, as a machine-enforced invariant.
//
// WHY THIS SUITE EXISTS. Three separate findings in this PR were one defect
// wearing three faces: a dimension the settings write persists was missing from
// the audit path. recommendedStage was invisible; config was detected but never
// described; enabled recorded a result rather than a transition. Each instance
// was fixed. The CLASS was not closed, because "these four are the complete set"
// lived in prose and was duplicated by hand in two files.
//
// MEASURED, on the head before this suite existed: adding a fifth persisted
// field to upsert() left all 101 unit and 103 integration cases green while a
// real accepted transition (null -> "CONFIDENTIAL-OPERATIONAL-NOTE", HTTP 200,
// persisted) produced ZERO audit records. A green suite proved nothing about
// dimensions nobody had thought of.
//
// So completeness is now declared once, as data, in WRITE_CONTRACT, and checked
// mechanically. These cases prove the checks actually fire — including
// end-to-end against a real server built from a MODIFIED COPY of the app, since
// the only honest way to test "adding a dimension fails loudly" is to add one.
//
// Run with: node test/auditContract.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const store = require('../src/workspaceAgentSettingsStore');
const api = require('../src/featureOnboardApi');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (err) { failed += 1; console.log(`NOT OK - ${name}\n    ${err.message}`); }
}

// Every spawned process is tracked, not just the most recent one: check()
// swallows failures, so a case that throws never reaches its own cleanup and
// would otherwise orphan a server per failure.
const servers = [];
const temps = [];
function stopServers() {
  for (const p of servers.splice(0)) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
}
function cleanupAll() {
  stopServers();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupAll(); process.exit(1); });
}

function makeAppCopy(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rucker-contract-${label}-`));
  temps.push(root);
  fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'public'), path.join(root, 'public'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

// Anchored edits against the COPY. Each must match exactly once, so a rename in
// the real source turns into a loud failure here rather than a silently
// no-op experiment that would look like a passing test.
function editFile(root, rel, replacements) {
  const p = path.join(root, rel);
  let src = fs.readFileSync(p, 'utf8');
  for (const [from, to] of replacements) {
    assert.strictEqual(src.split(from).length - 1, 1, `anchor did not match exactly once in ${rel}: ${from.slice(0, 60)}`);
    src = src.split(from).join(to);
  }
  fs.writeFileSync(p, src);
}

const UPSERT_SIG = 'function upsert(workspaceId, agentId, { enabled, permissions, config, recommendedStage, expectedRevision } = {}) {';
const UPSERT_SIG_5 = 'function upsert(workspaceId, agentId, { enabled, permissions, config, recommendedStage, notes, expectedRevision } = {}) {';
const ROW_CREATED = '    createdAt: existing ? existing.createdAt : now,';
const ROW_CREATED_5 = '    notes: notes !== undefined ? notes : (existing ? existing.notes : null),\n    createdAt: existing ? existing.createdAt : now,';

// Add a fifth PERSISTED dimension to the copy. `classification` decides whether
// it is also declared in WRITE_CONTRACT, and as what.
function addFifthDimension(root, classification) {
  const edits = [[UPSERT_SIG, UPSERT_SIG_5], [ROW_CREATED, ROW_CREATED_5]];
  if (classification) {
    edits.push([`  permissions: 'semantic',`, `  permissions: 'semantic',\n  notes: '${classification}',`]);
  }
  editFile(root, 'src/workspaceAgentSettingsStore.js', edits);
}

async function bootExpectingSuccess(root, dataDir) {
  const port = 6300 + Math.floor(Math.random() * 250);
  const proc = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${baseUrl}/api/workspaces`); if (r.ok) return baseUrl; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never became ready');
}

// Boot and capture the outcome instead of asserting it, so a case can assert
// that the server REFUSED to start and say why.
function bootCapturing(root, dataDir) {
  return new Promise((resolve) => {
    const port = 6300 + Math.floor(Math.random() * 250);
    const proc = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servers.push(proc);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('exit', (code) => resolve({ exited: true, code, stderr: err }));
    setTimeout(() => resolve({ exited: false, code: null, stderr: err }), 4000);
  });
}

const AGENT = 'interview_agent';
async function call(baseUrl, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, body: json };
}
function readRow(dataDir, ws) {
  const f = path.join(dataDir, 'workspace_agent_settings.json');
  if (!fs.existsSync(f)) return null;
  const env = JSON.parse(fs.readFileSync(f, 'utf8'));
  const recs = Array.isArray(env) ? env : (env.records || env.data || []);
  return recs.find((r) => r.workspaceId === ws && r.agentId === AGENT) || null;
}
function auditEvents(dataDir, ws) {
  const f = path.join(dataDir, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.action === 'workspace_agent.updated' && String(e.entityId) === `${ws}:${AGENT}`);
}
function freshDataDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `rucker-contract-data-${label}-`));
  temps.push(d);
  return d;
}
async function newWorkspace(baseUrl) {
  const { DEFAULT_STAGE } = require('../src/businessStages');
  const r = await call(baseUrl, 'POST', '/api/workspaces', {
    name: `contract-${Math.random().toString(36).slice(2, 8)}`, stage: DEFAULT_STAGE,
  });
  assert.strictEqual(r.status, 201, `workspace creation failed: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

(async () => {
  // --- A: the declared set is exactly the dimensions the write can move ------

  await check('the write contract declares exactly the four semantic dimensions', async () => {
    assert.deepStrictEqual(
      [...store.SEMANTIC_DIMENSIONS],
      ['config', 'enabled', 'permissions', 'recommendedStage'],
      'the declared semantic dimension set changed — if that is intentional, the audit contract must move with it'
    );
  });

  await check('the audit contract covers the write contract, set-equal in both directions', async () => {
    const audited = Object.keys(api.CHANGE_DETECTORS).sort();
    assert.deepStrictEqual(
      audited, [...store.SEMANTIC_DIMENSIONS],
      'the route audits a different set of dimensions than the store declares semantic'
    );
    api.assertAuditCoversWriteContract(Object.keys(api.CHANGE_DETECTORS), store.SEMANTIC_DIMENSIONS);
  });

  await check('an UNCOVERED semantic dimension makes the coverage check throw', async () => {
    assert.throws(
      () => api.assertAuditCoversWriteContract(['permissions', 'enabled', 'config'], store.SEMANTIC_DIMENSIONS),
      /does not cover: recommendedStage/,
      'dropping a dimension from the audit contract was accepted'
    );
  });

  await check('a PHANTOM detector makes the coverage check throw', async () => {
    // The other direction: the route must not claim to audit state the store
    // does not declare semantic, or its completeness claim is false that way.
    assert.throws(
      () => api.assertAuditCoversWriteContract([...store.SEMANTIC_DIMENSIONS, 'ghost'], store.SEMANTIC_DIMENSIONS),
      /does not declare semantic: ghost/,
      'auditing a dimension the write contract does not declare was accepted'
    );
  });

  // --- B: expectedRevision is control, not state ----------------------------

  await check('expectedRevision is classified as control and can never be persisted', async () => {
    assert.strictEqual(store.WRITE_CONTRACT.expectedRevision, 'control', 'expectedRevision must be control input');
    assert.ok(!store.SEMANTIC_DIMENSIONS.includes('expectedRevision'), 'expectedRevision must not be a semantic dimension');
    assert.ok(!store.PERSISTED_FIELDS.includes('expectedRevision'), 'expectedRevision must not be a persisted field');
    assert.throws(
      () => store.assertRowMatchesContract({
        workspaceId: 'w', agentId: 'a', enabled: true, permissions: {}, config: {},
        recommendedStage: null, createdAt: 't', updatedAt: 't', revision: 0, expectedRevision: 3,
      }),
      /persists control-only field\(s\): expectedRevision/,
      'a row carrying expectedRevision was accepted'
    );
  });

  await check('every field of a really persisted row is classified', async () => {
    const dataDir = freshDataDir('classified');
    const baseUrl = await bootExpectingSuccess(REPO, dataDir);
    const ws = await newWorkspace(baseUrl);
    await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { a: 1 } });
    const row = readRow(dataDir, ws);
    assert.ok(row, 'wrong premise: no row was persisted');
    const unclassified = Object.keys(row).filter((k) => !(k in store.WRITE_CONTRACT));
    assert.deepStrictEqual(unclassified, [], `persisted row carries unclassified field(s): ${unclassified.join(', ')}`);
    assert.ok(!('expectedRevision' in row), 'expectedRevision leaked into stored state');
    stopServers();
  });

  await check('the row check rejects an unclassified field before anything is persisted', async () => {
    assert.throws(
      () => store.assertRowMatchesContract({
        workspaceId: 'w', agentId: 'a', enabled: true, permissions: {}, config: {},
        recommendedStage: null, createdAt: 't', updatedAt: 't', revision: 0, notes: 'x',
      }),
      /unclassified field\(s\): notes/,
      'an unclassified persisted field was accepted'
    );
  });

  await check('the row check rejects a declared field that has gone missing', async () => {
    assert.throws(
      () => store.assertRowMatchesContract({
        workspaceId: 'w', agentId: 'a', enabled: true, permissions: {}, config: {}, createdAt: 't', updatedAt: 't', revision: 0,
      }),
      /missing declared field\(s\): recommendedStage/,
      'silently dropping a declared dimension was accepted'
    );
  });

  // --- C: adding a real fifth dimension must FAIL LOUDLY ---------------------
  // These build a modified copy of the app and run it. This is the case the
  // previous head could not pass: there, the fifth dimension was persisted with
  // HTTP 200 and no audit record, and every suite stayed green.

  await check('END TO END: an UNCLASSIFIED fifth persisted dimension fails the write loudly', async () => {
    const root = makeAppCopy('unclassified');
    addFifthDimension(root, null);            // persisted, but never declared
    const dataDir = freshDataDir('unclassified');
    const baseUrl = await bootExpectingSuccess(root, dataDir);
    const ws = await newWorkspace(baseUrl);

    const r = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { notes: 'SHOULD-NOT-PERSIST' });
    assert.ok(
      r.status >= 500,
      `an unclassified persisted dimension was accepted with HTTP ${r.status} — this is the exact ` +
      'unaudited accepted transition the contract exists to prevent'
    );
    const row = readRow(dataDir, ws);
    assert.ok(row === null || row.notes === undefined,
      `the refused write still persisted state: ${JSON.stringify(row && row.notes)}`);
    assert.strictEqual(auditEvents(dataDir, ws).length, 0, 'a refused write must emit no audit record');
    stopServers();
  });

  await check('END TO END: a fifth dimension declared SEMANTIC without audit coverage refuses to boot', async () => {
    const root = makeAppCopy('semantic');
    addFifthDimension(root, 'semantic');      // declared, but no detector in the route
    const dataDir = freshDataDir('semantic');
    const outcome = await bootCapturing(root, dataDir);
    assert.ok(outcome.exited, 'the server started while its audit contract was incomplete');
    assert.notStrictEqual(outcome.code, 0, 'the server exited cleanly instead of failing');
    assert.match(
      outcome.stderr,
      /audit contract is incomplete[\s\S]*does not cover: notes/,
      `boot failed for the wrong reason: ${outcome.stderr.slice(0, 400)}`
    );
    stopServers();
  });

  await check('END TO END: classifying a fifth dimension as write_metadata is a deliberate, visible act', async () => {
    // The escape hatch, tested so its existence is explicit rather than a
    // surprise. Misclassifying new state as metadata DOES evade the audit
    // contract — but only by writing that classification into WRITE_CONTRACT,
    // where it is a reviewable line in the diff rather than an omission.
    const root = makeAppCopy('metadata');
    addFifthDimension(root, 'write_metadata');
    const dataDir = freshDataDir('metadata');
    const baseUrl = await bootExpectingSuccess(root, dataDir);
    const ws = await newWorkspace(baseUrl);
    const r = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { notes: 'classified-as-metadata' });
    assert.ok(r.status >= 200 && r.status < 300, `a classified dimension was refused: ${r.status}`);
    assert.strictEqual(readRow(dataDir, ws).notes, 'classified-as-metadata', 'the classified field was not persisted');
    stopServers();
  });

  await check('END TO END: a fully wired fifth dimension is actually audited, guard included', async () => {
    // The completeness chain end to end, and the case that makes the derived
    // emission guard load-bearing rather than decorative. A hand-written
    // `delta.changed || enabledChanged || configChanged || stageChanged` is
    // equivalent to the derived guard for TODAY's four dimensions, so nothing
    // else here can tell them apart. Add a real fifth dimension with a real
    // detector and they diverge: the derived guard emits, a re-hardcoded one
    // stays silent.
    const root = makeAppCopy('wired');
    addFifthDimension(root, 'semantic');
    editFile(root, 'src/featureOnboardApi.js', [
      ['  recommendedStage: (c) => c.stageChanged,', '  recommendedStage: (c) => c.stageChanged,\n  notes: (c) => c.notesChanged,'],
      ['      const ctx = { delta, enabledChanged, configChanged, stageChanged };',
       '      const ctx = { delta, enabledChanged, configChanged, stageChanged,\n'
       + '        notesChanged: (before ? (before.notes === undefined ? null : before.notes) : null) !== row.notes };'],
    ]);
    const dataDir = freshDataDir('wired');
    const baseUrl = await bootExpectingSuccess(root, dataDir);
    const ws = await newWorkspace(baseUrl);

    await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    const n = auditEvents(dataDir, ws).length;

    const r = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { notes: 'a real fifth dimension' });
    assert.ok(r.status >= 200 && r.status < 300, `the wired fifth dimension was refused: ${r.status}`);
    assert.strictEqual(readRow(dataDir, ws).notes, 'a real fifth dimension', 'wrong premise: the fifth dimension did not persist');
    assert.strictEqual(
      auditEvents(dataDir, ws).length - n, 1,
      'a newly wired semantic dimension changed persisted state without emitting an audit record — the ' +
      'emission guard is not actually derived from the detector map'
    );
    stopServers();
  });

  // --- D/E/F: the established behavior must not have moved -------------------
  // The four dimensions' audit OUTPUT, no-op silence and rejection silence are
  // covered in depth by test/permissionAudit.test.js (30 cases). This case
  // pins only what this change could plausibly have broken: that the derived
  // emission guard still emits on a real change and stays silent on a no-op.

  await check('the derived emission guard still emits once on a real change and never on a no-op', async () => {
    const dataDir = freshDataDir('behavior');
    const baseUrl = await bootExpectingSuccess(REPO, dataDir);
    const ws = await newWorkspace(baseUrl);

    const before = auditEvents(dataDir, ws).length;
    const real = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.ok(real.status >= 200 && real.status < 300, `real change refused: ${real.status}`);
    assert.strictEqual(auditEvents(dataDir, ws).length - before, 1, 'a real change must emit exactly one record');

    const mid = auditEvents(dataDir, ws).length;
    const noop = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.ok(noop.status >= 200 && noop.status < 300, `no-op refused: ${noop.status}`);
    assert.strictEqual(auditEvents(dataDir, ws).length - mid, 0, 'a no-op must emit nothing');

    const rej = await call(baseUrl, 'PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { edit_files: true }, expectedRevision: 99,
    });
    assert.strictEqual(rej.status, 409, `expected a stale-revision 409, got ${rej.status}`);
    assert.strictEqual(auditEvents(dataDir, ws).length - mid, 0, 'a rejected write must emit nothing');
    stopServers();
  });

  cleanupAll();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { cleanupAll(); console.error(err); process.exit(1); });
