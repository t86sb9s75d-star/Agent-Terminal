// Regression coverage for the cost/model fallback defect.
// Run with: node test/effectiveModel.test.js
//
// The defect: provider workers resolved their own default model at execution
// time (`agent.model || 'claude-sonnet-5'`) while agentManager recorded and
// priced the UNRESOLVED `agent.model`. An agent with no explicit model ran
// against a real billable default but was recorded as `model: null` and
// priced as `costUsd: null` — so genuine paid usage was invisible to run
// history, to the cost aggregate, and to the `knownCost` totals that the
// daily spending caps in budget.js compare against.
//
// These assertions pin down that one resolved value is used for invocation,
// provenance, and pricing alike — and, just as importantly, that resolution
// never invents pricing for something genuinely unknown.

const assert = require('assert');
const { resolveEffectiveModel, PROVIDER_DEFAULT_MODELS } = require('../src/models');
const { estimateCostUsd, TABLE } = require('../src/pricing');
const { aggregateCost } = require('../src/runsStore');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- Explicit configuration is always preserved, never overridden ---

check('anthropic with an explicit model keeps that model', () => {
  assert.strictEqual(resolveEffectiveModel('anthropic', 'claude-opus-5'), 'claude-opus-5');
});

check('openai with an explicit model keeps that model', () => {
  assert.strictEqual(resolveEffectiveModel('openai', 'gpt-4o'), 'gpt-4o');
});

// --- Omitted model resolves to the provider default, for BOTH providers ---

check('anthropic with model omitted resolves to the provider default', () => {
  assert.strictEqual(resolveEffectiveModel('anthropic', null), PROVIDER_DEFAULT_MODELS.anthropic);
  assert.strictEqual(resolveEffectiveModel('anthropic', undefined), PROVIDER_DEFAULT_MODELS.anthropic);
  assert.strictEqual(resolveEffectiveModel('anthropic', ''), PROVIDER_DEFAULT_MODELS.anthropic);
});

check('openai with model omitted resolves to the provider default', () => {
  assert.strictEqual(resolveEffectiveModel('openai', null), PROVIDER_DEFAULT_MODELS.openai);
  assert.strictEqual(resolveEffectiveModel('openai', undefined), PROVIDER_DEFAULT_MODELS.openai);
  assert.strictEqual(resolveEffectiveModel('openai', ''), PROVIDER_DEFAULT_MODELS.openai);
});

// --- custom has no model concept; unknown providers are not "fixed" ---

check('custom provider resolves to null — it has no model concept', () => {
  assert.strictEqual(resolveEffectiveModel('custom', null), null);
  assert.strictEqual(resolveEffectiveModel('custom', undefined), null);
});

check('an unknown provider is never silently given another provider default', () => {
  assert.strictEqual(resolveEffectiveModel('some-future-provider', null), null);
  assert.strictEqual(resolveEffectiveModel(undefined, null), null);
});

// --- Honesty: unknown models stay unpriced, never invented ---

check('a genuinely unknown model stays costUsd null — pricing is never invented', () => {
  const model = resolveEffectiveModel('anthropic', 'some-unreleased-model');
  assert.strictEqual(model, 'some-unreleased-model'); // preserved, not replaced
  assert.strictEqual(estimateCostUsd('anthropic', model, 1000, 1000), null);
});

check('custom-provider runs are never assigned a cost', () => {
  assert.strictEqual(estimateCostUsd('custom', resolveEffectiveModel('custom', null), 1000, 1000), null);
});

// --- The core defect: the resolved default must actually reach pricing ---

check('the resolved default model reaches estimateCostUsd and yields a real cost', () => {
  // This is the assertion that fails on the pre-fix code path, where
  // estimateCostUsd received the raw (null) agent.model instead.
  const anthropicModel = resolveEffectiveModel('anthropic', null);
  const openaiModel = resolveEffectiveModel('openai', null);

  const anthropicCost = estimateCostUsd('anthropic', anthropicModel, 1000, 1000);
  const openaiCost = estimateCostUsd('openai', openaiModel, 1000, 1000);

  assert.notStrictEqual(anthropicCost, null, 'anthropic default must be priceable');
  assert.notStrictEqual(openaiCost, null, 'openai default must be priceable');
  assert.ok(anthropicCost > 0 && openaiCost > 0);

  // And the unresolved value — what the code used to pass — is NOT priceable,
  // which is precisely why the spend went missing.
  assert.strictEqual(estimateCostUsd('anthropic', null, 1000, 1000), null);
  assert.strictEqual(estimateCostUsd('openai', null, 1000, 1000), null);
});

// --- Guard: a default that isn't in the pricing table would re-hide spend ---

check('every provider default is present in the pricing table', () => {
  for (const [provider, model] of Object.entries(PROVIDER_DEFAULT_MODELS)) {
    assert.ok(
      TABLE[provider] && TABLE[provider][model],
      `default model "${model}" for provider "${provider}" has no pricing entry — ` +
      'changing a default to an unpriced model would silently hide spend again'
    );
  }
});

// --- Budget/known-cost visibility, end to end through the aggregate ---

check('paid usage on a default model is no longer invisible to known-cost totals', () => {
  const finished = (provider) => ({
    provider,
    status: 'completed',
    costUsd: estimateCostUsd(provider, resolveEffectiveModel(provider, null), 1000, 1000),
  });

  const result = aggregateCost([finished('anthropic'), finished('openai')]);

  assert.strictEqual(result.pricingStatus, 'complete');
  assert.strictEqual(result.pricedRunCount, 2);
  assert.strictEqual(result.unpricedRunCount, 0);
  assert.ok(result.knownCost > 0, 'knownCost must include default-model spend');

  // Pre-fix shape, for contrast: the same two real runs priced with the
  // unresolved model produced knownCost 0 / "unavailable" — budget.js compares
  // its caps against knownCost, so that spend counted as nothing at all.
  const preFix = aggregateCost([
    { provider: 'anthropic', status: 'completed', costUsd: estimateCostUsd('anthropic', null, 1000, 1000) },
    { provider: 'openai', status: 'completed', costUsd: estimateCostUsd('openai', null, 1000, 1000) },
  ]);
  assert.strictEqual(preFix.knownCost, 0);
  assert.strictEqual(preFix.pricingStatus, 'unavailable');
});

console.log(`\n${passed} passed`);
