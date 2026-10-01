/**
 * Anthropic adapter (Messages API).
 *
 * Written against the Messages reference read 2026-10-02
 * (https://docs.claude.com/en/api/messages, canonical host [VERIFY]:
 * https://api.anthropic.com):
 *  - POST {host}/v1/messages
 *  - headers x-api-key + anthropic-version: 2023-06-01
 *  - body {model, max_tokens, system, messages:[{role,content}]}
 *  - output_config.format {type:'json_schema', schema} per the structured-outputs
 *    reference [VERIFY per-model support: a model that rejects it fails this
 *    call with 400, which the pipeline turns into fallback, never a crash]
 *  - response content[] text blocks joined; usage {input_tokens,
 *    output_tokens} [VERIFY field names]
 * Deliberately NOT sent: thinking params (min budget 1024 per the reference;
 * omission keeps the default; a wrong field would 400 every call).
 */
import type { Logger } from 'pino';
import { REPLY_JSON_SCHEMA } from './schema.js';
import { LlmError, postJsonWithRetry, type GenerateInput, type GenerateResult, type LlmAdapter } from './llm.js';

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  baseDelayMs?: number;
};

export function createAnthropicAdapter(options: AnthropicOptions): LlmAdapter {
  return {
    provider: 'anthropic',
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const parsed = (await postJsonWithRetry(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: options.model,
          max_tokens: input.maxTokens,
          system: input.system,
          messages: [
            ...input.history.map((m) => ({ role: m.role, content: m.text })),
            { role: 'user', content: input.userText },
          ],
          output_config: { format: { type: 'json_schema', schema: REPLY_JSON_SCHEMA } },
        },
        { timeoutMs: input.timeoutMs, fetchImpl: options.fetchImpl, logger: options.logger, baseDelayMs: options.baseDelayMs, op: 'llm.anthropic.generate' },
      )) as {
        content?: Array<{ type?: unknown; text?: unknown }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };

      const text = (parsed?.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text === '') {
        throw new LlmError('llm.anthropic.generate: empty response (no text block)', 200, null, false);
      }
      const usage = parsed?.usage ?? {};
      return {
        text,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      };
    },
  };
}
