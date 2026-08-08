// A-002 — permission lost update, and the revision contract that fixes it.
//
// THE INVARIANT THIS SUITE EXISTS FOR:
//
//   Once permission mutation A has been accepted, a later mutation B derived
//   from stale state may not silently erase A.
//
// THE CONCRETE CONTRACT BEING TESTED. The suite began implementation-agnostic
// ("preserve both, or refuse"), which was right while the design was still
// open. The design is now chosen — revision-based optimistic concurrency — so
// the oracles here are deliberately specific to it:
//
//   expectedRevision !== currentRevision
//     -> HTTP 409, code PERMISSION_REVISION_CONFLICT
//     -> no state mutation, and no revision advance
//
//   a write whose resulting authority equals the stored authority
//     -> success, state unchanged, revision unchanged
//
// The looser "if it was accepted, then assert..." shape that this file used
// before could be satisfied by a 500, a 400, or a crash-derived response — a
// server error would have read as a passing test. That is the same class of
// mistake as the original defect: green for a reason unrelated to the
// guarantee. Every deliberately stale request below now asserts the exact
// status, the error code, that the previously accepted state survived, that
// the rejected mutation did not partially apply, and that the revision did
// not move.
//
// If the concurrency design is ever changed, these oracles must be rewritten
// rather than relaxed — that is the intended cost of pinning a real contract.
//
// This exercises the real persistence/API path against a real server process.
// There are NO timing sleeps: staleness is constructed deliberately by holding
// a snapshot, not by racing the clock.
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
const CAP_A = 'edit_files';          // starts false (consequential -> least authority)
const CAP_B = 'run_commands';        // starts false
const CAP_C = 'read_workspace_data'; // starts true
const CAP_C_FALSE = 'spend_money';   // starts false — the value-type cases need a
                                     // capability whose DEFAULT is "not granted",
                                     // so a coerced value shows up as a widening.

// A fresh workspace per case, so no case can inherit another's state.
async function freshWorkspace(label) {
  const ws = await api('POST', '/api/workspaces', {
    name: `perm-${label}-${Math.random().toString(36).slice(2, 8)}`,
    stage: require('../src/businessStages').DEFAULT_STAGE,
  });
  assert.strictEqual(ws.status, 201, `workspace creation failed: ${JSON.stringify(ws.body)}`);
  return ws.body.id;
}

// The authoritative read: what the server actually persisted.
//
// The revision is returned as an ORDINARY field. It used to be attached
// non-enumerably, which meant deepStrictEqual silently skipped it and a test
// could "prove" state was unchanged while the revision had moved. Nothing in
// this file compares snapshots with deepStrictEqual any more; revisions are
// asserted explicitly, by value.
async function readRow(wsId, agentId = AGENT) {
  const res = await api('GET', `/api/workspaces/${wsId}/agents`);
  assert.strictEqual(res.status, 200, `agents read failed: ${res.status}`);
  const row = res.body.agents.find((a) => a.id === agentId);
  assert.ok(row, `agent row missing for ${agentId}`);
  return { perms: { ...row.effectivePermissions }, rev: row.permissionRevision };
}

// Reproduces EXACTLY what public/onboard.js does: build the whole map from a
// (possibly stale) snapshot and PUT it, carrying the revision it was read at.
async function putFrom(wsId, snapshot, changes, agentId = AGENT) {
  return api('PUT', `/api/workspaces/${wsId}/agents/${agentId}`, {
    permissions: { ...snapshot.perms, ...changes },
    expectedRevision: snapshot.rev,
  });
}

// ---- oracles -------------------------------------------------------------

function assertAccepted(r, label) {
  assert.ok(
    r.status >= 200 && r.status < 300,
    `${label}: expected the write to be accepted, got ${r.status} ${JSON.stringify(r.body)}`
  );
}

// A stale write has exactly one correct outcome under the chosen design.
// Anything else — 500, 400, 404, a crash-derived response — is a failure, not
// an alternative form of "refused".
function assertConflict(r, label) {
  assert.strictEqual(
    r.status, 409,
    `${label}: a stale permission write must be refused with 409, got ${r.status} ` +
    `${JSON.stringify(r.body)}. Any other status means the write was refused for some ` +
    'other reason (or not refused at all), which does not prove the conflict check ran.'
  );
  assert.strictEqual(
    r.body && r.body.code, 'PERMISSION_REVISION_CONFLICT',
    `${label}: refused with 409 but code was ${r.body && r.body.code} — the refusal did not come ` +
    'from the revision check'
  );
}

// The full "the rejected write did nothing" assertion: named capabilities hold
// their expected values AND the revision has not advanced.
function assertUnchanged(before, after, label, expectations = {}) {
  assert.strictEqual(
    after.rev, before.rev,
    `${label}: the revision advanced (${before.rev} -> ${after.rev}) on a request that was refused`
  );
  for (const [cap, want] of Object.entries(expectations)) {
    assert.strictEqual(
      after[cap] === undefined ? after.perms[cap] : after[cap], want,
      `${label}: ${cap} is ${after.perms[cap]}, expected ${want} — the refused write partially applied`
    );
  }
}

(async () => {
  await startServer();
  for (let i = 0; i < 40; i += 1) {
    try { await api('GET', '/api/workspaces'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  // ================================================================
  // THE CORE INVARIANT — fails on unmodified main
  // ================================================================
  await check('LOST UPDATE: a stale write is refused with 409 and erases nothing', async () => {
    const ws = await freshWorkspace('core');
    const s0 = await readRow(ws);                     // both clients read this

    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'mutation A');
    const afterA = await readRow(ws);
    assert.strictEqual(afterA.perms[CAP_A], true, 'precondition: A was not persisted, so nothing can be erased');
    assert.strictEqual(afterA.rev, s0.rev + 1, 'a real change must advance the revision exactly once');

    // B is derived from s0 — it has never seen A.
    const b = await putFrom(ws, s0, { [CAP_B]: true });
    assertConflict(b, 'stale mutation B');

    const final = await readRow(ws);
    assertUnchanged(afterA, final, 'stale mutation B', { [CAP_A]: true, [CAP_B]: false });
  });

  // ================================================================
  // ORDER INDEPENDENCE — the property must not depend on arrival order
  // ================================================================
  await check('ORDER: B then A from a shared stale snapshot behaves identically', async () => {
    const ws = await freshWorkspace('order');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_B]: true }), 'first mutation');
    const afterFirst = await readRow(ws);

    const r = await putFrom(ws, s0, { [CAP_A]: true });
    assertConflict(r, 'stale mutation (reversed order)');
    assertUnchanged(afterFirst, await readRow(ws), 'stale mutation (reversed order)', { [CAP_B]: true, [CAP_A]: false });
  });

  await check('ORDER: an independently stale client is refused, not silently applied', async () => {
    const ws = await freshWorkspace('indep');
    const sX = await readRow(ws);
    const sY = await readRow(ws);   // a second client, same starting view
    assertAccepted(await putFrom(ws, sX, { [CAP_A]: true }), 'client X');
    const afterX = await readRow(ws);

    const r = await putFrom(ws, sY, { [CAP_B]: true });
    assertConflict(r, 'independently stale client Y');
    assertUnchanged(afterX, await readRow(ws), 'independently stale client Y', { [CAP_A]: true, [CAP_B]: false });
  });

  // ================================================================
  // CONCURRENCY — exactly one winner, exactly one conflict
  // ================================================================
  await check('CONCURRENT: exactly one write wins, exactly one gets 409, revision moves once', async () => {
    // Repeated, and with the submission order reversed, because which request
    // the event loop serves first is scheduling-dependent. The invariant is
    // NOT which one wins — it is that there is exactly one winner, exactly one
    // conflict, exactly one revision transition, and no partial loser write.
    const REPS = 8;
    for (let i = 0; i < REPS; i += 1) {
      const reversed = i % 2 === 1;
      const ws = await freshWorkspace(`conc${i}`);
      const s0 = await readRow(ws);

      const writeA = () => putFrom(ws, s0, { [CAP_A]: true });
      const writeB = () => putFrom(ws, s0, { [CAP_B]: true });
      const [r1, r2] = await Promise.all(reversed ? [writeB(), writeA()] : [writeA(), writeB()]);

      const results = [r1, r2];
      const accepted = results.filter((r) => r.status >= 200 && r.status < 300);
      const conflicted = results.filter((r) => r.status === 409);

      assert.strictEqual(
        accepted.length, 1,
        `rep ${i}${reversed ? ' (reversed)' : ''}: expected exactly ONE accepted write, got ${accepted.length} ` +
        `(statuses ${results.map((r) => r.status).join(', ')}). Two acceptances means one silently ` +
        'overwrote the other; zero means no progress is possible.'
      );
      assert.strictEqual(
        conflicted.length, 1,
        `rep ${i}${reversed ? ' (reversed)' : ''}: expected exactly ONE 409, got ${conflicted.length} ` +
        `(statuses ${results.map((r) => r.status).join(', ')}) — the loser was refused for the wrong reason`
      );
      assertConflict(conflicted[0], `rep ${i} loser`);

      const final = await readRow(ws);
      assert.strictEqual(
        final.rev, s0.rev + 1,
        `rep ${i}: the revision moved ${s0.rev} -> ${final.rev}; exactly one write was accepted so it must move exactly once`
      );

      // The winner's capability is present; the loser's is absent. Which is
      // which depends on scheduling, so derive it from the accepted response
      // rather than assuming.
      const winnerIsA = (reversed ? results[1] : results[0]) === accepted[0];
      const wonCap = winnerIsA ? CAP_A : CAP_B;
      const lostCap = winnerIsA ? CAP_B : CAP_A;
      assert.strictEqual(final.perms[wonCap], true, `rep ${i}: the accepted write (${wonCap}) was not persisted`);
      assert.strictEqual(final.perms[lostCap], false, `rep ${i}: the REJECTED write (${lostCap}) was applied anyway`);
    }
  });

  // ================================================================
  // GRANT + REVOKE, AND SAME-KEY SEMANTICS
  // ================================================================
  await check('MIXED: a stale revoke on a DIFFERENT capability is refused, not merged', async () => {
    const ws = await freshWorkspace('mixed');
    const s0 = await readRow(ws);
    assert.strictEqual(s0.perms[CAP_C], true, 'precondition: CAP_C should start granted');
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'the grant');
    const afterGrant = await readRow(ws);

    const r = await putFrom(ws, s0, { [CAP_C]: false });   // revoke, from stale state
    assertConflict(r, 'stale revoke');
    assertUnchanged(afterGrant, await readRow(ws), 'stale revoke', { [CAP_A]: true, [CAP_C]: true });
  });

  await check('SAME KEY (stale): a second write to the same capability from an old revision is refused', async () => {
    const ws = await freshWorkspace('samekey-stale');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'first same-key write');
    const afterFirst = await readRow(ws);
    assert.strictEqual(afterFirst.perms[CAP_A], true);

    // Naming the same key does not make a stale revision fresh. Under OCC this
    // is a conflict, not a "later write wins".
    const r = await putFrom(ws, s0, { [CAP_A]: false });
    assertConflict(r, 'stale same-key write');
    assertUnchanged(afterFirst, await readRow(ws), 'stale same-key write', { [CAP_A]: true });
  });

  await check('SAME KEY (fresh): re-reading first lets the later value win', async () => {
    const ws = await freshWorkspace('samekey-fresh');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'first same-key write');
    const s1 = await readRow(ws);

    const r = await putFrom(ws, s1, { [CAP_A]: false });
    assertAccepted(r, 'fresh same-key write');
    const final = await readRow(ws);
    assert.strictEqual(final.perms[CAP_A], false, 'the fresh same-key write did not take effect');
    assert.strictEqual(final.rev, s1.rev + 1, 'a real change must advance the revision exactly once');
  });

  // ================================================================
  // DUPLICATES AND NO-OPS — two different things that look alike
  // ================================================================
  await check('DUPLICATE STALE REQUEST: replaying an accepted request is refused, not reapplied', async () => {
    const ws = await freshWorkspace('duplicate');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'original request');
    const afterFirst = await readRow(ws);

    // Byte-identical replay, including the now-superseded revision.
    const replay = await putFrom(ws, s0, { [CAP_A]: true });
    assertConflict(replay, 'replayed request');
    assertUnchanged(afterFirst, await readRow(ws), 'replayed request', { [CAP_A]: true });
  });

  await check('FRESH NO-OP: submitting the already-current map succeeds and does NOT advance the revision', async () => {
    // The contract the PR states. Measured before this was true: the revision
    // advanced on every permission-shaped write, so a request that granted and
    // revoked nothing still aged every other client's snapshot.
    const ws = await freshWorkspace('noop');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'setup change');
    const before = await readRow(ws);

    const noop = await putFrom(ws, before, {});   // exactly the stored map
    assertAccepted(noop, 'no-op write');

    const after = await readRow(ws);
    assert.strictEqual(
      after.rev, before.rev,
      `a write that changed no permission advanced the revision ${before.rev} -> ${after.rev} — ` +
      'it would age every other client\'s snapshot for nothing'
    );
    for (const cap of Object.keys(before.perms)) {
      assert.strictEqual(after.perms[cap], before.perms[cap], `the no-op changed ${cap}`);
    }
  });

  await check('NO-OP DOES NOT AGE ANOTHER CLIENT: B\'s real change still succeeds after A\'s no-op', async () => {
    // The interaction that makes the previous case matter rather than being a
    // cosmetic detail about a counter.
    const ws = await freshWorkspace('noop-age');
    const seed = await readRow(ws);
    assertAccepted(await putFrom(ws, seed, { [CAP_A]: true }), 'seed');

    const clientA = await readRow(ws);
    const clientB = await readRow(ws);            // both hold the same revision
    assert.strictEqual(clientA.rev, clientB.rev, 'precondition: both clients must start from one revision');

    assertAccepted(await putFrom(ws, clientA, {}), 'A\'s no-op');

    const bRes = await putFrom(ws, clientB, { [CAP_B]: true });
    assertAccepted(
      bRes,
      `B's legitimate change was refused (${bRes.status}) after A submitted a write that granted and ` +
      'revoked nothing — a no-op declared another client stale'
    );
    const final = await readRow(ws);
    assert.strictEqual(final.perms[CAP_B], true, 'B was accepted but not persisted');
    assert.strictEqual(final.perms[CAP_A], true, 'the seeded grant was lost');
    assert.strictEqual(final.rev, clientB.rev + 1, 'exactly one real change happened, so the revision must move once');
  });

  await check('NO-OP on an agent with NO stored row leaves the revision at 0', async () => {
    // The documented contract for the boundary case. GET reports the
    // least-authority default and revision 0 for an agent that has never been
    // configured; submitting exactly that map changes no authority, so the
    // client keeps the revision it already held. The row itself is still
    // created — enabled/config are real state — but storage mechanics must not
    // masquerade as an authority change.
    const ws = await freshWorkspace('noop-norow');
    const before = await readRow(ws);
    assert.strictEqual(before.rev, 0, 'precondition: an unconfigured agent must report revision 0');

    assertAccepted(await putFrom(ws, before, {}), 'default-map write against a nonexistent row');
    const after = await readRow(ws);
    assert.strictEqual(after.rev, 0, `submitting the default map for an unconfigured agent moved the revision to ${after.rev}`);

    // And a real change from that same revision must still be accepted.
    const real = await putFrom(ws, after, { [CAP_A]: true });
    assertAccepted(real, 'real change after the default-map write');
    assert.strictEqual((await readRow(ws)).rev, 1, 'the first real change must move the revision to 1');
  });

  // ================================================================
  // THE WELL-BEHAVED PATHS
  // ================================================================
  await check('REFRESHED: a client that re-reads between writes keeps both changes', async () => {
    const ws = await freshWorkspace('refresh');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'first write');
    const s1 = await readRow(ws);                     // the reload the UI performs

    const r = await putFrom(ws, s1, { [CAP_B]: true });
    assertAccepted(r, 'correctly refreshed write');
    const final = await readRow(ws);
    assert.strictEqual(final.perms[CAP_A], true, 'a refreshed write lost the earlier grant');
    assert.strictEqual(final.perms[CAP_B], true, 'a refreshed write did not persist');
    assert.strictEqual(final.rev, s1.rev + 1, 'two real changes happened, so the revision must be exactly one past the reload');
  });

  await check('RETRY: a client that re-reads after a 409 succeeds', async () => {
    const ws = await freshWorkspace('retry');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'setup grant');

    const first = await putFrom(ws, s0, { [CAP_B]: true });
    assertConflict(first, 'the stale attempt');   // asserted, not assumed

    const s1 = await readRow(ws);
    const retry = await putFrom(ws, s1, { [CAP_B]: true });
    assertAccepted(retry, 'the retry from fresh state');

    const final = await readRow(ws);
    assert.strictEqual(final.perms[CAP_A], true, 'the original grant did not survive the conflict/retry cycle');
    assert.strictEqual(final.perms[CAP_B], true, 'the retried mutation did not persist');
    assert.strictEqual(final.rev, s1.rev + 1, 'the refused attempt must not have advanced the revision');
  });

  await check('VERY STALE: a snapshot several revisions old is refused and erases nothing', async () => {
    const ws = await freshWorkspace('verystale');
    const ancient = await readRow(ws);
    // All three start FALSE, so each grant is a real change. Using a
    // capability that already defaults to true would be a no-op, which now
    // correctly does not advance the revision — and the snapshot would not
    // become as stale as this case intends.
    const GRANTS = [CAP_A, CAP_B, 'access_network'];
    for (const cap of GRANTS) {
      assert.strictEqual(ancient.perms[cap], false, `precondition: ${cap} must start false for this case to age the revision`);
      assertAccepted(await putFrom(ws, await readRow(ws), { [cap]: true }), `setup ${cap}`);
    }
    const before = await readRow(ws);
    assert.strictEqual(before.rev, ancient.rev + 3, 'precondition: three real changes must have advanced the revision three times');

    const r = await putFrom(ws, ancient, { contact_people: true });
    assertConflict(r, 'ancient snapshot');

    const final = await readRow(ws);
    assertUnchanged(before, final, 'ancient snapshot', {
      [CAP_A]: true, [CAP_B]: true, access_network: true, contact_people: false,
    });
  });

  await check('LEGACY CALLER: a permission write with no declared revision is REFUSED, not applied', async () => {
    // Every other case supplies a revision, so nothing else describes what
    // happens to a client that does not — a legacy script, a curl, or a future
    // "backwards compatible" fallback in the server. That gap is exactly where
    // A-002 would come back: measured by mutation, making the conflict block
    // conditional on a revision having been supplied returns this write to 200
    // and silently bumps the row.
    //
    // The contract here is a 400, not a 409: the request is malformed rather
    // than superseded, and it is refused before any conflict can be evaluated.
    const ws = await freshWorkspace('legacy');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'setup grant');
    const before = await readRow(ws);

    const legacy = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0.perms, [CAP_B]: true },   // no expectedRevision at all
    });
    assert.strictEqual(
      legacy.status, 400,
      `a permission write with NO declared revision returned ${legacy.status} ${JSON.stringify(legacy.body)} — ` +
      'it must be refused as a malformed request'
    );
    assert.strictEqual(legacy.body && legacy.body.code, 'VALIDATION_ERROR', 'refused, but not as a validation error');
    assert.match(String(legacy.body.error), /expectedRevision/, 'the refusal must name the missing field');

    assertUnchanged(before, await readRow(ws), 'undeclared-revision write', { [CAP_A]: true, [CAP_B]: false });
  });

  // ================================================================
  // PATCH SEMANTICS — omission changes nothing
  // ================================================================
  //
  // Under the previous FULL-REPLACEMENT rule any key the caller omitted was
  // refilled from defaultPermissionsFor(). Five capabilities default to ON, so
  // omission neither preserved nor cleared — it RESET. Measured at the CURRENT
  // revision, sending { spend_money: true } alone flipped a deliberate
  // read_workspace_data=false back to true and dropped a granted
  // edit_files=true, with HTTP 200. Optimistic concurrency could not help:
  // that caller was not stale.

  // A deliberately mixed state: a default-ON capability revoked, a default-OFF
  // capability granted. Any reset-to-defaults is visible in BOTH directions.
  async function mixedState(label) {
    const ws = await freshWorkspace(label);
    const s0 = await readRow(ws);
    assert.strictEqual(s0.perms[CAP_C], true, 'precondition: CAP_C must default ON');
    assert.strictEqual(s0.perms[CAP_A], false, 'precondition: CAP_A must default OFF');
    assertAccepted(await putFrom(ws, s0, { [CAP_C]: false, [CAP_A]: true }), `${label} setup`);
    const s = await readRow(ws);
    assert.strictEqual(s.perms[CAP_C], false, 'setup: the revocation did not persist');
    assert.strictEqual(s.perms[CAP_A], true, 'setup: the grant did not persist');
    return { ws, state: s };
  }
  // A patch names ONLY what it intends to change.
  const patch = (ws, snapshot, perms) => api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
    permissions: perms, expectedRevision: snapshot.rev,
  });

  await check('PATCH: a capability the caller did not name is preserved, in both directions', async () => {
    const { ws, state } = await mixedState('patch-omit');
    const r = await patch(ws, state, { [CAP_C_FALSE]: true });
    assertAccepted(r, 'a single-key patch');

    const after = await readRow(ws);
    assert.strictEqual(after.perms[CAP_C_FALSE], true, 'the named capability did not change');
    assert.strictEqual(
      after.perms[CAP_C], false,
      `omitting ${CAP_C} REINSTATED it (${state.perms[CAP_C]} -> ${after.perms[CAP_C]}) — a caller that ` +
      'named one capability silently undid an unrelated revocation'
    );
    assert.strictEqual(
      after.perms[CAP_A], true,
      `omitting ${CAP_A} DROPPED it (${state.perms[CAP_A]} -> ${after.perms[CAP_A]}) — a caller that named ` +
      'one capability silently discarded an unrelated grant'
    );
    assert.strictEqual(after.rev, state.rev + 1, 'one real change must advance the revision exactly once');
  });

  await check('PATCH: an empty patch is an accepted no-op and does not advance the revision', async () => {
    const { ws, state } = await mixedState('patch-empty');
    const r = await patch(ws, state, {});
    assertAccepted(r, 'an empty patch');
    const after = await readRow(ws);
    assert.strictEqual(after.perms[CAP_C], false, 'an empty patch reinstated a revoked capability');
    assert.strictEqual(after.perms[CAP_A], true, 'an empty patch dropped a granted capability');
    assert.strictEqual(after.rev, state.rev, `an empty patch advanced the revision ${state.rev} -> ${after.rev}`);
  });

  await check('PATCH: re-stating a value already in force changes nothing and does not advance the revision', async () => {
    const { ws, state } = await mixedState('patch-same');
    assertAccepted(await patch(ws, state, { [CAP_A]: true }), 'a same-value patch');
    const after = await readRow(ws);
    assert.strictEqual(after.rev, state.rev, 'a patch that changed no authority advanced the revision');
    assert.strictEqual(after.perms[CAP_C], false, 'a same-value patch disturbed another capability');
  });

  await check('PATCH: permissions:null is REFUSED, at a current revision and a stale one', async () => {
    // null used to mean "reset every capability to its default", which
    // silently granted the five that default to on. It is a malformed value,
    // not a way of saying "no opinion" — that is what omitting the field means.
    for (const [label, revOf] of [['current revision', (s) => s.rev], ['stale revision', () => 0]]) {
      const { ws, state } = await mixedState('patch-null');
      const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
        permissions: null, expectedRevision: revOf(state),
      });
      assert.strictEqual(r.status, 400, `${label}: permissions:null returned ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body && r.body.code, 'VALIDATION_ERROR', `${label}: refused, but not as a validation error`);
      assert.match(String(r.body.error), /must not be null/, `${label}: the refusal must name the null`);
      assertUnchanged(state, await readRow(ws), `permissions:null (${label})`, { [CAP_C]: false, [CAP_A]: true });
    }
  });

  await check('PATCH: omitting the permissions FIELD leaves permissions alone', async () => {
    // Distinct from null on purpose: absence means "this write is not about
    // permissions", which is exactly what the enabled/config path needs.
    const { ws, state } = await mixedState('patch-absent');
    assertAccepted(await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true }), 'a non-permission write');
    const after = await readRow(ws);
    assert.strictEqual(after.perms[CAP_C], false, 'an unrelated write reinstated a revoked capability');
    assert.strictEqual(after.perms[CAP_A], true, 'an unrelated write dropped a granted capability');
    assert.strictEqual(after.rev, state.rev, 'an unrelated write advanced the permission revision');
  });

  await check('PATCH: a stale partial patch is refused and applies nothing', async () => {
    const { ws, state } = await mixedState('patch-stale');
    assertAccepted(await patch(ws, state, { [CAP_B]: true }), 'the write that makes the snapshot stale');
    const before = await readRow(ws);

    const r = await patch(ws, state, { [CAP_C_FALSE]: true });   // state is now superseded
    assertConflict(r, 'a stale partial patch');
    assertUnchanged(before, await readRow(ws), 'a stale partial patch', {
      [CAP_C_FALSE]: false, [CAP_B]: true, [CAP_C]: false, [CAP_A]: true,
    });
  });

  await check('PATCH: one bad key rejects the whole patch — no valid key is partially applied', async () => {
    const { ws, state } = await mixedState('patch-atomic');
    for (const [label, perms, expected] of [
      ['a malformed value alongside a valid one', { [CAP_C_FALSE]: true, [CAP_B]: 'yes' }, /must be true or false/],
      ['an unknown key alongside a valid one', { [CAP_C_FALSE]: true, made_up_capability: true }, /unknown permission capability/],
    ]) {
      const before = await readRow(ws);
      const r = await patch(ws, before, perms);
      assert.strictEqual(r.status, 400, `${label}: expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(String(r.body && r.body.error), expected, `${label}: wrong diagnosis`);
      const after = await readRow(ws);
      assert.strictEqual(
        after.perms[CAP_C_FALSE], false,
        `${label}: the VALID key in the rejected patch was applied anyway — a patch must be all or nothing`
      );
      assertUnchanged(before, after, label, { [CAP_C]: false, [CAP_A]: true });
    }
  });

  await check('PATCH: a whole-map write still works — the frontend sends every current key', async () => {
    // Backward compatibility for the only production caller. A full map is
    // simply a patch that names every capability.
    const { ws, state } = await mixedState('patch-full');
    assertAccepted(await putFrom(ws, state, { [CAP_C_FALSE]: true }), 'a whole-map write');
    const after = await readRow(ws);
    assert.strictEqual(after.perms[CAP_C_FALSE], true, 'the whole-map write did not take effect');
    assert.strictEqual(after.perms[CAP_C], false, 'the whole-map write lost a revocation');
    assert.strictEqual(after.perms[CAP_A], true, 'the whole-map write lost a grant');
    assert.strictEqual(after.rev, state.rev + 1, 'one real change must advance the revision exactly once');
  });

  // ================================================================
  // VALUE TYPES — the authority boundary does not guess
  // ================================================================
  await check('TYPES: literal booleans are accepted, both directions', async () => {
    const ws = await freshWorkspace('types-ok');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'literal true');
    const granted = await readRow(ws);
    assert.strictEqual(granted.perms[CAP_A], true, 'literal true did not grant');

    assertAccepted(await putFrom(ws, granted, { [CAP_A]: false }), 'literal false');
    const revoked = await readRow(ws);
    assert.strictEqual(revoked.perms[CAP_A], false, 'literal false did not revoke');
  });

  await check('TYPES: no non-boolean value can become a grant through coercion', async () => {
    // Measured before the fix, through this same HTTP path, every one of these
    // stored a GRANT of a capability that defaults to false. "false" and "0"
    // are the ones that make coercion indefensible: a caller trying to REVOKE
    // would have GRANTED.
    const HOSTILE = [
      ['1', 1], ['0', 0], ['-1', -1], ['1.5', 1.5],
      ['"true"', 'true'], ['"false"', 'false'], ['"1"', '1'], ['"0"', '0'],
      ['"" (empty string)', ''], ['" " (space)', ' '], ['"no"', 'no'],
      ['null', null], ['[]', []], ['[false]', [false]], ['{}', {}],
      ['{a:1}', { a: 1 }], ['[[]]', [[]]], ['[{x:[1]}]', [{ x: [1] }]],
    ];
    for (const [label, value] of HOSTILE) {
      const ws = await freshWorkspace('types-bad');
      const s0 = await readRow(ws);
      // A witness capability the operator really did grant, so a partial
      // application of the refused write would be visible.
      assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), `witness grant for ${label}`);
      const before = await readRow(ws);

      const r = await putFrom(ws, before, { [CAP_C_FALSE]: value });
      assert.strictEqual(
        r.status, 400,
        `permission value ${label} returned ${r.status} ${JSON.stringify(r.body)} — a non-boolean must be ` +
        'refused, not coerced. JavaScript truthiness on an authority boundary turns "false", "0", [] and {} ' +
        'into grants.'
      );
      assert.strictEqual(r.body && r.body.code, 'VALIDATION_ERROR', `${label}: refused, but not as a validation error`);
      assert.match(String(r.body.error), /must be true or false/, `${label}: the refusal must name the type contract`);

      const after = await readRow(ws);
      assert.strictEqual(
        after.perms[CAP_C_FALSE], false,
        `permission value ${label} was stored as ${after.perms[CAP_C_FALSE]} despite the request being refused`
      );
      assert.strictEqual(after.perms[CAP_A], true, `${label}: the refused write disturbed an unrelated capability`);
      assert.strictEqual(after.rev, before.rev, `${label}: a refused write advanced the revision ${before.rev} -> ${after.rev}`);
    }
  });

  await check('TYPES: a malformed value is reported as malformed even when the revision is ALSO stale', async () => {
    // Ordering, and it is not cosmetic: re-reading cannot fix a value that is
    // the wrong type, so answering "revision N is current" would send the
    // caller into a retry loop that can never succeed.
    const ws = await freshWorkspace('types-order');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'setup');   // s0 is now stale
    const before = await readRow(ws);

    const r = await putFrom(ws, s0, { [CAP_C_FALSE]: 'false' });         // malformed AND stale
    assert.strictEqual(r.status, 400, `expected the malformed value to win, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(String(r.body && r.body.error), /must be true or false/, 'the caller was told about the revision instead of the bad value');
    assertUnchanged(before, await readRow(ws), 'malformed + stale', { [CAP_A]: true, [CAP_C_FALSE]: false });
  });

  await check('TYPES: an unknown capability outranks a malformed value on that same key', async () => {
    const ws = await freshWorkspace('types-unknown');
    const s0 = await readRow(ws);
    const before = await readRow(ws);
    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0.perms, made_up_capability: 'yes' },
      expectedRevision: s0.rev,
    });
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(
      String(r.body && r.body.error), /unknown permission capability/,
      'a capability that does not exist should be named as such — its value cannot matter'
    );
    assertUnchanged(before, await readRow(ws), 'unknown capability with a malformed value');
  });

  await check('TYPES: a non-object permissions payload is refused as such', async () => {
    const ws = await freshWorkspace('types-shape');
    const before = await readRow(ws);
    for (const [label, payload] of [['a string', 'everything'], ['an array', ['edit_files']], ['a number', 7]]) {
      const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
        permissions: payload, expectedRevision: before.rev,
      });
      assert.strictEqual(r.status, 400, `${label}: expected 400, got ${r.status}`);
      assert.match(
        String(r.body && r.body.error), /must be an object/,
        `${label}: an array's indices become "keys", so without an explicit check the caller is told ` +
        '"unknown permission capability: 0", which describes the symptom rather than the mistake'
      );
    }
    assertUnchanged(before, await readRow(ws), 'non-object payloads');
  });

  await check('DIAGNOSIS: a misspelled capability is reported as such, not as a conflict', async () => {
    // Ordering, not safety: both refuse. But if the revision check ran first,
    // a typo in a capability name would be answered with "revision 3 is
    // current", sending the operator to re-read state that was never the
    // problem.
    const ws = await freshWorkspace('diagnosis');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'setup');   // makes s0 stale
    const before = await readRow(ws);

    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, {
      permissions: { ...s0.perms, definitely_not_a_capability: true },
      expectedRevision: s0.rev,                      // stale AND invalid
    });
    assert.strictEqual(r.status, 400, `an unknown capability returned ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(
      String(r.body && r.body.error), /unknown permission/,
      `a misspelled capability was reported as "${r.body && r.body.error}" — the operator is sent to ` +
      'fix a conflict that does not exist instead of the typo they actually made'
    );
    const final = await readRow(ws);
    assertUnchanged(before, final, 'unknown-capability write', { [CAP_A]: true });
    assert.ok(!('definitely_not_a_capability' in final.perms), 'an unknown capability was persisted');
  });

  await check('NON-PERMISSION writes do not require a revision and do not invalidate snapshots', async () => {
    const ws = await freshWorkspace('enabled');
    const before = await readRow(ws);
    const r = await api('PUT', `/api/workspaces/${ws}/agents/${AGENT}`, { enabled: true });
    assertAccepted(r, 'enabling an agent');

    const after = await readRow(ws);
    assert.strictEqual(after.rev, before.rev, 'an unrelated write bumped the permission revision');

    const perm = await putFrom(ws, before, { [CAP_A]: true });
    assertAccepted(perm, 'a permission write using the pre-existing snapshot');
  });

  // ================================================================
  // DURABILITY
  // ================================================================
  await check('RESTART: the revision survives, and a pre-restart snapshot is still refused', async () => {
    const ws = await freshWorkspace('restart');
    const s0 = await readRow(ws);
    assertAccepted(await putFrom(ws, s0, { [CAP_A]: true }), 'pre-restart write');
    const beforeRestart = await readRow(ws);

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

    const afterRestart = await readRow(ws);
    assert.strictEqual(afterRestart.perms[CAP_A], true, 'permissions did not survive the restart');
    assert.strictEqual(afterRestart.rev, beforeRestart.rev, 'the permission revision did not survive a restart');

    // The property that matters: a snapshot taken BEFORE the restart must
    // still be recognised as stale AFTER it. A revision rebuilt from scratch
    // on load would make s0 look fresh and let it clobber.
    const r = await putFrom(ws, s0, { [CAP_B]: true });
    assertConflict(r, 'pre-restart snapshot used after restart');
    assertUnchanged(afterRestart, await readRow(ws), 'pre-restart snapshot used after restart', {
      [CAP_A]: true, [CAP_B]: false,
    });
  });

  // ================================================================
  // ISOLATION — a revision is per (workspace, agent)
  // ================================================================
  await check('ISOLATION: a write to one agent does not disturb another agent in the same workspace', async () => {
    const OTHER = 'brainstorm_agent';
    const ws = await freshWorkspace('isolation');
    const mine = await readRow(ws);
    const other = await readRow(ws, OTHER);

    assertAccepted(await putFrom(ws, other, { [CAP_A]: true }, OTHER), `writing to ${OTHER}`);

    // The other agent's write must not have aged my snapshot...
    const r = await putFrom(ws, mine, { [CAP_B]: true });
    assertAccepted(r, `a permission write to ${OTHER} wrongly invalidated the snapshot of ${AGENT}`);

    // ...nor changed my state.
    const final = await readRow(ws);
    assert.strictEqual(final.perms[CAP_A], false, `a write to ${OTHER} leaked into ${AGENT}`);
    assert.strictEqual(final.perms[CAP_B], true, 'my own write did not persist');
  });

  await check('ISOLATION: the same agent in two workspaces keeps independent revisions', async () => {
    const wsA = await freshWorkspace('iso-a');
    const wsB = await freshWorkspace('iso-b');
    const snapA = await readRow(wsA);
    const snapB = await readRow(wsB);

    assertAccepted(await putFrom(wsA, snapA, { [CAP_A]: true }), 'workspace A first write');
    assertAccepted(await putFrom(wsA, await readRow(wsA), { [CAP_B]: true }), 'workspace A second write');

    // wsB has seen none of that, and its snapshot must still be valid.
    const r = await putFrom(wsB, snapB, { [CAP_A]: true });
    assertAccepted(r, 'activity in workspace A invalidated a snapshot in workspace B');

    const finalB = await readRow(wsB);
    assert.strictEqual(finalB.perms[CAP_B], false, 'a write in workspace A leaked into workspace B');
    const finalA = await readRow(wsA);
    assert.strictEqual(finalA.perms[CAP_A], true, 'workspace A lost a grant');
    assert.strictEqual(finalA.perms[CAP_B], true, 'workspace A lost a grant');
  });

  stopServer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => { stopServer(); console.error(err); process.exit(1); });
