/**
 * LLM provider factory. The worker calls this once at startup; the provider
 * choice stays a config value, never a code branch scattered through the app.
 */
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createFakeLlm } from "./fake.js";
import { createGeminiAdapter } from "./gemini.js";
import type { LlmAdapter } from "./llm.js";
import { createOpenAIAdapter } from "./openai.js";

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
