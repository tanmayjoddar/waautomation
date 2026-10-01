/**
 * Test helpers. Nothing here talks to Supabase, Meta, an LLM or Google.
 */
import type { LogDestination } from '../src/logger.js';

/** A valid (fake) env: only the always-required variables. */
export function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    ...overrides,
  };
}

/** Collects everything written to it, for logger assertions. */
export function collectingStream(): { stream: LogDestination; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string): void {
        chunks.push(String(chunk));
      },
    },
    text: () => chunks.join(''),
  };
}
