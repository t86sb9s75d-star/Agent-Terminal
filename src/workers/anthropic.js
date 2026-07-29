const Anthropic = require('@anthropic-ai/sdk');

// Phase 4.5 — a dedicated, shorter network-level timeout for the provider
// call itself, distinct from the operator-facing runtime ceiling enforced
// in agentManager.js. That ceiling bounds the whole run (and is meant to be
// tunable per-agent for long tasks); this bounds a single stalled
// connection to the provider, which should never legitimately take this
// long regardless of what the agent's task is.
const PROVIDER_TIMEOUT_MS = Number(process.env.RUCKER_PROVIDER_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min

// `model` is the already-resolved effective model supplied by agentManager,
// which is the single place a provider default is applied (see models.js).
// This worker deliberately does not fall back to its own default: doing so is
// exactly what let the executed model drift away from the recorded and priced
// one, hiding real spend from run history and the budget caps.
async function runAnthropic({ agent, model, onLog, signal }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: PROVIDER_TIMEOUT_MS });

  const stream = client.messages.stream(
    {
      model,
      max_tokens: agent.maxTokens || 1024,
      system: agent.systemPrompt || undefined,
      messages: [{ role: 'user', content: agent.task }],
    },
    { signal, timeout: PROVIDER_TIMEOUT_MS }
  );

  stream.on('text', (text) => onLog(text));

  const final = await stream.finalMessage();
  onLog(`\n\n[done] model=${model} stop_reason=${final.stop_reason} usage=${JSON.stringify(final.usage)}`);

  return {
    inputTokens: final.usage?.input_tokens ?? null,
    outputTokens: final.usage?.output_tokens ?? null,
    cachedTokens: final.usage?.cache_read_input_tokens ?? null,
  };
}

module.exports = runAnthropic;
