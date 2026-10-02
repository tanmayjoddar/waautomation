/**
 * Circuit breaker tests. Pure logic, no network, no database: a tripped
 * breaker must fail fast, cool down, and reset on success, shared across
 * primary and fallback adapters.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  withCircuitBreaker,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_MAX_FAILURES,
} from "../../src/ai/circuitBreaker.js";
import type { LlmAdapter } from "../../src/ai/llm.js";

const okAdapter = (text = '{"a":1}'): LlmAdapter => ({
  provider: "test",
  generate: async () => ({ text, inputTokens: 1, outputTokens: 1 }),
});

const failingAdapter = (err = new Error("down")): LlmAdapter & { calls: number } => {
  let calls = 0;
  return {
    provider: "test",
    calls,
    generate: async () => {
      calls += 1;
      throw err;
    },
  } as LlmAdapter & { calls: number };
};

describe("CircuitBreaker", () => {
  it("stays closed below the threshold and counts failures", () => {
    const breaker = new CircuitBreaker(3, 60_000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.opened).toBe(false);
    expect(breaker.failures).toBe(2);
  });

  it("opens at the threshold and closes after the cooldown", () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(2, 1000);
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.opened).toBe(true);
      vi.advanceTimersByTime(999);
      expect(breaker.opened).toBe(true);
      vi.advanceTimersByTime(1);
      expect(breaker.opened).toBe(false);
      expect(breaker.failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a success resets the count", () => {
    const breaker = new CircuitBreaker(2, 60_000);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.opened).toBe(false);
  });

  it("defaults match the documented policy", () => {
    expect(CIRCUIT_MAX_FAILURES).toBe(3);
    expect(CIRCUIT_COOLDOWN_MS).toBe(60_000);
  });
});

describe("withCircuitBreaker", () => {
  it("passes calls through while closed and records the success", async () => {
    const breaker = new CircuitBreaker(3, 60_000);
    const wrapped = withCircuitBreaker(okAdapter(), breaker);
    const result = await wrapped.generate({
      system: "s",
      history: [],
      userText: "hi",
      maxTokens: 10,
      timeoutMs: 1000,
    });
    expect(result.text).toBe('{"a":1}');
    expect(breaker.failures).toBe(0);
  });

  it("fails fast without calling the adapter while open", async () => {
    const inner = failingAdapter();
    const breaker = new CircuitBreaker(1, 60_000);
    const wrapped = withCircuitBreaker(inner, breaker);
    await expect(
      wrapped.generate({ system: "s", history: [], userText: "hi", maxTokens: 10, timeoutMs: 1000 }),
    ).rejects.toThrow();
    // Second call: breaker open, adapter untouched.
    const callsBefore = (inner as unknown as { calls: number }).calls;
    await expect(
      wrapped.generate({ system: "s", history: [], userText: "hi", maxTokens: 10, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect((inner as unknown as { calls: number }).calls).toBe(callsBefore);
  });

  it("one breaker shared by two adapters trips both after combined failures", async () => {
    const breaker = new CircuitBreaker(2, 60_000);
    const primary = withCircuitBreaker(failingAdapter(), breaker);
    const fallback = withCircuitBreaker(failingAdapter(), breaker);
    const input = { system: "s", history: [], userText: "hi", maxTokens: 10, timeoutMs: 1000 };
    await expect(primary.generate(input)).rejects.toThrow("down");
    await expect(fallback.generate(input)).rejects.toThrow("down");
    expect(breaker.opened).toBe(true);
    await expect(primary.generate(input)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(fallback.generate(input)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});
