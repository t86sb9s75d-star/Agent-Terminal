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

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}`);
    process.exitCode = 1;
  }
}

run();
