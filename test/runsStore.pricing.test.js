// Minimal, dependency-free assertions for the cost-aggregation semantics.
// Run with: node test/runsStore.pricing.test.js
//
// Guards against the aggregate silently regressing into summing only known
// costs and presenting that partial sum as if it were the complete total.

const assert = require('assert');
const { aggregateCost } = require('../src/runsStore');

function run(provider, costUsd) {
  return { provider, status: 'completed', costUsd };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// 1. All runs priced -> complete, knownCost is the true total
check('all priced -> complete', () => {
  const result = aggregateCost([run('anthropic', 0.42), run('openai', 0.31)]);
  assert.strictEqual(result.pricingStatus, 'complete');
  assert.strictEqual(result.knownCost, 0.73);
  assert.strictEqual(result.pricedRunCount, 2);
  assert.strictEqual(result.unpricedRunCount, 0);
  assert.strictEqual(result.totalRunCount, 2);
});

// 2. Mixed priced/unpriced -> partial, knownCost is explicitly partial
check('mixed priced and unpriced -> partial', () => {
  const result = aggregateCost([run('anthropic', 0.42), run('anthropic', null), run('openai', 0.31)]);
  assert.strictEqual(result.pricingStatus, 'partial');
  assert.strictEqual(result.knownCost, 0.73);
  assert.strictEqual(result.pricedRunCount, 2);
  assert.strictEqual(result.unpricedRunCount, 1);
  assert.strictEqual(result.totalRunCount, 3);
});

// 3. All unpriced -> unavailable, never reported as $0.00
check('all unpriced -> unavailable', () => {
  const result = aggregateCost([run('anthropic', null), run('openai', null)]);
  assert.strictEqual(result.pricingStatus, 'unavailable');
  assert.strictEqual(result.knownCost, 0);
  assert.strictEqual(result.pricedRunCount, 0);
  assert.strictEqual(result.unpricedRunCount, 2);
  assert.strictEqual(result.totalRunCount, 2);
});

// 4. No applicable runs -> empty, distinct from "unavailable"
check('no runs -> empty', () => {
  const result = aggregateCost([]);
  assert.strictEqual(result.pricingStatus, 'empty');
  assert.strictEqual(result.knownCost, 0);
  assert.strictEqual(result.totalRunCount, 0);
});

// custom-provider runs are excluded from the pricing population entirely —
// they are not "unpriced", cost just doesn't apply to them.
check('custom-provider runs excluded from pricing population', () => {
  const result = aggregateCost([run('custom', null), run('custom', null)]);
  assert.strictEqual(result.pricingStatus, 'empty');
  assert.strictEqual(result.totalRunCount, 0);
});

check('custom-provider runs do not affect a partial billed total', () => {
  const result = aggregateCost([run('custom', null), run('anthropic', 0.5), run('anthropic', null)]);
  assert.strictEqual(result.pricingStatus, 'partial');
  assert.strictEqual(result.knownCost, 0.5);
  assert.strictEqual(result.totalRunCount, 2); // custom run excluded
});

console.log(`\n${passed} passed`);
