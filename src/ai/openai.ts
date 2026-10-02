/**
 * OpenAI adapter (chat completions).
 *
 * The method reference itself was unreadable from here (only the API overview
 * loaded), so every field below is [VERIFY] against
 * https://platform.openai.com/docs/api-reference — written from the
 * long-stable chat-completions shape:
 *  - POST https://api.openai.com/v1/chat/completions, Bearer auth
 *  - body {model, messages:[{role,content}] with a system first message,
 *    max_tokens, response_format:{type:'json_object'}}
 *  - response choices[0].message.content; usage {prompt_tokens,
 *    completion_tokens}
 * Notes: max_tokens (not max_completion_tokens) matches chat completions;
 * some newer models prefer the latter [VERIFY]. No temperature sent
 * (provider default applies).
 */
import type { Logger } from 'pino';
import { LlmError, postJsonWithRetry, type GenerateInput, type GenerateResult, type LlmAdapter } from './llm.js';

export type OpenAIOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  baseDelayMs?: number;
};

/**
 * Lists model ids for startup validation ([VERIFY] shape against the API
 * reference: GET /v1/models with Bearer auth, {data: [{id}]}).
 */
export async function listOpenAiModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`list models failed with HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (parsed?.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((n): n is string => n !== null);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAIAdapter(options: OpenAIOptions): LlmAdapter {
  return {
    provider: 'openai',
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const parsed = (await postJsonWithRetry(
        'https://api.openai.com/v1/chat/completions',
        { Authorization: `Bearer ${options.apiKey}` },
        {
          model: options.model,
          messages: [
            { role: 'system', content: input.system },
            ...input.history.map((m) => ({ role: m.role, content: m.text })),
            { role: 'user', content: input.userText },
          ],
          max_tokens: input.maxTokens,
          response_format: { type: 'json_object' },
        },
        { timeoutMs: input.timeoutMs, fetchImpl: options.fetchImpl, logger: options.logger, baseDelayMs: options.baseDelayMs, op: 'llm.openai.generate' },
      )) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };

      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content === '') {
        throw new LlmError('llm.openai.generate: empty response (no choice content)', 200, null, false);
      }
      const usage = parsed?.usage ?? {};
      return {
        text: content,
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      };
    },
  };
}
