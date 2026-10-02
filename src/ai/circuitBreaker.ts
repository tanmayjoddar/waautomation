/**
 * Circuit breaker for LLM calls (hardening).
 *
 * After MAX_CONSECUTIVE_FAILURES consecutive generate() failures the breaker
 * opens for COOLDOWN_MS: calls fail fast with CircuitOpenError instead of
 * hitting a dead provider. Any success resets the count. One breaker is
 * shared by the primary and fallback adapters, so "N consecutive primary and
 * fallback failures" trips a single cooldown for both.
 *
 * In-memory per process by design: a restart fail-opens (one probe per job
 * instead of a storm, bounded by worker concurrency), and the count rebuilds
 * within seconds if the provider is still down. Surviving a restart was
 * deliberately NOT built: that needs a table, and the blast radius of a
 * cold breaker is a few retried jobs, not an outage.
 */
import type { LlmAdapter } from "./llm.js";

export const CIRCUIT_MAX_FAILURES = 3;
export const CIRCUIT_COOLDOWN_MS = 60_000;

export class CircuitOpenError extends Error {
  constructor() {
    super("LLM circuit is open: cooling down after consecutive failures");
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    readonly maxFailures: number = CIRCUIT_MAX_FAILURES,
    readonly cooldownMs: number = CIRCUIT_COOLDOWN_MS,
  ) {}

  /** True while calls must fail fast. A cooled-down breaker closes itself. */
  get opened(): boolean {
    if (this.consecutiveFailures < this.maxFailures) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.consecutiveFailures = 0;
      this.openedAt = 0;
      return false;
    }
    return true;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.openedAt = Date.now();
    }
  }
}

/** Wraps any adapter: fail fast while open, account every outcome. */
export function withCircuitBreaker(
  adapter: LlmAdapter,
  breaker: CircuitBreaker,
): LlmAdapter {
  return {
    provider: adapter.provider,
    async generate(input) {
      if (breaker.opened) throw new CircuitOpenError();
      try {
        const result = await adapter.generate(input);
        breaker.recordSuccess();
        return result;
      } catch (err) {
        breaker.recordFailure();
        throw err;
      }
    },
  };
}
