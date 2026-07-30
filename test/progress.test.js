// Deterministic progress math — the calculation §14 requires to be transparent
// and never fabricated. Run with: node test/progress.test.js
const assert = require('assert');
const { workspaceProgress, ycOverall, scoreSection, clampPct } = require('../src/progress');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// ---- Workspace progress ----

check('no milestones -> progress is null (not measurable, never fabricated 0)', () => {
  const r = workspaceProgress([]);
  assert.strictEqual(r.progress, null);
  assert.strictEqual(r.milestoneCount, 0);
});

check('undefined/garbage input -> null, not a crash', () => {
  assert.strictEqual(workspaceProgress(undefined).progress, null);
  assert.strictEqual(workspaceProgress(null).progress, null);
});

check('all milestones done -> 100', () => {
  const r = workspaceProgress([{ done: true }, { done: true }]);
  assert.strictEqual(r.progress, 100);
});

check('half done (equal weights) -> 50', () => {
  const r = workspaceProgress([{ done: true }, { done: false }]);
  assert.strictEqual(r.progress, 50);
});

check('weighted milestones respect their weights', () => {
  // 3-weight done + 1-weight not done = 3/4 = 75
  const r = workspaceProgress([{ done: true, weight: 3 }, { done: false, weight: 1 }]);
  assert.strictEqual(r.progress, 75);
  assert.strictEqual(r.totalWeight, 4);
  assert.strictEqual(r.completedWeight, 3);
});

check('partial milestone fraction counts proportionally', () => {
  // one milestone 50% complete -> 50
  assert.strictEqual(workspaceProgress([{ fraction: 0.5 }]).progress, 50);
  // fraction out of range is clamped
  assert.strictEqual(workspaceProgress([{ fraction: 2 }]).progress, 100);
  assert.strictEqual(workspaceProgress([{ fraction: -1 }]).progress, 0);
});

check('non-positive weight falls back to 1 rather than removing the milestone', () => {
  const r = workspaceProgress([{ done: true, weight: 0 }, { done: false, weight: 0 }]);
  assert.strictEqual(r.totalWeight, 2); // both counted as weight 1
  assert.strictEqual(r.progress, 50);
});

// ---- YC progress ----

check('YC overall is the weighted average of section scores', () => {
  const r = ycOverall([
    { id: 'a', label: 'A', weight: 1, items: [{ done: true }, { done: true }] },   // 100
    { id: 'b', label: 'B', weight: 1, items: [{ done: false }, { done: false }] }, // 0
  ]);
  assert.strictEqual(r.overall, 50);
});

check('YC section weights actually weight the average', () => {
  const r = ycOverall([
    { id: 'a', label: 'A', weight: 3, items: [{ done: true }] },   // 100 * 3
    { id: 'b', label: 'B', weight: 1, items: [{ done: false }] },  // 0 * 1
  ]);
  assert.strictEqual(r.overall, 75);
});

check('YC checklist with nothing done is a real 0 (not null)', () => {
  const r = ycOverall([{ id: 'a', label: 'A', weight: 1, items: [{ done: false }] }]);
  assert.strictEqual(r.overall, 0);
});

check('YC exposes missing items and completed/total per section (transparency)', () => {
  const r = ycOverall([
    { id: 's', label: 'S', weight: 1, items: [
      { id: 'i1', label: 'Item 1', done: true },
      { id: 'i2', label: 'Item 2', done: false },
    ] },
  ]);
  const s = r.sections[0];
  assert.strictEqual(s.completedItems, 1);
  assert.strictEqual(s.totalItems, 2);
  assert.strictEqual(s.score, 50);
  assert.strictEqual(s.missingItems.length, 1);
  assert.strictEqual(s.missingItems[0].id, 'i2');
});

check('YC manual-score section is clamped and rounded, no items required', () => {
  const s = scoreSection({ id: 'm', label: 'M', weight: 1, score: 150 });
  assert.strictEqual(s.score, 100); // clamped
  assert.strictEqual(s.completedItems, null);
  assert.strictEqual(s.totalItems, null);
});

check('YC with zero total weight -> 0, not a divide-by-zero', () => {
  const r = ycOverall([{ id: 'a', label: 'A', weight: 0, items: [{ done: true }] }]);
  assert.strictEqual(r.overall, 0);
  assert.strictEqual(r.totalWeight, 0);
});

check('clampPct bounds are enforced', () => {
  assert.strictEqual(clampPct(-5), 0);
  assert.strictEqual(clampPct(140), 100);
  assert.strictEqual(clampPct(42), 42);
});

console.log(`\n${passed} passed`);
