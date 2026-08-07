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

// Assert that `needle` appears in `selector`, waiting for it rather than
// sleeping first. A mutation here means POST -> reload eight endpoints ->
// re-render, and a fixed sleep that is generous on a developer machine is not
// generous on a loaded CI runner. This failed exactly that way in CI on a
// 500ms sleep, so every "content appears after an action" assertion goes
// through here.
//
// It is still a real assertion: it throws with the same message on timeout,
// and it cannot pass by the content never rendering.
async function expectText(page, selector, needle, message) {
  try {
    await page.waitForFunction(
      ({ sel, txt }) => {
        const el = document.querySelector(sel);
        return Boolean(el && el.textContent.includes(txt));
      },
      { sel: selector, txt: needle },
      { timeout: 10000 }
    );
  } catch {
    const actual = await page.textContent(selector).catch(() => '(selector not found)');
    throw new assert.AssertionError({
      message: `${message || `expected ${selector} to contain ${JSON.stringify(needle)}`}\n  actual: ${String(actual).slice(0, 300)}`,
    });
  }
}

// The negative counterpart. Deliberately requires the caller to have already
// established a positive signal (via expectText or a waitForSelector), because
// "text is absent" is trivially true before anything renders.
async function expectNoText(page, selector, needle, message) {
  const actual = await page.textContent(selector);
  assert.ok(!actual.includes(needle), message || `${selector} must not contain ${JSON.stringify(needle)}`);
}

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

// ---------------------------------------------------------------------------
// The authoritative workspace-owned record types, read from the BACKEND rather
// than restated here. A hard-coded copy is exactly how tasks and experiments
// came to have stores, validation, API routes and recovery registration while
// being unreachable by any operator for a whole release — nothing compared the
// two lists, so nothing failed.
// ---------------------------------------------------------------------------
const RECORD_STORES = require('../../src/workspaceRecordsStore').ALL;

// Types deliberately not given an operator surface. Adding to this list is a
// product decision that must be justified in docs/FEATURE_ONBOARD.md's Known
// Limitations, not a way to silence the contract test. It is empty on purpose.
const BACKEND_ONLY_RECORD_TYPES = [];

// How to drive each type through the real UI. `tab` is the Business-view tab,
// `titleField` the required field in its create dialog, `seed` an API payload.
const RECORD_UI = {
  goals: { tab: 'goals', add: 'goal', titleField: 'title', seed: (v) => ({ title: v }) },
  tasks: { tab: 'tasks', add: 'task', titleField: 'title', seed: (v) => ({ title: v }) },
  decisions: { tab: 'decisions', add: 'decision', titleField: 'decision', seed: (v) => ({ decision: v }) },
  assumptions: { tab: 'assumptions', add: 'assumption', titleField: 'statement', seed: (v) => ({ statement: v }) },
  experiments: { tab: 'experiments', add: 'experiment', titleField: 'title', seed: (v) => ({ title: v }) },
  evidence: { tab: 'evidence', add: 'evidence', titleField: 'summary', seed: (v) => ({ summary: v, evidenceKind: 'customer_statement' }) },
};

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
    // This case failed once under load and passed on retry. It was a real
    // race, not noise: it slept 300ms and then asserted the wizard was gone,
    // while the skip handler awaits POST /api/onboarding/complete first. Under
    // contention that POST outlasts the sleep.
    //
    // The reload half was worse — it slept 400ms and asserted the wizard was
    // ABSENT, so a slow boot passes the test by not having rendered yet. That
    // is a false pass on the assertion that matters, which is exactly the
    // shape of a test that cannot fail.
    //
    // Both now wait for a condition. The reload waits for a positive signal
    // that the app has finished booting before asserting the absence.
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="skip"]');
    // closeOnboarding() hides the overlay rather than removing it, so the
    // condition is 'hidden', not 'detached'. Asserting the wrong mechanism is
    // how a wait becomes a sleep with extra steps.
    await page.waitForSelector('.fo-wizard', { state: 'hidden', timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    // Positive proof the app booted: the nav rail is wired and the Business
    // view renders. Only then does "no wizard" mean anything.
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#view-business .view-heading', { timeout: 10000 });
    assert.ok(!(await page.isVisible('.fo-wizard')), 'skipped onboarding must not reappear');
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
    await expectText(page, '#fo-business-panel', 'ALPHA-ONLY-GOAL', 'A shows its own goal');
    await expectNoText(page, '#fo-business-panel', 'BETA-ONLY-GOAL', 'A must NOT show B\'s goal');

    await page.selectOption('#fo-workspace', b.id);
    await page.click('[data-fo-tab="goals"]');
    await expectText(page, '#fo-business-panel', 'BETA-ONLY-GOAL', 'B shows its own goal');
    await expectNoText(page, '#fo-business-panel', 'ALPHA-ONLY-GOAL', 'B must NOT show A\'s goal');
  });

  // R-008 — this case used to be named "every workspace-owned record type" while
  // covering three of six, and it asserted only ABSENCE, so a renderer that drew
  // nothing at all passed it. It now enumerates the backend's own list and
  // asserts both directions for every type: each workspace shows its own record
  // AND does not show the other's. A blank panel now fails on the positive half;
  // a panel leaking everything fails on the negative half.
  await check('[regression] a slow load for an abandoned workspace can never paint over the current one', async ({ page, base }) => {
    // A-001. Every other isolation case here WAITS for the correct data before
    // asserting, so none of them can observe a stale load landing afterwards —
    // the suite was structurally blind to this. The race is forced here by
    // delaying exactly one workspace's fetch, so it is deterministic rather
    // than timing-dependent.
    const a = await seedWorkspace(base, 'Alpha');
    const b = (await api(base, '/api/workspaces', 'POST', { name: 'Beta' })).body;
    await api(base, `/api/workspaces/${a.id}/goals`, 'POST', { title: 'ALPHA-SECRET' });
    await api(base, `/api/workspaces/${b.id}/goals`, 'POST', { title: 'BETA-SECRET' });

    // Workspace A's goals resolve long after the operator has moved to B.
    await page.route(`**/api/workspaces/${a.id}/goals`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');
    await page.click('[data-fo-tab="goals"]');

    // Latch the response for the load that selecting A is about to start.
    // Registered HERE, not earlier: opening the Business view already fetched
    // A's goals once, so a waiter registered before that would resolve on the
    // wrong response and the assertions below would run ~1.2s too early and
    // pass vacuously. (Verified: the first version of this test did exactly
    // that and survived the mutation it was written to catch.)
    const abandonedLoadLanded = page.waitForResponse(
      (r) => r.url().includes(`/api/workspaces/${a.id}/goals`),
      { timeout: 30000 }
    );
    await page.selectOption('#fo-workspace', a.id);
    await page.waitForTimeout(100);       // A's load is in flight and will hang
    await page.selectOption('#fo-workspace', b.id);

    // B's data must arrive...
    await expectText(page, '#fo-business-panel', 'BETA-SECRET', 'the newly selected workspace must render');
    // ...and A's abandoned load must never overwrite it once it has ACTUALLY
    // landed. Proven landed, not assumed landed.
    await abandonedLoadLanded;
    await page.waitForTimeout(400); // let the resolved handler assign and re-render
    assert.strictEqual(await page.$eval('#fo-workspace', (el) => el.value), b.id, 'the selector must still read Beta');
    await expectNoText(page, '#fo-business-panel', 'ALPHA-SECRET',
      'a superseded load must never paint another workspace\'s records over the current one');
    await expectText(page, '#fo-business-panel', 'BETA-SECRET', 'and the current workspace must still be rendered');
  });

  await check('[contract] every workspace-owned record type is isolated per workspace, both directions', async ({ page, base }) => {
    const a = await seedWorkspace(base, 'Alpha');
    const b = (await api(base, '/api/workspaces', 'POST', { name: 'Beta' })).body;

    const types = Object.keys(RECORD_STORES).filter((t) => !BACKEND_ONLY_RECORD_TYPES.includes(t));
    for (const type of types) {
      const ui = RECORD_UI[type];
      assert.ok(ui, `no UI mapping for record type "${type}" — add a surface or an allowlist entry`);
      await api(base, `/api/workspaces/${a.id}/${type}`, 'POST', ui.seed(`ALPHA-${type.toUpperCase()}`));
      await api(base, `/api/workspaces/${b.id}/${type}`, 'POST', ui.seed(`BETA-${type.toUpperCase()}`));
    }

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');

    for (const [ws, mine, theirs] of [[a, 'ALPHA', 'BETA'], [b, 'BETA', 'ALPHA']]) {
      await page.selectOption('#fo-workspace', ws.id);
      await page.waitForTimeout(400);
      for (const type of types) {
        await page.click(`[data-fo-tab="${RECORD_UI[type].tab}"]`);
        // POSITIVE first, and it WAITS: a blank renderer cannot pass this, and
        // a slow render cannot make the negative assertion below vacuous.
        await expectText(page, '#fo-business-panel', `${mine}-${type.toUpperCase()}`, `${ws.name} must render its own ${type}`);
        // NEGATIVE: a renderer returning every workspace's data must not pass.
        await expectNoText(page, '#fo-business-panel', `${theirs}-${type.toUpperCase()}`, `${ws.name} must NOT render the other workspace's ${type}`);
      }
    }
  });

  // The reachability contract. Deliberately not satisfied by the presence of a
  // DOM tab: it creates each record type through the real dialog against a real
  // server and asserts the result renders, so a tab that lists nothing, cannot
  // create, or posts to a route that does not exist all fail here.
  await check('[contract] every backend record type is reachable and usable from the Business view', async ({ page, base }) => {
    await seedWorkspace(base, 'Reach');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');

    const backendTypes = Object.keys(RECORD_STORES);
    const expected = backendTypes.filter((t) => !BACKEND_ONLY_RECORD_TYPES.includes(t));

    // Every allowlist entry must name a type that actually exists, so the
    // allowlist cannot rot into a list of typos that silently excuses nothing.
    for (const t of BACKEND_ONLY_RECORD_TYPES) {
      assert.ok(backendTypes.includes(t), `backend-only allowlist names "${t}", which is not a record store`);
    }

    for (const type of expected) {
      const ui = RECORD_UI[type];
      assert.ok(ui, `record type "${type}" has no UI mapping`);
      const tab = await page.$(`[data-fo-tab="${ui.tab}"]`);
      assert.ok(tab, `record type "${type}" has no Business-view tab (add one, or add a reviewed allowlist entry)`);

      await page.click(`[data-fo-tab="${ui.tab}"]`);
      await page.waitForTimeout(200);

      // empty state, before anything exists
      const emptyPanel = await page.textContent('#fo-business-panel');
      assert.ok(/No .*(yet|logged|captured)/i.test(emptyPanel), `${type} must show an empty state, got: ${emptyPanel.slice(0, 120)}`);

      // create through the real dialog
      const addBtn = await page.$(`[data-fo-add="${ui.add}"]`);
      assert.ok(addBtn, `record type "${type}" has a tab but no create affordance`);
      await addBtn.click();
      await page.waitForSelector('.fo-modal');
      const marker = `REACHABLE-${type.toUpperCase()}`;
      await page.fill(`.fo-modal [name="${ui.titleField}"]`, marker);
      await page.click('.fo-modal button[type="submit"]');
      await expectText(page, '#fo-business-panel', marker, `record type "${type}" was created but does not render in its own tab`);
    }

    // No dead pluralisation branches: every type pluralOf() knows about must be
    // one the operator can reach (this is how `task`/`experiment` sat in
    // pluralOf for a release while nothing could call them).
    const known = await page.evaluate(() => Array.from(document.querySelectorAll('[data-fo-tab]')).map((el) => el.dataset.foTab));
    for (const type of expected) {
      assert.ok(known.includes(RECORD_UI[type].tab), `tab "${RECORD_UI[type].tab}" is missing from the rendered tablist`);
    }
  });

  await check('[smoke] a task and an experiment survive a reload with their fields intact', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Persist');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');

    await page.click('[data-fo-tab="tasks"]');
    await page.click('[data-fo-add="task"]');
    await page.waitForSelector('.fo-modal');
    await page.fill('.fo-modal [name="title"]', 'Call ten roofers');
    await page.fill('.fo-modal [name="notes"]', 'Ask what they quote on');
    await page.click('.fo-modal button[type="submit"]');
    await page.waitForTimeout(400);

    await page.click('[data-fo-tab="experiments"]');
    await page.click('[data-fo-add="experiment"]');
    await page.waitForSelector('.fo-modal');
    await page.fill('.fo-modal [name="title"]', 'Landing page smoke test');
    await page.fill('.fo-modal [name="successThreshold"]', '20 signups in 2 weeks');
    await page.fill('.fo-modal [name="failureThreshold"]', 'fewer than 5 signups');
    await page.click('.fo-modal button[type="submit"]');
    await page.waitForTimeout(400);

    // reload: the record must come back from disk, not from page state
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');

    await page.click('[data-fo-tab="tasks"]');
    await expectText(page, '#fo-business-panel', 'Call ten roofers', 'task did not survive reload');
    await expectText(page, '#fo-business-panel', 'Ask what they quote on', 'task notes are not rendered');

    await page.click('[data-fo-tab="experiments"]');
    await expectText(page, '#fo-business-panel', 'Landing page smoke test', 'experiment did not survive reload');
    let panel = await page.textContent('#fo-business-panel');
    // Both thresholds must be visible: an experiment that only shows its
    // success bar cannot disconfirm anything, which is the whole point.
    assert.ok(panel.includes('20 signups in 2 weeks'), 'success threshold is not rendered');
    assert.ok(panel.includes('fewer than 5 signups'), 'failure threshold is not rendered');

    // the API agrees with what the UI shows
    const xs = (await api(base, `/api/workspaces/${ws.id}/experiments`)).body;
    assert.strictEqual(xs.length, 1);
    assert.strictEqual(xs[0].failureThreshold, 'fewer than 5 signups');
  });

  await check('[regression] a record can be corrected in place, not only deleted and retyped', async ({ page, base }) => {
    // Before this, goals/tasks/assumptions/evidence/experiments could be
    // created and hard-deleted but never edited: the only way to fix a typo
    // was to destroy the record and its history.
    const ws = await seedWorkspace(base, 'Edit');
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: 'Frist paying customer' });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await page.click('[data-fo-tab="goals"]');
    await page.waitForTimeout(300);

    await page.click('[data-fo-edit="goal"]');
    await page.waitForSelector('.fo-modal');
    // the dialog must arrive PREFILLED — an empty edit form silently wipes fields
    assert.strictEqual(await page.inputValue('.fo-modal [name="title"]'), 'Frist paying customer');
    await page.fill('.fo-modal [name="title"]', 'First paying customer');
    await page.click('.fo-modal button[type="submit"]');
    await expectText(page, '#fo-business-panel', 'First paying customer', 'the corrected title must render');
    await expectNoText(page, '#fo-business-panel', 'Frist', 'the typo must be gone');

    // corrected in place: still one record, same id, history not destroyed
    const goals = (await api(base, `/api/workspaces/${ws.id}/goals`)).body;
    assert.strictEqual(goals.length, 1, 'editing must not create a second record');
    assert.strictEqual(goals[0].title, 'First paying customer');
  });

  await check('[contract] a failed RECORD load renders an error, not an empty tab', async ({ page, base, server }) => {
    // There are TWO distinct failure paths and they need separate cases.
    // The one below corrupts the goals store, which GET /api/workspaces itself
    // reads — so the workspace LIST fails and activate()'s catch handles it.
    // This case corrupts a store the list does NOT read, so the list succeeds,
    // the workspace renders, and only loadActiveWorkspaceDetail()'s catch runs.
    //
    // A mutation sweep proved that path was uncovered: deleting
    // `state.loadError = err.message` from loadActiveWorkspaceDetail left the
    // whole suite green, because every existing case reached the other catch.
    const ws = await seedWorkspace(base, 'PartialDegrade');
    await api(base, `/api/workspaces/${ws.id}/decisions`, 'POST', { decision: 'Some decision' });
    await h.stopServer(server);

    const path = require('path');
    fs.writeFileSync(path.join(server.dataDir, 'workspace_decisions.json'), '{ truncated mid-write');
    fs.rmSync(path.join(server.dataDir, 'backups', 'workspace_decisions'), { recursive: true, force: true });

    const restarted = h.startServer(server.dataDir);
    try {
      await h.waitForReady(restarted.baseUrl);
      // the list itself must still work — otherwise this is the other path again
      const list = await api(restarted.baseUrl, '/api/workspaces');
      assert.strictEqual(list.status, 200, 'the workspace list must still succeed, or this case tests the wrong path');
      assert.strictEqual((await api(restarted.baseUrl, `/api/workspaces/${ws.id}/decisions`)).status, 503,
        'the decisions store must actually be degraded');

      await page.goto(restarted.baseUrl, { waitUntil: 'networkidle' });
      await page.click('.rail-item[data-view="business"]');
      await page.waitForSelector('#view-business .fo-error', { timeout: 10000 });
      const view = await page.textContent('#view-business');
      assert.ok(/could not load/i.test(view), 'a failed record load must say the load failed');
      assert.ok(!/No decisions logged/i.test(view), 'a degraded record store must never render as an empty tab');
      assert.ok(!/No workspaces yet/i.test(view), 'and never as "no workspaces"');
    } finally {
      await h.stopServer(restarted);
    }
  });

  await check('[contract] a failed WORKSPACE LIST renders an error, not an empty state', async ({ page, base, server }) => {
    // A degraded store (503 STORE_DEGRADED) previously left the panel blank,
    // which is indistinguishable from "you have no records yet" — the operator
    // would read a real integrity problem as an empty workspace.
    const ws = await seedWorkspace(base, 'Degraded');
    await api(base, `/api/workspaces/${ws.id}/goals`, 'POST', { title: 'Some goal' });
    await h.stopServer(server);

    // corrupt the goals store beyond recovery: no valid backup to fall back to
    const path = require('path');
    fs.writeFileSync(path.join(server.dataDir, 'workspace_goals.json'), '{ this is not json');
    fs.rmSync(path.join(server.dataDir, 'backups', 'workspace_goals'), { recursive: true, force: true });

    const restarted = h.startServer(server.dataDir);
    try {
      await h.waitForReady(restarted.baseUrl);
      await page.goto(restarted.baseUrl, { waitUntil: 'networkidle' });
      await page.click('.rail-item[data-view="business"]');
      await page.waitForSelector('#view-business .fo-error', { timeout: 10000 });
      const alert = await page.$('#view-business .fo-error');
      assert.strictEqual(await alert.getAttribute('role'), 'alert', 'the error must be announced, not only visible');
      const view = await page.textContent('#view-business');
      assert.ok(/could not load/i.test(view), 'the error must say the load failed');
      // The worst outcome, and the one this guards: a degraded store made the
      // list endpoint 503, which left state.workspaces empty, which rendered
      // "No workspaces yet" — telling the operator their data does not exist.
      assert.ok(!/No workspaces yet/i.test(view), 'an unreadable store must never be shown as "no workspaces"');
      assert.ok(!/No goals yet/i.test(view), 'a failed load must never be shown as an empty state');
    } finally {
      await h.stopServer(restarted);
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

  await check('[regression] the dashboard greeting comes from the profile, not a hardcoded name', async ({ page, base }) => {
    // public/app.js shipped with `const OPERATOR_NAME = 'Brody'` — one
    // person's name compiled into a tool meant to be run by whoever installs
    // it. The greeting is now the operator's own, and absent until they say.
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="next"][data-next="profile"]');
    await page.waitForSelector('.fo-wizard [name="displayName"]');
    await page.fill('.fo-wizard [name="displayName"]', 'Ada');
    await page.click('[data-wz="next"][data-next="operating_mode"]');
    await page.click('[data-wz="next"][data-next="workspace"]');
    await page.fill('.fo-wizard [name="name"]', 'Greeting Co');
    await page.click('[data-wz="next"][data-next="agents"]');
    await page.click('[data-wz="next"][data-next="permissions"]');
    await page.click('[data-wz="next"][data-next="yc"]');
    await page.click('[data-wz="next"][data-next="review"]');
    await page.click('[data-wz="next"][data-next="done"]');
    await page.waitForSelector('.fo-cc-name');

    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="command"]');
    await page.waitForSelector('.condition-headline');
    const headline = await page.textContent('.condition-headline');
    assert.ok(headline.includes('Ada'), `greeting must use the operator's own name, got: ${headline}`);
    assert.ok(!/Brody/.test(await page.content()), 'no hardcoded operator name may remain in the served app');
    assert.strictEqual((await api(base, '/api/profile')).body.displayName, 'Ada');
  });

  await check('[regression] a workspace can be archived and unarchived from the interface', async ({ page, base }) => {
    // The selector already rendered "(archived)" while the only way to enter
    // or leave that state was curl — the operator could see a state they
    // could not reach or escape.
    const ws = await seedWorkspace(base, 'Archivable');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('[data-fo="toggle-archive"]');
    assert.strictEqual((await page.textContent('[data-fo="toggle-archive"]')).trim(), 'Archive');

    await page.click('[data-fo="toggle-archive"]');
    // Wait for the control to actually flip rather than sleeping a guessed
    // interval. A fixed 600ms here produced a false FAIL under CPU contention
    // during a mutation sweep while passing in isolation.
    await expectText(page, '[data-fo="toggle-archive"]', 'Unarchive', 'the control must flip direction');
    assert.ok((await page.textContent('#fo-workspace')).includes('(archived)'), 'the selector must show the archived state');
    assert.ok(await page.$('.fo-archived-note'), 'an archived workspace must explain what archiving does');
    assert.strictEqual((await api(base, '/api/workspaces')).body.find((w) => w.id === ws.id).archived, true);

    // archiving is not a lock: records stay readable and creatable
    await page.click('[data-fo-tab="goals"]');
    await page.click('[data-fo-add="goal"]');
    await page.waitForSelector('.fo-modal');
    await page.fill('.fo-modal [name="title"]', 'Still editable');
    await page.click('.fo-modal button[type="submit"]');
    await expectText(page, '#fo-business-panel', 'Still editable', 'an archived workspace must still accept new records');

    // and it is reversible through the same control
    await page.click('[data-fo="toggle-archive"]');
    await expectText(page, '[data-fo="toggle-archive"]', 'Archive', 'the control must flip back');
    assert.strictEqual((await api(base, '/api/workspaces')).body.find((w) => w.id === ws.id).archived, false);
    assert.strictEqual(await page.$('.fo-archived-note'), null);
  });

  await check('[regression] a workspace can be edited in place from the interface', async ({ page, base }) => {
    const ws = await seedWorkspace(base, 'Typo Co', { stage: 'problem_discovery' });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('[data-fo="edit-workspace"]');
    await page.click('[data-fo="edit-workspace"]');
    await page.waitForSelector('.fo-modal');
    assert.strictEqual(await page.inputValue('.fo-modal [name="name"]'), 'Typo Co', 'the edit dialog must be prefilled');
    assert.strictEqual(await page.inputValue('.fo-modal [name="stage"]'), 'problem_discovery', 'the current stage must be preselected');
    await page.fill('.fo-modal [name="name"]', 'Apparel Co');
    await page.fill('.fo-modal [name="targetDate"]', '2026-12-31');
    await page.click('.fo-modal button[type="submit"]');
    await expectText(page, '.fo-cc-name', 'Apparel Co', 'the renamed workspace must render');
    const after = (await api(base, '/api/workspaces')).body;
    assert.strictEqual(after.length, 1, 'editing must not create a second workspace');
    assert.strictEqual(after[0].id, ws.id);
    assert.strictEqual(after[0].name, 'Apparel Co');
    assert.strictEqual(after[0].targetDate, '2026-12-31');
    assert.strictEqual(after[0].stage, 'problem_discovery', 'an untouched field must survive the edit');
  });

  // ---------------- permission review (R-002, R-004) ----------------

  const CAPABILITIES = require('../../src/permissions').CAPABILITIES;
  const RUNTIME_SUMMARY = require('../../src/permissions').RUNTIME_ENFORCEMENT_SUMMARY;

  // Toggle a permission and wait for the WORK to finish, not for a duration.
  //
  // This replaces three waitForTimeout(500) calls. The sleeps were not merely
  // slow — they made the test's verdict depend on machine speed, which is how
  // A-002 stayed hidden: the client refreshes its snapshot after each write,
  // so a sleep long enough to cover the refresh made the sequence look safe,
  // and a sleep too short made it look flaky. Neither reading was about the
  // defect. Here the test waits for the two observable events the client
  // actually performs — the PUT settling and the refresh GET that follows it —
  // so the next toggle can only start from a refreshed snapshot. Correctness
  // for stale and concurrent clients is a separate contract, proved against
  // the server in test/permissionConcurrency.test.js; this case proves only
  // that ordinary sequential use through the UI is deterministic.
  // The signal is the revision the client has RENDERED. Waiting on the network
  // instead was itself unsound: a waitForResponse registered before the click
  // can be satisfied by an /agents GET still in flight from an earlier step,
  // which returns control while the client's snapshot is still the old one —
  // it produced a 409 that looked like a product defect and was not. The
  // rendered revision cannot be matched early, because it only advances once
  // the write has been accepted AND the refresh has been applied to state.
  async function togglePermission(page, boxSelector, value, agentId) {
    const panel = `#fo-perms-${agentId}`;
    const revOf = async () => Number(await page.getAttribute(panel, 'data-fo-perm-revision'));
    const before = await revOf();

    let refused = null;
    page.once('response', function watch(res) {
      try {
        if (res.request().method() === 'PUT' && new URL(res.url()).pathname.endsWith(`/agents/${agentId}`) && !res.ok()) {
          refused = res.status();
        }
      } catch { /* ignore malformed */ }
    });

    if (value) await page.check(boxSelector); else await page.uncheck(boxSelector);

    try {
      await page.waitForFunction(
        ([sel, prev]) => {
          const el = document.querySelector(sel);
          return !!el && Number(el.getAttribute('data-fo-perm-revision')) > prev;
        },
        [panel, before],
        { timeout: 10000 }
      );
    } catch (err) {
      throw new Error(
        `toggling ${boxSelector} never advanced the rendered permission revision past ${before}` +
        (refused ? ` — the write was refused with ${refused}, so ordinary sequential toggling conflicts with itself` : '') +
        ` (${err.message})`
      );
    }
    return revOf();
  }

  async function openPermissionsFor(page, agentId) {
    await page.click('[data-fo-tab="agents"]');
    await page.waitForSelector(`[data-fo-perms="${agentId}"]`);
    await page.click(`[data-fo-perms="${agentId}"]`);
    await page.waitForSelector(`#fo-perms-${agentId} .fo-perm`);
  }

  await check('[contract] the permission surface lists every backend capability with its real classification', async ({ page, base }) => {
    // The whole point of R-002: there was no permission surface at all, while
    // three documents said there was. The catalog is read from the backend so
    // a 14th capability cannot appear in code and be missing from the screen.
    await seedWorkspace(base, 'Perms');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await openPermissionsFor(page, 'interview_agent');

    const rendered = await page.$$eval('#fo-perms-interview_agent [data-fo-perm]', (els) => els.map((e) => e.dataset.foPerm));
    assert.strictEqual(rendered.length, CAPABILITIES.length, `expected all ${CAPABILITIES.length} capabilities, got ${rendered.length}`);
    for (const cap of CAPABILITIES) {
      assert.ok(rendered.includes(cap.key), `capability "${cap.key}" is missing from the permission surface`);
    }

    const panel = await page.textContent('#fo-perms-interview_agent');
    for (const cap of CAPABILITIES) {
      assert.ok(panel.includes(cap.label), `capability label "${cap.label}" is not shown`);
    }
    // Each of the three system controls must NAME its code path on screen.
    for (const cap of CAPABILITIES.filter((c) => c.enforcement === 'system_control')) {
      assert.ok(panel.includes(cap.enforcementPoint), `"${cap.key}" must name its enforcement point on screen`);
    }
    // The classifications must be distinguishable, not a uniform label.
    assert.ok(panel.includes('System control'), 'system-controlled capabilities must be marked');
    assert.ok(panel.includes('Recorded only'), 'recorded-only capabilities must be marked');
  });

  await check('[regression] permission changes persist per workspace and per agent', async ({ page, base }) => {
    const a = await seedWorkspace(base, 'PermA');
    const b = (await api(base, '/api/workspaces', 'POST', { name: 'PermB' })).body;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('#fo-workspace');
    // Registered BEFORE the change that triggers it, so the wait cannot be
    // satisfied by a load left over from page startup.
    const loaded = page.waitForResponse((res) =>
      res.request().method() === 'GET' && res.url().includes(`/api/workspaces/${a.id}/agents`));
    await page.selectOption('#fo-workspace', a.id);
    await loaded;
    await openPermissionsFor(page, 'interview_agent');

    // Two capabilities, both moved AWAY from their defaults, changed one after
    // the other. Asserting on values that happen to equal the default proves
    // nothing: the store fills missing keys from defaultPermissionsFor(), so a
    // client that posts only the changed key still produces the default value
    // for everything else and a weaker version of this test passes. Granting
    // edit_files and THEN run_commands is what detects it — under a partial
    // send the second write resets the first back to off.
    const editBox = '#fo-perms-interview_agent [data-fo-perm="edit_files"]';
    const cmdBox = '#fo-perms-interview_agent [data-fo-perm="run_commands"]';
    const readBox = '#fo-perms-interview_agent [data-fo-perm="read_workspace_data"]';
    assert.strictEqual(await page.isChecked(editBox), false, 'edit_files must start off (least authority)');
    assert.strictEqual(await page.isChecked(readBox), true, 'read_workspace_data starts on so the agent can function');

    await togglePermission(page, editBox, true, 'interview_agent');
    await togglePermission(page, cmdBox, true, 'interview_agent');
    // and revoke one that starts ON, so a default-fill is detectable there too
    await togglePermission(page, readBox, false, 'interview_agent');

    // survives a full reload, read back from disk
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.rail-item[data-view="business"]');
    await page.waitForSelector('.fo-tab');
    await openPermissionsFor(page, 'interview_agent');
    assert.strictEqual(await page.isChecked(editBox), true, 'the first grant must survive both the second write and the reload');
    assert.strictEqual(await page.isChecked(cmdBox), true, 'the second grant must survive reload');
    assert.strictEqual(await page.isChecked(readBox), false, 'a revoked capability must not be refilled from the default');

    const settings = (await api(base, `/api/workspaces/${a.id}/agents`)).body;
    const row = settings.agents.find((x) => x.id === 'interview_agent');
    assert.strictEqual(row.effectivePermissions.edit_files, true, 'an earlier grant must not be reset by a later write');
    assert.strictEqual(row.effectivePermissions.run_commands, true);
    assert.strictEqual(row.effectivePermissions.read_workspace_data, false, 'a revocation must persist, not fall back to the default');
    assert.strictEqual(row.effectivePermissions.spend_money, false, 'unrelated consequential capabilities must stay off');

    // scoped: workspace B's copy of the same global agent is untouched
    const other = (await api(base, `/api/workspaces/${b.id}/agents`)).body;
    assert.strictEqual(other.agents.find((x) => x.id === 'interview_agent').effectivePermissions.edit_files, false,
      'a permission granted in one workspace must not leak into another');
  });

  await check('[contract] no permission surface claims enforcement or approval it does not have', async ({ page, base }) => {
    // R-004. Deliberately NOT a blanket word ban — "not enforced" and
    // "Nothing in the runtime reads this value" are the honest phrasings and
    // must stay possible. What is forbidden is a CLAIM: language asserting
    // that ticking a box stops, gates or guarantees something.
    const FORBIDDEN = [
      /requires? your approval/i,
      /require approval/i,
      /approval (is )?required/i,
      /will be blocked/i,
      /is blocked/i,
      /are blocked/i,
      /is prevented/i,
      /are prevented/i,
      /is protected/i,
      /are protected/i,
      /disabled at (the )?system level/i,
      /guarantee[sd]?\b/i,
      /cannot spend/i,
      /we will ask you first/i,
      // "is/are enforced" as a bare claim. The catalog's own honest phrasings
      // ("Nothing in the runtime reads this value", "Always-on control: ...")
      // do not match, and neither does "not enforced".
      /(?<!not )\bis enforced\b/i,
      /(?<!not )\bare enforced\b/i,
    ];

    const assertClean = (text, where) => {
      for (const rx of FORBIDDEN) {
        assert.ok(!rx.test(text), `${where} contains a claim the code does not support: ${rx}`);
      }
    };

    // 1. the onboarding permissions step
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fo-wizard');
    await page.click('[data-wz="next"][data-next="profile"]');
    await page.click('[data-wz="next"][data-next="operating_mode"]');
    await page.click('[data-wz="next"][data-next="workspace"]');
    await page.fill('.fo-wizard [name="name"]', 'CopyCheck');
    await page.click('[data-wz="next"][data-next="agents"]');
    await page.click('[data-wz="next"][data-next="permissions"]');
    await page.waitForSelector('.fo-wizard .fo-perm');

    const step = await page.textContent('.fo-wizard-body');
    assertClean(step, 'the onboarding permissions step');

    // It must also be a REAL surface, not two paragraphs: every capability
    // reviewable before onboarding claims permission review happened.
    const wizardRows = await page.$$eval('.fo-wizard .fo-perm .fo-perm-label', (els) => els.map((e) => e.textContent.trim()));
    assert.strictEqual(wizardRows.length, CAPABILITIES.length, 'the onboarding step must list every capability');
    assert.ok(step.includes(RUNTIME_SUMMARY), 'the onboarding step must state the runtime-enforcement summary verbatim');
    assert.ok(/no approval queue/i.test(step), 'the step must say plainly that no approval queue exists');

    // 2. the per-agent permission surface
    await page.click('[data-wz="next"][data-next="yc"]');
    await page.click('[data-wz="next"][data-next="review"]');
    await page.click('[data-wz="next"][data-next="done"]');
    await page.waitForSelector('.fo-cc-name');
    await openPermissionsFor(page, 'interview_agent');
    assertClean(await page.textContent('#fo-business-panel'), 'the agents tab');

    // 3. and the settings view, which also talks about the operating model
    await page.click('.rail-item[data-view="settings"]');
    await page.waitForSelector('#view-settings .fo-card');
    assertClean(await page.textContent('#view-settings'), 'the settings view');
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
    // Gate the negative assertion on the payload actually being rendered.
    // Without this, an unpainted tab makes "nothing executed" trivially true.
    await expectText(page, '#fo-business-panel', 'onerror', 'the goal payload must render as literal text first');
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
      // The tampered record must be on screen before "no attribute was forged"
      // means anything — an empty panel forges nothing either.
      await expectText(page, '#fo-business-panel', 'Tampered', 'the tampered goal must render before asserting no forgery');
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
    // Wait for the condition, not a duration. The modal is proven present
    // above, so this cannot pass by the dialog never having opened.
    await page.waitForSelector('.fo-modal', { state: 'detached', timeout: 10000 });
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
