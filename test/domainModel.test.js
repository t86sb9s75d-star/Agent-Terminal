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

check('applyPermissionPatch rejects unknown capabilities', () => {
  assert.throws(() => permissions.applyPermissionPatch({ made_up_power: true }, {}), /unknown permission/);
});

// This block used to read `normalizePermissions coerces to booleans and fills
// defaults` and asserted `{ spend_money: 1 }` becomes true. It passed, which is
// how an unsafe contract survives review: it had a green test defending it.
// Coercion on an authority boundary fails in the widening direction — measured
// through the HTTP API, "false", "0", [] and {} all stored a GRANT of a
// capability that defaults to false.
check('applyPermissionPatch requires literal booleans', () => {
  const base = permissions.defaultPermissionsFor();
  const patched = permissions.applyPermissionPatch({ spend_money: true }, base);
  assert.strictEqual(patched.spend_money, true);

  // The specific value this test used to bless.
  assert.throws(() => permissions.applyPermissionPatch({ spend_money: 1 }, base), /must be true or false/);
  // The one that makes coercion indefensible: a caller trying to REVOKE grants.
  assert.throws(() => permissions.applyPermissionPatch({ spend_money: 'false' }, base), /must be true or false/);
  for (const bad of ['true', '0', '', ' ', 0, -1, 1.5, null, [], [false], {}, { a: 1 }]) {
    assert.throws(
      () => permissions.applyPermissionPatch({ edit_files: bad }, base),
      /must be true or false/,
      `${JSON.stringify(bad)} was accepted as a permission value`
    );
  }
});

check('applyPermissionPatch rejects a non-object payload, and null specifically', () => {
  const base = permissions.defaultPermissionsFor();
  assert.throws(() => permissions.applyPermissionPatch('everything', base), /must be an object/);
  // An array is an object; without an explicit check its indices become keys
  // and the caller is told "unknown permission capability: 0".
  assert.throws(() => permissions.applyPermissionPatch(['edit_files'], base), /must be an object/);
  // null used to mean "reset every capability to its default", which silently
  // granted the five that default to on.
  assert.throws(() => permissions.applyPermissionPatch(null, base), /must not be null/);
});

// PATCH semantics: omission changes nothing. Under the previous
// full-replacement rule an omitted key was refilled from the default, so a
// caller naming one capability silently reinstated revoked ones and dropped
// granted ones.
check('applyPermissionPatch preserves every capability the caller did not name', () => {
  const current = {
    ...permissions.defaultPermissionsFor(),
    read_workspace_data: false,   // a default-ON capability deliberately revoked
    edit_files: true,             // a default-OFF capability deliberately granted
  };
  const patched = permissions.applyPermissionPatch({ spend_money: true }, current);
  assert.strictEqual(patched.spend_money, true, 'the named capability did not change');
  assert.strictEqual(patched.read_workspace_data, false, 'an omitted revocation was undone');
  assert.strictEqual(patched.edit_files, true, 'an omitted grant was lost');

  // An empty patch is an explicit no-op, not a reset.
  const empty = permissions.applyPermissionPatch({}, current);
  assert.deepStrictEqual(empty, current, 'an empty patch changed the effective authority');
});

// The canonical resolver. Read and write must agree about what a persisted row
// means under the CURRENT vocabulary.
check('resolveEffectivePermissions fills defaults, ignores unknown keys, and distrusts non-booleans', () => {
  const defaults = permissions.defaultPermissionsFor();

  // No row at all -> the least-authority default.
  assert.deepStrictEqual(permissions.resolveEffectivePermissions(null), defaults);
  assert.deepStrictEqual(permissions.resolveEffectivePermissions(undefined), defaults);

  // A row from an older vocabulary: missing keys resolve to the current
  // default rather than being absent, so GET and the write path agree.
  const old = permissions.resolveEffectivePermissions({ edit_files: true });
  assert.strictEqual(old.edit_files, true, 'a persisted value was dropped');
  assert.strictEqual(old.read_workspace_data, true, 'a key absent from an old row must resolve to its default');
  assert.strictEqual(Object.keys(old).length, permissions.CAPABILITY_KEYS.length, 'the resolved map must cover the current vocabulary exactly');

  // A key the vocabulary no longer defines must not become ghost authority.
  const ghost = permissions.resolveEffectivePermissions({ edit_files: true, retired_capability: true });
  assert.ok(!('retired_capability' in ghost), 'a retired capability leaked into effective authority');

  // Only a tampered store can hold a non-boolean; fall back to the default
  // rather than coercing it into a grant.
  const tampered = permissions.resolveEffectivePermissions({ spend_money: 'true', edit_files: [] });
  assert.strictEqual(tampered.spend_money, false, 'a tampered non-boolean was coerced into a grant');
  assert.strictEqual(tampered.edit_files, false, 'a tampered non-boolean was coerced into a grant');
});

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
