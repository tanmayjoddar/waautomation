/**
 * Slice 4 queue tests against a real Supabase project (migration 003).
 *
 * Proves the claim guard (never two running jobs for one contact, even under
 * concurrency), started_at, and the stale reaper, plus the re-asserted grants.
 * Isolated `wa-test-queue-*` tenants, deleted in afterAll. Skips loudly
 * without 003_worker.sql.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimDueJob, enqueueReplyJob, requeueStaleJobs } from '../../src/db/supabase.js';
import type { Job } from '../../src/db/types.js';
import {
  dbHarness,
  dbTest,
  deleteTestClient,
  purgeAbandonedTestTenants,
  schemaReadiness,
  testPhone,
  TEST_CLIENT_PREFIX,
  type DbHarness,
} from './harness.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const NAMESPACE = `${TEST_CLIENT_PREFIX}queue-`;

const ready = dbHarness();
const suiteName = ready.ok ? 'worker queue (live database, migration 003)' : `worker queue (skipped: ${ready.reason})`;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = '';
  const createdClientIds: string[] = [];
  let n = 100;

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  const anon = (): SupabaseClient | null => {
    if (!h.config.supabase.anonKey) return null;
    return createClient(h.config.supabase.url, h.config.supabase.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  };

  const newContact = async (): Promise<string> => {
    n += 1;
    const { data, error } = await h.supabase
      .from('contacts')
      .insert({ client_id: clientId, phone: testPhone(h.tag, n) })
      .select('id')
      .single();
    expect(error, 'cannot create a queue test contact').toBeNull();
    return (data as { id: string }).id;
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, { requireWorkerQueue: true });
    if (skipReason !== null) return;
    const { data, error } = await h.supabase
      .from('clients')
      .insert({ business_name: `${NAMESPACE}${h.tag}`, phone_number_id: `${h.tag}-queue` })
      .select('id')
      .single();
    expect(error, 'cannot create a queue test client').toBeNull();
    clientId = (data as { id: string }).id;
    createdClientIds.push(clientId);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it('claims set started_at', test(async () => {
    const contact = await newContact();
    await enqueueReplyJob(h.supabase, clientId, contact, -5);
    const job = await claimDueJob(h.supabase, clientId);
    expect(job?.status).toBe('running');
    expect(job?.started_at).toBeTruthy();
    expect(job?.attempts).toBe(1);
  }));

  it('a contact with a running job cannot be claimed again until it finishes', test(async () => {
    const contact = await newContact();
    await enqueueReplyJob(h.supabase, clientId, contact, -5);
    const first = await claimDueJob(h.supabase, clientId);
    expect(first).not.toBeNull();

    // A new inbound while the first job runs: a second pending job appears...
    await enqueueReplyJob(h.supabase, clientId, contact, -5);
    // ...but the guard refuses to hand it out while the first is running.
    expect(await claimDueJob(h.supabase, clientId)).toBeNull();

    await h.supabase.from('jobs').update({ status: 'done' }).eq('id', (first as Job).id);
    const second = await claimDueJob(h.supabase, clientId);
    expect(second, 'the pending job is claimable once nothing runs').not.toBeNull();
  }));

  it('concurrent claims for a busy contact hand out nothing', test(async () => {
    const contact = await newContact();
    await enqueueReplyJob(h.supabase, clientId, contact, -5);
    const first = await claimDueJob(h.supabase, clientId);
    expect(first, 'setup claim must win').not.toBeNull();
    // A new inbound while the first job runs: the second pending job appears
    // (the debounce index only forbids two PENDING rows, and none is pending).
    await enqueueReplyJob(h.supabase, clientId, contact, -5);

    // Six racers, one busy contact: the guard must refuse every one of them,
    // even when their snapshots all predate each other's commits.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimDueJob(h.supabase, clientId)),
    );
    expect(results.filter((j) => j !== null)).toHaveLength(0);

    const { data } = await h.supabase.from('jobs').select('status').eq('contact_id', contact);
    expect((data ?? []).map((r) => (r as { status: string }).status).sort()).toEqual(['pending', 'running']);
  }));

  it('requeue_stale_jobs revives retries and fails the exhausted', test(async () => {
    const contact = await newContact();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: retriable } = await h.supabase
      .from('jobs')
      .insert({ client_id: clientId, contact_id: contact, run_at: old, status: 'running', attempts: 1, started_at: old })
      .select('id')
      .single();
    const { data: exhausted } = await h.supabase
      .from('jobs')
      .insert({ client_id: clientId, contact_id: contact, run_at: old, status: 'running', attempts: 3, started_at: old })
      .select('id')
      .single();

    expect(await requeueStaleJobs(h.supabase, 5)).toBe(2);

    const { data: rows } = await h.supabase.from('jobs').select('id,status,started_at,last_error').in('id', [(retriable as { id: string }).id, (exhausted as { id: string }).id]);
    const byId = new Map((rows ?? []).map((r) => [(r as { id: string }).id, r]));
    expect((byId.get((retriable as { id: string }).id) as { status: string }).status).toBe('pending');
    expect((byId.get((retriable as { id: string }).id) as { started_at: string | null }).started_at).toBeNull();
    const failedRow = byId.get((exhausted as { id: string }).id) as { status: string; last_error: string };
    expect(failedRow.status).toBe('failed');
    expect(failedRow.last_error).toContain('stale worker');

    // A fresh running job is untouched.
    await enqueueReplyJob(h.supabase, clientId, contact, -5);
    await claimDueJob(h.supabase, clientId);
    expect(await requeueStaleJobs(h.supabase, 5)).toBe(0);
  }));

  it('anon cannot call requeue_stale_jobs', test(async () => {
    const client = anon();
    if (client === null) return;
    const { error } = await client.rpc('requeue_stale_jobs', { p_minutes: 5 });
    expect(error, 'anon was allowed to call requeue_stale_jobs').not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not allowed|42501/i);
  }));

  it('anon cannot call claim_due_job either (003 re-asserted the grants)', test(async () => {
    const client = anon();
    if (client === null) return;
    const { error } = await client.rpc('claim_due_job', { p_client_id: clientId });
    expect(error, 'anon was allowed to call claim_due_job').not.toBeNull();
  }));
});
