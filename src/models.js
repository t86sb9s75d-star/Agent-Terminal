// Single source of truth for which model a run actually executes against.
//
// The defect this module exists to prevent: each provider worker used to
// resolve its own default at execution time (`agent.model || 'claude-sonnet-5'`),
// while agentManager separately recorded and priced `agent.model` — the
// UNRESOLVED value. An agent created without an explicit model therefore ran
// against a real, billable default model, but was recorded as `model: null`
// and priced as `costUsd: null`. That made genuine paid usage invisible in
// three places at once: run-record provenance, the cost aggregate the
// dashboard shows, and the `knownCost` totals the daily spending caps in
// budget.js compare against.
//
// Resolution now happens exactly ONCE, in agentManager.start(), before
// execution. The same resolved value is handed to the worker, written to the
// run record, recorded in the audit event, and passed to pricing — so
// "what ran", "what we say ran", and "what we charged for" cannot drift apart.
// Workers deliberately do NOT re-derive a default; they use what they are given.

// Only providers that make a billable model-based call belong here. `custom`
// has no model concept at all, so it is intentionally absent rather than
// mapped to a placeholder.
const PROVIDER_DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
};

// Returns the model a run will actually execute against, or null when the
// provider has no model concept (custom) or is not one this system knows.
//
// Deliberate properties:
//   - An explicitly configured model is returned UNCHANGED, even if this
//     system has no pricing for it. Being unpriced is a truthful outcome;
//     substituting a known model to make the cost look complete would be
//     inventing data (see pricing.js — unknown models must stay null).
//   - An unrecognised provider is never silently given another provider's
//     default. It resolves to null and stays honestly unpriced.
//   - Falsy handling matches the `||` semantics the workers previously used,
//     so this changes which value is *accounted for*, never which model is
//     actually invoked for an already-working agent.
function resolveEffectiveModel(provider, configuredModel) {
  if (configuredModel) return configuredModel;
  return PROVIDER_DEFAULT_MODELS[provider] ?? null;
}

module.exports = { PROVIDER_DEFAULT_MODELS, resolveEffectiveModel };
