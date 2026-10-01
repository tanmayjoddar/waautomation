/**
 * The seed script must be safe to run twice and must scope everything to the
 * demo client. Run `npm run seed` yourself before this test passes: the test
 * runs the same function and then checks the result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemoTenant } from '../../scripts/seed.js';
import type { Client, Knowledge, Settings } from '../../src/db/types.js';
import { dbHarness, dbTest, purgeAbandonedTestTenants, schemaReadiness, TEST_CLIENT_PREFIX, type DbHarness } from './harness.js';

const ready = dbHarness();
const suiteName = ready.ok
  ? 'seed: one demo client, one settings row, five knowledge rows'
  : `seed (skipped: ${ready.reason})`;

/** Unique name so a test run never disturbs a real demo client. */
const TEST_NAMESPACE = `${TEST_CLIENT_PREFIX}seed-`;
const TEST_BUSINESS_NAME = TEST_NAMESPACE;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = '';

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason !== null) return;
    // Remove any tenant a crashed earlier run left behind, so "running the seed
    // again creates no duplicates" really does test a fresh start.
    await purgeAbandonedTestTenants(h.supabase, TEST_NAMESPACE);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null || !clientId) return;
    await h.supabase.from('clients').delete().eq('id', clientId);
  });

  it(
    'creates the client, the settings row and five knowledge rows',
    test(async (harness) => {
      const result = await seedDemoTenant(harness.supabase, {
        businessName: TEST_BUSINESS_NAME,
        phoneNumberId: `${harness.tag}-seed`,
      });
      clientId = result.client.id;

      expect(result.client.business_name).toBe(TEST_BUSINESS_NAME);
      expect(result.settingsRow).toBe(true);
      expect(result.knowledgeInserted).toBe(5);
      expect(result.knowledgeUpdated).toBe(0);

      const { data: settings } = await harness.supabase
        .from('settings')
        .select('*')
        .eq('client_id', clientId);
      expect(settings, 'exactly one settings row per client').toHaveLength(1);
      const settingsRow = (settings as Settings[])[0] as Settings;
      expect(settingsRow.slot_minutes).toBe(30);
      expect(settingsRow.voice_replies_enabled).toBe(false);
      expect(settingsRow.confirm_template).toBe('booking_confirmation');
      expect(settingsRow.reminder_template).toBe('appointment_reminder');
      expect(settingsRow.sheet_bookings_tab).toBe('Bookings');
      expect(settingsRow.sheet_leads_tab).toBe('Leads');
    }),
  );

  it(
    'every knowledge row belongs to that client and covers a different kind',
    test(async (harness) => {
      const { data, error } = await harness.supabase
        .from('knowledge')
        .select('*')
        .eq('client_id', clientId);
      expect(error).toBeNull();
      const rows = data as Knowledge[];
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.kind))).toEqual(
        new Set(['price', 'timing', 'address', 'faq', 'policy']),
      );
      expect(rows.every((r) => r.client_id === clientId), 'scoped by client_id').toBe(true);
      expect(
        rows.every((r) => r.content.length > 0 && r.title.length > 0),
        'the AI must never read an empty knowledge row',
      ).toBe(true);
    }),
  );

  it(
    'running the seed again updates in place and creates no duplicates',
    test(async (harness) => {
      const again = await seedDemoTenant(harness.supabase, {
        businessName: TEST_BUSINESS_NAME,
        phoneNumberId: `${harness.tag}-seed`,
      });
      expect(again.client.id, 'the same client must be found again').toBe(clientId);
      expect(again.knowledgeInserted, 'nothing new the second time').toBe(0);
      expect(again.knowledgeUpdated, 'the five rows are updated in place').toBe(5);

      const { count: clientCount } = await harness.supabase
        .from('clients')
        .select('*', { count: 'exact', head: true })
        .eq('business_name', TEST_BUSINESS_NAME);
      expect(clientCount, 'no second demo client').toBe(1);

      const { count: knowledgeCount } = await harness.supabase
        .from('knowledge')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId);
      expect(knowledgeCount, 'still five knowledge rows').toBe(5);
    }),
  );

  it(
    'the placeholder text is explicit, so the AI cannot invent facts from it',
    test(async (harness) => {
      const { data } = await harness.supabase.from('knowledge').select('*').eq('client_id', clientId);
      const rows = data as Knowledge[];
      const price = rows.find((r) => r.kind === 'price');
      expect(price, 'a price row must exist').toBeTruthy();
      expect(price?.content, 'demo content must shout that it is not real').toContain('NOT SET');
    }),
  );

  it(
    'the seeded client row is readable by the service role and has a phone number id',
    test(async (harness) => {
      const { data } = await harness.supabase
        .from('clients')
        .select('*')
        .eq('id', clientId)
        .single();
      const client = data as Client;
      expect(client.phone_number_id).toBe(`${h.tag}-seed`);
      expect(client.default_language).toBe('hinglish');
      expect(client.timezone).toBe('Asia/Kolkata');
      expect(client.active).toBe(true);
    }),
  );
});
