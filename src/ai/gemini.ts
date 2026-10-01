/**
 * Gemini adapter via the generateContent REST endpoint.
 *
 * DECISION (see report): the pasted docs say the Interactions API is now
 * recommended and generateContent is legacy-but-supported. The Interactions
 * REST reference (URL, auth, request/response JSON) is unreadable from here,
 * and guessing a brand-new API shape risks 400ing every call, so this adapter
 * uses the stable generateContent shape with [VERIFY] on each field. Moving
 * to Interactions later is a one-file swap behind the LlmAdapter interface.
 *
 * Written against long-stable generateContent behaviour [VERIFY all of it
 * against https://ai.google.dev/gemini-api/docs]:
 *  - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *  - auth header x-goog-api-key (the ?key= query form also exists)
 *  - system_instruction.parts[].text, contents[].{role,parts[].text} with
 *    roles 'user'/'model', generationConfig {responseMimeType, maxOutputTokens}
 *  - response candidates[0].content.parts[].text joined; usageMetadata
 *    {promptTokenCount, candidatesTokenCount}
 * Deliberately NOT sent: thinking-budget fields (a wrong field 400s every
 * call; the default applies) and temperature (provider default applies).
 */
import type { Logger } from 'pino';
import { LlmError, postJsonWithRetry, type GenerateInput, type GenerateResult, type LlmAdapter } from './llm.js';

export type GeminiOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  baseDelayMs?: number;
};

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function createGeminiAdapter(options: GeminiOptions): LlmAdapter {
  return {
    provider: 'gemini',
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`;
      const contents = [
        ...input.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        { role: 'user', parts: [{ text: input.userText }] },
      ];
      const parsed = (await postJsonWithRetry(
        url,
        { 'x-goog-api-key': options.apiKey },
        {
          system_instruction: { parts: [{ text: input.system }] },
          contents,
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: input.maxTokens },
        },
        { timeoutMs: input.timeoutMs, fetchImpl: options.fetchImpl, logger: options.logger, baseDelayMs: options.baseDelayMs, op: 'llm.gemini.generate' },
      )) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
        usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
      };

      const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => textOf(p?.text)).filter((t): t is string => t !== null).join('');
      if (text === '') {
        throw new LlmError('llm.gemini.generate: empty response (blocked or no candidates)', 200, null, false);
      }
      const usage = parsed?.usageMetadata ?? {};
      return {
        text,
        inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
        outputTokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0,
      };
    },
  };
}
