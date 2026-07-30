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
    assert.strictEqual(permissions.requiresApproval(key), true);
  }
});

check('normalizePermissions rejects unknown capabilities', () => {
  assert.throws(() => permissions.normalizePermissions({ made_up_power: true }), /unknown permission/);
});

check('normalizePermissions coerces to booleans and fills defaults', () => {
  const norm = permissions.normalizePermissions({ spend_money: 1 });
  assert.strictEqual(norm.spend_money, true);   // coerced
  assert.strictEqual(norm.contact_people, false); // filled from conservative default
});

check('enforcement labels are honest: only genuinely-gated caps are "enforced"', () => {
  const byKey = Object.fromEntries(permissions.CAPABILITIES.map((c) => [c.key, c.enforcement]));
  // These have real code paths (budget.js caps, custom-provider boundary).
  assert.strictEqual(byKey.spend_money, 'enforced');
  assert.strictEqual(byKey.paid_model_calls, 'enforced');
  assert.strictEqual(byKey.use_custom_provider, 'enforced');
  // These are stored preferences only in Phase 1 — must NOT claim enforcement.
  assert.strictEqual(byKey.contact_people, 'preference');
  assert.strictEqual(byKey.edit_files, 'preference');
});

console.log(`\n${passed} passed`);
