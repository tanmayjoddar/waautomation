/**
 * Gate for tests that need a real Supabase project.
 *
 * These tests SKIP themselves, loudly, when the project is not configured or the
 * schema is missing, so `npm test` never fails for someone who has not reached
 * that step of Part 2 yet. The skip reason appears in the test list.
 *
 * Everything written by these tests is namespaced with a unique prefix and
 * removed again in afterAll. Nothing here touches the demo tenant.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { EnvError, loadEnvFromFile, type AppConfig } from '../../src/config.js';
import { createServiceClient } from '../../src/db/supabase.js';

export type DbHarness = {
  config: AppConfig;
  supabase: SupabaseClient;
  /** Unique marker for this run, so leftovers can be found and cleaned. */
  tag: string;
};

export type DbReadiness = { ok: true; harness: DbHarness } | { ok: false; reason: string };

let cached: DbReadiness | null = null;

/** `wa-test-<8 hex>` - visible in the Supabase table editor if a run dies. */
const makeTag = (): string => `wa-test-${Math.random().toString(16).slice(2, 10)}`;

/**
 * A 4 ms sleep that lets PostgREST finish. Needed after admin.createUser before
 * signInWithPassword can see the user.
 */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries `attempt` until it returns true, for auth propagation races. */
export async function retry(
  attempts: number,
  delayMs: number,
  attempt: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await attempt()) return true;
    await wait(delayMs);
  }
  return false;
}

async function probeSchema(supabase: SupabaseClient, requireMessageErrorColumns = false): Promise<string | null> {
  const { error } = await supabase.from('clients').select('id').limit(1);
  if (!error) {
    if (!requireMessageErrorColumns) return null;
    // Migration 002: the failed-status write path references these columns, so
    // a project without them fails those tests with a confusing PostgREST
    // error instead of a skip. Probe the column directly.
    const { error: columnError } = await supabase.from('messages').select('meta_error_code').limit(1);
    if (!columnError) return null;
    return `002_message_errors.sql has not been applied: run supabase/migrations/002_message_errors.sql in the Supabase SQL Editor first (Postgres said: ${columnError.message})`;
  }
  const message = error.message;
  if (/does not exist|schema cache|not found/i.test(message)) {
    return `the schema is missing: run supabase/migrations/001_init.sql in the Supabase SQL Editor first (Postgres said: ${message})`;
  }
  return `cannot read the clients table: ${message}`;
}

/**
 * Checks that the migration has actually been applied. Returns a skip reason or
 * null. Call it in beforeAll, keep the string, and pass it to `ctx.skip()` in
 * each test.
 */
export async function schemaReadiness(
  supabase: SupabaseClient,
  opts?: { requireMessageErrorColumns?: boolean },
): Promise<string | null> {
  return probeSchema(supabase, opts?.requireMessageErrorColumns ?? false);
}

/** The subset of vitest's TestContext this helper needs. */
type SkipContext = { skip: (note?: string) => void };

/**
 * Wraps a test body so that it skips (with a reason) when the database is not
 * usable, instead of failing with a confusing PostgREST error.
 */
export function dbTest(
  reason: () => string | null,
  body: (h: DbHarness) => Promise<void>,
): (ctx: SkipContext) => Promise<void> {
  return async (ctx) => {
    const why = reason();
    if (why !== null) {
      ctx.skip(why);
      return;
    }
    const readiness = dbHarness();
    if (!readiness.ok) {
      ctx.skip(readiness.reason);
      return;
    }
    await body(readiness.harness);
  };
}

export function dbHarness(): DbReadiness {
  if (cached) return cached;

  let config: AppConfig;
  try {
    config = loadEnvFromFile();
  } catch (err) {
    cached = {
      ok: false,
      reason:
        err instanceof EnvError
          ? `.env is not usable yet: ${err.problems.join('; ')}`
          : `.env could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
    return cached;
  }

  if (config.isProduction) {
    cached = { ok: false, reason: 'NODE_ENV=production in .env: refusing to run database tests against a live project' };
    return cached;
  }

  const supabase = createServiceClient(config);
  const tag = makeTag();
  cached = { ok: true, harness: { config, supabase, tag } };
  return cached;
}

/** For tests that need the anon key as well (the RLS test). */
export function anonKey(config: AppConfig): string | null {
  return config.supabase.anonKey;
}

/**
 * Reserved prefix for every tenant these tests create. A crashed or timed-out run
 * leaves its client behind, and because `jobs` cascades from `clients` the next
 * run would then find due jobs in the queue that it did not create.
 *
 * Each suite appends its own namespace (`wa-test-fns-`, `wa-test-rls-`, ...) and
 * purges only that namespace: vitest runs test FILES in parallel, so two suites
 * sharing a prefix would delete each other's tenants mid-test.
 */
export const TEST_CLIENT_PREFIX = 'wa-test-';

/**
 * Garbage-collects tenants left behind by a previous run of ONE suite that never
 * cleaned up. `namespace` must include the trailing separator.
 */
export async function purgeAbandonedTestTenants(
  supabase: SupabaseClient,
  namespace: string,
  keepClientId: string | null = null,
): Promise<number> {
  let query = supabase.from('clients').delete().like('business_name', `${namespace}%`).select('id');
  if (keepClientId !== null) query = query.neq('id', keepClientId);
  const { data, error } = await query;
  if (error) throw new Error(`purgeAbandonedTestTenants failed: ${error.message}`);
  return data?.length ?? 0;
}

/** A phone number that cannot collide with a real contact. */
export const testPhone = (tag: string, n: number): string => `9199${tag.slice(-6)}${String(n).padStart(4, '0')}`;

/** Delete a client and everything that cascades from it. */
export async function deleteTestClient(supabase: SupabaseClient, clientId: string): Promise<void> {
  await supabase.from('clients').delete().eq('id', clientId);
}
