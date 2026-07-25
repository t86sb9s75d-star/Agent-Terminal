const Anthropic = require('@anthropic-ai/sdk');

async function runAnthropic({ agent, onLog, signal }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = agent.model || 'claude-sonnet-5';

  const stream = client.messages.stream(
    {
      model,
      max_tokens: agent.maxTokens || 1024,
      system: agent.systemPrompt || undefined,
      messages: [{ role: 'user', content: agent.task }],
    },
    { signal }
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
