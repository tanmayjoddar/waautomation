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
import type { Logger } from "pino";
import {
  LlmError,
  postJsonWithRetry,
  type GenerateInput,
  type GenerateResult,
  type LlmAdapter,
} from "./llm.js";

export type GeminiOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  baseDelayMs?: number;
};

const textOf = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Lists model ids for startup validation ([VERIFY] shape against the Gemini
 * REST reference: GET v1beta/models with the key, {models: [{name}]} where
 * name looks like 'models/<id>'). Returns ids without the 'models/' prefix.
 */
export async function listGeminiModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
      { headers: { "x-goog-api-key": apiKey }, signal: controller.signal },
    );
    if (!res.ok) {
      throw new Error(`list models failed with HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as {
      models?: Array<{ name?: unknown }>;
    };
    return (parsed?.models ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null))
      .filter((n): n is string => n !== null);
  } finally {
    clearTimeout(timer);
  }
}

export function createGeminiAdapter(options: GeminiOptions): LlmAdapter {
  return {
    provider: "gemini",
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`;
      const contents = [
        ...input.history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.text }],
        })),
        { role: "user", parts: [{ text: input.userText }] },
      ];
      const parsed = (await postJsonWithRetry(
        url,
        { "x-goog-api-key": options.apiKey },
        {
          system_instruction: { parts: [{ text: input.system }] },
          contents,
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: input.maxTokens,
          },
        },
        {
          timeoutMs: input.timeoutMs,
          fetchImpl: options.fetchImpl,
          logger: options.logger,
          baseDelayMs: options.baseDelayMs,
          op: "llm.gemini.generate",
        },
      )) as {
        candidates?: Array<{
          finishReason?: unknown;
          content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
        }>;
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          thoughtsTokenCount?: unknown;
        };
      };

      const candidate = parsed?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .filter((p) => p?.thought !== true)
        .map((p) => textOf(p?.text))
        .filter((t): t is string => t !== null)
        .join("");
      if (text === "") {
        throw new LlmError(
          "llm.gemini.generate: empty response (blocked or no candidates)",
          200,
          null,
          false,
        );
      }
      if (candidate?.finishReason === "MAX_TOKENS") {
        options.logger?.warn(
          {
            op: "llm.gemini.generate",
            model: options.model,
            maxTokens: input.maxTokens,
          },
          "llm.gemini.generate: output cut off at the token limit",
        );
      }
      const usage = parsed?.usageMetadata ?? {};
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      return {
        text,
        inputTokens: num(usage.promptTokenCount),
        // Thinking tokens are billed as output, so count them.
        outputTokens:
          num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount),
      };
    },
  };
}
