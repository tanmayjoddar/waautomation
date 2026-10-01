/**
 * SQL function privileges, live (spec 1.12 / migration requirement).
 *
 * The point of this file is that Postgres, not our code, refuses the call.
 * Supabase grants EXECUTE on new functions to PUBLIC, and the anon and
 * authenticated roles are members of PUBLIC, so without the REVOKE block at the
 * end of the migration anyone holding the public anon key could claim another
 * tenant's jobs or enqueue work.
 *
 * What is asserted:
 *   anon          -> cannot call claim_due_job, enqueue_reply_job or client_stats
 *   authenticated -> can call client_stats (the dashboard needs it, RLS-limited),
 *                    still cannot call claim_due_job or enqueue_reply_job
 *   service_role  -> can call all three
 *
 * The anon key must actually work, or "refused" would prove nothing: a stale key
 * is refused by the API gateway long before Postgres sees a function call. That is
 * why the first test probes the key and the suite skips loudly if it is unusable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { claimDueJob, enqueueReplyJob, getClientStats } from '../../src/db/supabase.js';
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  purgeAbandonedTestTenants,
  retry,
  schemaReadiness,
  TEST_CLIENT_PREFIX,
  testPhone,
  type DbHarness,
} from './harness.js';

const NAMESPACE = `${TEST_CLIENT_PREFIX}priv-`;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const ready = dbHarness();
const suiteName = ready.ok ? 'function privileges: anon refused, service_role allowed' : `function privileges (skipped: ${ready.reason})`;

/**
 * PostgREST/GoTrue wording for "you may not call this".
 *
 * Two shapes count as a refusal. Postgres says "permission denied"; when the role
 * cannot EXECUTE at all, PostgREST also hides the routine from that role's schema
 * cache and answers "could not find the function ... in the schema cache". The
 * same call is asserted to succeed as service_role in this file, which is what
 * rules out a misspelled function or a wrong argument name.
 */
const looksLikePermissionDenial = (message: string): boolean =>
  /permission denied|not authorized|insufficient_privilege|42501|401|schema cache|does not exist/i.test(message);

/** An unusable key is a different problem from a missing privilege. */
const looksLikeBadKey = (message: string): boolean => /invalid api key|no api key/i.test(message);

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  /**
   * Set when the anon key is missing or unusable, which is an environment problem
   * rather than a privilege failure: every call with such a key is refused by the
   * API gateway before Postgres sees it. The affected tests then SKIP with this
   * reason printed, instead of failing on a refusal that proves nothing.
   */
  let anonKeyProblem: string | null = null;
  let clientId = '';
  let userId = '';
  let asUser: SupabaseClient | null = null;
  const createdClientIds: string[] = [];
  const createdUserIds: string[] = [];

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  /** Same as `test`, but also skipped when the anon key cannot be used. */
  const anonTest = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason ?? anonKeyProblem, body);

  const anon = (): SupabaseClient =>
    createClient(h.config.supabase.url, h.config.supabase.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason !== null) return;

    // The service-role fixture is needed either way.
    const { data: client, error: clientError } = await h.supabase
      .from('clients')
      .insert({ business_name: `${NAMESPACE}${h.tag}`, phone_number_id: `${h.tag}-priv` })
      .select('id')
      .single();
    if (clientError) throw new Error(`cannot create the privileges test client: ${clientError.message}`);
    clientId = (client as { id: string }).id;
    createdClientIds.push(clientId);

    if (h.config.supabase.anonKey === null) {
      anonKeyProblem = 'SUPABASE_ANON_KEY is not set in .env';
      return;
    }

    // Is the anon key usable at all? A plain read must not be refused by the key.
    const probe = await anon().from('clients').select('id').limit(1);
    if (probe.error !== null) {
      anonKeyProblem = looksLikeBadKey(probe.error.message)
        ? `SUPABASE_ANON_KEY is rejected by the Supabase API ("${probe.error.message}"). Every call with it fails before Postgres sees it, so the anon privilege checks below would prove nothing. Copy the current anon/publishable key from Supabase -> Project Settings -> API into .env.`
        : `the anon key could not read the clients table: ${probe.error.message}`;
      return;
    }

    // A throwaway dashboard user who belongs to that client.
    const email = `wa-priv-${h.tag}@example.test`;
    const password = `${randomBytes(24).toString('base64url')}Aa1!`;
    const { data: user, error: userError } = await h.supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (userError) throw new Error(`cannot create the privileges test user: ${userError.message}`);
    userId = user.user?.id as string;
    createdUserIds.push(userId);

    const { error: memberError } = await h.supabase.from('client_users').insert({ client_id: clientId, user_id: userId });
    if (memberError) throw new Error(`cannot add the test user to the client: ${memberError.message}`);

    // Sign in on the client we are going to KEEP. anon() builds a fresh client on
    // every call, so signing in on a throwaway one loses the session: `asUser`
    // would then be an unauthenticated client and every assertion in the
    // "authenticated dashboard user" block would silently run as the anon role
    // instead (which is refused by the very grants under test).
    const userClient = anon();
    const signedIn = await retry(6, 500, async () => {
      const attempt = await userClient.auth.signInWithPassword({ email, password });
      return !attempt.error;
    });
    if (!signedIn) {
      throw new Error('could not sign in as the privileges test user; check the Supabase auth rate limit in the dashboard');
    }
    // Guard against exactly the bug this file had: if the client is not signed
    // in as our dashboard user, the "authenticated" assertions below quietly run
    // as anon and report a permission failure that does not exist.
    const { data: sessionData } = await userClient.auth.getSession();
    if (sessionData.session?.user.id !== userId) {
      throw new Error('the test client is not signed in as the dashboard test user, so the authenticated checks would run as anon');
    }
    asUser = userClient;
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    for (const id of createdUserIds) await h.supabase.auth.admin.deleteUser(id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  describe('the anon key itself', () => {
    it(
      'is usable, otherwise the assertions below would be meaningless',
      anonTest(async () => {
        const probe = await anon().from('clients').select('id').limit(1);
        expect(probe.error, `the anon key is unusable: ${probe.error?.message ?? ''}`).toBeNull();
        expect(anonKeyProblem).toBeNull();
      }),
    );
  });

  describe('anon', () => {
    it('cannot call claim_due_job', anonTest(async () => {
      const { error, data } = await anon().rpc('claim_due_job');
      expect(error, 'anon was allowed to call claim_due_job').not.toBeNull();
      expect(looksLikeBadKey(error?.message ?? ''), 'the anon key itself was rejected, so this proves nothing').toBe(false);
      expect(looksLikePermissionDenial(error?.message ?? ''), `unexpected error: ${error?.message}`).toBe(true);
      expect(data ?? null).toBeNull();
    }));

    it('cannot call enqueue_reply_job', anonTest(async () => {
      const before = await jobCount();
      const { error } = await anon().rpc('enqueue_reply_job', { p_client: clientId, p_contact: ZERO_UUID, p_delay_seconds: 60 });
      expect(error, 'anon was allowed to call enqueue_reply_job').not.toBeNull();
      expect(looksLikePermissionDenial(error?.message ?? ''), `unexpected error: ${error?.message}`).toBe(true);

      // Counted for THIS client only: vitest runs files in parallel and other
      // suites have jobs of their own.
      expect(await jobCount()).toBe(before);
    }));

    it('cannot call client_stats', anonTest(async () => {
      const { error } = await anon().rpc('client_stats', { p_client: clientId, p_from: '2000-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z' });
      expect(error, 'anon was allowed to call client_stats').not.toBeNull();
      expect(looksLikePermissionDenial(error?.message ?? ''), `unexpected error: ${error?.message}`).toBe(true);
    }));

    it('cannot claim the queued job even with the correct arguments', anonTest(async () => {
      await enqueueReplyJob(h.supabase, clientId, (await contactId(1)).id, 0);

      const attempt = await anon().rpc('claim_due_job', { p_client_id: clientId });
      expect(attempt.error).not.toBeNull();
      expect(looksLikePermissionDenial(attempt.error?.message ?? '')).toBe(true);
      expect(attempt.data ?? null).toBeNull();

      // Still ours, so nothing was claimed behind our back.
      const stillQueued = await claimDueJob(h.supabase, clientId);
      expect(stillQueued).not.toBeNull();
    }));
  });

  describe('an authenticated dashboard user', () => {
    it('can call client_stats for their own client', anonTest(async () => {
      const { error } = await (asUser as SupabaseClient).rpc('client_stats', {
        p_client: clientId,
        p_from: '2000-01-01T00:00:00Z',
        p_to: '2100-01-01T00:00:00Z',
      });
      expect(error, 'a dashboard user could not read client_stats').toBeNull();
    }));

    it('cannot read another tenant through client_stats: the function is SECURITY INVOKER', anonTest(async () => {
      // Give this client no data of its own, and point it at a client it does not
      // belong to. RLS inside the function turns that into zeroes, not rows.
      const other = await h.supabase
        .from('clients')
        .insert({ business_name: `${NAMESPACE}other-${h.tag}`, phone_number_id: `${h.tag}-other` })
        .select('id')
        .single();
      createdClientIds.push((other.data as { id: string }).id);
      const otherId = (other.data as { id: string }).id;
      await h.supabase.from('contacts').insert({ client_id: otherId, phone: testPhone(h.tag, 3) });

      const { data, error } = await (asUser as SupabaseClient).rpc('client_stats', {
        p_client: otherId,
        p_from: '2000-01-01T00:00:00Z',
        p_to: '2100-01-01T00:00:00Z',
      });
      expect(error).toBeNull();
      expect(data?.[0]?.leads ?? 0).toBe(0);
      expect(data?.[0]?.bookings ?? 0).toBe(0);
    }));

    it('still cannot call claim_due_job', anonTest(async () => {
      const { error } = await (asUser as SupabaseClient).rpc('claim_due_job');
      expect(error, 'a signed-in dashboard user was allowed to call claim_due_job').not.toBeNull();
      expect(looksLikePermissionDenial(error?.message ?? ''), `unexpected error: ${error?.message}`).toBe(true);
    }));

    it('still cannot call enqueue_reply_job', anonTest(async () => {
      const { error } = await (asUser as SupabaseClient).rpc('enqueue_reply_job', { p_client: clientId, p_contact: ZERO_UUID, p_delay_seconds: 60 });
      expect(error, 'a signed-in dashboard user was allowed to call enqueue_reply_job').not.toBeNull();
    }));
  });

  describe('service_role', () => {
    it('can call client_stats', test(async () => {
      const stats = await getClientStats(h.supabase, clientId, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
      expect(stats).toBeDefined();
      expect(stats.bookings).toBeGreaterThanOrEqual(0);
    }));

    it('can call enqueue_reply_job and claim the job, including the global path', test(async () => {
      const contact = await contactId(2);
      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);

      const scoped = await claimDueJob(h.supabase, clientId);
      expect(scoped, 'the scoped claim returned nothing').not.toBeNull();
      expect(scoped?.client_id).toBe(clientId);

      await enqueueReplyJob(h.supabase, clientId, contact.id, 0);

      // The global queue is shared, so a parallel suite may claim our job first.
      // Keep claiming until this client's job turns up.
      let mine: { client_id: string } | null = null;
      for (let attempt = 0; attempt < 5 && mine === null; attempt += 1) {
        const job = await claimDueJob(h.supabase, null);
        if (job?.client_id === clientId) mine = job;
      }
      expect(mine, 'the global claim never returned this client\'s job').not.toBeNull();
    }));
  });

  /** Jobs belonging to THIS test client, so parallel suites do not skew the count. */
  const jobCount = async (): Promise<number> => {
    const { count, error } = await h.supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('client_id', clientId);
    expect(error, 'cannot count jobs').toBeNull();
    return count ?? 0;
  };

  /** A fresh contact in the test client. The phone must differ per call: (client_id,
   * phone) is unique, and two tests in this file each need their own contact. */
  const contactId = async (n: number): Promise<{ id: string }> => {
    const { data, error } = await h.supabase.from('contacts').insert({ client_id: clientId, phone: testPhone(h.tag, n) }).select('id').single();
    if (error) throw new Error(`cannot create a test contact ${n}: ${error.message}`);
    return data as { id: string };
  };
});