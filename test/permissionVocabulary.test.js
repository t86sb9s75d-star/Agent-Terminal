// Capability-vocabulary evolution at the permission boundary.
//
// WHY THIS FILE EXISTS SEPARATELY: every other permission test runs against the
// vocabulary compiled into this process, so none of them can produce a row that
// was stored under a DIFFERENT vocabulary — and that is precisely the state
// where the read path and the write path used to disagree. A capability added
// after a row was written read as OFF, rendered unchecked, and then became ON
// the first time anything unrelated was written.
//
// To get a real old row, this suite copies src/ and public/ to a temporary
// directory, runs a server from the COPY, then edits the copy's permissions.js
// and restarts against the same data directory. The repository is never
// modified — a test that mutates tracked source to prove a point leaves the
// branch one crash away from a dirty tree.
//
// THE INVARIANT under test is not "the stored JSON contains every current key".
// It is: the operator-visible effective authority must not change merely
// because an unrelated write caused an old row to be re-normalized.
//
// Run with: node test/permissionVocabulary.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const AGENT = 'interview_agent';
const ON = 'read_workspace_data';   // defaults TRUE
const OFF = 'edit_files';           // defaults FALSE
const UNRELATED = 'spend_money';    // defaults FALSE

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (err) { failed += 1; console.log(`NOT OK - ${name}\n    ${err.message}`); }
}

const temps = [];
// EVERY server ever spawned, not just the current one. Tracking a single
// reference leaked a process per failed case: check() swallows the failure, so
// the end-of-case stopServer() never ran and the next boot() overwrote the
// handle. Six mutation runs left seven orphaned servers behind before this was
// caught — in CI that is an accumulating resource leak, and the working-tree
// check would not notice.
const servers = [];
function stopServer() {
  for (const p of servers.splice(0)) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
}
function cleanupAll() {
  stopServer();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupAll(); process.exit(1); });
}

// A runnable copy of the app. node_modules is symlinked rather than copied.
function makeAppCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-vocab-app-'));
  temps.push(root);
  fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'public'), path.join(root, 'public'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

let baseUrl = null;
async function boot(appRoot, dataDir) {
  stopServer();   // never leave a predecessor running
  const port = 6800 + Math.floor(Math.random() * 200);
  servers.push(spawn(process.execPath, [path.join(appRoot, 'src', 'server.js')], {
    env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${baseUrl}/api/workspaces`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server from ${appRoot} never became ready`);
}
async function reboot(appRoot, dataDir) {
  stopServer();
  await new Promise((r) => setTimeout(r, 600));   // let the instance lock clear
  await boot(appRoot, dataDir);
}

async function api(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, body: json };
}
async function readRow(ws) {
  const r = await api('GET', `/api/workspaces/${ws}/agents`);
  assert.strictEqual(r.status, 200, `agents read failed: ${r.status}`);
  const row = r.body.agents.find((a) => a.id === AGENT);
  return { perms: row.effectivePermissions, rev: row.permissionRevision };
}

// Editors for the COPY's vocabulary.
function addCapability(appRoot, key, consequential) {
  const f = path.join(appRoot, 'src', 'permissions.js');
  const src = fs.readFileSync(f, 'utf8');
  const line = `  { key: '${key}', label: 'Added', consequential: ${consequential}, enforcement: 'recorded_only', enforcementPoint: null, gatedByStoredValue: false },\n];`;
  const next = src.replace(/\n\];/, `\n${line}`);
  assert.notStrictEqual(next, src, 'failed to inject a capability into the copied vocabulary');
  fs.writeFileSync(f, next);
}
function removeCapability(appRoot, key) {
  const f = path.join(appRoot, 'src', 'permissions.js');
  const src = fs.readFileSync(f, 'utf8');
  const next = src.split('\n').filter((l) => !l.includes(`key: '${key}'`)).join('\n');
  assert.notStrictEqual(next, src, `failed to remove ${key} from the copied vocabulary`);
  fs.writeFileSync(f, next);
}

// Build a row under vocabulary V1 with a deliberately mixed authority state, so
// any reset-to-defaults is visible in both directions.
async function seedV1(appRoot) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-vocab-data-'));
  temps.push(dataDir);
  await boot(appRoot, dataDir);
  const stage = require('../src/businessStages').DEFAULT_STAGE;
  const ws = (await api('POST', '/api/workspaces', { name: `vocab-${Math.random().toString(36).slice(2, 7)}`, stage })).body.id;
  const s0 = await readRow(ws);
  const w = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
    permissions: { [ON]: false, [OFF]: true }, expectedRevision: s0.rev,
  });
  assert.ok(w.status >= 200 && w.status < 300, `V1 seed failed: ${w.status} ${JSON.stringify(w.body)}`);
  const s = await readRow(ws);
  assert.strictEqual(s.perms[ON], false, 'V1 seed: the revocation did not persist');
  assert.strictEqual(s.perms[OFF], true, 'V1 seed: the grant did not persist');
  return { dataDir, ws, state: s };
}

(async () => {
  await check('a capability ADDED with default OFF reads OFF before and after an unrelated write', async () => {
    const app = makeAppCopy();
    const { dataDir, ws, state } = await seedV1(app);
    addCapability(app, 'added_off', true);          // consequential -> defaults false
    await reboot(app, dataDir);

    const before = await readRow(ws);
    assert.strictEqual(before.perms.added_off, false, 'a newly added default-OFF capability must read as not granted');
    assert.strictEqual(before.rev, state.rev, 'merely growing the vocabulary must not advance the revision');

    const w = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { [UNRELATED]: true }, expectedRevision: before.rev,
    });
    assert.ok(w.status >= 200 && w.status < 300, `the unrelated write was refused: ${w.status} ${JSON.stringify(w.body)}`);
    const after = await readRow(ws);
    assert.strictEqual(after.perms.added_off, false, 'an unrelated write changed a capability nobody named');
    assert.strictEqual(after.perms[ON], false, 'an unrelated write reinstated a revoked capability');
    assert.strictEqual(after.perms[OFF], true, 'an unrelated write dropped a granted capability');
    stopServer();
  });

  await check('a capability ADDED with default ON reads ON immediately, and an unrelated write does not change it', async () => {
    // THE ORIGINAL DEFECT: the operator saw this unchecked, then an unrelated
    // write materialised it as granted. Read and write disagreed. Whatever the
    // chosen semantics, they must agree — here the capability is effective
    // immediately by definition, so GET says so BEFORE the first write.
    const app = makeAppCopy();
    const { dataDir, ws, state } = await seedV1(app);
    addCapability(app, 'added_on', false);          // non-consequential -> defaults true
    await reboot(app, dataDir);

    const before = await readRow(ws);
    assert.strictEqual(
      before.perms.added_on, true,
      'a newly added default-ON capability must be reported as effective BEFORE any write — otherwise the ' +
      'operator sees it off and a later unrelated write turns it on'
    );
    assert.strictEqual(before.rev, state.rev, 'merely growing the vocabulary must not advance the revision');

    const w = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { [UNRELATED]: true }, expectedRevision: before.rev,
    });
    assert.ok(w.status >= 200 && w.status < 300, `the unrelated write was refused: ${w.status} ${JSON.stringify(w.body)}`);
    const after = await readRow(ws);
    assert.strictEqual(
      after.perms.added_on, before.perms.added_on,
      `an unrelated write changed added_on from ${before.perms.added_on} to ${after.perms.added_on} — the ` +
      'operator was shown one value and a write materialised another'
    );
    assert.strictEqual(after.perms[ON], false, 'an unrelated write reinstated a revoked capability');
    assert.strictEqual(after.perms[OFF], true, 'an unrelated write dropped a granted capability');
    stopServer();
  });

  await check('an empty patch after vocabulary growth is still a no-op and does not advance the revision', async () => {
    const app = makeAppCopy();
    const { dataDir, ws } = await seedV1(app);
    addCapability(app, 'added_on2', false);         // defaults true
    await reboot(app, dataDir);

    const before = await readRow(ws);
    const w = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: {}, expectedRevision: before.rev,
    });
    assert.ok(w.status >= 200 && w.status < 300, `an empty patch was refused: ${w.status} ${JSON.stringify(w.body)}`);
    const after = await readRow(ws);
    assert.strictEqual(
      after.rev, before.rev,
      `materialising a grown vocabulary into storage advanced the revision ${before.rev} -> ${after.rev} — ` +
      'storage mechanics must not masquerade as an operator permission change'
    );
    assert.deepStrictEqual(after.perms, before.perms, 'an empty patch changed effective authority');
    stopServer();
  });

  await check('a capability REMOVED from the vocabulary is not ghost authority and does not brick writes', async () => {
    // Measured before the resolver existed: GET returned the retired key, the
    // client faithfully echoed it back, and every subsequent permission write
    // failed 400 "unknown permission capability" — the agent's permissions
    // became unwritable.
    const app = makeAppCopy();
    const { dataDir, ws } = await seedV1(app);
    removeCapability(app, 'contact_people');
    await reboot(app, dataDir);

    const before = await readRow(ws);
    assert.ok(
      !('contact_people' in before.perms),
      'a capability the vocabulary no longer defines is still being reported as effective authority'
    );

    const w = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { [UNRELATED]: true }, expectedRevision: before.rev,
    });
    assert.ok(
      w.status >= 200 && w.status < 300,
      `a permission write after a capability was retired returned ${w.status} ${JSON.stringify(w.body)} — ` +
      'the retired key made the row unwritable'
    );
    const after = await readRow(ws);
    assert.ok(!('contact_people' in after.perms), 'a retired capability came back');
    assert.strictEqual(after.perms[ON], false, 'the write reinstated a revoked capability');
    assert.strictEqual(after.perms[OFF], true, 'the write dropped a granted capability');
    stopServer();
  });

  cleanupAll();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { cleanupAll(); console.error(err); process.exit(1); });
