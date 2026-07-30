// Feature Onboard — browser critical-path suite.
// Run with: npm run test:frontend
//
// Every case spawns a real server against its own throwaway data directory and
// drives real Chromium. No API keys are passed to the server, so no paid
// provider call can occur. On failure, artifacts (screenshot, page HTML,
// console/page errors, failed requests, server stdout/stderr) are written to
// test-artifacts/<case>/ for CI to upload.
//
// Test classification is noted per case:
//   [contract]    frontend depends on an exact server response shape
//   [regression]  guards a defect that was actually observed
//   [adversarial] hostile or malformed input
//   [smoke]       does the path work at all
//   [a11y]        accessibility semantics
//   [legacy]      pre-existing behavior must not break

const assert = require('assert');
const fs = require('fs');
const h = require('./harness');

let passed = 0;
const failures = [];

async function check(name, fn) {
  const dataDir = h.freshDataDir();
  const server = h.startServer(dataDir);
  let browser = null;
  let page = null;
  let observed = null;
  try {
    await h.waitForReady(server.baseUrl);
    browser = await h.chromium.launch({ executablePath: CHROMIUM.path });
    page = await browser.newPage();
    observed = h.observe(page);
    await fn({ page, server, base: server.baseUrl, observed });
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`not ok - ${name}`);
    await h.captureArtifacts(name, { page, server, observed, error: err });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await h.stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---- helpers shared by cases ----
const api = (base, path, method = 'GET', body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// Drive the wizard from welcome to a completed workspace.
async function completeOnboarding(page, workspaceName) {
  await page.waitForSelector('.fo-wizard', { timeout: 10000 });
  await page.click('[data-wz="next"][data-next="profile"]');
  await page.click('[data-wz="next"][data-next="operating_mode"]');
  await page.click('[data-wz="next"][data-next="workspace"]');
  await page.waitForSelector('.fo-wizard [name="name"]');
  await page.fill('.fo-wizard [name="name"]', workspaceName);
  await page.click('[data-wz="next"][data-next="agents"]');
  await page.click('[data-wz="next"][data-next="permissions"]');
  await page.click('[data-wz="next"][data-next="yc"]');
  await page.click('[data-wz="next"][data-next="review"]');
  await page.click('[data-wz="next"][data-next="done"]');
  await page.waitForSelector('.fo-cc-name', { timeout: 10000 });
}

// Seed a workspace through the API and mark onboarding done, so a case can go
// straight to the surface under test.
async function seedWorkspace(base, name, extra = {}) {
  const ws = (await api(base, '/api/workspaces', 'POST', { name, ...extra })).body;
  await api(base, '/api/onboarding/start', 'POST');
  await api(base, '/api/onboarding/complete', 'POST', { skipped: false });
  return ws;
}

let CHROMIUM = null;

async function run() {
  CHROMIUM = h.resolveChromium();
  if (!CHROMIUM) {
    console.log('# no Chromium available — skipping frontend suite');
    console.log('# set RUCKER_CHROMIUM, or run: npx playwright install chromium');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  console.log(`# chromium: ${CHROMIUM.path} (${CHROMIUM.source})`);

  // ---------------- onboarding lifecycle ----------------

  await check('[smoke] first-run onboarding appears on a fresh install', async ({ page, base }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard', { timeout: 10000 });
    assert.ok(await page.isVisible('.fo-wizard'));
  });

  await check('[regression] workspace step blocks advancing without a name', async ({ page, base }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="next"][data-next="profile"]');
    await page.click('[data-wz="next"][data-next="operating_mode"]');
    await page.click('[data-wz="next"][data-next="workspace"]');
    await page.waitForSelector('.fo-wizard [name="name"]');
    await page.click('[data-wz="next"][data-next="agents"]'); // empty name
    assert.ok(await page.$('.fo-wizard [name="name"]'), 'should still be on the workspace step');
    assert.strictEqual(await page.getAttribute('.fo-wizard [name="name"]', 'aria-invalid'), 'true',
      'the invalid field must be marked aria-invalid for assistive tech');
  });

  await check('[smoke] onboarding can be skipped and does not reappear on reload', async ({ page, base }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="skip"]');
    await page.waitForTimeout(300);
    assert.ok(!(await page.isVisible('.fo-wizard')), 'wizard should close on skip');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const wiz = await page.$('.fo-wizard');
    assert.ok(!wiz || !(await page.isVisible('.fo-wizard')), 'skipped onboarding must not reappear');
  });

  await check('[regression] partial onboarding persists and resumes after reload', async ({ page, base }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="next"][data-next="profile"]');
    await page.click('[data-wz="next"][data-next="operating_mode"]');
    await page.waitForTimeout(300); // let the PUT land
    const saved = (await api(base, '/api/onboarding')).body;
    assert.strictEqual(saved.currentStep, 'operating_mode', 'server should hold the in-progress step');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    const resumed = await page.textContent('.fo-wizard-body');
    assert.ok(resumed.includes('operating'), `resumed on the saved step (got: ${resumed.slice(0, 60)})`);
  });

  await check('[smoke] completing onboarding creates the workspace and lands in Command Center', async ({ page, base }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await completeOnboarding(page, 'Apparel Co');
    assert.ok((await page.textContent('.fo-cc-name')).includes('Apparel Co'));
    const list = (await api(base, '/api/workspaces')).body;
    assert.strictEqual(list.length, 1, 'exactly one workspace should have been created');
    const ob = (await api(base, '/api/onboarding')).body;
    assert.strictEqual(ob.completed, true);
  });

  await check('[smoke] onboarding can be reopened from Settings', async ({ page, base }) => {
    await seedWorkspace(base, 'Seeded');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="settings"]');
    await page.waitForSelector('[data-fo="reopen-onboarding"]');
    await page.click('[data-fo="reopen-onboarding"]');
    await page.waitForSelector('.fo-wizard', { timeout: 5000 });
    assert.ok(await page.isVisible('.fo-wizard'), 'wizard should reopen');
    // reopening must not have destroyed the existing workspace
    assert.strictEqual((await api(base, '/api/workspaces')).body.length, 1);
  });

  // ---------------- workspaces + isolation ----------------

  await check('[contract] workspace switching swaps the rendered records (no cross-workspace leak)', async ({ page, base }) => {
    const a = await seedWorkspace(base, 'Alpha');
    const b = (await api(base, '/api/workspaces', 'POST', { name: 'Beta' })).body;
    await api(base, `/api/workspaces/${a.id}/goals`, 'POST', { title: 'ALPHA-ONLY-GOAL' });
    await api(base, `/api/workspaces/${b.id}/goals`, 'POST', { title: 'BETA-ONLY-GOAL' });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');
    await page.selectOption('#fo-workspace', a.id);
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(300);
    let panel = await page.textContent('#fo-business-panel');
    assert.ok(panel.includes('ALPHA-ONLY-GOAL'), 'A shows its own goal');
    assert.ok(!panel.includes('BETA-ONLY-GOAL'), 'A must NOT show B\'s goal');

    await page.selectOption('#fo-workspace', b.id);
    await page.waitForTimeout(400);
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(200);
    panel = await page.textContent('#fo-business-panel');
    assert.ok(panel.includes('BETA-ONLY-GOAL'), 'B shows its own goal');
    assert.ok(!panel.includes('ALPHA-ONLY-GOAL'), 'B must NOT show A\'s goal');
  });

  await check('[contract] every workspace-owned record type stays scoped in the UI', async ({ page, base }) => {
    const a = await seedWorkspace(base, 'Alpha');
    const b = (await api(base, '/api/workspaces', 'POST', { name: 'Beta' })).body;
    await api(base, `/api/workspaces/${a.id}/decisions`, 'POST', { decision: 'ALPHA-DECISION' });
    await api(base, `/api/workspaces/${a.id}/assumptions`, 'POST', { statement: 'ALPHA-ASSUMPTION' });
    await api(base, `/api/workspaces/${a.id}/evidence`, 'POST', { summary: 'ALPHA-EVIDENCE', evidenceKind: 'customer_statement' });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');
    await page.selectOption('#fo-workspace', b.id);
    await page.waitForTimeout(400);
    for (const tab of ['decisions', 'assumptions', 'evidence']) {
      await page.click(`[data-fo-tab="${tab}"]`);
      await page.waitForTimeout(200);
      const panel = await page.textContent('#fo-business-panel');
      assert.ok(!panel.includes('ALPHA-'), `workspace B must not render A's ${tab}`);
    }
  });

  await check('[smoke] creating a record through the UI persists and renders', async ({ page, base }) => {
    await seedWorkspace(base, 'Rec');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="decisions"]');
    await page.click('[data-fo-add="decision"]');
    await page.waitForSelector('.fo-modal');
    await page.fill('.fo-modal [name="decision"]', 'Use JSON files');
    await page.click('.fo-modal button[type="submit"]');
    await page.waitForTimeout(500);
    assert.ok((await page.textContent('#fo-business-panel')).includes('Use JSON files'));
  });

  await check('[contract] agent recommendations follow the workspace stage', async ({ page, base }) => {
    const early = await seedWorkspace(base, 'Early', { stage: 'problem_discovery' });
    const late = (await api(base, '/api/workspaces', 'POST', { name: 'Late', stage: 'first_revenue' })).body;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');
    await page.selectOption('#fo-workspace', early.id);
    await page.waitForTimeout(300);
    await page.click('[data-fo-tab="agents"]');
    await page.waitForTimeout(300);
    const earlyRecs = await page.$$eval('.fo-agent.recommended .fo-agent-name', (els) => els.map((e) => e.textContent));
    await page.selectOption('#fo-workspace', late.id);
    await page.waitForTimeout(400);
    await page.click('[data-fo-tab="agents"]');
    await page.waitForTimeout(300);
    const lateRecs = await page.$$eval('.fo-agent.recommended .fo-agent-name', (els) => els.map((e) => e.textContent));
    assert.ok(earlyRecs.length > 0 && lateRecs.length > 0, 'both stages recommend something');
    assert.notDeepStrictEqual(earlyRecs.sort(), lateRecs.sort(), 'recommendations must differ by stage');
  });

  await check('[smoke] per-workspace agent enablement persists across reload', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Agents');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="agents"]');
    await page.waitForSelector('[data-fo-agent="interview_agent"]');
    await page.check('[data-fo-agent="interview_agent"]');
    await page.waitForTimeout(400);
    const server = (await api(base, `/api/workspaces/${ws.id}/agents`)).body;
    const row = server.agents.find((a) => a.id === 'interview_agent');
    assert.ok(row.settings && row.settings.enabled === true, 'enablement must reach the server');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="agents"]');
    await page.waitForSelector('[data-fo-agent="interview_agent"]');
    assert.strictEqual(await page.isChecked('[data-fo-agent="interview_agent"]'), true, 'must stay enabled after reload');
  });

  // ---------------- YC ----------------

  await check('[contract] YC tab renders all four sections with their checklist items', async ({ page, base }) => {
    await seedWorkspace(base, 'YC', { ycEnabled: true });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-yc-section');
    const labels = await page.$$eval('#view-yc .section-title', (els) => els.map((e) => e.textContent.trim()));
    for (const req of ['YC Startup School Progress', 'YC Business Process', 'YC Partner Search', 'YC Application Process']) {
      assert.ok(labels.includes(req), `missing YC section: ${req}`);
    }
    // This is the exact contract that broke once: sections must carry items.
    const items = await page.$$('#view-yc .fo-check input[type="checkbox"]');
    assert.ok(items.length >= 10, `expected the full checklist to render, got ${items.length} items`);
  });

  await check('[regression] toggling a YC item updates section and overall scores, and survives reload', async ({ page, base }) => {
    await seedWorkspace(base, 'YC', { ycEnabled: true });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-yc-section');
    const overallBefore = await page.textContent('#view-yc .fo-meter-val');
    const sectionBefore = await page.textContent('#view-yc .fo-section-score');
    await page.click('#view-yc .fo-check input[type="checkbox"]');
    await page.waitForTimeout(500);
    const overallAfter = await page.textContent('#view-yc .fo-meter-val');
    const sectionAfter = await page.textContent('#view-yc .fo-section-score');
    assert.notStrictEqual(overallBefore, overallAfter, `overall must change (${overallBefore} -> ${overallAfter})`);
    assert.notStrictEqual(sectionBefore, sectionAfter, `section score must change (${sectionBefore} -> ${sectionAfter})`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-yc-section');
    assert.strictEqual(await page.textContent('#view-yc .fo-meter-val'), overallAfter, 'YC progress must survive reload');
  });

  await check('[contract] YC missing-items list shrinks as items are completed', async ({ page, base }) => {
    await seedWorkspace(base, 'YC', { ycEnabled: true });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-missing');
    const before = await page.textContent('#view-yc .fo-missing');
    await page.click('#view-yc .fo-check input[type="checkbox"]');
    await page.waitForTimeout(500);
    const after = await page.textContent('#view-yc .fo-missing');
    assert.notStrictEqual(before, after, 'missing-items text should update');
  });

  await check('[contract] YC progress is never presented as an acceptance probability', async ({ page, base }) => {
    await seedWorkspace(base, 'YC', { ycEnabled: true });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-yc-section');
    const text = (await page.textContent('#view-yc')).toLowerCase();
    for (const phrase of ['chance of acceptance', 'probability', 'likely to be accepted', 'odds of acceptance']) {
      assert.ok(!text.includes(phrase), `YC copy must not claim "${phrase}"`);
    }
    assert.ok(text.includes('not a prediction') || text.includes('preparation'), 'YC copy should frame the score as preparation');
  });

  // ---------------- safety / adversarial ----------------

  await check('[adversarial] operator-supplied HTML renders as text, never as elements', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Hostile <script>alert(1)</script>');
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: '<img src=x onerror="window.__pwned=1">' });
    await api(base, `/api/workspaces/${ws.id}/decisions`, 'POST', { decision: '"><svg onload="window.__pwned=1">' });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-cc-name');
    // nothing injected executed
    assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, 'no injected handler may execute');
    // and no real elements were created from the payloads
    const injected = await page.evaluate(() => document.querySelectorAll('#view-business script, #view-business svg[onload], #view-business img[onerror]').length);
    assert.strictEqual(injected, 0, 'payloads must not become live elements');
    // the text is still visible to the operator
    assert.ok((await page.textContent('.fo-cc-name')).includes('<script>'), 'the literal text should be shown');
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
  });

  await check('[adversarial] a quote-breaking id from a tampered store cannot forge an attribute', async ({ page, base, server }) => {
    // Record ids are the only operator-adjacent values that reach an ATTRIBUTE
    // context (data-id, <option value>), and the API always generates them as
    // UUIDs — so a quote payload cannot be delivered through the API at all.
    // The realistic delivery path is a hand-edited/corrupted store file, which
    // this project's threat model explicitly contemplates. Tamper the goals
    // file directly so a malicious id really does reach attr(), then assert no
    // attribute is forged. (Written this way after the first version of this
    // test was found to be vacuous: it put the payload in the goal TITLE, which
    // renders in text context and therefore passed even with escaping broken.)
    const ws = await seedWorkspace(base, 'Attr');
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: 'Tampered' });
    await h.stopServer(server); // stop so our write is not overwritten in-flight

    const dataDir = server.dataDir;
    const file = require('path').join(dataDir, 'workspace_goals.json');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.records[0].id = '" onmouseover="window.__pwned=1" x="';
    fs.writeFileSync(file, JSON.stringify(envelope, null, 2));

    const restarted = h.startServer(dataDir);
    try {
      await h.waitForReady(restarted.baseUrl);
      await page.goto(restarted.baseUrl, { waitUntil: 'networkidle' });
      await page.click('.rail-item[data-view="business"]');
      await page.waitForSelector('.fo-tab');
      await page.click('[data-fo-tab="goals"]');
      await page.waitForTimeout(400);
      const forged = await page.evaluate(() => document.querySelectorAll('#view-business [onmouseover]').length);
      assert.strictEqual(forged, 0, 'a malicious id must not be able to forge an event-handler attribute');
      assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, 'no injected handler may execute');
    } finally {
      await h.stopServer(restarted);
    }
  });

  await check('[adversarial] unicode, emoji, RTL and newlines render and persist safely', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Unicode');
    const tricky = 'Café 😀 مرحبا\nsecond line';
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: tricky });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(300);
    const panel = await page.textContent('#fo-business-panel');
    assert.ok(panel.includes('Café') && panel.includes('😀') && panel.includes('مرحبا'), 'unicode must render');
    // and it round-trips through the API unchanged
    const goals = (await api(base, `/api/workspaces/${ws.id}/goals`)).body;
    assert.strictEqual(goals[0].title, tricky, 'value must persist byte-for-byte');
  });

  await check('[adversarial] an extremely long value does not break layout or overflow the page', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Long');
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: 'A'.repeat(5000) });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `a 5000-char value must not cause horizontal overflow (got ${overflow}px)`);
  });

  // ---------------- accessibility ----------------

  await check('[a11y] dialogs close with Escape and expose dialog semantics', async ({ page, base }) => {
    await seedWorkspace(base, 'A11y');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="goals"]');
    await page.click('[data-fo-add="goal"]');
    await page.waitForSelector('.fo-modal');
    const role = await page.getAttribute('.modal-overlay[role="dialog"]', 'aria-modal');
    assert.strictEqual(role, 'true', 'dialog must set aria-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.$('.fo-modal'), null, 'Escape must close the dialog');
  });

  await check('[a11y] progress controls expose readable accessible values', async ({ page, base }) => {
    await seedWorkspace(base, 'A11y', { ycEnabled: true });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('[role="progressbar"]');
    const bars = await page.$$eval('#view-yc [role="progressbar"]', (els) => els.map((e) => ({
      now: e.getAttribute('aria-valuenow'), text: e.getAttribute('aria-valuetext'),
      min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax'),
    })));
    assert.ok(bars.length > 0, 'YC view should expose a progressbar');
    for (const b of bars) {
      assert.ok(b.now !== null && b.min === '0' && b.max === '100', 'progressbar needs now/min/max');
      assert.ok(b.text && b.text.length > 0, 'progressbar needs a human-readable aria-valuetext');
    }
  });

  await check('[a11y] tabs expose tablist/tab semantics with a selected state', async ({ page, base }) => {
    await seedWorkspace(base, 'A11y');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tabs');
    assert.strictEqual(await page.getAttribute('.fo-tabs', 'role'), 'tablist');
    const selected = await page.$$eval('.fo-tab', (els) => els.map((e) => e.getAttribute('aria-selected')));
    assert.strictEqual(selected.filter((s) => s === 'true').length, 1, 'exactly one tab is selected');
  });

  await check('[a11y] keyboard-only navigation reaches the Business view and its tabs', async ({ page, base }) => {
    await seedWorkspace(base, 'Keyboard');
    await page.goto(base, { waitUntil: 'networkidle' });
    // Tab until the Business rail item is focused, then activate with Enter.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.dataset?.view === 'business');
    }
    assert.ok(reached, 'Business rail item must be reachable by keyboard');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.ok(await page.isVisible('.fo-tabs'), 'Enter should activate the view');
  });

  // ---------------- mobile ----------------

  await check('[a11y] mobile 390px: nav works, wizard is usable, no horizontal overflow', async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    // wizard must be reachable/scrollable, not clipped off-screen
    const wizBox = await page.$eval('.fo-wizard', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, width: r.width }; });
    assert.ok(wizBox.width <= 390, 'wizard must fit the viewport width');
    await completeOnboarding(page, 'Mobile Co');
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal overflow after onboarding (got ${overflow}px)`);
    await page.click('.rail-item[data-view="yc"]');
    await page.waitForSelector('.fo-yc-section');
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal overflow on YC at 390px (got ${overflow}px)`);
  });

  await check('[a11y] short viewport (on-screen keyboard) does not trap the wizard', async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 360 }); // keyboard-open-ish
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="next"][data-next="profile"]');
    await page.click('[data-wz="next"][data-next="operating_mode"]');
    await page.click('[data-wz="next"][data-next="workspace"]');
    await page.waitForSelector('.fo-wizard [name="name"]');
    // The primary action must be reachable — either already visible or after scrolling.
    const btn = await page.$('[data-wz="next"][data-next="agents"]');
    await btn.scrollIntoViewIfNeeded();
    assert.ok(await btn.isVisible(), 'the continue button must be reachable on a short viewport');
  });

  // ---------------- legacy regression ----------------

  await check('[legacy] existing Command, Agents, Activity and Workstreams views still work', async ({ page, base }) => {
    await seedWorkspace(base, 'Legacy');
    await page.goto(base, { waitUntil: 'networkidle' });
    for (const view of ['command', 'workstreams', 'agents', 'activity', 'security']) {
      await page.click(`.rail-item[data-view="${view}"]`);
      await page.waitForTimeout(350);
      const visible = await page.isVisible(`#view-${view}`);
      assert.ok(visible, `legacy view ${view} should be visible when selected`);
      const html = await page.innerHTML(`#view-${view}`);
      assert.ok(html.trim().length > 0, `legacy view ${view} should render content`);
    }
  });

  await check('[legacy] creating an agent through the existing UI still works', async ({ page, base }) => {
    await seedWorkspace(base, 'Legacy');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('#new-agent-btn');
    await page.waitForSelector('#agent-form');
    await page.fill('#agent-form [name="name"]', 'Legacy Agent');
    await page.click('#provider-segmented [data-provider="custom"]');
    await page.fill('#agent-form [name="command"]', 'echo hi');
    await page.click('#agent-form button[type="submit"]');
    await page.waitForTimeout(600);
    const agents = (await api(base, '/api/agents')).body;
    assert.strictEqual(agents.length, 1, 'the agent should have been created');
    assert.strictEqual(agents[0].name, 'Legacy Agent');
  });

  await check('[legacy] existing workstream creation and run history remain available', async ({ page, base }) => {
    await seedWorkspace(base, 'Legacy');
    const ws = (await api(base, '/api/workstreams', 'POST', { name: 'Legacy WS' })).body;
    assert.ok(ws.id, 'workstream API still works');
    const agent = (await api(base, '/api/agents', 'POST', { name: 'Runner', provider: 'custom', command: 'echo done' })).body;
    await api(base, `/api/agents/${agent.id}/start`, 'POST');
    await new Promise((r) => setTimeout(r, 1200));
    const runs = (await api(base, `/api/agents/${agent.id}/runs`)).body;
    assert.ok(runs.runs.length >= 1, 'run history should record the run');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="workstreams"]');
    await page.waitForTimeout(400);
    assert.ok((await page.innerHTML('#view-workstreams')).includes('Legacy WS'), 'workstream renders in the legacy view');
  });

  // ---------------- observation ----------------

  await check('[smoke] a full session produces no console errors, page errors, or failed requests', async ({ page, base, observed }) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await completeOnboarding(page, 'Clean Session');
    for (const view of ['yc', 'business', 'settings', 'command', 'agents', 'activity']) {
      await page.click(`.rail-item[data-view="${view}"]`);
      await page.waitForTimeout(300);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    assert.deepStrictEqual(observed.pageErrors, [], 'no uncaught page errors');
    assert.deepStrictEqual(observed.consoleErrors, [], 'no console errors');
    assert.deepStrictEqual(observed.failedRequests, [], 'no failed/4xx-5xx requests (including favicon)');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack || f.err.message}`);
    process.exitCode = 1;
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
