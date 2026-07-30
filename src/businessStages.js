// Feature Onboard — the business-stage model.
//
// A workspace (a business/company/major project) has exactly one current
// stage. The stage is guidance, never a lock: it changes which agents are
// recommended, which next actions are surfaced, and what the Command Center
// emphasizes — but the operator can always use any agent regardless of stage
// (see agentCatalog.recommendationsForStage, which is advisory).
//
// Stages are an ordered list. Order matters only for display and for
// "how far along" context — it is NOT a progress percentage. A workspace at
// "fundraise" has not "completed 80% of a business"; it is simply at a later
// stage than one at "problem discovery". Progress is measured separately and
// deterministically (see progress.js), never inferred from stage position.

// id is the stable machine identifier (never shown raw to the operator and
// never embedded in business logic beyond this file); label is the display
// text; emphasis lists the dashboard areas the Command Center should surface
// first at this stage. emphasis values are a controlled vocabulary consumed
// by the frontend — they are data, not free-form strings scattered in the UI.
const STAGES = [
  { id: 'problem_discovery', label: 'Problem discovery', emphasis: ['interviews', 'assumptions', 'evidence'] },
  { id: 'idea_validation', label: 'Idea validation', emphasis: ['interviews', 'experiments', 'evidence', 'assumptions'] },
  { id: 'prototype', label: 'Prototype', emphasis: ['goals', 'experiments', 'tasks'] },
  { id: 'customer_testing', label: 'Customer testing', emphasis: ['experiments', 'evidence', 'goals'] },
  { id: 'first_revenue', label: 'First revenue', emphasis: ['goals', 'tasks', 'evidence'] },
  { id: 'repeatable_sales', label: 'Repeatable sales', emphasis: ['goals', 'tasks', 'evidence'] },
  { id: 'growth', label: 'Growth', emphasis: ['goals', 'tasks'] },
  { id: 'fundraise', label: 'Fundraise', emphasis: ['yc', 'evidence', 'goals', 'decisions'] },
  { id: 'scale', label: 'Scale', emphasis: ['goals', 'tasks', 'decisions'] },
];

const STAGE_IDS = STAGES.map((s) => s.id);
const DEFAULT_STAGE = 'problem_discovery';

function isValidStage(id) {
  return STAGE_IDS.includes(id);
}

function getStage(id) {
  return STAGES.find((s) => s.id === id) || null;
}

// The dashboard areas to emphasize at a given stage. Falls back to a neutral
// set for an unknown/unset stage rather than throwing, so a partially
// configured workspace still renders something sensible. Callers that need to
// REJECT an invalid stage (e.g. store validation) use isValidStage instead.
function emphasisForStage(id) {
  const stage = getStage(id);
  return stage ? stage.emphasis : ['goals', 'tasks'];
}

module.exports = { STAGES, STAGE_IDS, DEFAULT_STAGE, isValidStage, getStage, emphasisForStage };
