const OpenAI = require('openai');

// Phase 4.5 — see the matching comment in workers/anthropic.js: this is a
// network-level timeout on the provider call itself, separate from the
// operator-facing runtime ceiling enforced in agentManager.js.
const PROVIDER_TIMEOUT_MS = Number(process.env.RUCKER_PROVIDER_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min

async function runOpenAI({ agent, onLog, signal }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: PROVIDER_TIMEOUT_MS });
  const model = agent.model || 'gpt-4o-mini';

  const messages = [];
  if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt });
  messages.push({ role: 'user', content: agent.task });

  const stream = await client.chat.completions.create(
    {
      model,
      max_tokens: agent.maxTokens || 1024,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal, timeout: PROVIDER_TIMEOUT_MS }
  );

  let finishReason = null;
  let usage = null;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) onLog(delta);
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  onLog(`\n\n[done] model=${model} finish_reason=${finishReason}`);

  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
  };
}

module.exports = runOpenAI;
