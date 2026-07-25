// Run with: node test/runsStore.executionSuccess.test.js
//
// Guards against a cancelled (operator-stopped) run being scored as a
// failure. Execution success measures system outcomes (completed vs
// error) — a deliberate stop is neither.

const assert = require('assert');
const { executionSuccessRate } = require('../src/runsStore');

function run(status) { return { status }; }

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('all completed -> 100%', () => {
  assert.strictEqual(executionSuccessRate([run('completed'), run('completed')]), 100);
});

check('mixed completed/error -> partial rate', () => {
  assert.strictEqual(executionSuccessRate([run('completed'), run('error')]), 50);
});

check('cancelled runs are excluded, not scored as failure', () => {
  // One completed run and one cancelled run: rate must be 100%, not 50%.
  const rate = executionSuccessRate([run('completed'), run('cancelled')]);
  assert.strictEqual(rate, 100);
});

check('only cancelled runs -> null (nothing to score)', () => {
  assert.strictEqual(executionSuccessRate([run('cancelled'), run('cancelled')]), null);
});

check('no runs -> null', () => {
  assert.strictEqual(executionSuccessRate([]), null);
});

console.log(`\n${passed} passed`);
