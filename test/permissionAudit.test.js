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

// The PERSISTED settings row, read from the store file rather than from the
// API — recommendedStage and config are not surfaced by GET .../agents as
// top-level fields, and the question here is what was actually written.
function persistedRow(ws) {
  const f = path.join(dataDir, 'workspace_agent_settings.json');
  if (!fs.existsSync(f)) return null;
  const env = JSON.parse(fs.readFileSync(f, 'utf8'));
  const recs = Array.isArray(env) ? env : (env.records || env.data || []);
  return recs.find((r) => r.workspaceId === ws && r.agentId === AGENT) || null;
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

  // ---------------------------------------------------------------------
  // EVERY INDEPENDENTLY MUTABLE DIMENSION OF THIS ROW.
  //
  // The emission condition is only correct if it covers the COMPLETE set of
  // state this endpoint can move. Derived from upsert()'s parameter list, that
  // set is: permissions, enabled, config, recommendedStage. The cases above
  // cover permissions thoroughly and enabled partially. These cover the rest,
  // and the failure they exist for is the one that was measured on the first
  // version of this route: a recommendedStage-only write changed persisted
  // state (null -> "growth", HTTP 200) and emitted nothing at all.
  // ---------------------------------------------------------------------

  await check('a recommendedStage-only change is audited and names both sides', async () => {
    const ws = await freshWorkspace('stage');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });   // row now exists
    const rowBefore = persistedRow(ws);
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { recommendedStage: 'growth' });
    assert.ok(r.status >= 200 && r.status < 300, `stage write was refused: ${r.status}`);

    const rowAfter = persistedRow(ws);
    assert.strictEqual(rowAfter.recommendedStage, 'growth', 'the store did not persist the stage — wrong premise');
    assert.notStrictEqual(rowBefore.recommendedStage, rowAfter.recommendedStage, 'no transition to audit — wrong premise');

    const evs = permissionEvents(ws);
    assert.strictEqual(
      evs.length - n, 1,
      'a recommendedStage transition was persisted with no audit record — an accepted state change ' +
      'is invisible to the trail'
    );
    const d = evs[evs.length - 1].details;
    assert.strictEqual(d.recommendedStageFrom, rowBefore.recommendedStage, 'record misstates the stage it moved FROM');
    assert.strictEqual(d.recommendedStageTo, rowAfter.recommendedStage, 'record misstates the stage it moved TO');
    assert.deepStrictEqual(d.permissionsGranted, [], 'a stage change must not invent grants');
    assert.deepStrictEqual(d.permissionsRevoked, [], 'a stage change must not invent revocations');
    assert.strictEqual(
      d.permissionRevisionFrom, d.permissionRevisionTo,
      'a stage change must not move the permission revision'
    );
  });

  await check('a recommendedStage NO-OP emits nothing', async () => {
    const ws = await freshWorkspace('stagenoop');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, recommendedStage: 'growth' });
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { recommendedStage: 'growth' });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(persistedRow(ws).recommendedStage, 'growth', 'stage should be unmoved');
    assert.strictEqual(
      permissionEvents(ws).length - n, 0,
      're-stating the stage already stored fabricated an update that did not happen'
    );
  });

  await check('an enabled NO-OP emits nothing', async () => {
    const ws = await freshWorkspace('enablednoop');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(persistedRow(ws).enabled, true, 'enabled should be unmoved');
    assert.strictEqual(
      permissionEvents(ws).length - n, 0,
      're-stating enabled:true fabricated an update that did not happen'
    );
  });

  await check('a config change is audited', async () => {
    const ws = await freshWorkspace('config');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { a: 1 } });
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { a: 2 } });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.deepStrictEqual(persistedRow(ws).config, { a: 2 }, 'the store did not persist the config — wrong premise');
    assert.strictEqual(
      permissionEvents(ws).length - n, 1,
      'a real config change must stay audited'
    );
  });

  await check('a config key-order-only change is a semantic NO-OP and emits nothing', async () => {
    // A JSON object is an unordered collection, and this config bag has no
    // consumer anywhere in src/ or public/ — nothing can observe key order, so
    // reordering keys is not a state transition. Measured with the old
    // JSON.stringify comparison this emitted an event: an assertion that a
    // configuration changed when it had not.
    const ws = await freshWorkspace('configorder');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { a: 1, b: 2 } });
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { b: 2, a: 1 } });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(
      permissionEvents(ws).length - n, 0,
      'reordering config keys emitted an update — the record asserts a configuration change that ' +
      'did not semantically occur'
    );

    // Nested objects reorder too, and must be judged the same way.
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { outer: { x: 1, y: 2 } } });
    const n2 = permissionEvents(ws).length;
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { outer: { y: 2, x: 1 } } });
    assert.strictEqual(permissionEvents(ws).length - n2, 0, 'a nested key reorder is still a semantic no-op');
  });

  await check('config ARRAY order IS meaningful and still counts as a change', async () => {
    // The counterpart to the case above, and the reason the comparison must be
    // deep-structural rather than "sort everything": arrays are ordered, so
    // [1,2] -> [2,1] is a real change and losing it would be a false negative.
    const ws = await freshWorkspace('configarray');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { list: [1, 2] } });
    const n = permissionEvents(ws).length;

    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { list: [2, 1] } });
    assert.deepStrictEqual(persistedRow(ws).config, { list: [2, 1] }, 'wrong premise: array not persisted');
    assert.strictEqual(
      permissionEvents(ws).length - n, 1,
      'reordering an array is a real change and must not be swallowed as a no-op'
    );
  });

  await check('a permission-only change does not claim a stage transition', async () => {
    // Guards the other direction: the stage fields must appear only when the
    // stage actually moved, never as decoration on an unrelated record.
    const ws = await freshWorkspace('nostage');
    const s = await state(ws);
    const n = permissionEvents(ws).length;
    await write(ws, { [A1]: true }, s.rev);

    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, 'expected exactly one record');
    const d = evs[evs.length - 1].details;
    assert.ok(
      !('recommendedStageFrom' in d) && !('recommendedStageTo' in d),
      `record claims a stage transition that did not happen: ${JSON.stringify(d)}`
    );
  });

  await check('several dimensions moving in ONE request produce ONE truthful record', async () => {
    const ws = await freshWorkspace('multidim');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: false, config: { a: 1 } });
    const before = await state(ws);
    const rowBefore = persistedRow(ws);
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      enabled: true,
      config: { a: 2 },
      recommendedStage: 'scale',
      permissions: { [A1]: true },
      expectedRevision: before.rev,
    });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status} ${JSON.stringify(r.body)}`);
    const after = await state(ws);

    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, 'four dimensions moving together is still one accepted change');
    const d = evs[evs.length - 1].details;
    assert.strictEqual(d.enabled, true, 'record misstates enabled');
    assert.strictEqual(d.recommendedStageFrom, rowBefore.recommendedStage, 'record misstates the stage it moved FROM');
    assert.strictEqual(d.recommendedStageTo, 'scale', 'record misstates the stage it moved TO');
    assertReconstructs(evs[evs.length - 1], before, after, 'multi-dimension');
    assert.deepStrictEqual(d.permissionsGranted, [A1], 'the permission delta must stay truthful alongside the rest');
    // This case deliberately moves config too. Asserting only the other three
    // dimensions would prove "a config change causes an event" while leaving
    // "the record identifies the config transition" untested — which is exactly
    // how the config evidence gap survived a green suite.
    assert.strictEqual(d.enabledFrom, false, 'record misstates the enabled value it moved FROM');
    assert.deepStrictEqual(d.configKeysChanged, ['a'], 'the config transition must be named alongside the others');
    assert.deepStrictEqual(d.configKeysAdded, [], 'nothing was added to config');
    assert.deepStrictEqual(d.configKeysRemoved, [], 'nothing was removed from config');
    assert.notStrictEqual(d.configFrom, d.configTo, 'a real config transition must not have equal fingerprints');
  });

  await check('a rejected write moves no dimension and emits nothing, even when it names them all', async () => {
    // The rejection cases above send only permissions. This one sends every
    // dimension at once with a stale revision: the whole write must be refused
    // as a unit, leaving no partial state change and no record.
    const ws = await freshWorkspace('rejectall');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { a: 1 } });
    const s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);            // advance the revision
    const rowBefore = persistedRow(ws);
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      enabled: false, config: { a: 99 }, recommendedStage: 'growth',
      permissions: { [A2]: true }, expectedRevision: 0,   // stale
    });
    assert.strictEqual(r.status, 409, `expected a 409 conflict, got ${r.status}`);
    assert.deepStrictEqual(
      persistedRow(ws), rowBefore,
      'a refused write changed persisted state — the refusal was not atomic'
    );
    assert.strictEqual(permissionEvents(ws).length - n, 0, 'a refused write must emit nothing');
  });

  // ---------------------------------------------------------------------
  // EVIDENCE, NOT JUST EMISSION.
  //
  // Detecting a change and describing it are different guarantees. Measured on
  // the previous head, a config-only transition {mode:"A"} -> {mode:"B"} emitted
  // exactly this record:
  //
  //   {"enabled":true,"permissionsGranted":[],"permissionsRevoked":[],
  //    "permissionRevisionFrom":0,"permissionRevisionTo":0}
  //
  // No field in it refers to config at all, so a reader could not tell that
  // config was the thing that moved — the same failure that was fixed for
  // recommendedStage, left in place for config.
  //
  // THE CONTRACT FOR CONFIG IS DELIBERATELY NOT "RECONSTRUCT THE VALUES".
  // config is a schemaless bag whose keys are chosen by the caller at write
  // time. The project's existing convention for configuration history
  // (configHistoryStore.js) does record before/after VALUES, but only over a
  // fixed TRACKED_FIELDS list with a curated REDACTED_FIELDS allowlist, under a
  // stated rule that a secret-bearing field must be registered there before it
  // ships. That discipline cannot be applied to a map with no schema — you
  // cannot pre-register the secret-bearing key names of a bag the caller
  // invents. events.jsonl is append-only and hash-chained, so a value written
  // here can never be redacted without breaking the chain.
  //
  // So the record identifies WHICH keys moved (names only, never values) and
  // pins each side with a canonical fingerprint. That lets an auditor holding a
  // candidate config prove or disprove it was the state at that moment, with no
  // disclosure. These cases enforce both halves: the evidence is present, and
  // the values are not.
  // ---------------------------------------------------------------------

  // Independent reimplementation of the canonical hash. Deliberately NOT
  // imported from the route: importing the implementation under test would make
  // a bug in it invisible to these assertions.
  const crypto = require('crypto');
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  const fingerprint = (cfg) => crypto.createHash('sha256').update(canonical(cfg || {})).digest('hex');

  await check('a config-only transition is IDENTIFIED in the record, not merely counted', async () => {
    const ws = await freshWorkspace('cfgevid');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { mode: 'A' } });
    const cfgBefore = persistedRow(ws).config;
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { mode: 'B' } });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    const cfgAfter = persistedRow(ws).config;
    assert.deepStrictEqual(cfgAfter, { mode: 'B' }, 'wrong premise: config not persisted');

    const evs = permissionEvents(ws);
    assert.strictEqual(evs.length - n, 1, 'a config change must be audited');
    const d = evs[evs.length - 1].details;
    assert.deepStrictEqual(d.configKeysChanged, ['mode'], 'the record must name the key that moved');
    assert.deepStrictEqual(d.configKeysAdded, [], 'nothing was added');
    assert.deepStrictEqual(d.configKeysRemoved, [], 'nothing was removed');
    assert.strictEqual(d.configFrom, fingerprint(cfgBefore), 'configFrom does not pin the persisted BEFORE state');
    assert.strictEqual(d.configTo, fingerprint(cfgAfter), 'configTo does not pin the persisted AFTER state');
    assert.notStrictEqual(d.configFrom, d.configTo, 'a real transition must not have equal fingerprints');
  });

  await check('config VALUES never reach the append-only audit log', async () => {
    // The privacy half of the contract. events.jsonl cannot be redacted later
    // without breaking the hash chain, so a value written here is permanent.
    const ws = await freshWorkspace('cfgsecret');
    const CANARY = 'sk-canary-VALUE-must-never-be-logged-9f3a2b';
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { token: 'old-value-also-secret' } });
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { token: CANARY } });

    const raw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
    assert.ok(!raw.includes(CANARY), 'a config VALUE was copied into the append-only audit log');
    assert.ok(!raw.includes('old-value-also-secret'), 'a previous config VALUE was copied into the audit log');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.deepStrictEqual(d.configKeysChanged, ['token'], 'the key NAME is the evidence, and it must be present');
  });

  await check('config evidence distinguishes added, removed and changed keys', async () => {
    const ws = await freshWorkspace('cfgkeys');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { keep: 1, drop: 2, edit: 3 } });
    const n = permissionEvents(ws).length;

    const cfgBefore = persistedRow(ws).config;
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { keep: 1, edit: 4, fresh: 5 } });
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'expected exactly one record');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.deepStrictEqual(d.configKeysAdded, ['fresh'], 'added key misreported');
    assert.deepStrictEqual(d.configKeysRemoved, ['drop'], 'removed key misreported');
    assert.deepStrictEqual(d.configKeysChanged, ['edit'], 'changed key misreported — `keep` did not move');

    // Both sides here hold SEVERAL keys in non-alphabetical insertion order, so
    // a fingerprint computed over raw JSON.stringify would differ from the
    // canonical one. The single-key cases elsewhere cannot tell those apart —
    // this is the case that pins canonicalisation.
    assert.ok(Object.keys(cfgBefore).length > 1, 'wrong premise: need a multi-key config to detect key ordering');
    assert.strictEqual(d.configFrom, fingerprint(cfgBefore), 'configFrom is not the CANONICAL fingerprint of the before state');
    assert.strictEqual(d.configTo, fingerprint(persistedRow(ws).config), 'configTo is not the CANONICAL fingerprint of the after state');
  });

  await check('a config fingerprint is blind to key order but not to values', async () => {
    // Direct statement of the equality semantics the fingerprint must have, and
    // the tie back to the no-op rule: two configs the route considers equal must
    // fingerprint equal, or the record would contradict the route's own
    // decision that a reorder is not a change.
    const ws = await freshWorkspace('cfgfp');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { x: 1, y: 2, z: 3 } });
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { config: { p: 0 } });          // real change
    const viaOrderA = permissionEvents(ws)[permissionEvents(ws).length - 1].details.configFrom;

    const ws2 = await freshWorkspace('cfgfp2');
    await api('PUT', `/api/workspaces/${ws2}/agents/${AGENT}`, { enabled: true, config: { z: 3, x: 1, y: 2 } }); // same content, other order
    await api('PUT', `/api/workspaces/${ws2}/agents/${AGENT}`, { config: { p: 0 } });
    const viaOrderB = permissionEvents(ws2)[permissionEvents(ws2).length - 1].details.configFrom;

    assert.strictEqual(viaOrderA, viaOrderB, 'the same configuration fingerprinted differently depending on key order');

    const ws3 = await freshWorkspace('cfgfp3');
    await api('PUT', `/api/workspaces/${ws3}/agents/${AGENT}`, { enabled: true, config: { x: 1, y: 2, z: 4 } }); // one VALUE differs
    await api('PUT', `/api/workspaces/${ws3}/agents/${AGENT}`, { config: { p: 0 } });
    const different = permissionEvents(ws3)[permissionEvents(ws3).length - 1].details.configFrom;
    assert.notStrictEqual(different, viaOrderA, 'configs differing in a VALUE must not fingerprint identically');
  });

  await check('config evidence is absent when config did not move', async () => {
    // The counterpart to the case above: a permission-only write must not
    // decorate its record with a config transition that did not happen.
    const ws = await freshWorkspace('cfgabsent');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { a: 1 } });
    const s = await state(ws);
    const n = permissionEvents(ws).length;

    await write(ws, { [A1]: true }, s.rev);
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'expected exactly one record');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    for (const k of ['configKeysAdded', 'configKeysRemoved', 'configKeysChanged', 'configFrom', 'configTo']) {
      assert.ok(!(k in d), `record claims a config transition that did not happen: ${k} present`);
    }
  });

  await check('a config key REORDER alongside a real change claims no config transition', async () => {
    // The sharpest case for the fingerprint: an event IS emitted (enabled
    // moved), so "no event" cannot hide a wrong answer here. The record must
    // still not claim config changed, and this is what catches a fingerprint
    // computed over non-canonical JSON.
    const ws = await freshWorkspace('cfgreorder');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: false, config: { a: 1, b: 2 } });
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { b: 2, a: 1 } });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'the enabled change must still be audited');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.strictEqual(d.enabledTo, true, 'the enabled transition must be recorded');
    assert.ok(
      !('configKeysChanged' in d) && !('configFrom' in d),
      `record claims a config transition for a key reorder: ${JSON.stringify(d)}`
    );
  });

  await check('config and another dimension moving together are BOTH identified', async () => {
    const ws = await freshWorkspace('cfgmixed');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: false, config: { mode: 'A' } });
    const cfgBefore = persistedRow(ws).config;
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true, config: { mode: 'B' } });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'one accepted change is one record');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.strictEqual(d.enabledFrom, false, 'the enabled transition must name where it came from');
    assert.strictEqual(d.enabledTo, true, 'the enabled transition must name where it went');
    assert.deepStrictEqual(d.configKeysChanged, ['mode'], 'the config transition must not be masked by the enabled one');
    assert.strictEqual(d.configFrom, fingerprint(cfgBefore), 'configFrom must pin the persisted before state');
    assert.strictEqual(d.configTo, fingerprint(persistedRow(ws).config), 'configTo must pin the persisted after state');
  });

  await check('an enabled transition names both sides, and is absent when enabled did not move', async () => {
    // Measured on the previous head: the record carried `enabled: <result>` on
    // EVERY event, so a reader could not tell whether enabled had moved. That
    // is the same gap that was closed for recommendedStage.
    const ws = await freshWorkspace('enabledevid');
    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    const n = permissionEvents(ws).length;

    await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: false });
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'expected exactly one record');
    assert.strictEqual(d.enabledFrom, true, 'record misstates the enabled value it moved FROM');
    assert.strictEqual(d.enabledTo, false, 'record misstates the enabled value it moved TO');

    // Now a permission-only change with enabled deliberately unchanged.
    const s = await state(ws);
    await write(ws, { [A1]: true }, s.rev);
    const d2 = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.deepStrictEqual(d2.permissionsGranted, [A1], 'wrong premise: the permission change did not land');
    assert.ok(
      !('enabledFrom' in d2) && !('enabledTo' in d2),
      `record claims an enabled transition that did not happen: ${JSON.stringify(d2)}`
    );
  });

  await check('the first event for a newly materialized row reports no prior enabled state', async () => {
    // There was no row before, so there is no previous boolean to name. null
    // says that honestly rather than implying a false -> true transition that
    // never had a `false` side.
    const ws = await freshWorkspace('firstevent');
    const n = permissionEvents(ws).length;

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.ok(r.status >= 200 && r.status < 300, `refused: ${r.status}`);
    assert.strictEqual(permissionEvents(ws).length - n, 1, 'materializing a row with enabled:true is a real change');
    const d = permissionEvents(ws)[permissionEvents(ws).length - 1].details;
    assert.strictEqual(d.enabledFrom, null, 'no settings row existed, so enabledFrom must be null, not false');
    assert.strictEqual(d.enabledTo, true, 'enabledTo must be the persisted value');
  });

  stopServer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { stopServer(); console.error(err); process.exit(1); });
