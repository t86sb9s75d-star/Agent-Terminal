// Pure domain-model tests: business stages, agent catalog, permissions.
// Run with: node test/domainModel.test.js
const assert = require('assert');
const stages = require('../src/businessStages');
const catalog = require('../src/agentCatalog');
const permissions = require('../src/permissions');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// ---- Business stages ----

check('all nine stages are present and ordered', () => {
  assert.strictEqual(stages.STAGES.length, 9);
  assert.strictEqual(stages.STAGES[0].id, 'problem_discovery');
  assert.strictEqual(stages.STAGES[8].id, 'scale');
});

check('isValidStage accepts known stages and rejects unknown', () => {
  assert.strictEqual(stages.isValidStage('fundraise'), true);
  assert.strictEqual(stages.isValidStage('not_a_stage'), false);
  assert.strictEqual(stages.isValidStage(undefined), false);
});

check('emphasisForStage returns the stage emphasis, with a neutral fallback', () => {
  assert.deepStrictEqual(stages.emphasisForStage('problem_discovery'), ['interviews', 'assumptions', 'evidence']);
  assert.deepStrictEqual(stages.emphasisForStage('bogus'), ['goals', 'tasks']); // fallback, no throw
});

check('fundraise stage emphasizes YC', () => {
  assert.ok(stages.emphasisForStage('fundraise').includes('yc'));
});

// ---- Agent catalog ----

check('all twelve required business agents are present', () => {
  assert.strictEqual(catalog.CATALOG.length, 12);
  const names = catalog.CATALOG.map((a) => a.name);
  for (const required of [
    'Interview Agent', 'Business Idea Storm', 'Brainstorm Agent',
    'Stock Analyzer', 'Financial Terminal', 'Business Advisory Agent',
    'Marketing Agent', 'Lead Generation Agent', 'Lead Conversion',
    'Design Agent', 'Operations Agent', 'Workflow Agent',
  ]) {
    assert.ok(names.includes(required), `missing required agent: ${required}`);
  }
});

check('"Business Idea Storm" keeps its exact operator-facing name', () => {
  assert.ok(catalog.getCatalogAgent('business_idea_storm'));
  assert.strictEqual(catalog.getCatalogAgent('business_idea_storm').name, 'Business Idea Storm');
});

check('every catalog agent requires only valid permission keys', () => {
  for (const agent of catalog.CATALOG) {
    for (const perm of agent.requiredPermissions) {
      assert.ok(permissions.isValidCapability(perm), `${agent.id} -> bad perm ${perm}`);
    }
  }
});

check('stage recommendations resolve to real catalog agents, in order', () => {
  const recs = catalog.recommendationsForStage('problem_discovery');
  assert.deepStrictEqual(recs.map((a) => a.id), ['interview_agent', 'business_idea_storm', 'brainstorm_agent', 'business_advisory_agent']);
});

check('recommendationsForStage on an unknown stage returns [] (advisory, never throws)', () => {
  assert.deepStrictEqual(catalog.recommendationsForStage('nope'), []);
});

check('every stage with recommendations maps to known agent ids', () => {
  for (const [stageId, ids] of Object.entries(catalog.STAGE_RECOMMENDATIONS)) {
    assert.ok(stages.isValidStage(stageId), `recommendation for unknown stage ${stageId}`);
    for (const id of ids) assert.ok(catalog.isValidCatalogAgent(id), `unknown agent ${id} for stage ${stageId}`);
  }
});

// ---- Permissions ----

check('default permissions grant no consequential capability', () => {
  const def = permissions.defaultPermissionsFor();
  for (const key of permissions.CONSEQUENTIAL_KEYS) {
    assert.strictEqual(def[key], false, `consequential ${key} must default OFF`);
  }
  // non-consequential reads default on so the agent can function
  assert.strictEqual(def.read_workspace_data, true);
});

check('spending, paid calls, contacting people, and acting without approval are consequential', () => {
  for (const key of ['spend_money', 'paid_model_calls', 'contact_people', 'act_without_approval', 'run_commands']) {
    assert.ok(permissions.CONSEQUENTIAL_KEYS.includes(key), `${key} should be consequential`);
    assert.strictEqual(permissions.isConsequential(key), true);
  }
  // "consequential" must not be read as "approval-gated": no approval
  // mechanism exists, which is why requiresApproval() was removed.
  assert.strictEqual(permissions.requiresApproval, undefined);
});

// The permission catalog is the single authority the UI and the docs both
// read. These cases exist so the catalog cannot quietly claim more than the
// code does — which is what happened when three capabilities were labelled
// "enforced" while nothing consulted their stored value.
check('every capability declares its enforcement classification and gating honestly', () => {
  const valid = ['system_control', 'recorded_only'];
  assert.strictEqual(permissions.CAPABILITIES.length, 13);
  for (const cap of permissions.CAPABILITIES) {
    assert.ok(valid.includes(cap.enforcement), `${cap.key} has an unknown enforcement value: ${cap.enforcement}`);
    // A system control must NAME where it lives, or the claim is unverifiable.
    if (cap.enforcement === 'system_control') {
      assert.ok(cap.enforcementPoint && cap.enforcementPoint.includes('src/'), `${cap.key} claims a system control but names no code path`);
    } else {
      assert.strictEqual(cap.enforcementPoint, null, `${cap.key} is recorded-only and must not name an enforcement point`);
    }
  }
});

check('no capability claims its stored value gates anything', () => {
  // Verified against every call site: budget.assertWithinBudget() and
  // workers/custom.js both run unconditionally and never read these values.
  // If a real gate is ever written, flip that one capability here and the UI
  // copy follows automatically — this test is the tripwire for that change.
  for (const cap of permissions.CAPABILITIES) {
    assert.strictEqual(cap.gatedByStoredValue, false, `${cap.key} claims to be gated by its stored value — prove it with a call site first`);
  }
  assert.match(permissions.RUNTIME_ENFORCEMENT_SUMMARY, /No setting on this screen is consulted by the runtime/);
  assert.match(permissions.RUNTIME_ENFORCEMENT_SUMMARY, /recorded, not what an agent can do/);
});

check('normalizePermissions rejects unknown capabilities', () => {
  assert.throws(() => permissions.normalizePermissions({ made_up_power: true }), /unknown permission/);
});

// This case used to read `normalizePermissions coerces to booleans and fills
// defaults` and asserted `{ spend_money: 1 }` becomes true. It passed, which is
// how an unsafe contract survives review: it had a green test defending it.
// Coercion on an authority boundary fails in the widening direction — measured
// through the HTTP API, "false", "0", [] and {} all stored a GRANT of a
// capability that defaults to false. The fill-from-default half was always
// correct and is kept.
check('normalizePermissions requires literal booleans and fills defaults', () => {
  const norm = permissions.normalizePermissions({ spend_money: true });
  assert.strictEqual(norm.spend_money, true);
  assert.strictEqual(norm.contact_people, false); // filled from conservative default

  // The specific value this test used to bless.
  assert.throws(() => permissions.normalizePermissions({ spend_money: 1 }), /must be true or false/);
  // The one that makes coercion indefensible: a caller trying to REVOKE grants.
  assert.throws(() => permissions.normalizePermissions({ spend_money: 'false' }), /must be true or false/);
  for (const bad of ['true', '0', '', ' ', 0, -1, 1.5, null, [], [false], {}, { a: 1 }]) {
    assert.throws(
      () => permissions.normalizePermissions({ edit_files: bad }),
      /must be true or false/,
      `${JSON.stringify(bad)} was accepted as a permission value`
    );
  }
});

check('normalizePermissions rejects a non-object permissions payload', () => {
  assert.throws(() => permissions.normalizePermissions('everything'), /must be an object/);
  // An array is an object; without an explicit check its indices become keys
  // and the caller is told "unknown permission capability: 0".
  assert.throws(() => permissions.normalizePermissions(['edit_files']), /must be an object/);
});

// This case used to assert enforcement === 'enforced' for spend_money,
// paid_model_calls and use_custom_provider, and it passed — which is how a
// misleading claim survives review: it had a green test defending it. The
// three do have an always-on system control, but nothing reads their stored
// per-agent value, so "enforced" invited the operator to believe the toggle
// did something. The classification now separates those two facts.
check('the three capabilities with a system control name it; the other ten claim nothing', () => {
  const byKey = Object.fromEntries(permissions.CAPABILITIES.map((c) => [c.key, c]));
  for (const key of ['spend_money', 'paid_model_calls', 'use_custom_provider']) {
    assert.strictEqual(byKey[key].enforcement, 'system_control');
    assert.ok(byKey[key].enforcementPoint, `${key} must name where its control lives`);
    // ...and that control is NOT this toggle.
    assert.strictEqual(byKey[key].gatedByStoredValue, false);
  }
  assert.strictEqual(byKey.contact_people.enforcement, 'recorded_only');
  assert.strictEqual(byKey.edit_files.enforcement, 'recorded_only');
  assert.strictEqual(byKey.act_without_approval.enforcement, 'recorded_only');

  const controlled = permissions.CAPABILITIES.filter((c) => c.enforcement === 'system_control');
  assert.strictEqual(controlled.length, 3, 'exactly three capabilities have a system-level control today');
});

console.log(`\n${passed} passed`);
