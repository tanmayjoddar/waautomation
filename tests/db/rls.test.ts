/**
 * Proves the acceptance criterion: user A cannot read or change user B's rows.
 *
 * This is the only test that needs SUPABASE_ANON_KEY. It creates two throwaway
 * Supabase Auth users, signs in as each one, and queries with the anon key so
 * that Postgres - not our code - decides what each user may see.
 *
 * If sign-in fails, the usual cause is the Supabase auth rate limit
 * (Dashboard -> Authentication -> Rate Limits) after many test runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '../../src/db/supabase.js';
import type { Booking, Client, Contact } from '../../src/db/types.js';
import { dbHarness, dbTest, deleteTestClient, retry, schemaReadiness, testPhone, type DbHarness } from './harness.js';

const ready = dbHarness();
const anonMissing =
  ready.ok && ready.harness.config.supabase.anonKey === null
    ? ' - SUPABASE_ANON_KEY is not set in .env (Part 2, account 2)'
    : '';
const suiteName = ready.ok
  ? `RLS: user A can never read or write user B's rows${anonMissing}`
  : `RLS (skipped: ${ready.reason})`;

type Fixture = {
  userAId: string;
  userBId: string;
  clientAId: string;
  clientBId: string;
  contactAId: string;
  contactBId: string;
  bookingAId: string;
  bookingBId: string;
};

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let asA: SupabaseClient | null = null;
  let asB: SupabaseClient | null = null;
  const fixture: Partial<Fixture> = {};
  const createdClientIds: string[] = [];

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  /** Creates a user, signs in as them, and returns a client bound to their JWT. */
  const signInAs = async (harness: DbHarness, label: string): Promise<{ id: string; client: SupabaseClient }> => {
    const { config } = harness;
    const email = `wa-rls-${label}-${harness.tag}@example.test`;
    // Random, generated per run: not a hardcoded credential anywhere.
    const password = `${randomBytes(24).toString('base64url')}Aa1!`;

    const { data, error } = await harness.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`cannot create the ${label} test user: ${error.message}`);
    const userId = data.user?.id as string;
    if (!userId) throw new Error(`no user id returned for the ${label} test user`);

    const anon = createClient(config.supabase.url, config.supabase.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // Auth propagation: the user may need a moment before sign-in succeeds.
    const ok = await retry(6, 500, async () => {
      const attempt = await anon.auth.signInWithPassword({ email, password });
      return !attempt.error;
    });
    if (!ok) {
      throw new Error(
        `could not sign in as the ${label} test user. If this keeps happening, check the Supabase auth rate limit (Dashboard -> Authentication -> Rate Limits); the project may also have "Confirm email" enabled.`,
      );
    }
    return { id: userId, client: anon };
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason) return;
    if (!h.config.supabase.anonKey) {
      skipReason =
        'SUPABASE_ANON_KEY is not set in .env (Part 2, account 2) - the RLS test needs the anon key to query as a logged-in user';
      return;
    }

    // Admin client, used only to create and delete the throwaway users.
    const admin = createServiceClient(h.config);

    const userA = await signInAs(h, 'a');
    const userB = await signInAs(h, 'b');
    asA = userA.client;
    asB = userB.client;
    fixture.userAId = userA.id;
    fixture.userBId = userB.id;

    // Two tenants, one owner each.
    const { data: clientA, error: clientAError } = await admin
      .from('clients')
      .insert({ business_name: `RLS A ${h.tag}`, phone_number_id: `${h.tag}-a` })
      .select('*')
      .single();
    expect(clientAError).toBeNull();
    const { data: clientB, error: clientBError } = await admin
      .from('clients')
      .insert({ business_name: `RLS B ${h.tag}`, phone_number_id: `${h.tag}-b` })
      .select('*')
      .single();
    expect(clientBError).toBeNull();
    const clientAId = (clientA as Client).id;
    const clientBId = (clientB as Client).id;
    fixture.clientAId = clientAId;
    fixture.clientBId = clientBId;
    createdClientIds.push(clientAId, clientBId);

    const { error: membershipError } = await admin.from('client_users').insert([
      { user_id: fixture.userAId, client_id: fixture.clientAId },
      { user_id: fixture.userBId, client_id: fixture.clientBId },
    ]);
    expect(membershipError, 'cannot create the client_users rows').toBeNull();

    const { data: contactA } = await admin
      .from('contacts')
      .insert({ client_id: fixture.clientAId, phone: testPhone(h.tag, 1), name: 'A customer' })
      .select('*')
      .single();
    const { data: contactB } = await admin
      .from('contacts')
      .insert({ client_id: fixture.clientBId, phone: testPhone(h.tag, 2), name: 'B customer' })
      .select('*')
      .single();
    fixture.contactAId = (contactA as Contact).id;
    fixture.contactBId = (contactB as Contact).id;

    const slotStart = new Date(Date.now() + 86_400_000).toISOString();
    const slotEnd = new Date(Date.now() + 87_600_000).toISOString();
    const { data: bookingA } = await admin
      .from('bookings')
      .insert({
        client_id: fixture.clientAId,
        contact_id: fixture.contactAId,
        service: 'A service',
        slot_start: slotStart,
        slot_end: slotEnd,
        status: 'pending',
      })
      .select('*')
      .single();
    const { data: bookingB } = await admin
      .from('bookings')
      .insert({
        client_id: fixture.clientBId,
        contact_id: fixture.contactBId,
        service: 'B service',
        slot_start: slotStart,
        slot_end: slotEnd,
        status: 'pending',
      })
      .select('*')
      .single();
    fixture.bookingAId = (bookingA as Booking).id;
    fixture.bookingBId = (bookingB as Booking).id;

    // One knowledge row each, so the tenant_select policies are covered too.
    await admin.from('knowledge').insert([
      { client_id: fixture.clientAId, kind: 'faq', title: 'A only', content: 'secret A' },
      { client_id: fixture.clientBId, kind: 'faq', title: 'B only', content: 'secret B' },
    ]);
  });

  afterAll(async () => {
    if (!ready.ok) return;
    if (fixture.userAId) await h.supabase.auth.admin.deleteUser(fixture.userAId).catch(() => undefined);
    if (fixture.userBId) await h.supabase.auth.admin.deleteUser(fixture.userBId).catch(() => undefined);
    if (skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
  });

  // ==========================================================================
  it(
    'A sees their own client and cannot see B s',
    test(async () => {
      const { data, error } = await (asA as SupabaseClient).from('clients').select('*');
      expect(error).toBeNull();
      const rows = data as Client[];
      expect(rows.map((r) => r.id)).toEqual([fixture.clientAId]);
      expect(rows.every((r) => r.business_name.startsWith('RLS A'))).toBe(true);
    }),
  );

  it(
    'B sees their own client and cannot see A s',
    test(async () => {
      const { data, error } = await (asB as SupabaseClient).from('clients').select('*');
      expect(error).toBeNull();
      expect((data as Client[]).map((r) => r.id)).toEqual([fixture.clientBId]);
    }),
  );

  it(
    'A cannot see B s contacts, B cannot see A s',
    test(async () => {
      const { data: aSees } = await (asA as SupabaseClient).from('contacts').select('*');
      expect((aSees as Contact[]).map((c) => c.id)).toEqual([fixture.contactAId]);

      const { data: bSees } = await (asB as SupabaseClient).from('contacts').select('*');
      expect((bSees as Contact[]).map((c) => c.id)).toEqual([fixture.contactBId]);
    }),
  );

  it(
    'A cannot see B s bookings, B cannot see A s',
    test(async () => {
      const { data: aSees } = await (asA as SupabaseClient).from('bookings').select('*');
      expect((aSees as Booking[]).map((b) => b.id)).toEqual([fixture.bookingAId]);

      const { data: bSees } = await (asB as SupabaseClient).from('bookings').select('*');
      expect((bSees as Booking[]).map((b) => b.id)).toEqual([fixture.bookingBId]);
    }),
  );

  it(
    'A cannot see B s knowledge base',
    test(async () => {
      const { data } = await (asA as SupabaseClient).from('knowledge').select('*');
      const rows = (data ?? []) as { title: string }[];
      expect(rows.map((r) => r.title)).toEqual(['A only']);
    }),
  );

  it(
    'A cannot read the sheet_outbox at all (server-only table)',
    test(async () => {
      const { data, error } = await (asA as SupabaseClient).from('sheet_outbox').select('*');
      expect(error, 'RLS with no policy returns rows, not an error').toBeNull();
      expect(data ?? []).toEqual([]);
    }),
  );

  it(
    'A cannot change B s booking status',
    test(async () => {
      const { data, error } = await (asA as SupabaseClient)
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', fixture.bookingBId as string)
        .select();
      expect(error).toBeNull();
      expect(data ?? [], 'the update must match no rows').toEqual([]);

      const { data: check } = await h.supabase
        .from('bookings')
        .select('status')
        .eq('id', fixture.bookingBId as string)
        .single();
      expect((check as { status: string }).status).toBe('pending');
    }),
  );

  it(
    'A cannot move their own contact to B s client',
    test(async () => {
      const { error } = await (asA as SupabaseClient)
        .from('contacts')
        .update({ client_id: fixture.clientBId as string })
        .eq('id', fixture.contactAId as string);
      expect(error, 'the with check policy must reject this').not.toBeNull();

      const { data: check } = await h.supabase
        .from('contacts')
        .select('client_id')
        .eq('id', fixture.contactAId as string)
        .single();
      expect((check as { client_id: string }).client_id).toBe(fixture.clientAId);
    }),
  );

  it(
    'A CAN take over their own contact (the dashboard feature must keep working)',
    test(async () => {
      const { data, error } = await (asA as SupabaseClient)
        .from('contacts')
        .update({ bot_paused: true })
        .eq('id', fixture.contactAId as string)
        .select();
      expect(error).toBeNull();
      expect(data, 'their own row must be updatable').toHaveLength(1);
    }),
  );

  it(
    'the service role (the server) still sees both tenants',
    test(async () => {
      const { data } = await h.supabase
        .from('clients')
        .select('id')
        .in('id', [fixture.clientAId as string, fixture.clientBId as string]);
      expect((data ?? []) as unknown[]).toHaveLength(2);
    }),
  );

  it(
    'an anonymous visitor sees nothing',
    test(async () => {
      const anon = createClient(h.config.supabase.url, h.config.supabase.anonKey as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.from('contacts').select('*');
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    }),
  );
});
