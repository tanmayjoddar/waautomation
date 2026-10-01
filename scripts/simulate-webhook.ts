/**
 * Sends signed sample webhook deliveries to a running server (spec 1.6 step 8).
 *
 *   npm run simulate:webhook                 # all samples against localhost:3000
 *   npm run simulate:webhook -- --url https://my-host/webhook
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
    { samples: samples.length, accepted: sent, failed, unsigned_rejected: rejected },
    'webhook simulation done (re-run to see duplicate deliveries being ignored)',
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
    const routedId = argValue('--phone-number-id') ?? process.env['WA_PHONE_NUMBER_ID'] ?? 'SIMULATED-PHONE-NUMBER-ID';

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