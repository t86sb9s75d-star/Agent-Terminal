// Permission audit integrity.
//
// THE INVARIANT:
//
//   The audit history must describe real state transitions truthfully, and with
//   enough information to identify what changed.
//
// Two things that were measured to be false before this suite existed:
//
//   1. A permission write recorded `details: { enabled }` and nothing else.
//      Granting edit_files produced the evidence `{"enabled":false}` — naming
//      neither the capability nor the direction. An independent reviewer could
//      not reconstruct the authority transition from the trail at all.
//
//   2. A write whose requested state already equalled the stored state still
//      emitted `workspace_agent.updated`. The trail asserted an update that
//      provably never happened.
//
// Rejected writes already emitted nothing, and these cases pin that so it
// cannot regress into "every attempt is an update".
//
// EVIDENCE IS READ FROM DISK. Assertions run against events.jsonl — the
// persisted, hash-chained record — not against an API response that summarises
// it. An audit trail that is only correct in memory is not an audit trail, and
// counting events is not the same as reading what they claim.
//
// Run with: node test/permissionAudit.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (err) { failed += 1; console.log(`NOT OK - ${name}\n    ${err.message}`); }
}

let server = null;
let dataDir = null;
let baseUrl = null;
function stopServer() {
  if (server) { server.kill('SIGTERM'); server = null; }
  if (dataDir) { fs.rmSync(dataDir, { recursive: true, force: true }); dataDir = null; }
}
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopServer(); process.exit(1); });
}

async function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-permaudit-'));
  const port = 5100 + Math.floor(Math.random() * 150);
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${baseUrl}/api/workspaces`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never became ready');
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

const AGENT = 'interview_agent';
const ON = 'read_workspace_data';   // defaults TRUE
const A1 = 'edit_files';            // defaults FALSE
const A2 = 'run_commands';          // defaults FALSE

// The persisted, hash-chained audit records — read off disk.
function permissionEvents(ws) {
  const f = path.join(dataDir, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.action === 'workspace_agent.updated' && String(e.entityId) === `${ws}:${AGENT}`);
}

async function state(ws) {
  const r = await api('GET', `/api/workspaces/${ws}/agents`);
  assert.strictEqual(r.status, 200, `agents read failed: ${r.status}`);
  const row = r.body.agents.find((a) => a.id === AGENT);
  return { perms: row.effectivePermissions, rev: row.permissionRevision };
}
async function freshWorkspace(label) {
  const ws = await api('POST', '/api/workspaces', {
    name: `audit-${label}-${Math.random().toString(36).slice(2, 8)}`,
    stage: require('../src/businessStages').DEFAULT_STAGE,
  });
  assert.strictEqual(ws.status, 201, `workspace creation failed: ${JSON.stringify(ws.body)}`);
  return ws.body.id;
}
const write = (ws, permissions, expectedRevision) =>
  api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { permissions, expectedRevision });

// The whole point: can the authority transition be reconstructed from the
// record alone? Compares the record's claim against the measured before/after.
function assertReconstructs(ev, before, after, label) {
  assert.ok(ev, `${label}: no audit record to reconstruct from`);
  const d = ev.details || {};
  assert.ok(Array.isArray(d.permissionsGranted), `${label}: record has no permissionsGranted array`);
  assert.ok(Array.isArray(d.permissionsRevoked), `${label}: record has no permissionsRevoked array`);

  const trulyGranted = Object.keys(before.perms).filter((k) => before.perms[k] === false && after.perms[k] === true).sort();
  const trulyRevoked = Object.keys(before.perms).filter((k) => before.perms[k] === true && after.perms[k] === false).sort();

  assert.deepStrictEqual(
    d.permissionsGranted, trulyGranted,
    `${label}: the record claims granted=${JSON.stringify(d.permissionsGranted)} but the persisted transition granted ${JSON.stringify(trulyGranted)}`
  );
  assert.deepStrictEqual(
    d.permissionsRevoked, trulyRevoked,
    `${label}: the record claims revoked=${JSON.stringify(d.permissionsRevoked)} but the persisted transition revoked ${JSON.stringify(trulyRevoked)}`
  );
  assert.strictEqual(d.permissionRevisionFrom, before.rev, `${label}: wrong revision-from`);
  assert.strictEqual(d.permissionRevisionTo, after.rev, `${label}: wrong revision-to`);
}

(async () => {
  await startServer();

  await check('a real transition records which capability was granted, and the revision it moved through', async () => {
    const ws = await freshWorkspace('real');
    const before = await state(ws);
    const n = permissionEvents(ws).length;

    const r = await write(ws, { [A1]: true }, before.rev);
    assert.ok(r.status >= 200 && r.status < 300, `the write was refused: ${r.status}`);
    const after = await state(ws);
    assert.strictEqual(after.perms[A1], true, 'precondition: the grant did not persist');

    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, `expected exactly one audit record, got ${evs.length - n}`);
    assertReconstructs(evs[evs.length - 1], before, after, 'single grant');
  });

  await check('a NO-OP write emits no audit record at all', async () => {
    // The fabrication case. Before this, re-sending a value already in force
    // recorded `workspace_agent.updated` — the trail asserted an update that
    // provably did not happen, and after the revision fix it did not even
    // correspond to a revision change.
    const ws = await freshWorkspace('noop');
    let s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);
    s = await state(ws);
    const n = permissionEvents(ws).length;

    const r = await write(ws, { [A1]: true }, s.rev);
    assert.ok(r.status >= 200 && r.status < 300, `the no-op was refused: ${r.status}`);
    const after = await state(ws);
    assert.strictEqual(after.rev, s.rev, 'precondition: the no-op moved the revision');
    assert.deepStrictEqual(after.perms, s.perms, 'precondition: the no-op changed state');

    assert.strictEqual(
      permissionEvents(ws).length, n,
      'a write that changed no authority produced an audit record — the trail claims a transition that never happened'
    );
  });

  await check('an EMPTY patch emits no audit record', async () => {
    const ws = await freshWorkspace('empty');
    let s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);
    s = await state(ws);
    const n = permissionEvents(ws).length;

    const r = await write(ws, {}, s.rev);
    assert.ok(r.status >= 200 && r.status < 300, `the empty patch was refused: ${r.status}`);
    assert.strictEqual(permissionEvents(ws).length, n, 'an empty patch fabricated an audit record');
  });

  await check('a REJECTED stale write emits no audit record and does not appear as a change', async () => {
    const ws = await freshWorkspace('stale');
    let s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);
    s = await state(ws);
    const n = permissionEvents(ws).length;

    const r = await write(ws, { [A2]: true }, 0);
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    assert.strictEqual(
      permissionEvents(ws).length, n,
      'a refused stale write produced an audit record — a rejection must never read as a successful authority change'
    );
    assert.strictEqual((await state(ws)).perms[A2], false, 'the refused write altered state');
  });

  await check('a REJECTED malformed write emits no audit record', async () => {
    const ws = await freshWorkspace('malformed');
    const s = await state(ws);
    const n = permissionEvents(ws).length;
    const r = await write(ws, { [A1]: 'yes' }, s.rev);
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.strictEqual(permissionEvents(ws).length, n, 'a refused malformed write produced an audit record');
  });

  await check('a REJECTED unknown capability emits no audit record', async () => {
    const ws = await freshWorkspace('unknown');
    const s = await state(ws);
    const n = permissionEvents(ws).length;
    const r = await write(ws, { made_up_capability: true }, s.rev);
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.strictEqual(
      permissionEvents(ws).length, n,
      'an unknown capability produced an audit record — a rejected write must not look like an accepted one'
    );
  });

  await check('a MULTI-KEY change names every capability that moved', async () => {
    const ws = await freshWorkspace('multi');
    const before = await state(ws);
    const n = permissionEvents(ws).length;

    await write(ws, { [A1]: true, [A2]: true }, before.rev);
    const after = await state(ws);
    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, 'expected exactly one record for one accepted write');
    assertReconstructs(evs[evs.length - 1], before, after, 'multi-key');
    assert.deepStrictEqual(evs[evs.length - 1].details.permissionsGranted, [A1, A2].sort(), 'both grants must be named');
  });

  await check('a MIXED grant + revoke attributes each direction correctly', async () => {
    // The case that catches a delta computed with the direction reversed: one
    // capability moves false->true and another true->false in the SAME write,
    // so swapping the two arrays cannot look correct by accident.
    const ws = await freshWorkspace('mixed');
    let s = await state(ws);
    assert.strictEqual(s.perms[ON], true, 'precondition: ON must start granted');
    assert.strictEqual(s.perms[A1], false, 'precondition: A1 must start revoked');

    const before = await state(ws);
    const n = permissionEvents(ws).length;
    await write(ws, { [A1]: true, [ON]: false }, before.rev);   // grant one, revoke one
    const after = await state(ws);
    assert.strictEqual(after.perms[A1], true, 'precondition: the grant did not persist');
    assert.strictEqual(after.perms[ON], false, 'precondition: the revocation did not persist');

    const ev = permissionEvents(ws)[permissionEvents(ws).length - 1];
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'expected exactly one record');
    assertReconstructs(ev, before, after, 'mixed');
    assert.deepStrictEqual(ev.details.permissionsGranted, [A1], 'the grant is in the wrong array');
    assert.deepStrictEqual(ev.details.permissionsRevoked, [ON], 'the revocation is in the wrong array');
  });

  await check('a non-permission change is still audited, with an honestly EMPTY permission delta', async () => {
    // Enabling an agent is a real change and must stay audited. It must not
    // invent a permission delta to justify the record.
    const ws = await freshWorkspace('enabled');
    const n = permissionEvents(ws).length;
    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.ok(r.status >= 200 && r.status < 300, `enabling was refused: ${r.status}`);

    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, 'enabling an agent must still be audited');
    const d = evs[evs.length - 1].details;
    assert.strictEqual(d.enabled, true, 'the record must carry the new enabled value');
    assert.deepStrictEqual(d.permissionsGranted, [], 'a non-permission change must not invent grants');
    assert.deepStrictEqual(d.permissionsRevoked, [], 'a non-permission change must not invent revocations');
  });

  await check('the recorded delta matches PERSISTED state, not the submitted request', async () => {
    // A request may name capabilities whose values do not change. The evidence
    // must describe the accepted transition, so re-stating one value in force
    // while changing another records only the one that moved.
    const ws = await freshWorkspace('persisted');
    let s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);
    s = await state(ws);

    const before = await state(ws);
    await write(ws, { [A1]: true, [A2]: true }, before.rev);   // A1 re-stated, A2 actually changes
    const after = await state(ws);
    const ev = permissionEvents(ws)[permissionEvents(ws).length - 1];

    assert.deepStrictEqual(
      ev.details.permissionsGranted, [A2],
      `the record claims ${JSON.stringify(ev.details.permissionsGranted)} — a value merely re-stated in the ` +
      'request is not a transition, so the delta must come from persisted before/after'
    );
    assertReconstructs(ev, before, after, 'request vs persisted');
  });

  await check('delta arrays are deterministically ordered', async () => {
    // Two writes producing the same transition must serialise identically, so a
    // consumer comparing records is comparing semantics, not key order.
    const seen = [];
    for (let i = 0; i < 2; i += 1) {
      const ws = await freshWorkspace(`order${i}`);
      const s = await state(ws);
      await write(ws, { [A2]: true, [A1]: true }, s.rev);   // deliberately reversed key order
      const ev = permissionEvents(ws)[permissionEvents(ws).length - 1];
      seen.push(JSON.stringify(ev.details.permissionsGranted));
    }
    assert.strictEqual(seen[0], seen[1], `the same transition serialised two ways: ${seen.join(' vs ')}`);
    assert.strictEqual(seen[0], JSON.stringify([A1, A2].sort()), 'delta arrays must be sorted');
  });

  await check('audit evidence and persisted authority do not diverge across a sequence', async () => {
    // Replay the whole trail and check it reproduces the final stored state.
    // This is the end-to-end form of the invariant: the history must be enough
    // to reconstruct where the row ended up.
    const ws = await freshWorkspace('replay');
    let s = await state(ws);
    for (const patch of [{ [A1]: true }, { [A2]: true }, { [ON]: false }, { [A1]: false }]) {
      const r = await write(ws, patch, s.rev);
      assert.ok(r.status >= 200 && r.status < 300, `setup write refused: ${r.status}`);
      s = await state(ws);
    }

    const replayed = (await state(ws)) && require('../src/permissions').defaultPermissionsFor();
    for (const ev of permissionEvents(ws)) {
      for (const k of ev.details.permissionsGranted) replayed[k] = true;
      for (const k of ev.details.permissionsRevoked) replayed[k] = false;
    }
    const actual = (await state(ws)).perms;
    assert.deepStrictEqual(
      replayed, actual,
      'replaying every audit delta from the default state does not reproduce the persisted permissions — ' +
      'the trail and the stored authority have diverged'
    );
  });

  stopServer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { stopServer(); console.error(err); process.exit(1); });
