/**
 * Seeds the demo tenant: 1 client, 1 settings row, 5 knowledge rows.
 *
 *   npm run seed
 *
 * Reads your local .env. It never prints a secret, and it is safe to run again:
 * the demo client is found by business_name and updated, the knowledge rows are
 * matched on (client_id, kind, title).
 *
 * The knowledge rows are PLACEHOLDERS. The AI is only allowed to answer from the
 * knowledge base, so leaving demo text in place makes it obvious that the answer
 * is not real yet. Replace them with the client's own words before going live.
 */
import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EnvError, loadEnvFromFile } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createServiceClient } from '../src/db/supabase.js';
import type { Client, Knowledge, KnowledgeKind, Settings } from '../src/db/types.js';

const DEMO_BUSINESS_NAME = 'Demo Business';

const DEMO_KNOWLEDGE: { kind: KnowledgeKind; title: string; content: string }[] = [
  {
    kind: 'price',
    title: 'Price list (PLACEHOLDER - replace before going live)',
    content:
      'NOT SET. Do not quote any price until this row is replaced with the real price list. ' +
      'If a customer asks for a price and this row is still a placeholder, say the team will confirm the price shortly.',
  },
  {
    kind: 'timing',
    title: 'Opening hours (PLACEHOLDER - confirm with the business)',
    content:
      'NOT SET. The default opening hours in the settings row are Mon-Fri 10:00-19:00 and Sat 10:00-14:00, closed Sunday. ' +
      'Replace this row with the real hours. Appointments are 30 minutes long by default.',
  },
  {
    kind: 'address',
    title: 'Address (PLACEHOLDER - replace before going live)',
    content:
      'NOT SET. Do not give directions until this row holds the real address. ' +
      'If asked, say the team will share the location shortly.',
  },
  {
    kind: 'faq',
    title: 'Frequently asked questions (PLACEHOLDER)',
    content:
      'NOT SET. Questions the business expects: what services are offered, how to pay, whether a walk-in is allowed, ' +
      'how to reschedule, and whether a home visit is possible. Add the real answers here.',
  },
  {
    kind: 'policy',
    title: 'Policies (PLACEHOLDER)',
    content:
      'NOT SET. Typical policies to record: cancellation and reschedule notice, late arrival, refunds, and that ' +
      'no medical, legal or financial advice is given over WhatsApp.',
  },
];

export type SeedResult = {
  client: Client;
  settingsRow: boolean;
  knowledgeInserted: number;
  knowledgeUpdated: number;
};

/** Exported so the seed test can call it with its own client. */
export async function seedDemoTenant(
  supabase: SupabaseClient,
  options: { businessName?: string; phoneNumberId?: string | null } = {},
): Promise<SeedResult> {
  const businessName = options.businessName ?? DEMO_BUSINESS_NAME;
  const phoneNumberId = options.phoneNumberId ?? null;

  // 1. the client. `business_name` identifies the demo tenant so re-running does
  //    not create a second one when WA_PHONE_NUMBER_ID arrives later.
  const { data: foundRows, error: findError } = await supabase
    .from('clients')
    .select('*')
    .eq('business_name', businessName)
    .limit(1);
  if (findError) throw new Error(`seed: cannot read clients: ${findError.message}`);

  const existing = (foundRows?.[0] as Client | undefined) ?? null;
  let client: Client;

  if (existing) {
    const { data, error } = await supabase
      .from('clients')
      .update(phoneNumberId ? { phone_number_id: phoneNumberId } : {})
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw new Error(`seed: cannot update client: ${error.message}`);
    client = data as Client;
  } else {
    const { data, error } = await supabase
      .from('clients')
      .insert({ business_name: businessName, phone_number_id: phoneNumberId })
      .select('*')
      .single();
    if (error) throw new Error(`seed: cannot insert client: ${error.message}`);
    client = data as Client;
  }

  // 2. settings: one row per client, primary key is client_id.
  const { error: settingsError } = await supabase.from('settings').upsert(
    { client_id: client.id },
    { onConflict: 'client_id', ignoreDuplicates: true },
  );
  if (settingsError) throw new Error(`seed: cannot upsert settings: ${settingsError.message}`);
  const { data: settingsRows, error: settingsReadError } = await supabase
    .from('settings')
    .select('*')
    .eq('client_id', client.id);
  if (settingsReadError) throw new Error(`seed: cannot read settings: ${settingsReadError.message}`);
  const settings = (settingsRows?.[0] ?? null) as Settings | null;

  // 3. knowledge: matched on (client_id, kind, title) so re-running updates in
  //    place instead of growing a duplicate pile.
  let inserted = 0;
  let updated = 0;
  for (const row of DEMO_KNOWLEDGE) {
    const { data: existingRows, error: findKnowledgeError } = await supabase
      .from('knowledge')
      .select('id')
      .eq('client_id', client.id)
      .eq('kind', row.kind)
      .eq('title', row.title)
      .limit(1);
    if (findKnowledgeError) throw new Error(`seed: cannot read knowledge: ${findKnowledgeError.message}`);

    const existingKnowledgeId = (existingRows?.[0] as Pick<Knowledge, 'id'> | undefined)?.id;
    if (existingKnowledgeId) {
      const { error } = await supabase
        .from('knowledge')
        .update({ content: row.content })
        .eq('id', existingKnowledgeId)
        .eq('client_id', client.id);
      if (error) throw new Error(`seed: cannot update knowledge: ${error.message}`);
      updated += 1;
    } else {
      const { error } = await supabase
        .from('knowledge')
        .insert({ client_id: client.id, kind: row.kind, title: row.title, content: row.content });
      if (error) throw new Error(`seed: cannot insert knowledge: ${error.message}`);
      inserted += 1;
    }
  }

  return { client, settingsRow: settings !== null, knowledgeInserted: inserted, knowledgeUpdated: updated };
}

/** Reads .env and runs. Exported so the seed test can reuse it. */
export async function runSeed(): Promise<SeedResult> {
  const config = loadEnvFromFile();
  const logger = createLogger({ level: config.logLevel });
  const supabase = createServiceClient(config);

  const phoneNumberId = config.whatsappDemo?.phoneNumberId ?? null;
  if (!phoneNumberId) {
    logger.warn(
      'WA_PHONE_NUMBER_ID is not set: the demo client is created without one, so the webhook cannot route to it yet. Set it in .env and re-run npm run seed.',
    );
  }

  const result = await seedDemoTenant(supabase, { phoneNumberId });
  logger.info(
    {
      client_id: result.client.id,
      business_name: result.client.business_name,
      phone_number_id: result.client.phone_number_id,
      settings: result.settingsRow,
      knowledge_inserted: result.knowledgeInserted,
      knowledge_updated: result.knowledgeUpdated,
    },
    'seed done',
  );
  return result;
}

// Only run when executed directly, not when imported by a test.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runSeed().catch((err: unknown) => {
    if (err instanceof EnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
