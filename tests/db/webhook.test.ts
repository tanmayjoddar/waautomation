/**
 * Webhook ingest against a real Supabase project (spec 1.6 steps 3-4).
 *
 * Skips itself when .env has no project, when NODE_ENV=production, or when the
 * migration has not been applied. The skip reason is printed, never silent.
 *
 * Everything belongs to one throwaway client named `wa-test-webhook-*`, deleted
 * in afterAll. The demo tenant and the other suites' namespaces are untouched:
 * vitest runs files in parallel, so this suite only purges its own prefix.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ingestWebhookPayload, type IngestDeps, type IngestSummary } from '../../src/webhook/ingest.js';
import { createLogger } from '../../src/logger.js';
import type { Message } from '../../src/db/types.js';
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
import { collectingStream } from '../helpers.js';

const NAMESPACE = `${TEST_CLIENT_PREFIX}webhook-`;

const ready = dbHarness();
const suiteName = ready.ok ? 'webhook ingest (live database)' : `webhook ingest (skipped: ${ready.reason})`;

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = '';
  const createdClientIds: string[] = [];
  const { stream, text: logs } = collectingStream();
  const logger = createLogger({ level: 'debug', destination: stream });

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  const newClient = async (harness: DbHarness, label: string): Promise<string> => {
    const { data, error } = await harness.supabase
      .from('clients')
      .insert({ business_name: `${NAMESPACE}${label}-${harness.tag}`, phone_number_id: `${harness.tag}-${label}` })
      .select('id')
      .single();
    expect(error, 'cannot create a webhook test client').toBeNull();
    createdClientIds.push((data as { id: string }).id);
    return (data as { id: string }).id;
  };

  const deps = (overrides: Partial<IngestDeps> = {}): IngestDeps => ({
    supabase: h.supabase,
    logger,
    debounceSeconds: 90,
    ...overrides,
  });

  const run = (payload: unknown, overrides: Partial<IngestDeps> = {}): Promise<IngestSummary> =>
    ingestWebhookPayload(deps(overrides), payload);

  /** Wraps messages the way Meta delivers them. */
  const payload = (phoneNumberId: string, value: Record<string, unknown>): unknown => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-TEST', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId }, ...value } }] }],
  });

  const inbound = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    from: testPhone(h.tag, 1),
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  });

  const messages = async (client = clientId): Promise<Message[]> => {
    const { data, error } = await h.supabase.from('messages').select('*').eq('client_id', client).order('created_at');
    expect(error, 'cannot read messages').toBeNull();
    return (data ?? []) as Message[];
  };

  /** Structured log records, so tests can assert levels and fields, not substrings. */
  const logRecords = (): Array<Record<string, unknown>> =>
    logs()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const countJobs = async (client = clientId): Promise<number> => {
    const { count, error } = await h.supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('client_id', client);
    expect(error, 'cannot count jobs').toBeNull();
    return count ?? 0;
  };

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase);
    if (skipReason !== null) return;
    clientId = await newClient(h, 'main');
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    // Leftovers from a crashed earlier run of THIS suite only.
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  describe('a normal text message', () => {
    const body = { text: 'CUSTOMER_WORDS_MUST_NOT_BE_LOGGED_1234' };

    const delivery = (wamid: string): unknown =>
      payload(`${h.tag}-main`, {
        contacts: [{ profile: { name: 'Asha' }, wa_id: testPhone(h.tag, 1) }],
        messages: [inbound({ id: wamid, type: 'text', text: { body: body.text } })],
      });

    it('stores the message, creates the contact and enqueues one job', test(async (harness) => {
      const summary = await run(delivery('wamid.TEXT.A'));

      expect(summary.stored).toBe(1);
      expect(summary.jobsEnqueued).toBe(1);
      expect(summary.duplicates).toBe(0);
      expect(summary.errors).toBe(0);

      const rows = await messages();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        wamid: 'wamid.TEXT.A',
        direction: 'in',
        type: 'text',
        text: body.text,
        // Spec 1.x, messages table: `status text, -- sent | delivered | read |
        // failed`. That column only ever receives Meta's delivery callbacks,
        // and Meta sends those for OUTBOUND messages only, so an inbound row
        // must keep a NULL status. It is not "received" - the arrival is
        // already recorded by direction = 'in' plus created_at.
        status: null,
        media_id: null,
      });
      expect(rows[0]?.client_id).toBe(harness.config ? clientId : clientId);

      const { data: contacts } = await harness.supabase.from('contacts').select('*').eq('client_id', clientId);
      expect(contacts).toHaveLength(1);
      expect(contacts?.[0]).toMatchObject({ phone: testPhone(h.tag, 1), name: 'Asha' });

      expect(await countJobs()).toBe(1);
    }));

    it('queues a new contact for the sheet exactly once', test(async () => {
      await run(delivery('wamid.TEXT.B'));
      const { data } = await h.supabase.from('sheet_outbox').select('*').eq('client_id', clientId);
      expect(data).toHaveLength(1);
      expect(data?.[0]).toMatchObject({ entity: 'contact' });
    }));

    it('never logs the customer phone number or the message text', test(async () => {
      await run(delivery('wamid.TEXT.C'));
      const log = logs();
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(body.text);
      expect(log).not.toContain(testPhone(h.tag, 1));
      // The masked form proves the number went through the phone masker.
      expect(log).not.toMatch(/"(contactPhone|phone|from)"\s*:\s*"9199\d{6}/);
    }));
  });

  describe('duplicate delivery', () => {
    const delivery = (): unknown =>
      payload(`${h.tag}-main`, {
        contacts: [{ profile: { name: 'Asha' } }],
        messages: [inbound({ id: 'wamid.DUP', type: 'text', text: { body: 'only once' } })],
      });

    it('stores nothing, enqueues nothing and calls no hook the second time', test(async () => {
      const onMessageStored = vi.fn();
      const onUnsupportedType = vi.fn();

      const first = await run(delivery(), { hooks: { onMessageStored, onUnsupportedType } });
      expect(first.stored).toBe(1);
      expect(first.jobsEnqueued).toBe(1);

      const jobsAfterFirst = await countJobs();
      const { data: outboxAfterFirst } = await h.supabase.from('sheet_outbox').select('id').eq('client_id', clientId);

      const second = await run(delivery(), { hooks: { onMessageStored, onUnsupportedType } });

      expect(second.stored).toBe(0);
      expect(second.duplicates).toBe(1);
      expect(second.jobsEnqueued).toBe(0);
      expect(second.unsupported).toBe(0);

      // The unique constraint, not a log line, is what kept this to one row.
      const rows = await messages();
      expect(rows.filter((m) => m.wamid === 'wamid.DUP')).toHaveLength(1);
      expect(await countJobs()).toBe(jobsAfterFirst);

      const { data: outboxAfterSecond } = await h.supabase.from('sheet_outbox').select('id').eq('client_id', clientId);
      expect(outboxAfterSecond).toHaveLength(outboxAfterFirst?.length ?? 0);

      expect(onMessageStored).toHaveBeenCalledTimes(1);
      expect(onUnsupportedType).not.toHaveBeenCalled();
    }));

    it('two concurrent deliveries of the same message still store one row', test(async () => {
      const concurrent = payload(`${h.tag}-main`, {
        messages: [inbound({ id: 'wamid.RACE', type: 'text', text: { body: 'race' } })],
      });

      const [a, b] = await Promise.all([run(concurrent), run(concurrent)]);

      const stored = [a, b].reduce((n, s) => n + s.stored, 0);
      const duplicates = [a, b].reduce((n, s) => n + s.duplicates, 0);
      expect(stored).toBe(1);
      expect(duplicates).toBe(1);
      expect((await messages()).filter((m) => m.wamid === 'wamid.RACE')).toHaveLength(1);
    }));
  });

  describe('unknown phone_number_id', () => {
    it('is logged and ignored: no client, contact, message or job is created', test(async (harness) => {
      const summary = await run(
        payload('000000000000000', { messages: [inbound({ id: 'wamid.STRANGER', type: 'text', text: { body: 'hello?' } })] }),
      );

      expect(summary.unknownPhoneNumberId).toBe(1);
      expect(summary.stored).toBe(0);
      expect(summary.jobsEnqueued).toBe(0);
      expect(summary.errors).toBe(0);

      const { count } = await harness.supabase.from('messages').select('id', { count: 'exact', head: true }).eq('wamid', 'wamid.STRANGER');
      expect(count).toBe(0);
      expect(logs()).toContain('unknown phone_number_id');
    }));
  });

  describe('several messages in one delivery', () => {
    it('stores every message and still enqueues a single debounced job', test(async () => {
      const summary = await run(
        payload(`${h.tag}-main`, {
          messages: [
            inbound({ id: 'wamid.BATCH.1', type: 'text', text: { body: 'one' } }),
            inbound({ id: 'wamid.BATCH.2', type: 'text', text: { body: 'two' } }),
            inbound({ id: 'wamid.BATCH.3', type: 'audio', audio: { id: 'MEDIA-SIM-1' } }),
          ],
        }),
      );

      expect(summary.stored).toBe(3);
      // enqueue_reply_job is debounced per contact, so three messages in one
      // delivery must not become three jobs.
      expect(summary.jobsEnqueued).toBeGreaterThanOrEqual(1);
      const rows = await messages();
      expect(rows.filter((m) => (m.wamid ?? '').startsWith('wamid.BATCH'))).toHaveLength(3);
    }));
  });

  describe('every supported message type', () => {
    it('audio keeps the media id for the later download', test(async () => {
      await run(payload(`${h.tag}-main`, { messages: [inbound({ id: 'wamid.AUDIO', type: 'audio', audio: { id: 'MEDIA-AUDIO-9' } })] }));
      const row = (await messages()).find((m) => m.wamid === 'wamid.AUDIO');
      expect(row).toMatchObject({ type: 'audio', media_id: 'MEDIA-AUDIO-9', text: null });
    }));

    it('a template button is stored as a template with its machine payload', test(async () => {
      await run(
        payload(`${h.tag}-main`, {
          messages: [
            inbound({
              id: 'wamid.BUTTON',
              type: 'button',
              button: { payload: 'CONFIRM_BOOKING', text: 'Confirm' },
              context: { id: 'wamid.REMINDER' },
            }),
          ],
        }),
      );
      const row = (await messages()).find((m) => m.wamid === 'wamid.BUTTON');
      expect(row).toMatchObject({ type: 'template', text: 'CONFIRM_BOOKING: Confirm' });
    }));

    it('an interactive reply keeps the chosen row id', test(async () => {
      await run(
        payload(`${h.tag}-main`, {
          messages: [inbound({ id: 'wamid.INTERACTIVE', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'evening', title: 'Evening slot' } } })],
        }),
      );
      const row = (await messages()).find((m) => m.wamid === 'wamid.INTERACTIVE');
      expect(row).toMatchObject({ type: 'interactive', text: 'evening: Evening slot' });
    }));

    it('an unsupported type is stored, flagged, and gets no reply job', test(async () => {
      const onUnsupportedType = vi.fn();
      const before = await countJobs();
      const summary = await run(
        payload(`${h.tag}-main`, { messages: [inbound({ id: 'wamid.STICKER', type: 'sticker', sticker: { id: 'M1' } })] }),
        { hooks: { onUnsupportedType } },
      );

      expect(summary.stored).toBe(1);
      expect(summary.unsupported).toBe(1);
      expect(summary.jobsEnqueued).toBe(0);
      expect(onUnsupportedType).toHaveBeenCalledWith({ clientId, wamid: 'wamid.STICKER' });

      const row = (await messages()).find((m) => m.wamid === 'wamid.STICKER');
      expect(row?.type).toBe('other');
      expect(await countJobs()).toBe(before);
    }));
  });

  describe('statuses[]', () => {
    const wamid = 'wamid.OUTBOUND.1';

    beforeAll(async () => {
      if (skipReason !== null) return;
      // An outbound row, which is what Meta sends status updates for.
      const { data: contact } = await h.supabase.from('contacts').select('id').eq('client_id', clientId).limit(1).single();
      await h.supabase.from('messages').insert({
        client_id: clientId,
        contact_id: (contact as { id: string }).id,
        wamid,
        direction: 'out',
        type: 'text',
        text: 'booked for tomorrow',
        status: 'sent',
      });
    });

    it('updates the matching message row', test(async () => {
      const summary = await run(
        payload(`${h.tag}-main`, { statuses: [{ id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] }),
      );

      expect(summary.statusesApplied).toBe(1);
      expect(summary.statusesUnknown).toBe(0);
      const row = (await messages()).find((m) => m.wamid === wamid);
      expect(row?.status).toBe('delivered');
    }));

    it('records a later status over the earlier one', test(async () => {
      await run(payload(`${h.tag}-main`, { statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }] }));
      expect((await messages()).find((m) => m.wamid === wamid)?.status).toBe('read');
    }));

    it('a status for an unknown wamid is counted, not an error', test(async () => {
      const summary = await run(payload(`${h.tag}-main`, { statuses: [{ id: 'wamid.NEVER.SENT', status: 'delivered', timestamp: '1' }] }));
      expect(summary.statusesUnknown).toBe(1);
      expect(summary.statusesApplied).toBe(0);
      expect(summary.errors).toBe(0);
    }));

    it('a failed status is stored and logged with its error code', test(async () => {
      await run(
        payload(`${h.tag}-main`, {
          statuses: [{ id: wamid, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131047, error_data: { details: 'Re-engagement' }, title: 'Re-engagement message' }] }],
        }),
      );
      expect((await messages()).find((m) => m.wamid === wamid)?.status).toBe('failed');
      expect(logs()).toContain('delivery failed');
      expect(logs()).toContain('131047');
      // One info line with the whole reason: code + title + message.
      const record = logRecords().find((r) => r['msg'] === 'message delivery failed' && r['wamid'] === wamid);
      expect(record, 'no failed-status line was logged').toBeDefined();
      expect(record).toMatchObject({
        level: 'info',
        status: 'failed',
        errorCode: 131047,
        errorTitle: 'Re-engagement message',
        errorMessage: 'Re-engagement',
      });
    }));

    it('a failed status for an unknown wamid is still logged at info with Meta reason', test(async () => {
      // The user's case: a message sent by hand (curl/template) has no row, so
      // its status can never be "applied" - but the reason must still be visible.
      const unknownWamid = `wamid.UNKNOWN.FAIL.${h.tag}`;
      const summary = await run(
        payload(`${h.tag}-main`, {
          statuses: [{ id: unknownWamid, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131026, error_data: { details: 'This number is not on WhatsApp' }, title: 'Message undeliverable' }] }],
        }),
      );
      expect(summary.statusesUnknown).toBe(1);
      expect(summary.statusesApplied).toBe(0);
      const record = logRecords().find((r) => r['msg'] === 'status for an unknown wamid' && r['wamid'] === unknownWamid);
      expect(record, 'no unknown-wamid status line was logged').toBeDefined();
      expect(record).toMatchObject({
        level: 'info',
        status: 'failed',
        errorCode: 131026,
        errorTitle: 'Message undeliverable',
        errorMessage: 'This number is not on WhatsApp',
      });
      // And the routing that led here is stated too: this id matched a client.
      const routed = logRecords().find((r) => r['msg'] === 'webhook change routed' && r['phoneNumberId'] === `${h.tag}-main`);
      expect(routed, 'no routing line was logged').toBeDefined();
      expect(routed?.['level']).toBe('info');
    }));

    it('a status for another tenant is never touched', test(async () => {
      const other = await newClient(h, 'other');
      const { data: otherContact, error: contactError } = await h.supabase
        .from('contacts')
        .insert({ client_id: other, phone: testPhone(h.tag, 4) })
        .select('id')
        .single();
      expect(contactError, 'cannot create the other tenant contact').toBeNull();

      const { data: row, error: insertError } = await h.supabase
        .from('messages')
        .insert({ client_id: other, contact_id: (otherContact as { id: string }).id, wamid: 'wamid.OTHER.1', direction: 'out', type: 'text', text: 'other tenant', status: 'sent' })
        .select('id')
        .single();
      expect(insertError, 'cannot create the other tenant message').toBeNull();
      expect(row).not.toBeNull();

      // The same wamid delivered under the main tenant must not update the row.
      await run(payload(`${h.tag}-main`, { statuses: [{ id: 'wamid.OTHER.1', status: 'delivered', timestamp: '1' }] }));
      const { data: after } = await h.supabase.from('messages').select('status').eq('client_id', other).eq('wamid', 'wamid.OTHER.1').single();
      expect(after?.status).toBe('sent');
    }));
  });

  describe('a paused contact', () => {
    it('is still stored, but gets no reply job', test(async (harness) => {
      const phone = testPhone(h.tag, 7);
      const { data: contact } = await harness.supabase
        .from('contacts')
        .insert({ client_id: clientId, phone, bot_paused: true })
        .select('id')
        .single();

      const before = await countJobs();
      const summary = await run(
        payload(`${h.tag}-main`, { messages: [inbound({ from: phone, id: 'wamid.PAUSED', type: 'text', text: { body: 'hello' } })] }),
      );

      expect(summary.stored).toBe(1);
      expect(summary.paused).toBe(1);
      expect(summary.jobsEnqueued).toBe(0);
      expect((await messages()).some((m) => m.wamid === 'wamid.PAUSED')).toBe(true);
      expect(await countJobs()).toBe(before);
      expect(contact).not.toBeNull();
    }));
  });

  describe('an inactive client', () => {
    it('is ignored without error', test(async () => {
      const inactive = await newClient(h, 'inactive');
      await h.supabase.from('clients').update({ active: false }).eq('id', inactive);

      const summary = await run(payload(`${h.tag}-inactive`, { messages: [inbound({ id: 'wamid.INACTIVE', type: 'text', text: { body: 'hi' } })] }));

      expect(summary.stored).toBe(0);
      expect(summary.errors).toBe(0);
      const { count } = await h.supabase.from('messages').select('id', { count: 'exact', head: true }).eq('wamid', 'wamid.INACTIVE');
      expect(count).toBe(0);
    }));
  });

  describe('robustness', () => {
    it('a payload with no entries is a no-op', test(async () => {
      const before = await messages();
      const summary = await run({ object: 'whatsapp_business_account', entry: [] });
      expect(summary.changes).toBe(0);
      expect(summary.stored).toBe(0);
      expect(await messages()).toHaveLength(before.length);
    }));

    it('garbage does not throw and is counted as an error-free no-op', test(async () => {
      for (const value of [null, 'text', 42, {}, [1, 2, 3]]) {
        const summary = await run(value);
        expect(summary.stored).toBe(0);
        expect(summary.errors).toBe(0);
      }
    }));

    it('a change without a phone_number_id is ignored, not stored', test(async () => {
      const summary = await run({
        object: 'whatsapp_business_account',
        entry: [{ id: 'A', changes: [{ field: 'messages', value: { metadata: {}, messages: [inbound({ id: 'wamid.NOROUTE', type: 'text', text: { body: 'hi' } })] } }] }],
      });
      expect(summary.unroutable).toBe(1);
      expect(summary.stored).toBe(0);
    }));

    it('one broken change does not abandon the rest of the delivery', test(async () => {
      const summary = await run({
        object: 'whatsapp_business_account',
        entry: [
          { id: 'A', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '9999999999' }, messages: [inbound({ id: 'wamid.UNKNOWN.B', type: 'text', text: { body: 'x' } })] } }] },
          { id: 'B', changes: [{ field: 'messages', value: { metadata: { phone_number_id: `${h.tag}-main` }, messages: [inbound({ id: 'wamid.AFTER.UNKNOWN', type: 'text', text: { body: 'still processed' } })] } }] },
        ],
      });
      expect(summary.unknownPhoneNumberId).toBe(1);
      expect(summary.stored).toBe(1);
    }));
  });
});