// Shared harness for the Feature Onboard browser tests.
//
// Deliberately NOT using @playwright/test: this repo's testing convention is
// plain Node scripts with a tiny check() helper (see test/integration.test.js),
// and adding a second test-runner framework would be more machinery than the
// suite needs. This module owns the parts that are genuinely fiddly — resolving
// a Chromium binary across local/CI, spawning an isolated server, and capturing
// debugging artifacts when something fails.
//
// Guarantees relied on by the suite:
//   - every run gets its own throwaway RUCKER_DATA_DIR (no shared state, so
//     tests do not depend on execution order),
//   - no API keys are provided, so no paid provider call can occur,
//   - the server child process and the temp directory are always cleaned up,
//     including when a test throws.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');
const ARTIFACT_DIR = process.env.RUCKER_TEST_ARTIFACTS || path.join(REPO_ROOT, 'test-artifacts');

// Resolve a usable Chromium. Order matters:
//  1. explicit override (RUCKER_CHROMIUM) — an operator/CI can always pin one;
//  2. the build Playwright itself expects (the normal case after
//     `npx playwright install chromium`, which is what CI does);
//  3. any chromium-<rev> already present in PLAYWRIGHT_BROWSERS_PATH — this
//     environment ships a build whose revision may not match the pinned
//     Playwright exactly, and refusing to run over an off-by-one revision
//     would mean no browser coverage at all locally.
// Returns null when nothing usable exists, so the caller can skip with a clear
// message instead of throwing an opaque launch error.
function resolveChromium() {
  if (process.env.RUCKER_CHROMIUM && fs.existsSync(process.env.RUCKER_CHROMIUM)) {
    return { path: process.env.RUCKER_CHROMIUM, source: 'RUCKER_CHROMIUM' };
  }
  try {
    const expected = chromium.executablePath();
    if (expected && fs.existsSync(expected)) return { path: expected, source: 'playwright-managed' };
  } catch { /* executablePath throws if browsers were never installed */ }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    const candidates = fs.readdirSync(root)
      .filter((d) => d.startsWith('chromium-'))
      .map((d) => path.join(root, d, 'chrome-linux', 'chrome'))
      .filter((p) => fs.existsSync(p))
      .sort();
    if (candidates.length) return { path: candidates[candidates.length - 1], source: 'PLAYWRIGHT_BROWSERS_PATH' };
  }
  return null;
}

let portCursor = 4930 + Math.floor(Math.random() * 40);

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rucker-fe-'));
}

// Spawn a real server against an isolated data directory. No provider API keys
// are passed, so a paid call is impossible by construction.
function startServer(dataDir, extraEnv = {}) {
  const port = portCursor++;
  const env = { ...process.env, RUCKER_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const proc = spawn('node', [SERVER_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  return { proc, port, dataDir, baseUrl: `http://127.0.0.1:${port}`, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitForReady(baseUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(`${baseUrl}/api/providers`); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

async function stopServer(server) {
  if (!server || server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill('SIGTERM');
  const start = Date.now();
  while (server.proc.exitCode === null && server.proc.signalCode === null && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (server.proc.exitCode === null && server.proc.signalCode === null) server.proc.kill('SIGKILL');
}

// Attach observers so every test can assert on console errors, page errors and
// failed requests without repeating the wiring. Returns the collected arrays.
function observe(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  return { consoleErrors, pageErrors, failedRequests };
}

// Persist everything useful for debugging a CI failure. Deliberately does NOT
// write environment variables or request headers, which can carry secrets.
async function captureArtifacts(name, { page, server, observed, error }) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const safe = name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
    const dir = path.join(ARTIFACT_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      fs.writeFileSync(path.join(dir, 'page.html'), html);
    }
    const report = [
      `test: ${name}`,
      `error: ${error ? error.stack || error.message : '(none)'}`,
      '',
      '--- console errors ---', ...(observed?.consoleErrors || []),
      '', '--- page errors ---', ...(observed?.pageErrors || []),
      '', '--- failed requests ---', ...(observed?.failedRequests || []),
      '', '--- server stdout ---', server ? server.getStdout() : '',
      '', '--- server stderr ---', server ? server.getStderr() : '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'report.txt'), report);
  } catch { /* artifact capture must never mask the original failure */ }
}

module.exports = {
  chromium, resolveChromium, freshDataDir, startServer, waitForReady, stopServer,
  observe, captureArtifacts, ARTIFACT_DIR, REPO_ROOT,
};
