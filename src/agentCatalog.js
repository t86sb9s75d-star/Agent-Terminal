// Feature Onboard — the coordinated agent catalog.
//
// These are DEFINITIONS, not agent instances. Rucker Park's agents are global
// and created through the existing store.create() path (an `anthropic` agent
// with a preset task/system prompt). A catalog entry describes such an agent
// so the operator can enable/configure it per workspace without twelve copies
// of near-identical chat code existing in the codebase (handoff §7).
//
// Nothing here executes anything. Wiring "enable this catalog agent in this
// workspace" to an actual store.create() call is a later phase; this phase
// establishes the catalog and the stage→recommendation mapping as data.

const { CAPABILITY_KEYS } = require('./permissions');

// Each entry:
//   id            stable machine identifier
//   name          operator-facing name (kept verbatim per handoff, incl.
//                 "Business Idea Storm")
//   group         catalog grouping for display
//   purpose       one-line description
//   provider      how it would be instantiated ('anthropic' for LLM agents)
//   capabilities  what the agent is designed to do (descriptive)
//   requiredPermissions  permission keys this agent needs to function; used to
//                 seed its per-workspace permission grant. Validated against
//                 the permission vocabulary at module load (see assertion).
const CATALOG = [
  // Research and discovery
  { id: 'interview_agent', name: 'Interview Agent', group: 'Research and discovery', purpose: 'Plan and structure customer interviews and synthesize what was learned.', provider: 'anthropic', capabilities: ['draft interview scripts', 'summarize transcripts', 'extract evidence'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'business_idea_storm', name: 'Business Idea Storm', group: 'Research and discovery', purpose: 'Generate and pressure-test business ideas against the founder profile.', provider: 'anthropic', capabilities: ['idea generation', 'constraint-fit scoring', 'assumption surfacing'], requiredPermissions: ['read_workspace_data', 'paid_model_calls'] },
  { id: 'brainstorm_agent', name: 'Brainstorm Agent', group: 'Research and discovery', purpose: 'Open-ended brainstorming on a specific prompt or problem.', provider: 'anthropic', capabilities: ['divergent ideation', 'option framing'], requiredPermissions: ['read_workspace_data', 'paid_model_calls'] },

  // Finance and analysis
  { id: 'stock_analyzer', name: 'Stock Analyzer', group: 'Finance and analysis', purpose: 'Analyze public-market data for research context (read-only, no trading).', provider: 'anthropic', capabilities: ['summarize filings', 'ratio analysis'], requiredPermissions: ['read_workspace_data', 'access_network', 'paid_model_calls'] },
  { id: 'financial_terminal', name: 'Financial Terminal', group: 'Finance and analysis', purpose: 'Build and sanity-check financial models and projections.', provider: 'anthropic', capabilities: ['unit economics', 'projection modeling'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'business_advisory_agent', name: 'Business Advisory Agent', group: 'Finance and analysis', purpose: 'General strategic advice grounded in the workspace evidence and stage.', provider: 'anthropic', capabilities: ['strategy review', 'risk surfacing'], requiredPermissions: ['read_workspace_data', 'paid_model_calls'] },

  // Go-to-market
  { id: 'marketing_agent', name: 'Marketing Agent', group: 'Go-to-market', purpose: 'Draft positioning, messaging, and marketing plans.', provider: 'anthropic', capabilities: ['positioning', 'copy drafting'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'lead_generation_agent', name: 'Lead Generation Agent', group: 'Go-to-market', purpose: 'Plan lead-generation approaches and target lists (no autonomous outreach).', provider: 'anthropic', capabilities: ['channel planning', 'ICP definition'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'lead_conversion', name: 'Lead Conversion', group: 'Go-to-market', purpose: 'Design conversion steps, follow-up sequences, and objection handling.', provider: 'anthropic', capabilities: ['funnel design', 'objection scripts'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },

  // Product and execution
  { id: 'design_agent', name: 'Design Agent', group: 'Product and execution', purpose: 'Draft product requirements, flows, and design critiques.', provider: 'anthropic', capabilities: ['requirements drafting', 'flow critique'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'operations_agent', name: 'Operations Agent', group: 'Product and execution', purpose: 'Design operating processes, onboarding, and fulfillment steps.', provider: 'anthropic', capabilities: ['process design', 'SOP drafting'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'paid_model_calls'] },
  { id: 'workflow_agent', name: 'Workflow Agent', group: 'Product and execution', purpose: 'Break objectives into concrete tasks and sequences.', provider: 'anthropic', capabilities: ['task breakdown', 'sequencing'], requiredPermissions: ['read_workspace_data', 'write_workspace_data', 'create_tasks', 'paid_model_calls'] },
];

const CATALOG_IDS = CATALOG.map((a) => a.id);

// Fail fast at load time if a catalog entry references a permission key that
// isn't in the vocabulary — a typo here would otherwise silently ship an
// agent whose required permission can never be granted.
for (const agent of CATALOG) {
  for (const perm of agent.requiredPermissions) {
    if (!CAPABILITY_KEYS.includes(perm)) {
      throw new Error(`agentCatalog: agent "${agent.id}" requires unknown permission "${perm}"`);
    }
  }
}

// Stage → recommended agent ids (handoff §8). Data, not conditionals. A stage
// absent from this map falls back to an empty recommendation (the operator
// still sees the full catalog; recommendations are additive guidance).
const STAGE_RECOMMENDATIONS = {
  problem_discovery: ['interview_agent', 'business_idea_storm', 'brainstorm_agent', 'business_advisory_agent'],
  idea_validation: ['interview_agent', 'marketing_agent', 'lead_generation_agent', 'business_advisory_agent'],
  prototype: ['design_agent', 'workflow_agent', 'operations_agent'],
  customer_testing: ['interview_agent', 'design_agent', 'operations_agent'],
  first_revenue: ['lead_generation_agent', 'lead_conversion', 'financial_terminal', 'operations_agent'],
  repeatable_sales: ['lead_generation_agent', 'lead_conversion', 'operations_agent', 'workflow_agent'],
  growth: ['marketing_agent', 'lead_generation_agent', 'financial_terminal', 'operations_agent'],
  fundraise: ['business_advisory_agent', 'financial_terminal', 'interview_agent'],
  scale: ['operations_agent', 'workflow_agent', 'financial_terminal'],
};

function getCatalogAgent(id) {
  return CATALOG.find((a) => a.id === id) || null;
}

function isValidCatalogAgent(id) {
  return CATALOG_IDS.includes(id);
}

// Returns the recommended catalog agent objects for a stage, in declared
// order. Unknown/unset stage → empty array (never throws; recommendations are
// advisory, so a partially configured workspace just gets no suggestions).
function recommendationsForStage(stageId) {
  const ids = STAGE_RECOMMENDATIONS[stageId] || [];
  return ids.map(getCatalogAgent).filter(Boolean);
}

module.exports = {
  CATALOG,
  CATALOG_IDS,
  STAGE_RECOMMENDATIONS,
  getCatalogAgent,
  isValidCatalogAgent,
  recommendationsForStage,
};
