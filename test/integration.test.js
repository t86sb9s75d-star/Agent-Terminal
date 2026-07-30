// Phase 9 — integration tests. Everything here spawns a REAL server
// process (node src/server.js) against a throwaway RUCKER_DATA_DIR and
// talks to it over real HTTP, the same way the manual verification during
// development did. This replaces "I ran curl by hand and it worked" with
// something that keeps working automatically on the next change.
//
// Run with: node test/integration.test.js
// (Also included in `npm test`.)

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
let nextPort = 4300; // avoid colliding with a real dev instance on 4173

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`NOT OK - ${name}`);
    console.log(`  ${err.message}`);
  }
}

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-it-'));
}

function startServer(dataDir, extraEnv = {}) {
  const port = nextPort++;
  const proc = spawn('node', [SERVER_PATH], {
    env: { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, baseUrl: `http://127.0.0.1:${port}`, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitForReady(baseUrl, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/providers`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

async function waitForExit(proc, timeoutMs = 5000) {
  const start = Date.now();
  while (proc.exitCode === null && proc.signalCode === null && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function stopServer(server) {
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill('SIGTERM');
  await waitForExit(server.proc);
  if (server.proc.exitCode === null && server.proc.signalCode === null) {
    server.proc.kill('SIGKILL');
    await waitForExit(server.proc);
  }
}

async function killServerHard(server) {
  server.proc.kill('SIGKILL');
  await waitForExit(server.proc);
}

// ---------------- tests ----------------

async function run() {
  await check('boots, creates an agent, starts and completes a custom run', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const createRes = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'IT Agent', provider: 'custom', command: 'echo hello' }),
      });
      assert.strictEqual(createRes.status, 201);
      const agent = await createRes.json();

      const startRes = await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      assert.strictEqual(startRes.status, 202);
      await new Promise((r) => setTimeout(r, 500));

      const getRes = await fetch(`${server.baseUrl}/api/agents/${agent.id}`);
      const got = await getRes.json();
      assert.strictEqual(got.status, 'idle');

      const logsRes = await fetch(`${server.baseUrl}/api/agents/${agent.id}/logs`);
      const logs = await logsRes.text();
      assert.ok(logs.includes('hello'), 'log output should contain the echoed text');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('custom agents never see the server process environment (secret exclusion)', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir, { ANTHROPIC_API_KEY: 'super-secret-leak-check-value' });
    try {
      await waitForReady(server.baseUrl);
      const createRes = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Secret Test', provider: 'custom', command: 'echo "KEY=$ANTHROPIC_API_KEY"' }),
      });
      const agent = await createRes.json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 500));
      const logs = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/logs`)).text();
      assert.ok(!logs.includes('super-secret-leak-check-value'), 'secret must not appear in custom agent output');
      assert.ok(logs.includes('KEY='), 'the echo itself should have run, just with an empty value');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('path traversal via agent id cannot delete files outside the logs directory', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-canary-'));
    const canaryFile = path.join(canaryDir, 'evil.log');
    fs.writeFileSync(canaryFile, 'do not delete me');
    try {
      await waitForReady(server.baseUrl);
      const relTraversal = path.relative(path.join(dataDir, 'logs'), canaryFile).replace(/\.log$/, '');
      const res = await fetch(`${server.baseUrl}/api/agents/${encodeURIComponent(relTraversal)}`, { method: 'DELETE' });
      assert.strictEqual(res.status, 404, 'a traversal id for a non-existent agent must 404, not act');
      assert.strictEqual(fs.readFileSync(canaryFile, 'utf8'), 'do not delete me', 'canary file outside logs/ must survive untouched');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  await check('cross-origin state-changing requests are rejected; same-origin and no-origin are allowed', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const crossOrigin = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ name: 'CSRF', provider: 'custom', command: 'echo hi' }),
      });
      assert.strictEqual(crossOrigin.status, 403);

      const sameOrigin = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
        body: JSON.stringify({ name: 'Legit', provider: 'custom', command: 'echo hi' }),
      });
      assert.strictEqual(sameOrigin.status, 201);

      const noOrigin = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'API client', provider: 'custom', command: 'echo hi' }),
      });
      assert.strictEqual(noOrigin.status, 201);

      const list = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(list.length, 2, 'the cross-origin request must not have created an agent');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('an archived workstream blocks new agent assignment and run starts', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const ws = await (await fetch(`${server.baseUrl}/api/workstreams`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'WS' }),
      })).json();
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A', provider: 'custom', command: 'echo hi', workstreamId: ws.id }),
      })).json();

      await fetch(`${server.baseUrl}/api/workstreams/${ws.id}/archive`, { method: 'POST' });

      const startRes = await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      assert.strictEqual(startRes.status, 409);
      const startBody = await startRes.json();
      assert.strictEqual(startBody.code, 'WORKSTREAM_ARCHIVED');

      const createRes = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'B', provider: 'custom', command: 'echo hi', workstreamId: ws.id }),
      });
      assert.strictEqual(createRes.status, 409);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('a run left "running" by a hard kill is recovered as interrupted on restart', async () => {
    const dataDir = freshDataDir();
    let server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Crash', provider: 'custom', command: 'sleep 30' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 300));

      await killServerHard(server);

      const runsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
      assert.ok(runsRaw.records.some((r) => r.status === 'running'), 'sanity check: a run should still be marked running on disk after the hard kill');

      server = startServer(dataDir);
      await waitForReady(server.baseUrl);
      const runsRes = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json();
      assert.strictEqual(runsRes.runs.length, 1);
      assert.strictEqual(runsRes.runs[0].status, 'interrupted');

      const agentStatus = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}`)).json();
      assert.strictEqual(agentStatus.status, 'idle', 'in-memory status must reset, not stay stuck running');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('direct file tampering is detected, flagged, and produces a Sentinel finding', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tamper Target', provider: 'custom', command: 'echo hi' }),
      });

      const filePath = path.join(dataDir, 'agents.json');
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      envelope.records[0].name = 'TAMPERED';
      fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));

      await fetch(`${server.baseUrl}/api/agents`); // trigger a read

      const status = await (await fetch(`${server.baseUrl}/api/security/status`)).json();
      assert.strictEqual(status.healthy, false);
      assert.ok(status.degraded.some((d) => d.subsystem === 'agents' && d.reason === 'tampered'));

      const findings = await (await fetch(`${server.baseUrl}/api/security/findings`)).json();
      assert.ok(findings.some((f) => f.ruleId === 'store_integrity_failure' && f.entityId === 'agents'));
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('operator recovery (restore_backup and accept_current) clears a tampered store', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Recovery Test', provider: 'custom', command: 'echo hi' }),
      });

      const filePath = path.join(dataDir, 'agents.json');
      const tamper = (name) => {
        const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        envelope.records[0].name = name;
        fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
      };

      tamper('TAMPERED');
      await fetch(`${server.baseUrl}/api/agents`); // trigger detection
      let status = await (await fetch(`${server.baseUrl}/api/security/status`)).json();
      assert.strictEqual(status.healthy, false);

      const restoreRes = await fetch(`${server.baseUrl}/api/security/stores/agents/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'restore_backup' }),
      });
      assert.strictEqual(restoreRes.status, 200);
      status = await (await fetch(`${server.baseUrl}/api/security/status`)).json();
      assert.strictEqual(status.healthy, true);
      const afterRestore = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(afterRestore[0].name, 'Recovery Test', 'restore_backup should discard the tampered content');

      tamper('DELIBERATE EDIT');
      await fetch(`${server.baseUrl}/api/agents`);
      const acceptRes = await fetch(`${server.baseUrl}/api/security/stores/agents/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'accept_current' }),
      });
      assert.strictEqual(acceptRes.status, 200);
      const afterAccept = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(afterAccept[0].name, 'DELIBERATE EDIT', 'accept_current should keep the current on-disk content as the new baseline');
      status = await (await fetch(`${server.baseUrl}/api/security/status`)).json();
      assert.strictEqual(status.healthy, true);

      const badStore = await fetch(`${server.baseUrl}/api/security/stores/nonexistent/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'accept_current' }),
      });
      assert.strictEqual(badStore.status, 404);
      const badResolution = await fetch(`${server.baseUrl}/api/security/stores/agents/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'yolo' }),
      });
      assert.strictEqual(badResolution.status, 400);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('a second instance against the same data directory is refused', async () => {
    const dataDir = freshDataDir();
    const server1 = startServer(dataDir);
    try {
      await waitForReady(server1.baseUrl);
      const server2 = startServer(dataDir);
      await waitForExit(server2.proc, 3000);
      assert.strictEqual(server2.proc.exitCode, 1, 'second instance should exit(1), not start serving');
      assert.ok(server2.getStderr().includes('already holds the lock'));
    } finally {
      await stopServer(server1);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('retrying a start request with the same Idempotency-Key does not start a second run', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Idem', provider: 'custom', command: 'sleep 2' }),
      })).json();

      const headers = { 'Idempotency-Key': 'test-retry-key' };
      const first = await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST', headers });
      assert.strictEqual(first.status, 202);
      const retry = await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST', headers });
      assert.strictEqual(retry.status, 202);
      assert.strictEqual(retry.headers.get('idempotent-replay'), 'true');

      await new Promise((r) => setTimeout(r, 2500));
      const runsRes = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json();
      assert.strictEqual(runsRes.runs.length, 1, 'exactly one run should exist despite the retry');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('3 failures for one agent produce exactly one repeated-failure finding, and containment can stop it', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Flaky', provider: 'custom', command: 'exit 1' }),
      })).json();

      for (let i = 0; i < 3; i++) {
        await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
        await new Promise((r) => setTimeout(r, 400));
      }

      const findings = await (await fetch(`${server.baseUrl}/api/security/findings`)).json();
      const matching = findings.filter((f) => f.ruleId === 'repeated_run_failure' && f.entityId === agent.id);
      assert.strictEqual(matching.length, 1, 'exactly one finding should be created, not one per failure');
      assert.strictEqual(matching[0].status, 'open');

      const contained = await (await fetch(`${server.baseUrl}/api/security/findings/${matching[0].id}/contain`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stopAgent: true }),
      })).json();
      assert.strictEqual(contained.status, 'contained');
      assert.strictEqual(contained.statusHistory.length, 2);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('10 truly concurrent start requests for one agent produce exactly one run', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Race Test', provider: 'custom', command: 'sleep 2' }),
      })).json();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' }))
      );
      const statuses = results.map((r) => r.status).sort();
      assert.strictEqual(statuses.filter((s) => s === 202).length, 1, 'exactly one request should succeed');
      assert.strictEqual(statuses.filter((s) => s === 409).length, 9, 'the other nine should be rejected as already-running');

      await new Promise((r) => setTimeout(r, 2500));
      const runsRes = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json();
      assert.strictEqual(runsRes.runs.length, 1, 'exactly one run should have been created despite the race');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('malformed JSON returns a stable error shape, not a leaked stack trace', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const res = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not valid json',
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.code, 'VALIDATION_ERROR');
      assert.ok(!body.error.includes('/src/'), 'error message must not leak a filesystem path');
      assert.ok(!body.error.includes('at '), 'error message must not leak a stack trace');

      // server must still be healthy afterward
      const health = await fetch(`${server.baseUrl}/api/providers`);
      assert.strictEqual(health.status, 200);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('a run exceeding the runtime ceiling is terminated and marked timed_out', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir, { RUCKER_DEFAULT_RUNTIME_TIMEOUT_MS: '1000' });
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Long Runner', provider: 'custom', command: 'sleep 30' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });

      await new Promise((r) => setTimeout(r, 2500));

      const runsRes = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json();
      assert.strictEqual(runsRes.runs[0].status, 'timed_out');

      const events = await (await fetch(`${server.baseUrl}/api/activity?limit=5`)).json();
      const timeoutEvent = events.find((e) => e.action === 'run.timed_out');
      assert.ok(timeoutEvent, 'run.timed_out event should be recorded');
      assert.strictEqual(timeoutEvent.actor.actorType, 'policy_engine', 'a timeout is enforced by the system, not the requester');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('output beyond the configured cap is truncated, not unbounded', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir, { RUCKER_MAX_OUTPUT_BYTES: '10000' });
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Firehose', provider: 'custom', command: 'yes | head -c 200000' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 1500));

      const logPath = path.join(dataDir, 'logs', `${agent.id}.log`);
      const size = fs.statSync(logPath).size;
      assert.ok(size < 200000, `log file should be capped well below the ~200KB the command would produce, got ${size}`);
      assert.ok(size < 20000, `log file should be capped near the 10000-byte limit plus the truncation marker, got ${size}`);

      const runsRes = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json();
      assert.strictEqual(runsRes.runs[0].outputTruncated, true);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('per-agent daily spending cap blocks a paid-provider run from starting', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir, { RUCKER_MAX_DAILY_COST_PER_AGENT_USD: '1.00' });
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Spendy', provider: 'anthropic', task: 'noop', model: 'claude-sonnet-5' }),
      })).json();

      // Seed a completed, already-priced run directly on disk — the same
      // mechanism a real run would produce, without spending real money in
      // a test. The server re-reads the file on every request, so this is
      // picked up on the next API call.
      const runsPath = path.join(dataDir, 'runs.json');
      const envelope = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
      envelope.records.push({
        id: 'seeded-run-1', agentId: agent.id, provider: 'anthropic', model: 'claude-sonnet-5',
        workstreamId: null, requestId: null, startedAt: Date.now(), endedAt: Date.now(), durationMs: 1000,
        status: 'completed', inputTokens: 1000, outputTokens: 500, cachedTokens: null, costUsd: 1.5,
        error: null, outputTruncated: false, overBudgetCap: false,
      });
      fs.writeFileSync(runsPath, JSON.stringify(envelope, null, 2));

      const startRes = await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      assert.strictEqual(startRes.status, 429);
      const body = await startRes.json();
      assert.strictEqual(body.code, 'BUDGET_LIMIT_REACHED');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ---------------- Post-merge stabilization pass regression tests ----------------
  // Each of these corresponds to a specific finding from the PR #3 review
  // (Copilot) or the follow-up stabilization audit. See the stabilization
  // report for the finding-to-fix mapping.

  await check('[Finding A] resolving a workstream incident actually clears hasUnresolvedFailure via the API', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const ws = await (await fetch(`${server.baseUrl}/api/workstreams`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'WS' }),
      })).json();
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'A', provider: 'custom', command: 'exit 1', workstreamId: ws.id }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 600));

      const runId = (await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json()).runs[0].id;

      const before = await (await fetch(`${server.baseUrl}/api/workstreams/${ws.id}`)).json();
      assert.strictEqual(before.hasUnresolvedFailure, true);

      await fetch(`${server.baseUrl}/api/workstreams/${ws.id}/resolve/${runId}`, { method: 'POST' });

      const afterSingle = await (await fetch(`${server.baseUrl}/api/workstreams/${ws.id}`)).json();
      assert.strictEqual(afterSingle.hasUnresolvedFailure, false, 'GET /api/workstreams/:id must reflect the resolution');
      assert.deepStrictEqual(afterSingle.unresolvedFailureRunIds, []);

      const afterList = (await (await fetch(`${server.baseUrl}/api/workstreams`)).json())[0];
      assert.strictEqual(afterList.hasUnresolvedFailure, false, 'GET /api/workstreams (list) must also reflect the resolution');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('[Finding B] whitespace-only task/command is rejected for every provider', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const post = (body) => fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });

      for (const blank of ['   ', '\t\n', '\n\n  \t']) {
        const customRes = await post({ name: 'C', provider: 'custom', command: blank });
        assert.strictEqual(customRes.status, 400, `custom command "${JSON.stringify(blank)}" must be rejected`);
        const anthropicRes = await post({ name: 'A', provider: 'anthropic', task: blank });
        assert.strictEqual(anthropicRes.status, 400, `anthropic task "${JSON.stringify(blank)}" must be rejected`);
        const openaiRes = await post({ name: 'O', provider: 'openai', task: blank });
        assert.strictEqual(openaiRes.status, 400, `openai task "${JSON.stringify(blank)}" must be rejected`);
      }

      // valid, real content must still work
      const validRes = await post({ name: 'Valid', provider: 'custom', command: 'echo hi' });
      assert.strictEqual(validRes.status, 201);

      const agents = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(agents.length, 1, 'none of the blank-content requests should have created an agent');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('[Finding C] switching provider without that provider\'s required field is rejected, with the required field it succeeds', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Switcher', provider: 'anthropic', task: 'a real task' }),
      })).json();

      const put = (body) => fetch(`${server.baseUrl}/api/agents/${agent.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });

      const rejected = await put({ provider: 'custom' });
      assert.strictEqual(rejected.status, 400);

      const unchanged = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}`)).json();
      assert.strictEqual(unchanged.provider, 'anthropic', 'a rejected update must not partially mutate the stored agent');

      const accepted = await put({ provider: 'custom', command: 'echo hi' });
      assert.strictEqual(accepted.status, 200);
      const final = await accepted.json();
      assert.strictEqual(final.provider, 'custom');
      assert.strictEqual(final.command, 'echo hi');

      // custom -> paid provider without task must also be rejected
      const agent2 = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Switcher2', provider: 'custom', command: 'echo hi' }),
      })).json();
      const rejected2 = await fetch(`${server.baseUrl}/api/agents/${agent2.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai' }),
      });
      assert.strictEqual(rejected2.status, 400);

      // provider unchanged, unrelated partial update still works
      const renamed = await fetch(`${server.baseUrl}/api/agents/${agent2.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
      });
      assert.strictEqual(renamed.status, 200);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('[Finding D] a backup captures the just-written content, not the version it replaced', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Original Name', provider: 'custom', command: 'echo hi' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${agent.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed After Backup' }),
      });

      // Corrupt the primary file and restore from backup — the restored
      // content must reflect the SECOND (latest) write, not the first.
      fs.writeFileSync(path.join(dataDir, 'agents.json'), 'not valid json');
      await fetch(`${server.baseUrl}/api/agents`); // trigger detection
      const recoverRes = await fetch(`${server.baseUrl}/api/security/stores/agents/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution: 'restore_backup' }),
      });
      assert.strictEqual(recoverRes.status, 200);

      const restored = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(restored[0].name, 'Renamed After Backup', 'restore_backup must recover the latest write, not the version it replaced');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('maxTokens rejects NaN, negative, and zero; accepts valid positive integers', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const post = (maxTokens) => fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T', provider: 'custom', command: 'echo hi', maxTokens }),
      });

      for (const bad of ['abc', -50, 0, NaN, Infinity]) {
        const res = await post(bad);
        assert.strictEqual(res.status, 400, `maxTokens=${bad} must be rejected`);
      }

      const goodRes = await post(2048);
      assert.strictEqual(goodRes.status, 201);
      const good = await goodRes.json();
      assert.strictEqual(good.maxTokens, 2048);

      const defaultRes = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Default', provider: 'custom', command: 'echo hi' }),
      });
      const defaulted = await defaultRes.json();
      assert.strictEqual(defaulted.maxTokens, 1024, 'omitting maxTokens must still default to 1024');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('reusing an Idempotency-Key with a different payload is a 409 conflict, not a silently wrong replay', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'reused-key' };

      const first = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Agent A', provider: 'custom', command: 'echo A' }),
      });
      assert.strictEqual(first.status, 201);

      const sameRetry = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Agent A', provider: 'custom', command: 'echo A' }),
      });
      assert.strictEqual(sameRetry.status, 201);
      assert.strictEqual(sameRetry.headers.get('idempotent-replay'), 'true');

      const differentPayload = await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Agent B', provider: 'custom', command: 'echo B' }),
      });
      assert.strictEqual(differentPayload.status, 409);
      const conflictBody = await differentPayload.json();
      assert.strictEqual(conflictBody.code, 'IDEMPOTENCY_CONFLICT');

      const agents = await (await fetch(`${server.baseUrl}/api/agents`)).json();
      assert.strictEqual(agents.length, 1, 'the conflicting request must not have silently created "Agent B"');
      assert.strictEqual(agents[0].name, 'Agent A');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ---------------- Effective-model accounting regression tests ----------------
  // The defect: workers resolved their own default model at execution time
  // while agentManager recorded and priced the unresolved `agent.model`, so a
  // blank-model agent spent real money against a real default but was recorded
  // as model: null / costUsd: null — invisible to run history and to the
  // knownCost totals the daily budget caps compare against. See src/models.js.
  //
  // These cases need no API key and make no paid call: the run record and its
  // audit event are written BEFORE the provider is contacted, and the worker
  // then fails fast on the missing key.

  await check('a blank-model paid agent records the resolved default model, not null', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const agent = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Blank Model', provider: 'anthropic', task: 'noop' }),
      })).json();
      assert.strictEqual(agent.model, null, 'precondition: no model configured');

      await fetch(`${server.baseUrl}/api/agents/${agent.id}/start`, { method: 'POST' });

      // The run fails (no ANTHROPIC_API_KEY) but provenance is already written.
      let runs = [];
      for (let i = 0; i < 40; i += 1) {
        ({ runs } = await (await fetch(`${server.baseUrl}/api/agents/${agent.id}/runs`)).json());
        if (runs.length > 0 && runs[0].status !== 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(
        runs[0].model,
        'claude-sonnet-5',
        'run record must name the model that would actually have been invoked'
      );
      assert.strictEqual(runs[0].provider, 'anthropic');

      // The audit event must carry the same resolved value, not null.
      const events = await (await fetch(`${server.baseUrl}/api/activity?limit=200`)).json();
      const started = events.find((e) => e.action === 'run.started');
      assert.ok(started, 'run.started event must exist');
      assert.strictEqual(started.details.model, 'claude-sonnet-5');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('an explicitly configured model is recorded unchanged, and custom agents stay model-free', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);

      // Explicit model on a paid provider — must be preserved verbatim.
      const explicit = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Explicit', provider: 'openai', task: 'noop', model: 'gpt-4o' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${explicit.id}/start`, { method: 'POST' });

      // Custom provider — no model concept, and unaffected by this change.
      const custom = await (await fetch(`${server.baseUrl}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Custom', provider: 'custom', command: 'echo done' }),
      })).json();
      await fetch(`${server.baseUrl}/api/agents/${custom.id}/start`, { method: 'POST' });

      const settled = async (id) => {
        let runs = [];
        for (let i = 0; i < 40; i += 1) {
          ({ runs } = await (await fetch(`${server.baseUrl}/api/agents/${id}/runs`)).json());
          if (runs.length > 0 && runs[0].status !== 'running') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return runs[0];
      };

      const explicitRun = await settled(explicit.id);
      assert.strictEqual(explicitRun.model, 'gpt-4o', 'explicit model must not be replaced by the default');

      const customRun = await settled(custom.id);
      assert.strictEqual(customRun.status, 'completed');
      assert.strictEqual(customRun.model, null, 'custom agents have no model');
      assert.strictEqual(customRun.costUsd, null, 'custom agents are never assigned a cost');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ---------------- Feature Onboard (Phase 3) API tests ----------------
  // Full HTTP coverage of the workspace operating layer: workspace scoping,
  // server-computed progress, YC, onboarding, and restart persistence.

  const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const post = (base, p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const put = (base, p, b) => fetch(`${base}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

  await check('two workspaces keep their records strictly separated over HTTP', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const a = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'Alpha' }))).body;
      const b = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'Beta' }))).body;

      const goalA = (await json(await post(server.baseUrl, `/api/workspaces/${a.id}/goals`, { title: 'A goal' }))).body;
      await post(server.baseUrl, `/api/workspaces/${b.id}/goals`, { title: 'B goal' });

      // list is scoped
      const aList = (await json(await fetch(`${server.baseUrl}/api/workspaces/${a.id}/goals`))).body;
      const bList = (await json(await fetch(`${server.baseUrl}/api/workspaces/${b.id}/goals`))).body;
      assert.strictEqual(aList.length, 1);
      assert.strictEqual(bList.length, 1);
      assert.strictEqual(aList[0].title, 'A goal');

      // cross-workspace GET of A's goal under B is a 404, not a leak
      const cross = await json(await fetch(`${server.baseUrl}/api/workspaces/${b.id}/goals/${goalA.id}`));
      assert.strictEqual(cross.status, 404);
      // cross-workspace PUT/DELETE under B must not touch A's goal
      assert.strictEqual((await put(server.baseUrl, `/api/workspaces/${b.id}/goals/${goalA.id}`, { title: 'hijack' })).status, 404);
      assert.strictEqual((await fetch(`${server.baseUrl}/api/workspaces/${b.id}/goals/${goalA.id}`, { method: 'DELETE' })).status, 404);
      const stillA = (await json(await fetch(`${server.baseUrl}/api/workspaces/${a.id}/goals/${goalA.id}`))).body;
      assert.strictEqual(stillA.title, 'A goal');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('workspace progress is computed server-side from milestones, not trusted from the client', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const ws = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'Prog' }))).body;
      assert.strictEqual(ws.progress.progress, null); // no milestones yet -> null, not 0

      // A client trying to assert its own progress must be ignored.
      await post(server.baseUrl, `/api/workspaces/${ws.id}/goals`, { title: 'G', progress: 99, milestones: [{ label: 'a', done: true }, { label: 'b' }] });
      const after = (await json(await fetch(`${server.baseUrl}/api/workspaces/${ws.id}`))).body;
      assert.strictEqual(after.progress.progress, 50); // 1 of 2 milestones, server-computed
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('YC progress updates deterministically and rejects unknown items', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const ws = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'YC', ycEnabled: true }))).body;
      const before = (await json(await fetch(`${server.baseUrl}/api/workspaces/${ws.id}/yc`))).body;
      assert.strictEqual(before.overall, 0);
      assert.strictEqual(before.sections.length, 4);

      const updated = (await json(await put(server.baseUrl, `/api/workspaces/${ws.id}/yc`, { itemId: 'ss_enrolled', done: true }))).body;
      assert.ok(updated.overall > 0);

      const bad = await json(await put(server.baseUrl, `/api/workspaces/${ws.id}/yc`, { itemId: 'not_real', done: true }));
      assert.strictEqual(bad.status, 400);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('unknown workspace id is a 404 on every scoped route', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      for (const p of ['/api/workspaces/ghost', '/api/workspaces/ghost/goals', '/api/workspaces/ghost/yc', '/api/workspaces/ghost/agents']) {
        assert.strictEqual((await fetch(`${server.baseUrl}${p}`)).status, 404, `${p} should 404`);
      }
      assert.strictEqual((await post(server.baseUrl, '/api/workspaces/ghost/goals', { title: 'x' })).status, 404);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('onboarding is first-run detectable, resumable, and completable over HTTP', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      assert.strictEqual((await json(await fetch(`${server.baseUrl}/api/onboarding`))).body, null); // first run
      await post(server.baseUrl, '/api/onboarding/start');
      await put(server.baseUrl, '/api/onboarding', { currentStep: 'workspace', draft: { name: 'Draft Co' } });
      const mid = (await json(await fetch(`${server.baseUrl}/api/onboarding`))).body;
      assert.strictEqual(mid.currentStep, 'workspace');
      assert.strictEqual(mid.draft.name, 'Draft Co');
      assert.strictEqual((await put(server.baseUrl, '/api/onboarding', { currentStep: 'bogus' })).status, 400);
      await post(server.baseUrl, '/api/onboarding/complete', { skipped: false });
      assert.strictEqual((await json(await fetch(`${server.baseUrl}/api/onboarding`))).body.completed, true);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('workspaces and their records survive a server restart, and audit events are recorded', async () => {
    const dataDir = freshDataDir();
    let server = startServer(dataDir);
    let wsId;
    try {
      await waitForReady(server.baseUrl);
      const ws = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'Persisted' }))).body;
      wsId = ws.id;
      await post(server.baseUrl, `/api/workspaces/${wsId}/decisions`, { decision: 'Use JSON files', reasoning: 'single operator' });
      // audit event exists for the workspace creation
      const activity = (await json(await fetch(`${server.baseUrl}/api/activity?limit=200`))).body;
      assert.ok(activity.some((e) => e.action === 'workspace.created'), 'workspace.created audit event missing');
    } finally {
      await stopServer(server);
    }
    // Restart against the same data dir.
    server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      const list = (await json(await fetch(`${server.baseUrl}/api/workspaces`))).body;
      assert.ok(list.some((w) => w.id === wsId), 'workspace did not survive restart');
      const decisions = (await json(await fetch(`${server.baseUrl}/api/workspaces/${wsId}/decisions`))).body;
      assert.strictEqual(decisions.length, 1);
      assert.strictEqual(decisions[0].decision, 'Use JSON files');
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('every Feature Onboard store is registered for operator recovery', async () => {
    // A newly added store that the recovery endpoint does not know about is a
    // real gap: it would be the one store an operator could not repair after
    // corruption or tampering. This asserts the wiring rather than trusting it,
    // and is why docs/FEATURE_ONBOARD.md can state it as fact.
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      // Create data in every store so each has a file and a backup to restore.
      const ws = (await json(await post(server.baseUrl, '/api/workspaces', { name: 'Recover' }))).body;
      await put(server.baseUrl, '/api/profile', { skills: ['x'] });
      await post(server.baseUrl, '/api/onboarding/start');
      await put(server.baseUrl, `/api/workspaces/${ws.id}/yc`, { itemId: 'ss_enrolled', done: true });
      await put(server.baseUrl, `/api/workspaces/${ws.id}/agents/interview_agent`, { enabled: true });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/goals`, { title: 'g' });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/tasks`, { title: 't' });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/decisions`, { decision: 'd' });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/assumptions`, { statement: 'a' });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/experiments`, { title: 'e' });
      await post(server.baseUrl, `/api/workspaces/${ws.id}/evidence`, { summary: 's', evidenceKind: 'customer_statement' });

      const storeNames = [
        'workspaces', 'founder_profile', 'onboarding_state', 'yc_progress', 'workspace_agent_settings',
        'workspace_goals', 'workspace_tasks', 'workspace_decisions',
        'workspace_assumptions', 'workspace_experiments', 'workspace_evidence',
      ];
      for (const name of storeNames) {
        const res = await post(server.baseUrl, `/api/security/stores/${name}/recover`, { resolution: 'restore_backup' });
        assert.notStrictEqual(res.status, 404, `store "${name}" is not registered for recovery`);
        assert.strictEqual(res.status, 200, `recovery of "${name}" should succeed (got ${res.status})`);
      }
      // and an unknown store is still rejected
      const unknown = await post(server.baseUrl, '/api/security/stores/not_a_store/recover', { resolution: 'restore_backup' });
      assert.strictEqual(unknown.status, 404);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await check('existing agent and workstream APIs still work alongside Feature Onboard', async () => {
    const dataDir = freshDataDir();
    const server = startServer(dataDir);
    try {
      await waitForReady(server.baseUrl);
      // pre-existing endpoints unaffected by the new routes
      const agent = (await json(await post(server.baseUrl, '/api/agents', { name: 'Legacy', provider: 'custom', command: 'echo hi' }))).body;
      assert.ok(agent.id);
      const ws = (await json(await post(server.baseUrl, '/api/workstreams', { name: 'Legacy WS' }))).body;
      assert.ok(ws.id);
      // and the new namespace coexists
      assert.strictEqual((await fetch(`${server.baseUrl}/api/workspaces`)).status, 200);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}`);
    process.exitCode = 1;
  }
}

run();
