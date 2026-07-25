const OpenAI = require('openai');

async function runOpenAI({ agent, onLog, signal }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
    { signal }
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
