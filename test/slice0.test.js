// Slice 0 — the required proofs.
//
// Every case here spawns a REAL server process against a throwaway data
// directory and talks to it over real HTTP. Nothing is asserted from a
// component's own conclusion: denials are proven by reading the audit log
// back off disk, and "no effector ran" is proven by the absence of a run
// record, not by a return value.
//
// Run with: node test/slice0.test.js

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
let ownerToken = null;

function startServer() {
  return new Promise((resolve, reject) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-slice0-'));
    ownerToken = 'test-owner-token-' + Math.random().toString(36).slice(2);
    const port = 4300 + Math.floor(Math.random() * 400);
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port), RUCKER_OWNER_TOKEN: ownerToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    baseUrl = `http://127.0.0.1:${port}`;
    let out = '';
    const onData = (b) => {
      out += b.toString();
      if (/listening|running|http:\/\/127\.0\.0\.1/i.test(out)) resolve();
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('error', reject);
    setTimeout(() => resolve(), 3000); // fall through; the first request will surface a real failure
  });
}

function stopServer() {
  if (server) { server.kill('SIGTERM'); server = null; }
  if (dataDir) { fs.rmSync(dataDir, { recursive: true, force: true }); dataDir = null; }
}

// Unconditional sweep. A run that dies mid-scenario — which is exactly what a
// mutation run does — never reaches its own stopServer(), and the orphaned
// server keeps its port and data dir. Phase 8's A-008 was two consecutive
// suites failing on DIFFERENT tests because of one leaked headless browser;
// a leaked server is the same defect wearing different clothes.
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopServer(); process.exit(1); });
}

async function api(method, route, { body, token, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-rucker-owner-token': token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not all responses have bodies */ }
  return { status: res.status, body: json };
}

// The logs route returns text/plain, not JSON. Reading it as JSON silently
// yielded an empty string and made the loopback attack report "inconclusive" —
// a false FAIL that looked like a missing defence.
async function apiText(route) {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, text: await res.text() };
}

// Reads the audit log off DISK — the artifact, not the server's opinion.
function auditEvents() {
  const file = path.join(dataDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runRecords() {
  const file = path.join(dataDir, 'runs.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.records || []);
  } catch { return []; }
}

(async () => {
  await startServer();
  // Wait for the server to actually answer.
  for (let i = 0; i < 40; i += 1) {
    try { await api('GET', '/api/governance/constitution'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  // ===================================================================
  // OWNER AUTHENTICATION
  // ===================================================================

  await check('an anonymous caller CANNOT amend the Constitution', async () => {
    const before = (await api('GET', '/api/governance/constitution')).body;
    const res = await api('POST', '/api/governance/constitution/amend', {
      body: { rules: [{ kind: 'deny_capability', value: 'spend_money' }] },
    });
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, before.id, 'the Constitution CHANGED despite an unauthenticated request');
    assert.strictEqual(after.version, before.version, 'the version advanced on a rejected amendment');
  });

  await check('a WRONG token cannot amend the Constitution', async () => {
    const before = (await api('GET', '/api/governance/constitution')).body;
    const res = await api('POST', '/api/governance/constitution/amend', {
      token: 'not-the-owner-token',
      body: { rules: [{ kind: 'deny_capability', value: 'spend_money' }] },
    });
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, before.id, 'a wrong token amended the Constitution');
  });

  await check('the unauthorized attempt is AUDITED, with the attempted action named', async () => {
    const events = auditEvents().filter((e) => e.action === 'governance.unauthorized_attempt');
    assert.ok(events.length >= 2, `expected at least 2 unauthorized-attempt audit events, found ${events.length}`);
    const amendAttempt = events.find((e) => e.details.attemptedAction === 'constitution.amend');
    assert.ok(amendAttempt, 'no audit event names constitution.amend as the attempted action');
    assert.strictEqual(amendAttempt.flagged, true, 'an unauthenticated governance probe was not flagged');
  });

  await check('an anonymous caller cannot bind an agent to a workspace', async () => {
    const res = await api('POST', '/api/governance/agents/whatever/binding', {
      body: { workspaceId: 'ws-1', capabilities: [] },
    });
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    const bindings = (await api('GET', '/api/governance/bindings')).body;
    assert.strictEqual(bindings.bindings.length, 0, 'a binding was created without authentication');
  });

  await check('ONLY the authenticated owner can amend the root Constitution', async () => {
    const before = (await api('GET', '/api/governance/constitution')).body;
    const res = await api('POST', '/api/governance/constitution/amend', {
      token: ownerToken,
      body: {
        rules: [
          { kind: 'quarantine_provider', value: 'custom' },
          { kind: 'require_workspace', value: true },
          { kind: 'deny_capability', value: 'contact_people' },
        ],
        reason: 'slice 0 proof',
      },
    });
    assert.strictEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.notStrictEqual(after.id, before.id, 'the Constitution did not change after a valid amendment');
    assert.strictEqual(after.version, before.version + 1, 'the version did not advance');
    assert.ok(after.rules.some((r) => r.kind === 'deny_capability' && r.value === 'contact_people'), 'the new rule is not active');
  });

  await check('the completed amendment is audited and attributed to the owner', async () => {
    const amended = auditEvents().filter((e) => e.action === 'constitution.amended');
    assert.ok(amended.length >= 1, 'no constitution.amended audit event');
    assert.strictEqual(amended[amended.length - 1].actor.actorType, 'owner', `amendment attributed to ${amended[amended.length - 1].actor.actorType}, not owner`);
  });

  // ===================================================================
  // STALE / REPLAYED AUTHORIZATION
  // ===================================================================

  await check('a STALE amendment (computed against a superseded Constitution) is rejected', async () => {
    const current = (await api('GET', '/api/governance/constitution')).body;
    const stalePriorId = 'sha256-of-something-that-is-no-longer-active';
    const res = await api('POST', '/api/governance/constitution/amend', {
      token: ownerToken,
      body: { rules: [{ kind: 'require_workspace', value: true }], expectedPriorId: stalePriorId },
    });
    assert.strictEqual(res.status, 409, `expected 409 conflict, got ${res.status}`);
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, current.id, 'a stale amendment overwrote the active Constitution');
  });

  await check('a REPLAYED amendment is rejected the second time', async () => {
    const current = (await api('GET', '/api/governance/constitution')).body;
    const payload = {
      rules: [{ kind: 'quarantine_provider', value: 'custom' }, { kind: 'require_workspace', value: true }],
      expectedPriorId: current.id,
    };
    const first = await api('POST', '/api/governance/constitution/amend', { token: ownerToken, body: payload });
    assert.strictEqual(first.status, 201, `the first amendment should succeed, got ${first.status}`);
    // Replaying the identical request now carries a prior id that is no longer active.
    const replay = await api('POST', '/api/governance/constitution/amend', { token: ownerToken, body: payload });
    assert.strictEqual(replay.status, 409, `a replayed amendment was accepted (status ${replay.status})`);
  });

  await check('a FAILED amendment leaves the prior Constitution active', async () => {
    const before = (await api('GET', '/api/governance/constitution')).body;
    const res = await api('POST', '/api/governance/constitution/amend', {
      token: ownerToken,
      body: { rules: [{ kind: 'not_a_real_rule_kind', value: 'x' }] },
    });
    assert.ok(res.status >= 400, `an invalid ruleset was accepted (status ${res.status})`);
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, before.id, 'a failed amendment changed the active Constitution');
    assert.deepStrictEqual(after.rules, before.rules, 'a failed amendment altered the active rules');
  });

  await check('a rejected amendment is itself recorded — probing is not invisible', async () => {
    const rejected = auditEvents().filter((e) => e.action === 'constitution.amendment_rejected');
    assert.ok(rejected.length >= 1, 'no constitution.amendment_rejected audit event was written');
    assert.ok(rejected.every((e) => e.flagged === true), 'a rejected amendment was not flagged');
  });

  await check('a Constitution write and its audit evidence cannot silently diverge', async () => {
    // They are the same record: the active Constitution is DERIVED from the
    // chain. Proven by checking the chain verifies and the active id equals the
    // newest completed record's id.
    const history = (await api('GET', '/api/governance/constitution/history')).body;
    const active = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(history.integrity.ok, true, 'the constitution chain does not verify');
    const completed = history.history.filter((h) => h.outcome === 'completed');
    assert.ok(completed.length > 0, 'no completed amendments to compare');
    assert.strictEqual(
      active.id, completed[completed.length - 1].constitutionId,
      'the active Constitution id differs from the newest completed amendment record'
    );
  });

  // ===================================================================
  // LEGACY AGENTS — FAIL CLOSED
  // ===================================================================

  let legacyAgentId = null;
  let shellAgentId = null;
  await check('a legacy agent with NO workspace binding is denied before execution', async () => {
    const created = await api('POST', '/api/agents', {
      body: { name: 'legacy-anthropic', provider: 'anthropic', task: 'say hi' },
    });
    assert.strictEqual(created.status, 201, `agent creation failed: ${JSON.stringify(created.body)}`);
    legacyAgentId = created.body.id;

    const admission = await api('GET', `/api/governance/agents/${legacyAgentId}/admission`);
    assert.strictEqual(admission.status, 200);
    assert.strictEqual(admission.body.ok, false, 'an unbound legacy agent was admitted');
    assert.strictEqual(admission.body.code, 'GOVERNANCE_CONTEXT_MISSING', `wrong denial code: ${admission.body.code}`);
    assert.ok(/no workspace binding/i.test(admission.body.reason), `denial reason is not specific: ${admission.body.reason}`);
  });

  await check('the denial names an explicit owner migration path', async () => {
    const admission = await api('GET', `/api/governance/agents/${legacyAgentId}/admission`);
    assert.ok(admission.body.migrationPath, 'no migration path offered to the owner');
    assert.ok(/owner token/i.test(admission.body.migrationPath), `migration path does not require owner authority: ${admission.body.migrationPath}`);
  });

  await check('the refusal is AUDITED', async () => {
    const denials = auditEvents().filter((e) => e.action === 'governance.admission_denied' && e.entityId === legacyAgentId);
    assert.ok(denials.length >= 1, 'no admission_denied audit event for the unbound agent');
    assert.strictEqual(denials[0].flagged, true, 'the refusal was not flagged');
  });

  await check('NO provider or effector ran after the denial — proven by the absence of a run record', async () => {
    const runs = runRecords().filter((r) => r.agentId === legacyAgentId);
    assert.strictEqual(runs.length, 0, `${runs.length} run record(s) exist for an agent that was never admitted`);
  });

  await check('authorization is NOT inferred from workstreamId', async () => {
    // Give the agent a workstream. If anything inferred authorization from it,
    // the agent would now be admitted. It must still be refused.
    const ws = await api('POST', '/api/workstreams', { body: { name: 'a workstream', objective: 'x' } });
    assert.strictEqual(ws.status, 201, `workstream creation failed: ${JSON.stringify(ws.body)}`);
    await api('PUT', `/api/agents/${legacyAgentId}`, { body: { workstreamId: ws.body.id } });
    const admission = await api('GET', `/api/governance/agents/${legacyAgentId}/admission`);
    assert.strictEqual(admission.body.ok, false, 'having a workstream admitted the agent — authorization was inferred');
    assert.strictEqual(admission.body.code, 'GOVERNANCE_CONTEXT_MISSING');
  });

  await check('after an OWNER-AUTHENTICATED binding, the same agent is admitted', async () => {
    const bound = await api('POST', `/api/governance/agents/${legacyAgentId}/binding`, {
      token: ownerToken,
      body: { workspaceId: 'ws-explicit', capabilities: ['read_workspace_data'] },
    });
    assert.strictEqual(bound.status, 201, `binding failed: ${JSON.stringify(bound.body)}`);
    const admission = await api('GET', `/api/governance/agents/${legacyAgentId}/admission`);
    assert.strictEqual(admission.body.ok, true, `still refused after binding: ${admission.body.reason}`);
    assert.strictEqual(admission.body.workspaceId, 'ws-explicit');
    assert.deepStrictEqual(admission.body.capabilities, ['read_workspace_data']);
  });

  await check('binding is attributed to the OWNER actor, not to a bare HTTP caller', async () => {
    const bindings = (await api('GET', '/api/governance/bindings')).body.bindings;
    const row = bindings.find((b) => b.agentId === legacyAgentId);
    assert.ok(row, 'no binding row found');
    assert.strictEqual(row.boundBy.actorType, 'owner', `bound by ${row.boundBy.actorType} instead of owner`);
  });

  // ===================================================================
  // CUSTOM SHELL QUARANTINE
  // ===================================================================

  await check('a custom (shell) agent CANNOT be selected for governed execution', async () => {
    const created = await api('POST', '/api/agents', {
      body: { name: 'shell-agent', provider: 'custom', command: 'echo hello' },
    });
    assert.strictEqual(created.status, 201, `custom agent creation failed: ${JSON.stringify(created.body)}`);
    const shellId = created.body.id;

    // Bind it properly — so the ONLY thing that can refuse it is the quarantine.
    const bound = await api('POST', `/api/governance/agents/${shellId}/binding`, {
      token: ownerToken,
      body: { workspaceId: 'ws-explicit', capabilities: ['run_commands'] },
    });
    assert.strictEqual(bound.status, 201, 'could not bind the shell agent, so the quarantine is untested');

    const admission = await api('GET', `/api/governance/agents/${shellId}/admission`);
    // THE ESSENTIAL PROPERTY, asserted separately from the label. Mutation
    // testing showed why: defeating the provider allowlist still left the
    // agent refused (by the Constitution, as POLICY_BLOCKED), so an assertion
    // that only checked the code reported "detected" while the real guarantee
    // was intact. That is a false-positive detection — the test failed for a
    // reason unrelated to what it claims to protect.
    assert.strictEqual(admission.body.ok, false, 'a fully-bound shell agent was ADMITTED to governed execution');
    // Which layer refused it is informative, not the guarantee.
    assert.ok(
      ['PROVIDER_QUARANTINED', 'POLICY_BLOCKED'].includes(admission.body.code),
      `refused, but by an unexpected mechanism: ${admission.body.code}`
    );
    shellAgentId = shellId;
  });

  await check('the two quarantine mechanisms are INDEPENDENT — either one alone refuses the shell', async () => {
    // Mechanism A (the provider allowlist in governedExecution) is proven alone
    // here: amend the Constitution to DROP the quarantine rule entirely, and
    // confirm the shell agent is still refused.
    const current = (await api('GET', '/api/governance/constitution')).body;
    const withoutQuarantine = await api('POST', '/api/governance/constitution/amend', {
      token: ownerToken,
      body: { rules: [{ kind: 'require_workspace', value: true }], expectedPriorId: current.id, reason: 'independence probe' },
    });
    assert.strictEqual(withoutQuarantine.status, 201, `could not drop the quarantine rule (${withoutQuarantine.status}) — independence untested`);

    const active = (await api('GET', '/api/governance/constitution')).body;
    assert.ok(!active.quarantinedProviders.includes('custom'), 'the quarantine rule was not actually dropped — this probe proves nothing');

    const admission = await api('GET', `/api/governance/agents/${shellAgentId}/admission`);
    assert.strictEqual(admission.body.ok, false, 'with the Constitution rule removed, the shell agent was ADMITTED — the allowlist alone does not hold');
    assert.strictEqual(admission.body.code, 'PROVIDER_QUARANTINED', `expected the allowlist to be the refusing layer, got ${admission.body.code}`);

    // Mechanism B (the Constitution rule) is proven alone by mutation: with
    // 'custom' added to GOVERNED_PROVIDERS, admission is still refused as
    // POLICY_BLOCKED. Recorded in the Slice 0 report rather than executed here,
    // because it requires editing production source.

    // Restore the quarantine rule so later cases see the intended posture.
    const restored = await api('POST', '/api/governance/constitution/amend', {
      token: ownerToken,
      body: {
        rules: [{ kind: 'quarantine_provider', value: 'custom' }, { kind: 'require_workspace', value: true }],
        expectedPriorId: active.id,
        reason: 'restore quarantine after independence probe',
      },
    });
    assert.strictEqual(restored.status, 201, 'failed to restore the quarantine rule');
  });

  await check('the quarantine holds independently at the Constitution layer', async () => {
    const active = (await api('GET', '/api/governance/constitution')).body;
    assert.ok(
      active.quarantinedProviders.includes('custom'),
      `the root Constitution does not quarantine custom: ${JSON.stringify(active.quarantinedProviders)}`
    );
  });

  await check('the owner token is NOT reachable from a custom agent environment', async () => {
    const { ALLOWED_ENV_VARS } = require('../src/workers/custom');
    assert.ok(
      !ALLOWED_ENV_VARS.some((v) => /OWNER|TOKEN|SECRET/i.test(v)),
      `the custom-agent env allowlist exposes a credential-shaped variable: ${ALLOWED_ENV_VARS.join(', ')}`
    );
    assert.ok(!ALLOWED_ENV_VARS.includes('RUCKER_OWNER_TOKEN'), 'RUCKER_OWNER_TOKEN is in the custom-agent env allowlist');
  });

  // ===================================================================
  // WORKSPACE POLICY MAY ONLY NARROW
  // ===================================================================

  await check('a workspace policy cannot widen root authority', async () => {
    const constitution = require('../src/constitution');
    const root = [
      { kind: 'quarantine_provider', value: 'custom' },
      { kind: 'require_workspace', value: true },
      { kind: 'deny_capability', value: 'spend_money' },
    ];
    // Narrowing is allowed and additive.
    const narrowed = constitution.narrowWith(root, [{ kind: 'deny_capability', value: 'edit_files' }]);
    assert.ok(narrowed.some((r) => r.kind === 'deny_capability' && r.value === 'spend_money'), 'narrowing dropped a root prohibition');
    assert.ok(narrowed.some((r) => r.kind === 'deny_capability' && r.value === 'edit_files'), 'narrowing did not add the profile rule');

    // There is no operation that removes a root prohibition, and turning
    // require_workspace off is refused outright.
    assert.throws(
      () => constitution.narrowWith(root, [{ kind: 'require_workspace', value: false }]),
      /narrow, never widen/,
      'a profile was allowed to turn off require_workspace'
    );
  });

  // ===================================================================
  // FAIL CLOSED WHEN AUTH IS UNINITIALISED
  // ===================================================================

  await check('an UNINITIALISED auth module refuses everything rather than allowing it', async () => {
    const ownerAuth = require('../src/ownerAuth');
    ownerAuth.__resetForTests();
    assert.throws(
      () => ownerAuth.assertOwner({ get: () => 'anything', headers: {} }),
      /not initialised/,
      'an uninitialised auth module did not fail closed'
    );
  });

  // ===================================================================
  // THE DECISIVE ATTACK — a REAL shell agent curling the owner API.
  //
  // This is the §16-B hole, fired end to end rather than reasoned about: a
  // `custom` provider agent gets a real shell with PATH, so it can reach the
  // loopback admin API of its own host. Before Slice 0 that API needed no
  // credential at all.
  // ===================================================================

  await check('ATTACK: a real shell agent cannot amend the Constitution over loopback', async () => {
    const before = (await api('GET', '/api/governance/constitution')).body;

    const cmd = `curl -s -o /tmp/rk-attack-body.txt -w "HTTP:%{http_code}" -X POST `
      + `-H "content-type: application/json" `
      + `-d '{"rules":[{"kind":"deny_capability","value":"read_workspace_data"}]}' `
      + `${baseUrl}/api/governance/constitution/amend`;

    const created = await api('POST', '/api/agents', {
      body: { name: 'loopback-attacker', provider: 'custom', command: cmd },
    });
    assert.strictEqual(created.status, 201, `attacker agent creation failed: ${JSON.stringify(created.body)}`);
    const attackerId = created.body.id;

    const started = await api('POST', `/api/agents/${attackerId}/start`);
    assert.strictEqual(started.status, 202, `the attack agent did not start (${started.status}) — the attack was never actually fired`);

    // Wait for the run to finish, reading real status rather than sleeping blind.
    let logs = '';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      logs = (await apiText(`/api/agents/${attackerId}/logs`)).text || '';
      if (/HTTP:\d{3}/.test(logs)) break;
    }

    const codeMatch = /HTTP:(\d{3})/.exec(logs);
    assert.ok(codeMatch, `the shell agent never completed its request — attack inconclusive, logs: ${logs.slice(0, 300)}`);
    assert.strictEqual(codeMatch[1], '401', `THE LOOPBACK HOLE IS OPEN: the shell agent got HTTP ${codeMatch[1]} from the amend endpoint`);

    // And the Constitution is untouched.
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, before.id, 'a shell agent CHANGED the Constitution');
    assert.strictEqual(after.version, before.version, 'a shell agent advanced the Constitution version');
  });

  await check('ATTACK: the shell agent\'s attempt is in the audit trail', async () => {
    const attempts = auditEvents().filter(
      (e) => e.action === 'governance.unauthorized_attempt' && e.details.attemptedAction === 'constitution.amend'
    );
    assert.ok(attempts.length >= 2, `expected the shell attempt to be audited alongside earlier probes, found ${attempts.length}`);
  });

  await check('ATTACK: a shell agent cannot bind itself to a workspace either', async () => {
    const cmd = `curl -s -o /dev/null -w "HTTP:%{http_code}" -X POST -H "content-type: application/json" `
      + `-d '{"workspaceId":"ws-stolen","capabilities":["spend_money"]}' `
      + `${baseUrl}/api/governance/agents/self/binding`;
    const created = await api('POST', '/api/agents', { body: { name: 'binder-attacker', provider: 'custom', command: cmd } });
    const id = created.body.id;
    await api('POST', `/api/agents/${id}/start`);
    let logs = '';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      logs = (await apiText(`/api/agents/${id}/logs`)).text || '';
      if (/HTTP:\d{3}/.test(logs)) break;
    }
    const m = /HTTP:(\d{3})/.exec(logs);
    assert.ok(m, `the binding attack never completed — inconclusive, logs: ${logs.slice(0, 200)}`);
    assert.strictEqual(m[1], '401', `a shell agent got HTTP ${m[1]} from the binding endpoint`);
    const bindings = (await api('GET', '/api/governance/bindings')).body.bindings;
    assert.ok(!bindings.some((b) => b.workspaceId === 'ws-stolen'), 'a shell agent created a binding for itself');
  });

  // ===================================================================
  // MALFORMED CREDENTIALS AND CONCURRENCY
  // ===================================================================

  await check('malformed credentials are refused without crashing the route', async () => {
    const malformed = [
      { headers: { 'x-rucker-owner-token': '' } },
      { headers: { 'x-rucker-owner-token': 'x'.repeat(100000) } },
      { headers: { authorization: 'Bearer' } },
      { headers: { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') } },
      { headers: { 'x-rucker-owner-token': '\u0000\u0001binary' } },
    ];
    const before = (await api('GET', '/api/governance/constitution')).body;
    for (const h of malformed) {
      let res;
      try {
        res = await api('POST', '/api/governance/constitution/amend', {
          ...h,
          body: { rules: [{ kind: 'require_workspace', value: true }] },
        });
      } catch (err) {
        // A transport-level rejection (the runtime refusing to send the header
        // at all) is also a refusal, and a safe one.
        continue;
      }
      // The property is NEVER AUTHENTICATES, not "always answers 401". The
      // oversized header is refused by Node's own header limit with 431 before
      // Express sees it — still a refusal, and a stricter one. Asserting the
      // exact code here would have been a false failure about a working
      // defence.
      assert.ok(
        res.status >= 400,
        `malformed credential was ACCEPTED with ${res.status}: ${JSON.stringify(h.headers).slice(0, 80)}`
      );
    }
    const after = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(after.id, before.id, 'a malformed credential changed the Constitution');
    // The server is still healthy afterwards.
    const health = await api('GET', '/api/governance/constitution');
    assert.strictEqual(health.status, 200, 'the server did not survive malformed credentials');
  });

  await check('CONCURRENT amendments: exactly one wins, and history stays consistent', async () => {
    const current = (await api('GET', '/api/governance/constitution')).body;
    // Ten simultaneous amendments, all computed against the SAME prior id.
    // Without optimistic concurrency all ten would apply, and the last write
    // would silently erase nine owner decisions.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api('POST', '/api/governance/constitution/amend', {
        token: ownerToken,
        body: {
          rules: [{ kind: 'require_workspace', value: true }, { kind: 'deny_capability', value: `concurrent_${i}` }],
          expectedPriorId: current.id,
        },
      }))
    );
    const accepted = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    assert.strictEqual(accepted.length, 1, `${accepted.length} concurrent amendments were accepted — expected exactly 1`);
    assert.strictEqual(conflicted.length, 9, `${conflicted.length} were rejected as conflicts — expected 9`);

    const history = (await api('GET', '/api/governance/constitution/history')).body;
    assert.strictEqual(history.integrity.ok, true, 'concurrent amendments broke the constitution chain');
    const active = (await api('GET', '/api/governance/constitution')).body;
    assert.strictEqual(active.version, current.version + 1, `version advanced by ${active.version - current.version} under concurrency`);
  });

  // ===================================================================
  // STORAGE / ACTIVE / VERSION / HASH / AUDIT CONSISTENCY
  // ===================================================================

  await check('active state, version, hash, history and audit all agree after every transition', async () => {
    const active = (await api('GET', '/api/governance/constitution')).body;
    const history = (await api('GET', '/api/governance/constitution/history')).body.history;
    const completed = history.filter((h) => h.outcome === 'completed');

    // 1. hash matches the rules it claims to identify
    const constitutionModule = require('../src/constitution');
    assert.strictEqual(constitutionModule.hashRules(active.rules), active.id, 'the active id is not the hash of the active rules');
    // 2. version equals the number of completed amendments
    assert.strictEqual(active.version, completed.length, `version ${active.version} but ${completed.length} completed amendments`);
    // 3. the chain links: each completed record names the previous active id
    for (let i = 1; i < completed.length; i += 1) {
      assert.strictEqual(
        completed[i].priorConstitutionId, completed[i - 1].constitutionId,
        `completed amendment ${i} does not chain to its predecessor`
      );
    }
    // 4. every completed amendment has a matching audit event
    const amendedEvents = auditEvents().filter((e) => e.action === 'constitution.amended');
    assert.strictEqual(
      amendedEvents.length, completed.length,
      `${completed.length} completed amendments but ${amendedEvents.length} audit events — storage and audit have diverged`
    );
  });

  // ===================================================================
  // BINDING / REGISTRY DRIFT
  // ===================================================================

  await check('a binding whose agent was deleted is visible as orphaned, not silently authoritative', async () => {
    const created = await api('POST', '/api/agents', { body: { name: 'to-be-deleted', provider: 'anthropic', task: 'x' } });
    const id = created.body.id;
    await api('POST', `/api/governance/agents/${id}/binding`, { token: ownerToken, body: { workspaceId: 'ws-doomed', capabilities: [] } });
    const del = await api('DELETE', `/api/agents/${id}`);
    assert.ok(del.status >= 200 && del.status < 300, `agent delete failed (${del.status}) — drift was never created`);

    const listing = (await api('GET', '/api/governance/bindings')).body;
    const orphan = listing.bindings.find((b) => b.agentId === id);
    assert.ok(orphan, 'the binding vanished with the agent — that is also drift, in the other direction');
    assert.strictEqual(orphan.orphaned, true, 'an orphaned binding is not reported as orphaned');
    assert.ok(listing.orphanedCount >= 1, 'orphanedCount does not surface the inconsistency');

    // And it authorizes nothing: admission 404s on the missing agent.
    const admission = await api('GET', `/api/governance/agents/${id}/admission`);
    assert.strictEqual(admission.status, 404, `a deleted agent's admission returned ${admission.status} rather than 404`);
  });

  await check('NO second governance path exists — every governance route is owner-gated or read-only', async () => {
    // Derived from the registered routes, not a hand-written list.
    const express = require('express');
    const collected = [];
    const recorder = {};
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
      recorder[m] = (routePath) => collected.push(`${m.toUpperCase()} ${routePath}`);
    }
    const { registerGovernanceRoutes } = require('../src/governanceApi');
    registerGovernanceRoutes(recorder, { eventLog: { record() {} }, sendError: () => {}, store: { get: () => null } });

    const mutating = collected.filter((r) => /^(POST|PUT|DELETE|PATCH)/.test(r));
    assert.ok(mutating.length >= 3, `expected at least 3 mutating governance routes, found ${mutating.length}`);
    // Every mutating governance route must reject an anonymous caller.
    for (const route of mutating) {
      const [method, routePath] = route.split(' ');
      const concrete = routePath.replace(':id', 'some-agent-id');
      const res = await api(method, concrete, { body: {} });
      assert.strictEqual(res.status, 401, `${route} answered ${res.status} to an anonymous caller — it is not owner-gated`);
    }
  });

  stopServer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  stopServer();
  console.error(err);
  process.exit(1);
});
