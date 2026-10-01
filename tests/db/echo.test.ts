/**
 * Echo tests against a real Supabase project (Slice 3, temporary: Slice 4
 * deletes the echo and these tests with it).
 *
 * The WhatsApp side is the FAKE client, so no test here touches Meta. What IS
 * real: the ingest pipeline, the database, and the demo-client restriction.
 * Each case proves one safety rule:
 *  - text to the demo client -> one send to that contact, outbound row saved;
 *  - the same delivery twice -> still exactly one send (dedupe stops it);
 *  - non-text -> stored, but no send;
 *  - text to another client -> stored, but no send (demo-only);
 *  - Meta down -> ingest still stores and still enqueues the reply job.
 *
 * Skips itself under the same conditions as the other live suites. Everything
 * belongs to throwaway clients named `wa-test-echo-*`, deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config.js';
import type { Message } from '../../src/db/types.js';
import { createLogger } from '../../src/logger.js';
import { createEchoHooks, handleStoredMessageForEcho, type EchoDeps } from '../../src/services/echo.js';
import { createFakeWhatsAppClient } from '../../src/whatsapp/fake.js';
import { ingestWebhookPayload, type IngestDeps } from '../../src/webhook/ingest.js';
import { baseEnv, collectingStream } from '../helpers.js';
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

const NAMESPACE = `${TEST_CLIENT_PREFIX}echo-`;

const ready = dbHarness();
const suiteName = ready.ok ? 'echo (live database, fake WhatsApp)' : `echo (skipped: ${ready.reason})`;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = '';
  let otherClientId = '';
  const createdClientIds: string[] = [];
  const { stream, text: logs } = collectingStream();
  const logger = createLogger({ level: 'debug', destination: stream });

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  const newClient = async (harness: DbHarness, label: string): Promise<{ id: string; phoneNumberId: string }> => {
    const phoneNumberId = `${harness.tag}-${label}`;
    const { data, error } = await harness.supabase
      .from('clients')
      .insert({ business_name: `${NAMESPACE}${label}-${harness.tag}`, phone_number_id: phoneNumberId })
      .select('id')
      .single();
    expect(error, 'cannot create an echo test client').toBeNull();
    createdClientIds.push((data as { id: string }).id);
    return { id: (data as { id: string }).id, phoneNumberId };
  };

  /** Wraps messages the way Meta delivers them. */
  const payload = (phoneNumberId: string, value: Record<string, unknown>): unknown => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-TEST', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId }, ...value } }] }],
  });

  const textMessage = (wamid: string, phone: string, body: string): Record<string, unknown> => ({
    messages: [{ from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
    contacts: [{ profile: { name: 'Echo' }, wa_id: phone }],
  });

  const depsFor = (demoClientId: string) => {
    const whatsapp = createFakeWhatsAppClient();
    const echo: EchoDeps = { supabase: h.supabase, whatsapp, logger, demoClientId };
    const deps: IngestDeps = {
      supabase: h.supabase,
      logger,
      debounceSeconds: 90,
      hooks: {
        onMessageStored: async (info) => {
          await handleStoredMessageForEcho(echo, info);
        },
      },
    };
    return { deps, whatsapp };
  };

  const messages = async (client = clientId): Promise<Message[]> => {
    const { data, error } = await h.supabase.from('messages').select('*').eq('client_id', client).order('created_at');
    expect(error, 'cannot read messages').toBeNull();
    return (data ?? []) as Message[];
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason !== null) return;
    clientId = (await newClient(h, 'demo')).id;
    otherClientId = (await newClient(h, 'other')).id;
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  it('a text to the demo client sends one echo to that contact and saves the outbound wamid', test(async () => {
    const { deps, whatsapp } = depsFor(clientId);
    const phone = testPhone(h.tag, 11);
    const wamid = `wamid.ECHO.TEXT.1.${h.tag}`;

    const summary = await ingestWebhookPayload(deps, payload(`${h.tag}-demo`, textMessage(wamid, phone, 'hello there')));

    expect(summary.stored).toBe(1);
    expect(summary.jobsEnqueued).toBe(1);
    expect(whatsapp.reads).toEqual([wamid]);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({ to: phone, body: 'I got: hello there' });

    const rows = await messages();
    // Scoped to this test's own rows: earlier tests wrote to the same client.
    expect(rows.filter((r) => r.wamid === wamid || r.text === 'I got: hello there')).toHaveLength(2);
    const outbound = rows.find((r) => r.direction === 'out' && r.text === 'I got: hello there');
    expect(outbound).toMatchObject({ type: 'text', wamid: whatsapp.sent[0]?.wamid, text: 'I got: hello there' });
    expect(outbound?.status).toBeNull();
  }));

  it('the same delivery twice still sends exactly once', test(async () => {
    const { deps, whatsapp } = depsFor(clientId);
    const phone = testPhone(h.tag, 12);
    const wamid = `wamid.ECHO.TEXT.2.${h.tag}`;
    const delivery = payload(`${h.tag}-demo`, textMessage(wamid, phone, 'again'));

    const first = await ingestWebhookPayload(deps, delivery);
    const second = await ingestWebhookPayload(deps, delivery);

    expect(first.stored).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(second.stored).toBe(0);
    expect(whatsapp.sent).toHaveLength(1);
    expect((await messages()).filter((r) => r.direction === 'out' && r.text === 'I got: again')).toHaveLength(1);
  }));

  it('a voice note is stored but gets no echo', test(async () => {
    const { deps, whatsapp } = depsFor(clientId);
    const phone = testPhone(h.tag, 13);
    const audioWamid = `wamid.ECHO.AUDIO.1.${h.tag}`;
    const delivery = payload(`${h.tag}-demo`, {
      messages: [{ from: phone, id: audioWamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'MEDIA-1', voice: true, mime_type: 'audio/ogg' } }],
      contacts: [{ profile: { name: 'Echo' }, wa_id: phone }],
    });

    const summary = await ingestWebhookPayload(deps, delivery);

    expect(summary.stored).toBe(1);
    expect(summary.jobsEnqueued).toBe(1);
    expect(whatsapp.sent).toHaveLength(0);
    expect(whatsapp.reads).toHaveLength(0);
    expect((await messages()).filter((r) => r.wamid === audioWamid && r.type === 'audio')).toHaveLength(1);
  }));

  it('a text to another client is stored but gets no echo', test(async () => {
    // The echo is wired for the demo client only; this delivery routes to other.
    const { deps, whatsapp } = depsFor(clientId);
    const phone = testPhone(h.tag, 14);
    const delivery = payload(`${h.tag}-other`, textMessage(`wamid.ECHO.TEXT.3.${h.tag}`, phone, 'hello other'));

    const summary = await ingestWebhookPayload(deps, delivery);

    expect(summary.stored).toBe(1);
    expect(whatsapp.sent).toHaveLength(0);
    expect(whatsapp.reads).toHaveLength(0);
    expect(await messages(otherClientId)).toHaveLength(1);
  }));

  it('a Meta outage still stores the message and still enqueues the reply job', test(async () => {
    const { deps, whatsapp } = depsFor(clientId);
    whatsapp.failAllSendsWith(new Error('Meta is down'));
    const phone = testPhone(h.tag, 15);
    const delivery = payload(`${h.tag}-demo`, textMessage(`wamid.ECHO.TEXT.4.${h.tag}`, phone, 'are you there'));

    const summary = await ingestWebhookPayload(deps, delivery);

    expect(summary.stored).toBe(1);
    expect(summary.jobsEnqueued).toBe(1);
    expect(summary.errors).toBe(0);
    expect(whatsapp.sent).toHaveLength(0);
    // Nothing half-written: the failed send leaves no outbound row for THIS
    // message (earlier tests' rows live on the same client, so scope by text).
    expect((await messages()).filter((r) => r.direction === 'out' && r.text === 'I got: are you there')).toHaveLength(0);
    expect(logs()).toContain('echo reply failed');
  }));

  describe('createEchoHooks gating', () => {
    const gatingEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
      baseEnv({
        META_APP_SECRET: 'test-app-secret',
        META_VERIFY_TOKEN: 'test-verify-token-16',
        GRAPH_API_VERSION: 'v21.0',
        WA_PHONE_NUMBER_ID: `${h.tag}-demo`,
        WA_TOKEN: 'test-wa-token',
        ...overrides,
      });

    it('returns hooks when ECHO_MODE=true and the demo client exists', test(async () => {
      const config = loadEnv(gatingEnv({ ECHO_MODE: 'true' }));
      expect(config.echoMode).toBe(true);
      const hooks = await createEchoHooks({ config, logger, supabase: h.supabase });
      expect(hooks?.onMessageStored).toBeDefined();
    }));

    it('is disabled without ECHO_MODE', test(async () => {
      const config = loadEnv(gatingEnv());
      expect(config.echoMode).toBe(false);
      await expect(createEchoHooks({ config, logger, supabase: h.supabase })).resolves.toBeUndefined();
    }));

    it('is disabled when no client has the demo phone_number_id', test(async () => {
      const config = loadEnv(gatingEnv({ ECHO_MODE: 'true', WA_PHONE_NUMBER_ID: 'no-such-number' }));
      await expect(createEchoHooks({ config, logger, supabase: h.supabase })).resolves.toBeUndefined();
    }));
  });
});
