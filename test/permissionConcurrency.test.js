// A-002 — permission lost update.
//
// THE INVARIANT UNDER TEST:
//
//   Once permission mutation A has been accepted, a later mutation B derived
//   from stale state may not SILENTLY erase A.
//
// The system may satisfy this either by preserving both non-conflicting
// changes, or by explicitly rejecting the stale write. A silent lost update is
// forbidden.
//
// This exercises the real persistence/API path against a real server process.
// There are NO timing sleeps: staleness is constructed deliberately by holding
// a snapshot, not by racing the clock. That distinction matters — the previous
// frontend test only ever hit this defect by accident on a slow runner, which
// made it look like a flaky test rather than a lost-update bug.
//
// Run with: node test/permissionConcurrency.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`NOT OK - ${name}\n    ${err.message}`);
  }
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

function startServer() {
  return new Promise((resolve) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-permconc-'));
    const port = 4800 + Math.floor(Math.random() * 400);
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    baseUrl = `http://127.0.0.1:${port}`;
    let out = '';
    const onData = (b) => { out += b.toString(); if (/listening|running|127\.0\.0\.1/i.test(out)) resolve(); };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    setTimeout(resolve, 3000);
  });
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
const CAP_A = 'edit_files';      // starts false (consequential -> least authority)
const CAP_B = 'run_commands';    // starts false
const CAP_C = 'read_workspace_data'; // starts true

// A fresh workspace per case, so no case can inherit another's state.
async function freshWorkspace(label) {
  const ws = await api('POST', '/api/workspaces', { name: `perm-${label}-${Math.random().toString(36).slice(2, 8)}`, stage: require('../src/businessStages').DEFAULT_STAGE });
  assert.strictEqual(ws.status, 201, `workspace creation failed: ${JSON.stringify(ws.body)}`);
  return ws.body.id;
}

// The authoritative read: what the server actually persisted.
async function readPerms(wsId) {
  const res = await api('GET', `/api/workspaces/${wsId}/agents`);
  assert.strictEqual(res.status, 200, `agents read failed: ${res.status}`);
  const row = res.body.agents.find((a) => a.id === AGENT);
  assert.ok(row, 'agent row missing');
  // The snapshot carries the revision it was read at — that is what makes a
  // stale client stale in a way the server can actually detect.
  const perms = { ...row.effectivePermissions };
  Object.defineProperty(perms, '__rev', { value: row.permissionRevision, enumerable: false });
  return perms;
}

// Reproduces EXACTLY what public/onboard.js does: build the whole map from a
// (possibly stale) snapshot and PUT it.
async function putWholeMapFromSnapshot(wsId, snapshot, capability, value) {
  return api('PUT', `/api/workspaces/${wsId}/agents/${AGENT}`, {
    permissions: { ...snapshot, [capability]: value },
    expectedRevision: snapshot.__rev,
  });
}

// Classify an outcome so every case reports the same four dimensions.
function classify({ status }) {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 409) return 'rejected-as-stale';
  return `rejected-${status}`;
}

(async () => {
  await startServer();
  for (let i = 0; i < 40; i += 1) {
    try { await api('GET', '/api/workspaces'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  // ================================================================
  // THE CORE INVARIANT — this is the case that fails on unmodified main
  // ================================================================
  await check('LOST UPDATE: a stale write must not silently erase an accepted grant', async () => {
    const ws = await freshWorkspace('core');
    const snapshot0 = await readPerms(ws);           // both clients read the same state

    const a = await putWholeMapFromSnapshot(ws, snapshot0, CAP_A, true);
    assert.strictEqual(classify(a), 'accepted', `mutation A was not accepted: ${a.status}`);
    const afterA = await readPerms(ws);
    assert.strictEqual(afterA[CAP_A], true, 'precondition failed: A was not persisted, so nothing can be erased');

    // B is derived from snapshot0 — it has never seen A.
    const b = await putWholeMapFromSnapshot(ws, snapshot0, CAP_B, true);
    const bOutcome = classify(b);

    const final = await readPerms(ws);

    // Either B is refused as stale, or both survive. Silence is forbidden.
    if (bOutcome === 'accepted') {
      assert.strictEqual(
        final[CAP_A], true,
        `SILENT LOST UPDATE: mutation A (${CAP_A}=true) was accepted, then a stale mutation B ` +
        `(${CAP_B}=true) was ALSO accepted and erased it. Final ${CAP_A}=${final[CAP_A]}, ${CAP_B}=${final[CAP_B]}. ` +
        'The server must either preserve both non-conflicting changes or refuse the stale write.'
      );
      assert.strictEqual(final[CAP_B], true, 'B was accepted but not persisted');
    } else {
      assert.strictEqual(bOutcome, 'rejected-as-stale', `B was refused, but not as a stale-write conflict: ${b.status}`);
      assert.strictEqual(final[CAP_A], true, 'B was refused yet A was still lost');
    }
  });

  // ================================================================
  // ORDER INDEPENDENCE — the property must not depend on arrival order
  // ================================================================
  await check('ORDER: B then A from a shared stale snapshot behaves identically', async () => {
    const ws = await freshWorkspace('order');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_B, true);
    const r = await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      assert.strictEqual(final[CAP_B], true, `SILENT LOST UPDATE (reversed order): ${CAP_B} was erased by a stale write`);
      assert.strictEqual(final[CAP_A], true, 'the second mutation was accepted but not persisted');
    }
  });

  await check('ORDER: two INDEPENDENTLY stale snapshots both survive or are refused', async () => {
    const ws = await freshWorkspace('indep');
    const sX = await readPerms(ws);
    const sY = await readPerms(ws);   // a second client, same starting view
    await putWholeMapFromSnapshot(ws, sX, CAP_A, true);
    const r = await putWholeMapFromSnapshot(ws, sY, CAP_B, true);
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      assert.strictEqual(final[CAP_A], true, 'SILENT LOST UPDATE: an independently stale client erased an accepted grant');
    }
  });

  await check('CONCURRENT: simultaneous mutations from one snapshot cannot silently drop one', async () => {
    const ws = await freshWorkspace('conc');
    const s0 = await readPerms(ws);
    const [ra, rb] = await Promise.all([
      putWholeMapFromSnapshot(ws, s0, CAP_A, true),
      putWholeMapFromSnapshot(ws, s0, CAP_B, true),
    ]);
    const final = await readPerms(ws);
    const acceptedCount = [ra, rb].filter((r) => classify(r) === 'accepted').length;
    if (acceptedCount === 2) {
      assert.ok(
        final[CAP_A] === true && final[CAP_B] === true,
        `SILENT LOST UPDATE under concurrency: both writes were accepted but the result kept only ` +
        `${CAP_A}=${final[CAP_A]}, ${CAP_B}=${final[CAP_B]}`
      );
    } else {
      assert.ok(acceptedCount >= 1, 'both concurrent writes were refused — no progress is possible');
    }
  });

  // ================================================================
  // NON-CONFLICTING GRANT + REVOKE, AND SAME-KEY SEMANTICS
  // ================================================================
  await check('MIXED: a grant and a revoke on DIFFERENT capabilities do not erase each other', async () => {
    const ws = await freshWorkspace('mixed');
    const s0 = await readPerms(ws);
    assert.strictEqual(s0[CAP_C], true, 'precondition: CAP_C should start granted');
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);      // grant
    const r = await putWholeMapFromSnapshot(ws, s0, CAP_C, false); // revoke, from stale state
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      assert.strictEqual(final[CAP_A], true, 'SILENT LOST UPDATE: a stale revoke erased an accepted grant');
      assert.strictEqual(final[CAP_C], false, 'the revoke was accepted but not persisted');
    }
  });

  await check('SAME KEY: two writes to the SAME capability resolve deterministically', async () => {
    const ws = await freshWorkspace('samekey');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const r = await putWholeMapFromSnapshot(ws, s0, CAP_A, false);
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      // Both writes name the same key, so the later one legitimately wins.
      // This is NOT a lost update — B is *about* that capability.
      assert.strictEqual(final[CAP_A], false, 'the later same-key write did not take effect');
    }
  });

  await check('IDEMPOTENT: repeating an identical mutation changes nothing', async () => {
    const ws = await freshWorkspace('idem');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const mid = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const final = await readPerms(ws);
    assert.deepStrictEqual(final, mid, 'repeating an identical mutation changed the stored state');
  });

  // ================================================================
  // REFRESHED CLIENT — the well-behaved path must keep working
  // ================================================================
  await check('REFRESHED: a client that re-reads between writes keeps both changes', async () => {
    const ws = await freshWorkspace('refresh');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const s1 = await readPerms(ws);                     // the reload the UI performs
    const r = await putWholeMapFromSnapshot(ws, s1, CAP_B, true);
    assert.strictEqual(classify(r), 'accepted', 'a correctly refreshed write was refused');
    const final = await readPerms(ws);
    assert.strictEqual(final[CAP_A], true, 'a refreshed write lost the earlier grant');
    assert.strictEqual(final[CAP_B], true, 'a refreshed write did not persist');
  });

  await check('RETRY: a client that re-reads after a conflict succeeds', async () => {
    const ws = await freshWorkspace('retry');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const first = await putWholeMapFromSnapshot(ws, s0, CAP_B, true);
    if (classify(first) === 'rejected-as-stale') {
      const s1 = await readPerms(ws);
      const retry = await putWholeMapFromSnapshot(ws, s1, CAP_B, true);
      assert.strictEqual(classify(retry), 'accepted', 'a retry from fresh state was still refused');
    }
    const final = await readPerms(ws);
    assert.strictEqual(final[CAP_A], true, 'the original grant did not survive the conflict/retry cycle');
    assert.strictEqual(final[CAP_B], true, 'the retried mutation did not persist');
  });

  await check('VERY STALE: a snapshot several revisions old cannot erase newer state', async () => {
    const ws = await freshWorkspace('verystale');
    const ancient = await readPerms(ws);
    for (const cap of [CAP_A, CAP_B, 'create_tasks']) {
      const cur = await readPerms(ws);
      await putWholeMapFromSnapshot(ws, cur, cap, true);
    }
    const before = await readPerms(ws);
    const r = await putWholeMapFromSnapshot(ws, ancient, 'modify_tasks', true);
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      for (const cap of [CAP_A, CAP_B, 'create_tasks']) {
        assert.strictEqual(
          final[cap], true,
          `SILENT LOST UPDATE: an ancient snapshot erased ${cap} (was ${before[cap]}, now ${final[cap]})`
        );
      }
    }
  });

  await check('LEGACY CALLER: a permission write with no declared revision is REFUSED, not applied', async () => {
    // Every other case in this file supplies a revision, so nothing else here
    // describes what happens to a client that does not — a legacy script, a
    // curl, or a future "backwards compatible" fallback in the server. That
    // gap is exactly where A-002 would come back: measured by mutation, making
    // the conflict block conditional on a revision having been supplied
    // returns this write to 200 and silently bumps the row. This case is the
    // only one that fails on that mutation.
    const ws = await freshWorkspace('legacy');
    const s0 = await readPerms(ws);
    const granted = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0, [CAP_A]: true }, expectedRevision: s0.__rev,
    });
    assert.strictEqual(classify(granted), 'accepted', 'setup grant failed');

    // No expectedRevision at all — the legacy whole-map contract.
    const legacy = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0, [CAP_B]: true },
    });
    assert.ok(
      legacy.status >= 400,
      `a permission write with NO declared revision was ACCEPTED (${legacy.status}) — a legacy or ` +
      'naive client can still silently overwrite newer state'
    );
    const final = await readPerms(ws);
    assert.strictEqual(final[CAP_A], true, 'the undeclared-revision write erased an accepted grant');
  });

  await check('NON-PERMISSION writes do not require a revision and do not invalidate snapshots', async () => {
    // enabled/config must keep working unchanged, and must not bump the
    // permission revision — otherwise every unrelated toggle would invalidate
    // a permission snapshot and produce spurious conflicts.
    const ws = await freshWorkspace('enabled');
    const before = await readPerms(ws);
    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assert.strictEqual(classify(r), 'accepted', `enabling an agent now requires a revision: ${r.status}`);
    const after = await readPerms(ws);
    assert.strictEqual(after.__rev, before.__rev, 'an unrelated write bumped the permission revision');
    const perm = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...before, [CAP_A]: true }, expectedRevision: before.__rev,
    });
    assert.strictEqual(classify(perm), 'accepted', 'the pre-existing snapshot was wrongly treated as stale');
  });

  await check('RESTART: state survives a server restart and stays consistent', async () => {
    const ws = await freshWorkspace('restart');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);
    const beforeRestart = await readPerms(ws);
    const keepDir = dataDir;
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    const port = 4800 + Math.floor(Math.random() * 400);
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, RUCKER_DATA_DIR: keepDir, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    baseUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i += 1) {
      try { await api('GET', '/api/workspaces'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const afterRestart = await readPerms(ws);
    assert.deepStrictEqual(afterRestart, beforeRestart, 'permissions changed across a restart');
    // deepStrictEqual does NOT cover the revision — __rev is non-enumerable —
    // so it is asserted explicitly. A revision that resets on load would make
    // every pre-restart snapshot look fresh again.
    assert.strictEqual(afterRestart.__rev, beforeRestart.__rev, 'the permission revision did not survive a restart');

    // The property that actually matters across a restart: a snapshot taken
    // BEFORE it must still be recognised as stale AFTER it. If the revision
    // were rebuilt from scratch on load, s0 would silently clobber.
    const r = await putWholeMapFromSnapshot(ws, s0, CAP_B, true);
    const final = await readPerms(ws);
    if (classify(r) === 'accepted') {
      assert.strictEqual(
        final[CAP_A], true,
        'SILENT LOST UPDATE ACROSS A RESTART: a snapshot taken before the restart was accepted ' +
        'afterwards and erased a grant — the revision does not survive process restart'
      );
    }
  });

  await check('DIAGNOSIS: a misspelled capability is reported as such, not as a conflict', async () => {
    // Ordering, not safety: both refuse. But if the revision check ran first,
    // a typo in a capability name would be answered with "revision 3 is
    // current", sending the operator to re-read state that was never the
    // problem. Pinned here because the concurrency guard was added in front of
    // the vocabulary check and this ordering was restored deliberately.
    const ws = await freshWorkspace('diagnosis');
    const s0 = await readPerms(ws);
    await putWholeMapFromSnapshot(ws, s0, CAP_A, true);   // make the snapshot stale

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0, definitely_not_a_capability: true },
      expectedRevision: s0.__rev,                          // stale AND invalid
    });
    assert.ok(r.status >= 400, 'an unknown capability was accepted');
    assert.match(
      String(r.body && r.body.error), /unknown permission/,
      `a misspelled capability was reported as "${r.body && r.body.error}" — the operator is sent to ` +
      'fix a conflict that does not exist instead of the typo they actually made'
    );
    const final = await readPerms(ws);
    assert.strictEqual(final[CAP_A], true, 'the refused write still altered stored state');
    assert.ok(!('definitely_not_a_capability' in final), 'an unknown capability was persisted');
  });

  // ================================================================
  // ISOLATION — a revision is per (workspace, agent), so an unrelated row
  // must never invalidate a snapshot or alter state.
  // ================================================================
  await check('ISOLATION: a write to one agent does not disturb another agent in the same workspace', async () => {
    const OTHER = 'brainstorm_agent';
    const ws = await freshWorkspace('isolation');
    const detail = await api('GET', `/api/workspaces/${ws}/agents`);
    const other = detail.body.agents.find((a) => a.id === OTHER);
    assert.ok(other, `precondition: catalog agent ${OTHER} must exist for this case to prove anything`);

    const mine = await readPerms(ws);                       // snapshot of AGENT
    const w = await api('PUT', `/api/workspaces/${ws}/agents/${OTHER}`, {
      permissions: { ...other.effectivePermissions, [CAP_A]: true },
      expectedRevision: other.permissionRevision,
    });
    assert.strictEqual(classify(w), 'accepted', `writing to ${OTHER} failed: ${w.status}`);

    // The other agent's write must not have aged my snapshot...
    const r = await putWholeMapFromSnapshot(ws, mine, CAP_B, true);
    assert.strictEqual(
      classify(r), 'accepted',
      `a permission write to ${OTHER} wrongly invalidated the snapshot of ${AGENT} — revisions are not per-row`
    );
    // ...nor changed my state.
    const final = await readPerms(ws);
    assert.strictEqual(final[CAP_A], false, `a write to ${OTHER} leaked into ${AGENT}`);
    assert.strictEqual(final[CAP_B], true, 'my own write did not persist');
  });

  await check('ISOLATION: the same agent in two workspaces keeps independent revisions', async () => {
    const wsA = await freshWorkspace('iso-a');
    const wsB = await freshWorkspace('iso-b');
    const snapA = await readPerms(wsA);
    const snapB = await readPerms(wsB);

    await putWholeMapFromSnapshot(wsA, snapA, CAP_A, true);
    await putWholeMapFromSnapshot(wsA, await readPerms(wsA), CAP_B, true);

    // wsB has seen none of that, and its snapshot must still be valid.
    const r = await putWholeMapFromSnapshot(wsB, snapB, CAP_A, true);
    assert.strictEqual(
      classify(r), 'accepted',
      'activity in one workspace invalidated a snapshot in another — the revision is not scoped per workspace'
    );
    const finalB = await readPerms(wsB);
    assert.strictEqual(finalB[CAP_B], false, 'a write in workspace A leaked into workspace B');
    const finalA = await readPerms(wsA);
    assert.strictEqual(finalA[CAP_A], true, 'workspace A lost a grant');
    assert.strictEqual(finalA[CAP_B], true, 'workspace A lost a grant');
  });

  stopServer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { stopServer(); console.error(err); process.exit(1); });
