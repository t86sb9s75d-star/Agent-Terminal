const Anthropic = require('@anthropic-ai/sdk');

<<<<<<< HEAD
// Phase 4.5 — a dedicated, shorter network-level timeout for the provider
// call itself, distinct from the operator-facing runtime ceiling enforced
// in agentManager.js. That ceiling bounds the whole run (and is meant to be
// tunable per-agent for long tasks); this bounds a single stalled
// connection to the provider, which should never legitimately take this
// long regardless of what the agent's task is.
const PROVIDER_TIMEOUT_MS = Number(process.env.RUCKER_PROVIDER_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min

=======
>>>>>>> origin/main
async function runAnthropic({ agent, onLog, signal }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server');
  }
<<<<<<< HEAD
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: PROVIDER_TIMEOUT_MS });
=======
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
>>>>>>> origin/main
  const model = agent.model || 'claude-sonnet-5';

  const stream = client.messages.stream(
    {
      model,
      max_tokens: agent.maxTokens || 1024,
      system: agent.systemPrompt || undefined,
      messages: [{ role: 'user', content: agent.task }],
    },
<<<<<<< HEAD
    { signal, timeout: PROVIDER_TIMEOUT_MS }
=======
    { signal }
>>>>>>> origin/main
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
