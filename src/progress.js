// Feature Onboard — deterministic progress math.
//
// Two kinds of progress, both computed here so the calculation is in one
// testable place and never invented by an AI or approximated from a proxy:
//
//   1. Workspace progress — weighted milestone completion. Returns null (not
//      0) when there is nothing to measure, consistent with Rucker Park's
//      existing refusal to fabricate a "progress" number from a success-ratio
//      (see workstreamsStore.computeMetrics, where progress is always null).
//
//   2. YC progress — weighted checklist sections, each fully inspectable. YC
//      differs from workspace milestones in one deliberate way: the YC
//      checklist sections always exist (they are a fixed configured
//      checklist), so 0% is a real, meaningful value ("nothing done yet"),
//      not "unmeasurable". A workspace with no milestones yet is unmeasurable
//      (null); a YC checklist with nothing checked is genuinely at 0.
//
// Nothing here claims a YC score is an acceptance probability. A 100 means the
// configured preparation checklist is complete — nothing more.

// Round half-up to an integer for headline display. Deterministic and
// float-noise-tolerant (adds a tiny epsilon so 0.5 boundaries round up
// consistently regardless of IEEE-754 representation).
function roundPct(value) {
  return Math.round(value + Number.EPSILON);
}

function clampPct(value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

// A milestone contributes `weight` (default 1) to the denominator and
// `weight * fraction` to the numerator. `fraction` supports partial progress
// in [0,1]; if absent, a truthy `done` counts as 1 and anything else as 0.
function milestoneFraction(m) {
  if (typeof m.fraction === 'number' && Number.isFinite(m.fraction)) {
    return Math.min(1, Math.max(0, m.fraction));
  }
  return m.done ? 1 : 0;
}

function milestoneWeight(m) {
  const w = Number(m.weight);
  // A non-positive or non-finite weight is treated as the default 1 rather
  // than silently removing the milestone from the calculation.
  return Number.isFinite(w) && w > 0 ? w : 1;
}

// Workspace progress from a milestone list.
// Returns { progress, completedWeight, totalWeight, milestoneCount } where
// progress is an integer 0..100, or null when there is nothing to measure
// (no milestones, or all weights somehow zero — defended, though
// milestoneWeight prevents the latter).
function workspaceProgress(milestones) {
  const list = Array.isArray(milestones) ? milestones : [];
  if (list.length === 0) {
    return { progress: null, completedWeight: 0, totalWeight: 0, milestoneCount: 0 };
  }
  let completedWeight = 0;
  let totalWeight = 0;
  for (const m of list) {
    const w = milestoneWeight(m);
    totalWeight += w;
    completedWeight += w * milestoneFraction(m);
  }
  if (totalWeight === 0) {
    return { progress: null, completedWeight: 0, totalWeight: 0, milestoneCount: list.length };
  }
  const progress = roundPct(clampPct((completedWeight / totalWeight) * 100));
  return { progress, completedWeight, totalWeight, milestoneCount: list.length };
}

// Score a single YC section. A section is either checklist-driven (has an
// `items` array of { done }) or manually scored (a numeric `score` 0..100).
// Checklist wins when items are present. Returns the section with its computed
// score plus the completed/total/missing breakdown the UI must show.
function scoreSection(section) {
  const items = Array.isArray(section.items) ? section.items : [];
  let score;
  let completedItems;
  let totalItems = items.length;
  const missingItems = [];

  if (totalItems > 0) {
    completedItems = 0;
    for (const item of items) {
      if (item.done) completedItems += 1;
      else missingItems.push({ id: item.id, label: item.label });
    }
    score = roundPct(clampPct((completedItems / totalItems) * 100));
  } else {
    // Manual-score section (no checklist items). Clamp and round; default 0.
    const raw = Number(section.score);
    score = Number.isFinite(raw) ? roundPct(clampPct(raw)) : 0;
    completedItems = null; // not item-based
    totalItems = null;
  }

  return {
    id: section.id,
    label: section.label,
    weight: sectionWeight(section),
    score,
    completedItems,
    totalItems,
    missingItems,
  };
}

function sectionWeight(section) {
  const w = Number(section.weight);
  return Number.isFinite(w) && w >= 0 ? w : 0;
}

// Overall YC progress from a list of sections. Weighted average of section
// scores over the total section weight. Every component is returned so the UI
// can show section score, section weight, and what is missing — the
// transparency §6.10/§14 require. Overall is an integer 0..100; 0 when the
// checklist exists but nothing is done, which is a real value here.
function ycOverall(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const scored = list.map(scoreSection);
  const totalWeight = scored.reduce((sum, s) => sum + s.weight, 0);
  let overall;
  if (totalWeight === 0) {
    // No weighted sections — nothing to average. Report 0 (checklist present
    // but unweighted/empty) rather than null, since YC progress is a
    // checklist completion measure, not an "unmeasurable scope" measure.
    overall = 0;
  } else {
    const weighted = scored.reduce((sum, s) => sum + s.score * s.weight, 0);
    overall = roundPct(clampPct(weighted / totalWeight));
  }
  return { overall, totalWeight, sections: scored };
}

module.exports = { workspaceProgress, ycOverall, scoreSection, roundPct, clampPct };
