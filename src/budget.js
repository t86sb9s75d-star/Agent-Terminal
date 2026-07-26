// Phase 4.6 — spending controls. Enforced BEFORE a paid-provider (anthropic
// / openai) run is allowed to start; a `custom` agent has no cost concept
// and is never subject to these checks (consistent with runsStore.aggregateCost
// excluding it entirely).
//
// These are lower-bound checks: they compare against `knownCost`, the sum of
// runs this system could actually price (see runsStore.aggregateCost's
// pricingStatus). If some of today's runs used a model this system has no
// documented price for, the real spend could be higher than what's checked
// here. This is the same truthful-partial-total philosophy already used for
// cost reporting elsewhere — a control built on a silently-optimistic number
// would be worse than no control at all, but blocking on totals this system
// cannot vouch for as complete is also documented, not hidden.
//
// All three limits are optional (unset = unlimited) so a fresh install has
// no surprise blocking behavior; an operator opts in by setting the env vars.

const runsStore = require('./runsStore');
const { AppError, Codes } = require('./errors');

function envLimit(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function limits() {
  return {
    perRunUsd: envLimit('RUCKER_MAX_COST_PER_RUN_USD'),
    perAgentDailyUsd: envLimit('RUCKER_MAX_DAILY_COST_PER_AGENT_USD'),
    systemDailyUsd: envLimit('RUCKER_MAX_DAILY_COST_SYSTEM_USD'),
  };
}

// Called before starting a paid-provider run. Throws AppError(BUDGET_LIMIT_REACHED)
// if a configured ceiling has already been reached; a no-op if no limits are set.
function assertWithinBudget({ agentId, provider }) {
  if (provider === 'custom') return; // no cost concept for custom commands
  const { systemDailyUsd, perAgentDailyUsd } = limits();
  if (systemDailyUsd === null && perAgentDailyUsd === null) return;

  if (systemDailyUsd !== null) {
    const systemSpent = runsStore.summarize().cost.knownCost;
    if (systemSpent >= systemDailyUsd) {
      throw new AppError(
        Codes.BUDGET_LIMIT_REACHED,
        `system daily spending limit reached ($${systemSpent.toFixed(2)} of $${systemDailyUsd.toFixed(2)}) — no new paid-provider runs will start today`,
        429
      );
    }
  }

  if (perAgentDailyUsd !== null) {
    const agentSpent = runsStore.summarizeForAgent(agentId).cost.knownCost;
    if (agentSpent >= perAgentDailyUsd) {
      throw new AppError(
        Codes.BUDGET_LIMIT_REACHED,
        `this agent's daily spending limit reached ($${agentSpent.toFixed(2)} of $${perAgentDailyUsd.toFixed(2)})`,
        429
      );
    }
  }
}

// The per-run cap can't be checked before the call (cost is only known after
// usage is reported back), so it's enforced immediately after a run
// finishes, as a policy signal for the operator to see and act on — not a
// pre-flight block. Returns true if this run exceeded the configured cap.
function exceededPerRunCap(costUsd) {
  const { perRunUsd } = limits();
  if (perRunUsd === null || costUsd === null || costUsd === undefined) return false;
  return costUsd > perRunUsd;
}

module.exports = { assertWithinBudget, exceededPerRunCap, limits };
