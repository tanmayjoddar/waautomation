/**
 * Fake LLM adapter for tests (and LLM_PROVIDER=fake local runs: $0, offline).
 *
 * Plays a script: each generate() consumes the next entry, records the input,
 * and either resolves with canned text+tokens or throws the scripted error.
 * Out of script it repeats a minimal valid reply, so a test that only cares
 * about call counts never has to count entries exactly.
 */
import type { GenerateInput, GenerateResult, LlmAdapter } from './llm.js';

export type FakeLlmScriptEntry = { text: string; inputTokens?: number; outputTokens?: number } | Error;

const CANNED_REPLY = JSON.stringify({
  reply_parts: ['Noted, our team will confirm this shortly.'],
  language: 'english',
  intent: 'other',
  name: null,
  service: null,
  chosen_slot: null,
  confidence: 0.4,
});

export type FakeLlm = LlmAdapter & {
  /** Every generate() input, in order. */
  calls: GenerateInput[];
};

export function createFakeLlm(script: FakeLlmScriptEntry[] = []): FakeLlm {
  const calls: GenerateInput[] = [];
  const queue = [...script];
  return {
    provider: 'fake',
    calls,
    async generate(input: GenerateInput): Promise<GenerateResult> {
      calls.push(input);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next !== undefined) {
        return { text: next.text, inputTokens: next.inputTokens ?? 10, outputTokens: next.outputTokens ?? 20 };
      }
      return { text: CANNED_REPLY, inputTokens: 10, outputTokens: 20 };
    },
  };
}
