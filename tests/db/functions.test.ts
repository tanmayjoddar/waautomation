/**
 * The three SQL functions the app depends on, tested against a real project.
 *
 * Skips itself when .env has no Supabase project, when NODE_ENV=production, or
 * when the migration has not been applied yet. The skip reason is printed by
 * vitest, so a skip is never silent.
 *
 * Every row created here belongs to a throwaway client and is deleted again in
 * afterAll. The demo tenant is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Contact } from '../../src/db/types.js';
import { claimDueJob, enqueueReplyJob, getClientStats } from '../../src/db/supabase.js';
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  schemaReadiness,
  purgeAbandonedTestTenants,
  testPhone,
  TEST_CLIENT_PREFIX,
  type DbHarness,
} from './harness.js';

const ready = dbHarness();
const suiteName = ready.ok
  ? 'SQL functions: client_stats, enqueue_reply_job, claim_due_job'
  : `SQL functions (skipped: ${ready.reason})`;

const past = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const future = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  /** created in beforeAll, removed in afterAll */
  const createdClientIds: string[] = [];
  let contactId = '';

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  const newClient = async (harness: DbHarness, label: string): Promise<string> => {
    const { data, error } = await harness.supabase
      .from('clients')
      .insert({
        business_name: `${TEST_CLIENT_PREFIX}fns-${label}-${harness.tag}`,
        phone_number_id: `${harness.tag}-${label}`,
      })
      .select('*')
      .single();
    expect(error, `cannot create the ${label} test client`).toBeNull();
    createdClientIds.push((data as { id: string }).id);
    return (data as { id: string }).id;
  };

  const newContact = async (harness: DbHarness, client: string, n: number): Promise<string> => {
    const { data, error } = await harness.supabase
      .from('contacts')
      .insert({ client_id: client, phone: testPhone(harness.tag, n) })
      .select('*')
      .single();
    expect(error, 'cannot create a test contact').toBeNull();
    return (data as Contact).id;
  };

  const addBooking = async (harness: DbHarness, client: string, contact: string, status: string) => {
    const base = Date.now() + 86_400_000;
    const { error } = await harness.supabase.from('bookings').insert({
      client_id: client,
      contact_id: contact,
      service: 'test service',
      slot_start: new Date(base).toISOString(),
      slot_end: new Date(base + 1_800_000).toISOString(),
      status,
    });
    expect(error, `cannot insert a ${status} booking`).toBeNull();
  };

  const clearJobs = async (harness: DbHarness, client: string): Promise<void> => {
    await harness.supabase.from('jobs').delete().eq('client_id', client);
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason !== null) return;
    // A run that died mid-suite leaves due jobs behind, which would make
    // "returns null when nothing is due" fail for reasons that have nothing to
    // do with this run. Cascading a client delete takes its jobs with it.
    const purged = await purgeAbandonedTestTenants(h.supabase, `${TEST_CLIENT_PREFIX}fns-`);
    if (purged > 0) console.log(`purged ${purged} test tenant(s) left by an earlier run`);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
  });

  // ==========================================================================
  // client_stats
  // ==========================================================================
  it(
    'client_stats: exactly one row of zeros when the period has no bookings',
    test(async (harness) => {
      const clientId = await newClient(harness, 'zero');
      const { supabase } = harness;
      await newContact(harness, clientId, 1); // one lead, zero bookings

      const stats = await getClientStats(supabase, clientId, past(1), future(1));
      expect(stats).toEqual({
        leads: 1,
        bookings: 0,
        confirmed: 0,
        pending: 0,
        cancelled: 0,
        reschedule_requested: 0,
        no_show: 0,
      });
    }),
  );

  it(
    'client_stats: a whole row of zeros for a client with no data at all',
    test(async (harness) => {
      const clientId = await newClient(harness, 'blank');
      const stats = await getClientStats(harness.supabase, clientId, past(1), future(1));
      expect(stats).toEqual({
        leads: 0,
        bookings: 0,
        confirmed: 0,
        pending: 0,
        cancelled: 0,
        reschedule_requested: 0,
        no_show: 0,
      });
    }),
  );

  it(
    'client_stats: a period in the past counts nothing',
    test(async (harness) => {
      const clientId = await newClient(harness, 'past');
      const contact = await newContact(harness, clientId, 1);
      await addBooking(harness, clientId, contact, 'confirmed');

      const stats = await getClientStats(harness.supabase, clientId, past(30), past(20));
      expect(stats.leads).toBe(0);
      expect(stats.bookings).toBe(0);
    }),
  );

  it(
    'client_stats: counts each booking status separately and they add up',
    test(async (harness) => {
      const clientId = await newClient(harness, 'statuses');
      const contact = await newContact(harness, clientId, 1);
      for (const status of ['confirmed', 'pending', 'cancelled', 'reschedule_requested', 'no_show']) {
        await addBooking(harness, clientId, contact, status);
      }

      const stats = await getClientStats(harness.supabase, clientId, past(1), future(1));
      expect(stats.bookings).toBe(5);
      expect(stats.confirmed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.reschedule_requested).toBe(1);
      expect(stats.no_show).toBe(1);
      expect(
        stats.confirmed + stats.pending + stats.cancelled + stats.reschedule_requested + stats.no_show,
      ).toBe(stats.bookings);
    }),
  );

  it(
    'client_stats: never counts another tenant\'s leads or bookings',
    test(async (harness) => {
      const mine = await newClient(harness, 'tenant-a');
      const theirs = await newClient(harness, 'tenant-b');
      const myContact = await newContact(harness, mine, 1);
      const theirContact = await newContact(harness, theirs, 1);
      await addBooking(harness, theirs, theirContact, 'confirmed');
      await addBooking(harness, theirs, theirContact, 'confirmed');

      const myStats = await getClientStats(harness.supabase, mine, past(1), future(1));
      expect(myStats.leads, "only my own contact").toBe(1);
      expect(myStats.bookings, "the other tenant's bookings must not leak in").toBe(0);
      expect(myStats.confirmed).toBe(0);

      const theirStats = await getClientStats(harness.supabase, theirs, past(1), future(1));
      expect(theirStats.bookings).toBe(2);
    }),
  );

  // ==========================================================================
  // enqueue_reply_job (the debounce)
  // ==========================================================================
  it(
    'enqueue_reply_job: two calls for one contact leave ONE pending job with the later run_at',
    test(async (harness) => {
      const clientId = await newClient(harness, 'debounce');
      const contact = await newContact(harness, clientId, 1);

      await enqueueReplyJob(harness.supabase, clientId, contact, 3);
      const { data: afterFirst } = await harness.supabase
        .from('jobs')
        .select('id')
        .eq('contact_id', contact)
        .eq('status', 'pending');
      expect(afterFirst, 'the first call must create a job').toHaveLength(1);

      await sleep(1100); // make sure the two run_at values cannot be identical
      await enqueueReplyJob(harness.supabase, clientId, contact, 30);

      const { data: rows } = await harness.supabase
        .from('jobs')
        .select('run_at')
        .eq('contact_id', contact)
        .eq('status', 'pending');
      expect(rows, 'the burst must collapse into a single pending job').toHaveLength(1);

      const secondsOut = (Date.parse((rows as { run_at: string }[])[0]!.run_at) - Date.now()) / 1000;
      expect(secondsOut, 'run_at must carry the LATER delay (30s), not the first (3s)').toBeGreaterThan(25);
      expect(secondsOut).toBeLessThan(35);
    }),
  );

  it(
    'enqueue_reply_job: a job already claimed is not reused, a new pending one is created',
    test(async (harness) => {
      const clientId = await newClient(harness, 'requeue');
      const contact = await newContact(harness, clientId, 1);

      await enqueueReplyJob(harness.supabase, clientId, contact, 1);
      const claimed = await claimDueJob(harness.supabase, clientId);
      expect(claimed?.id, 'the due job must be claimable').toBeTruthy();

      await enqueueReplyJob(harness.supabase, clientId, contact, 60);

      const { data: rows } = await harness.supabase
        .from('jobs')
        .select('status')
        .eq('contact_id', contact)
        .order('status');
      expect((rows ?? []).map((r) => (r as { status: string }).status), 'running + new pending').toEqual([
        'pending',
        'running',
      ]);
    }),
  );

  // ==========================================================================
  // claim_due_job
  // ==========================================================================
  it(
    'claim_due_job: returns null when nothing is due',
    test(async (harness) => {
      const clientId = await newClient(harness, 'nodue');
      const contact = await newContact(harness, clientId, 1);
      await enqueueReplyJob(harness.supabase, clientId, contact, 3600); // due in 1 hour
      expect(await claimDueJob(harness.supabase, clientId), 'a future job must not be claimed').toBeNull();
    }),
  );

  it(
    'claim_due_job: claims a due job once, marks it running and increments attempts',
    test(async (harness) => {
      const clientId = await newClient(harness, 'claim');
      const contact = await newContact(harness, clientId, 1);
      await enqueueReplyJob(harness.supabase, clientId, contact, -5); // already due

      const claimed = await claimDueJob(harness.supabase, clientId);
      expect(claimed, 'a due job must be claimed').not.toBeNull();
      expect(claimed?.client_id).toBe(clientId);
      expect(claimed?.contact_id).toBe(contact);
      expect(claimed?.status).toBe('running');
      expect(claimed?.attempts).toBe(1);

      const { data: rows } = await harness.supabase
        .from('jobs')
        .select('status,attempts')
        .eq('id', claimed?.id as string);
      expect((rows as unknown as { status: string; attempts: number }[])[0]).toMatchObject({
        status: 'running',
        attempts: 1,
      });

      expect(await claimDueJob(harness.supabase, clientId), 'no second claim of the same job').toBeNull();
    }),
  );

  it(
    'claim_due_job: two simultaneous claims of one job - only one wins (SKIP LOCKED)',
    test(async (harness) => {
      const clientId = await newClient(harness, 'race-one');
      const contact = await newContact(harness, clientId, 1);
      await enqueueReplyJob(harness.supabase, clientId, contact, -5);

      const results = await Promise.all([claimDueJob(harness.supabase, clientId), claimDueJob(harness.supabase, clientId)]);
      const winners = results.filter((job) => job !== null);
      expect(winners, 'exactly one of two concurrent claims may win').toHaveLength(1);
      expect(winners[0]?.attempts, 'the job must be attempted exactly once').toBe(1);

      const { data: rows } = await harness.supabase
        .from('jobs')
        .select('status,attempts')
        .eq('contact_id', contact);
      expect(rows, 'the job must exist exactly once, still running').toHaveLength(1);
      expect((rows as unknown as { status: string; attempts: number }[])[0]).toMatchObject({
        status: 'running',
        attempts: 1,
      });
    }),
  );

  it(
    'claim_due_job: n simultaneous claims of n due jobs - every job is handed out once',
    test(async (harness) => {
      const clientId = await newClient(harness, 'race-many');
      const n = 6;
      for (let i = 0; i < n; i += 1) {
        const contact = await newContact(harness, clientId, 200 + i);
        await enqueueReplyJob(harness.supabase, clientId, contact, -5);
      }

      const claims = await Promise.all(Array.from({ length: n }, () => claimDueJob(harness.supabase, clientId)));
      const ids = claims.filter((job) => job !== null).map((job) => job?.id as string);
      expect(ids, 'every job claimed').toHaveLength(n);
      expect(new Set(ids).size, 'no job handed to two workers').toBe(n);
      expect(claims.every((job) => job?.client_id === clientId), 'no cross-tenant claim').toBe(true);
    }),
  );

  it(
    'clearJobs helper is only used by tests: the queue is empty for the next run',
    test(async (harness) => {
      const clientId = await newClient(harness, 'clean');
      await clearJobs(harness, clientId);
      const { data } = await harness.supabase.from('jobs').select('id').eq('client_id', clientId);
      expect(data ?? []).toHaveLength(0);
    }),
  );
});
