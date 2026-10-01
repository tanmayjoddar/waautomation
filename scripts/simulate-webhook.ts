/**
 * Sends signed sample webhook deliveries to a running server (spec 1.6 step 8).
 *
 *   npm run simulate:webhook                 # all samples against localhost:3000
 *   npm run simulate:webhook -- --url https://my-host/webhook
 *   npm run simulate:webhook -- --cleanup    # delete this script's rows, no server needed
 *
 * The point is to exercise the real HTTP path end to end without Meta: every
 * request is signed with META_APP_SECRET exactly the way Meta signs it, so the
 * server's signature verification, dedupe, status handling and unknown-number
 * logging are all covered by one command.
 *
 * Samples: text, audio (voice note), template button, interactive reply,
 * delivery status, and one payload with several entries, changes and messages.
 *
 * Nothing sensitive is printed. Sample text and phone numbers stay out of the
 * console for the same reason they stay out of the server logs, and the app
 * secret is never printed.
 */
import { pathToFileURL } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EnvError, loadEnvFromFile } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { signPayload } from '../src/webhook/signature.js';

const SECRET = 'simulator-app-secret';
const logger = createLogger({ level: 'info' });

/** Fixed fake wamids, so a re-run is a duplicate and proves the dedupe path. */
const WAMID_PREFIX = 'wamid.SIM';

type Sample = { name: string; payload: unknown };

const message = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  from: '15550100' + Math.floor(1 + Math.random() * 9),
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...overrides,
});

/** Meta always wraps deliveries in entry[] -> changes[] -> value{}. */
function envelope(
  entries: { phoneNumberId: string; value: Record<string, unknown> }[],
): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: entries.map((entry, index) => ({
      id: `WABA-SIM-${index + 1}`,
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...entry.value, metadata: { display_phone_number: '15550000000', phone_number_id: entry.phoneNumberId } } }],
    })),
  };
}

/**
 * Builds the samples. `routedId` is the phone_number_id of the seeded client, so
 * these samples resolve to a real tenant; the last one deliberately uses an id
 * nobody owns to show it being ignored instead of crashing.
 */
function buildSamples(routedId: string): Sample[] {
  const now = String(Math.floor(Date.now() / 1000));

  return [
    {
      name: 'text',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.TEXT`, type: 'text', text: { body: 'Do you have availability tomorrow?' } })] },
        },
      ]),
    },
    {
      name: 'audio (voice note)',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.AUDIO`, type: 'audio', audio: { id: 'SIMULATED-MEDIA-AUDIO-1', mime_type: 'audio/ogg; codecs=opus' } })] },
        },
      ]),
    },
    {
      name: 'template button tap',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: {
            messages: [
              message({
                id: `${WAMID_PREFIX}.BUTTON`,
                type: 'button',
                button: { payload: 'CONFIRM_BOOKING', text: 'Confirm' },
                context: { id: `${WAMID_PREFIX}.REMINDER`, forwarded: false, frequently_forwarded: false },
              }),
            ],
          },
        },
      ]),
    },
    {
      name: 'interactive button reply',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.INTERACTIVE`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes, book it' } } })] },
        },
      ]),
    },
    {
      name: 'status update (delivered, for an outbound wamid)',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: {
            statuses: [
              { id: `${WAMID_PREFIX}.OUTBOUND-1`, status: 'delivered', timestamp: now, recipient_id: '155501001', conversation: { id: 'CONV-SIM', origin: { type: 'service' } }, pricing: { billable: true, pricing_model: 'CBP' } },
              { id: `${WAMID_PREFIX}.OUTBOUND-2`, status: 'failed', timestamp: now, recipient_id: '155501001', errors: [{ code: 131047, error_data: { details: 'Re-engagement message' }, title: 'Re-engagement message' }] },
            ],
          },
        },
      ]),
    },
    {
      name: 'several entries, changes and messages in one delivery',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.BATCH.1`, type: 'text', text: { body: 'first' } }), message({ id: `${WAMID_PREFIX}.BATCH.2`, type: 'text', text: { body: 'second' } })] },
        },
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.BATCH.3`, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'evening', title: 'Evening' } } })] },
        },
        {
          phoneNumberId: routedId,
          value: { statuses: [{ id: `${WAMID_PREFIX}.BATCH.OUT`, status: 'read', timestamp: now }] },
        },
      ]),
    },
    {
      name: 'unknown phone_number_id (must be ignored, not stored)',
      payload: envelope([
        {
          phoneNumberId: '000000000000000',
          value: { messages: [message({ id: `${WAMID_PREFIX}.UNKNOWN`, type: 'text', text: { body: 'this client is not configured' } })] },
        },
      ]),
    },
    {
      name: 'unsupported message type (stored, no reply job)',
      payload: envelope([
        {
          phoneNumberId: routedId,
          value: { messages: [message({ id: `${WAMID_PREFIX}.STICKER`, type: 'sticker', sticker: { id: 'SIMULATED-MEDIA-STICKER-1' } })] },
        },
      ]),
    },
  ];
}

export type SimulateResult = { sent: number; failed: number };

export async function simulate(options: { url: string; routedId: string; appSecret: string; verifyToken?: string }): Promise<SimulateResult> {
  const samples = buildSamples(options.routedId);
  let sent = 0;
  let failed = 0;

  for (const sample of samples) {
    // Sign the exact bytes we are about to send, like Meta does.
    const body = JSON.stringify(sample.payload);
    const signature = signPayload(body, options.appSecret);

    let ok = false;
    let status = 0;
    try {
      const res = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body,
      });
      status = res.status;
      ok = status === 200;
      await res.text();
    } catch (err) {
      logger.error({ sample: sample.name, err }, 'delivery failed');
    }

    if (ok) sent += 1;
    else {
      failed += 1;
      logger.error({ sample: sample.name, status }, 'sample was not accepted');
    }
  }

  // A bad signature must be refused, otherwise the server accepts anything.
  let rejected = false;
  try {
    const res = await fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload('{}', 'wrong-secret') },
      body: '{}',
    });
    rejected = res.status === 401;
    await res.text();
  } catch (err) {
    logger.error({ err }, 'negative test failed');
  }

  logger.info(
    {
      samples: samples.length,
      accepted: sent,
      failed,
      unsigned_rejected: rejected,
      phone_number_id: options.routedId,
    },
    'webhook simulation done. This proves the HTTP surface only: 200 means the signature was accepted and the work was queued, NOT that a row was written, because the 200 is returned before ingest. Check the server log line with "stored":N>0, or look in the database. Re-running sends the same wamids, so the second run must report "duplicates" instead of "stored".',
  );
  return { sent, failed };
}

/** Runs the GET verification handshake Meta does when you save the callback URL. */
async function verify(url: string, verifyToken: string): Promise<boolean> {
  const target = new URL(url);
  target.searchParams.set('hub.mode', 'subscribe');
  target.searchParams.set('hub.verify_token', verifyToken);
  target.searchParams.set('hub.challenge', '1158201444');

  const res = await fetch(target);
  const body = await res.text();
  const ok = res.status === 200 && body === '1158201444';
  logger.info({ status: res.status, echoed: ok }, 'GET verification handshake');
  return ok;
}

// =============================================================================
// Direct database access.
//
// Two jobs need it, and neither can be done over HTTP:
//
//   1. The status sample reports on wamid.SIM.OUTBOUND-1/2, which are messages
//      the app sent EARLIER through the Cloud API. Meta only sends a delivery
//      status for a message it already accepted from us, and a webhook delivery
//      can never contain an outbound row, so without seeding those two rows the
//      status sample can only ever answer "status for an unknown wamid".
//   2. Cleaning up afterwards. Every simulated inbound message is written with
//      the fixed wamid.SIM prefix, which makes it identifiable, but the demo
//      tenant is the user's real tenant and must not be left full of test rows.
//
// Everything here is best-effort and clearly reported: the HTTP simulation is the
// point of this script and it still runs when the database is unavailable.
// =============================================================================

/** The two outbound wamids the status sample reports on. */
const OUTBOUND_WAMIDS = [`${WAMID_PREFIX}.OUTBOUND-1`, `${WAMID_PREFIX}.OUTBOUND-2`];

/** Fixed fake number (E.164 digits) for the contacts this simulator creates. */
const SIM_CONTACT_PHONE = '15550100999';

/** Postgres unique_violation: this row is already there, which is fine. */
const UNIQUE_VIOLATION = '23505';

function database(config: ReturnType<typeof loadEnvFromFile>): SupabaseClient | null {
  if (config.supabase.url === null || config.supabase.serviceRoleKey === null) {
    logger.warn({}, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so the simulator cannot seed or clean up its own rows');
    return null;
  }
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, { auth: { persistSession: false } });
}

/** The tenant the samples route to, or null when that phone_number_id is unknown. */
async function routedClientId(db: SupabaseClient, phoneNumberId: string): Promise<string | null> {
  const { data, error } = await db.from('clients').select('id').eq('phone_number_id', phoneNumberId).maybeSingle();
  if (error) throw new Error(`cannot look up the client for phone_number_id: ${error.message}`);
  return data?.id ?? null;
}

/**
 * The contacts this simulator owns, found by DATA rather than by a stored flag:
 * any contact holding a simulated wamid, plus the fixed simulator number. A run
 * that died halfway through is therefore still cleanable.
 */
async function simulatedContactIds(db: SupabaseClient, clientId: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: messages, error: messageError } = await db
    .from('messages')
    .select('contact_id')
    .eq('client_id', clientId)
    .like('wamid', `${WAMID_PREFIX}.%`);
  if (messageError) throw new Error(`cannot list simulated messages: ${messageError.message}`);
  for (const row of messages ?? []) if (row.contact_id) ids.add(row.contact_id as string);

  const { data: byPhone, error: phoneError } = await db
    .from('contacts')
    .select('id')
    .eq('client_id', clientId)
    .eq('phone', SIM_CONTACT_PHONE);
  if (phoneError) throw new Error(`cannot list the simulator contact: ${phoneError.message}`);
  for (const row of byPhone ?? []) ids.add(row.id as string);

  return [...ids];
}

/**
 * Inserts the two outbound rows the status sample reports on. Returns how many
 * were created; an existing wamid is skipped, so repeated runs stay idempotent.
 */
async function seedOutboundSamples(db: SupabaseClient, clientId: string): Promise<number> {
  const { data: existing, error: lookupError } = await db
    .from('contacts')
    .select('id')
    .eq('client_id', clientId)
    .eq('phone', SIM_CONTACT_PHONE)
    .maybeSingle();
  if (lookupError) throw new Error(`cannot look up the simulator contact: ${lookupError.message}`);

  let contactId = existing?.id as string | undefined;
  if (contactId === undefined) {
    const { data: created, error: createError } = await db
      .from('contacts')
      .insert({ client_id: clientId, phone: SIM_CONTACT_PHONE, name: 'Simulated contact' })
      .select('id')
      .single();
    if (createError) throw new Error(`cannot create the simulator contact: ${createError.message}`);
    contactId = created.id as string;
  }

  let seeded = 0;
  for (const wamid of OUTBOUND_WAMIDS) {
    const { error } = await db.from('messages').insert({
      client_id: clientId,
      contact_id: contactId,
      wamid,
      direction: 'out',
      type: 'text',
      text: '(simulated outbound message)',
    });
    if (error === null) seeded += 1;
    else if (error.code !== UNIQUE_VIOLATION) throw new Error(`cannot seed ${wamid}: ${error.message}`);
  }
  return seeded;
}

/**
 * Removes everything this simulator wrote into the tenant.
 *
 * sheet_outbox.entity_id has NO foreign key: it points at a contact OR a booking
 * depending on `entity`, so Postgres cannot cascade it. Deleting the contacts
 * would leave those rows behind as orphans pointing at rows that no longer
 * exist, so they are deleted explicitly first. The contacts then cascade to
 * messages, jobs, bookings and booking_events.
 */
async function cleanupSimulatedData(db: SupabaseClient, clientId: string): Promise<{ contacts: number; sheetOutbox: number }> {
  const contactIds = await simulatedContactIds(db, clientId);
  if (contactIds.length === 0) {
    logger.info({}, 'nothing to clean up: this tenant holds no simulated rows');
    return { contacts: 0, sheetOutbox: 0 };
  }

  const { data: outbox, error: outboxError } = await db
    .from('sheet_outbox')
    .delete()
    .eq('client_id', clientId)
    .eq('entity', 'contact')
    .in('entity_id', contactIds)
    .select('id');
  if (outboxError) throw new Error(`cannot delete simulated sheet_outbox rows: ${outboxError.message}`);

  const { data: contacts, error: contactError } = await db.from('contacts').delete().in('id', contactIds).select('id');
  if (contactError) throw new Error(`cannot delete simulated contacts: ${contactError.message}`);

  return { contacts: contacts?.length ?? 0, sheetOutbox: outbox?.length ?? 0 };
}

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

// Only run when executed directly, not when imported by a test.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const run = async (): Promise<void> => {
    // META_APP_SECRET / META_VERIFY_TOKEN / WA_PHONE_NUMBER_ID come from .env.
    const config = loadEnvFromFile();
    const appSecret = config.meta?.appSecret ?? SECRET;
    const url = argValue('--url') ?? `http://127.0.0.1:${config.port}/webhook`;
    // Read the phone number id from the loaded config, NOT from process.env:
    // loadEnvFromFile() parses .env into `config` and never writes to the
    // environment, so process.env.WA_PHONE_NUMBER_ID is normally unset and the
    // old lookup silently fell back to the placeholder below. Every sample then
    // carried an unroutable id, the server ignored all of them, and the run
    // still reported "accepted: 8" because a 200 is returned before ingest.
    const routedId = argValue('--phone-number-id') ?? config.whatsappDemo?.phoneNumberId ?? 'SIMULATED-PHONE-NUMBER-ID';
    const cleaningUp = process.argv.includes('--cleanup');
    if (routedId === 'SIMULATED-PHONE-NUMBER-ID') {
      logger.warn(
        {},
        'WA_PHONE_NUMBER_ID is not available, so the samples carry a placeholder phone_number_id: the server will ignore every one of them and NOTHING will be written to the database. Set WA_PHONE_NUMBER_ID in .env (npm run seed puts it on the client) or pass --phone-number-id.',
      );
    }

    // --cleanup only touches the database, so it never needs a running server.
    if (cleaningUp) {
      const db = database(config);
      if (db === null || routedId === 'SIMULATED-PHONE-NUMBER-ID') return;
      const clientId = await routedClientId(db, routedId);
      if (clientId === null) {
        logger.warn({}, 'no client has that phone_number_id, so there is nothing to clean up');
        return;
      }
      const removed = await cleanupSimulatedData(db, clientId);
      logger.info(removed, 'simulated rows removed (contacts cascade to messages, jobs, bookings and booking_events)');
      return;
    }

    // Give the status sample something to report on before sending anything.
    const db = database(config);
    if (db !== null && routedId !== 'SIMULATED-PHONE-NUMBER-ID') {
      const clientId = await routedClientId(db, routedId);
      if (clientId === null) {
        logger.warn({}, 'no client has that phone_number_id: the server will ignore every sample. Run npm run seed, or pass --phone-number-id.');
      } else {
        const seeded = await seedOutboundSamples(db, clientId);
        logger.info({ seeded }, 'outbound rows ready for the status sample to report on');
      }
    }

    if (config.meta !== null) {
      await verify(url, config.meta.verifyToken);
    } else {
      logger.warn({}, 'META_* is not configured in .env: signing with a placeholder secret and skipping the GET handshake');
    }

    const result = await simulate({ url, routedId, appSecret });
    if (result.failed > 0) process.exitCode = 1;
  };

  run().catch((err: unknown) => {
    if (err instanceof EnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`simulator failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}