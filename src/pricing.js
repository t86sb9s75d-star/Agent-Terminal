// Estimated USD cost per 1M tokens. Source: publicly published provider pricing.
// These are estimates for operator visibility, not billing-grade figures — actual
// invoices may differ (volume tiers, promotions, regional pricing). Unknown
// models return null rather than a guessed number.
const TABLE = {
  anthropic: {
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-opus-5': { input: 15, output: 75 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
    'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  },
  openai: {
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'o1': { input: 15, output: 60 },
  },
};

function estimateCostUsd(provider, model, inputTokens, outputTokens) {
  const rates = TABLE[provider]?.[model];
  if (!rates || typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

module.exports = { estimateCostUsd, TABLE };
