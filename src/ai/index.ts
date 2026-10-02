/**
 * LLM provider factory. The worker calls this once at startup; the provider
 * choice stays a config value, never a code branch scattered through the app.
 */
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { createAnthropicAdapter, listAnthropicModels } from "./anthropic.js";
import { createFakeLlm } from "./fake.js";
import { createGeminiAdapter, listGeminiModels } from "./gemini.js";
import type { LlmAdapter } from "./llm.js";
import { createOpenAIAdapter, listOpenAiModels } from "./openai.js";

/** Second adapter on LLM_FALLBACK_MODEL, or null when none is set (or the provider is 'fake'). */
export function createFallbackLlmAdapter(
  llm: NonNullable<AppConfig["llm"]>,
  logger?: Logger,
  fetchImpl?: typeof fetch,
): LlmAdapter | null {
  if (llm.fallbackModel === null || llm.provider === "fake") return null;
  return createLlmAdapter(
    { ...llm, model: llm.fallbackModel },
    logger,
    fetchImpl,
  );
}

export function createLlmAdapter(
  llm: NonNullable<AppConfig["llm"]>,
  logger?: Logger,
  fetchImpl?: typeof fetch,
): LlmAdapter {
  const options = { apiKey: llm.apiKey, model: llm.model, fetchImpl, logger };
  switch (llm.provider) {
    case "gemini":
      return createGeminiAdapter(options);
    case "anthropic":
      return createAnthropicAdapter(options);
    case "openai":
      return createOpenAIAdapter(options);
    case "fake":
      return createFakeLlm();
  }
}

/**
 * Startup model validation: both names must exist at the provider and differ.
 * Transport failures (provider down, no network) warn and pass: only
 * definitive answers (bad key, unknown model, identical models) fail, loudly.
 * Model-list shapes are [VERIFY] per provider module.
 */
export async function validateLlmModels(
  llm: NonNullable<AppConfig["llm"]>,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (llm.provider === "fake") return;
  if (llm.fallbackModel !== null && llm.fallbackModel === llm.model) {
    throw new Error(
      `LLM_MODEL and LLM_FALLBACK_MODEL are both "${llm.model}": the fallback must differ or it protects nothing.`,
    );
  }
  let available: string[];
  try {
    switch (llm.provider) {
      case "gemini":
        available = await listGeminiModels(llm.apiKey, fetchImpl);
        break;
      case "anthropic":
        available = await listAnthropicModels(llm.apiKey, fetchImpl);
        break;
      case "openai":
        available = await listOpenAiModels(llm.apiKey, fetchImpl);
        break;
    }
  } catch (err) {
    logger.warn(
      { provider: llm.provider },
      `model validation skipped (list endpoint unreachable): ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const missing = [llm.model, llm.fallbackModel].filter(
    (name): name is string => name !== null && !available.includes(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `unknown ${llm.provider} model(s): ${missing.join(", ")}. Check LLM_MODEL${llm.fallbackModel ? " and LLM_FALLBACK_MODEL" : ""} against the provider's model list.`,
    );
  }
  logger.info(
    { provider: llm.provider, model: llm.model },
    "LLM models validated",
  );
}
