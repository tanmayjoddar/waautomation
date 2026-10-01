/**
 * Console chat loop tests against a real Supabase project (Slice 4).
 *
 * chatOnce() runs the typed text through the SAME ingest function as the
 * webhook, then the REAL worker pipeline (fake LLM, console sends) until the
 * queue is quiet. Everything belongs to a throwaway client named
 * `wa-test-chat-*`, deleted in afterAll. Skips like the other live suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatOnce, cleanupChatRows } from '../../scripts/chat.js';
import { loadEnv } from '../../src/config.js';
import type { Message } from '../../src/db/types.js';
import { createLogger } from '../../src/logger.js';
import { createFakeLlm } from '../../src/ai/fake.js';
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

const NAMESPACE = `${TEST_CLIENT_PREFIX}chat-`;

const ready = dbHarness();
const suiteName = ready.ok ? 'console chat (live database, fake LLM)' : `console chat (skipped: ${ready.reason})`;

const replyJson = (parts: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    reply_parts: parts,
    language: 'english',
    intent: 'question',
    name: null,
    service: null,
    chosen_slot: null,
    confidence: 0.9,
    ...extra,
  });

describe.skipIf(!ready.ok)(suiteName, () => {
  let h!: DbHarness;
  let skipReason: string | null = null;
  let clientId = '';
  let phoneNumberId = '';
  const createdClientIds: string[] = [];
  const { stream, text: logs } = collectingStream();
  const phone = testPhone(ready.ok ? ready.harness.tag : 'wa-test-000000', 31);

  const test = (body: (h: DbHarness) => Promise<void>) => dbTest(() => skipReason, body);

  beforeAll(async () => {
    if (!ready.ok) return;
    h = ready.harness;
    skipReason = await schemaReadiness(h.supabase, { requireWorkerQueue: true });
    if (skipReason !== null) return;
    phoneNumberId = `${h.tag}-chat`;
    const { data, error } = await h.supabase
      .from('clients')
      .insert({ business_name: `${NAMESPACE}demo-${h.tag}`, phone_number_id: phoneNumberId })
      .select('id')
      .single();
    expect(error, 'cannot create a chat test client').toBeNull();
    clientId = (data as { id: string }).id;
    createdClientIds.push(clientId);
  });

  afterAll(async () => {
    if (!ready.ok || skipReason !== null) return;
    for (const id of createdClientIds) await deleteTestClient(h.supabase, id);
    await purgeAbandonedTestTenants(h.supabase, NAMESPACE);
  });

  const chat = (
    script: string[],
    text: string,
    out: { write(chunk: string): void },
    contactPhone: string = phone,
  ): Promise<{ replies: string[]; stored: number; jobs: number; errors: number }> => {
    const config = loadEnv(
      baseEnv({ SEND_MODE: 'console', WA_PHONE_NUMBER_ID: phoneNumberId, WA_TOKEN: 'test-chat-token' }),
    );
    return chatOnce(
      {
        supabase: h.supabase,
        logger: createLogger({ level: 'debug', destination: stream }),
        llm: createFakeLlm(script.map((s) => ({ text: s }))),
        llmConfig: { provider: 'fake', apiKey: 'x', model: 'fake', timeoutMs: 5000, maxOutputTokens: 400 },
        config,
        demoClientId: clientId,
        demoPhoneNumberId: phoneNumberId,
        contactPhone,
        out,
        sendGapMs: 0,
      },
      text,
    ).then(({ summary, replies }) => ({ replies, stored: summary.stored, jobs: summary.jobsEnqueued, errors: summary.errors }));
  };

  const outRows = async (): Promise<Message[]> => {
    const { data, error } = await h.supabase.from('messages').select('*').eq('client_id', clientId).eq('direction', 'out');
    expect(error, 'cannot read out rows').toBeNull();
    return (data ?? []) as Message[];
  };

  it('one turn stores the inbound, runs the worker, and answers immediately', test(async () => {
    const chunks: string[] = [];
    const { replies, stored, jobs } = await chat(
      [replyJson(['Hello! How can I help?'])],
      'hello bot',
      { write: (c: string) => void chunks.push(c) },
    );

    expect(stored).toBe(1);
    expect(jobs).toBe(1);
    expect(replies).toEqual(['Hello! How can I help?']);

    const rows = await outRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wamid).toMatch(/^wamid\.FAKE\./);
    expect(rows[0]?.text).toBe('Hello! How can I help?');
    expect(rows[0]?.job_id).not.toBeNull();

    // usage was tracked and the print carries the body but no phone number.
    const { count } = await h.supabase.from('usage_log').select('id', { count: 'exact', head: true }).eq('client_id', clientId);
    expect(count).toBeGreaterThan(0);
    const printed = chunks.join('');
    expect(printed).toContain('Hello! How can I help?');
    expect(printed).not.toContain(phone);
  }));

  it('a second turn works and answers too', test(async () => {
    const { replies } = await chat([replyJson(['Second answer.'])], 'second message', { write: () => undefined });
    expect(replies).toEqual(['Second answer.']);
  }));

  it('survives a restart: rows from an earlier run never collide', test(async () => {
    const restartPhone = testPhone(h.tag, 32);
    const { data: contact, error: contactError } = await h.supabase
      .from('contacts')
      .insert({ client_id: clientId, phone: restartPhone })
      .select('id')
      .single();
    expect(contactError, 'cannot create the restart contact').toBeNull();
    const { error: rowError } = await h.supabase.from('messages').insert({
      client_id: clientId,
      contact_id: (contact as { id: string }).id,
      wamid: 'wamid.FAKE.1',
      direction: 'out',
      type: 'text',
      text: 'from the previous run',
    });
    expect(rowError, 'cannot seed the legacy fake row').toBeNull();

    const { replies, stored, errors } = await chat(
      [replyJson(['Fresh answer.'])],
      'after restart',
      { write: () => undefined },
      restartPhone,
    );

    expect(stored).toBe(1);
    expect(errors).toBe(0);
    expect(replies).toEqual(['Fresh answer.']);
    const { data: ownRows, error: ownError } = await h.supabase
      .from('messages')
      .select('wamid')
      .eq('client_id', clientId)
      .eq('contact_id', (contact as { id: string }).id)
      .eq('direction', 'out')
      .order('created_at');
    expect(ownError, 'cannot read own out rows').toBeNull();
    expect((ownRows ?? []).map((r) => r.wamid as string)).toEqual(['wamid.FAKE.1', expect.stringMatching(/^wamid\.FAKE\./)]);
    expect(logs()).not.toContain('duplicate key');
  }));

  it('refuses to run unless SEND_MODE is console', test(async () => {
    const config = loadEnv(baseEnv({ SEND_MODE: 'live' }));
    await expect(
      chatOnce({
        supabase: h.supabase,
        logger: createLogger({ level: 'debug', destination: stream }),
        llm: createFakeLlm([]),
        llmConfig: { provider: 'fake', apiKey: 'x', model: 'fake', timeoutMs: 5000, maxOutputTokens: 400 },
        config,
        demoClientId: clientId,
        demoPhoneNumberId: phoneNumberId,
      }, 'hi'),
    ).rejects.toThrow(/console/);
  }));

  it('cleanup removes the chat contact, its rows, sheet orphans and usage rows', test(async () => {
    const since = new Date().toISOString();
    await chat([replyJson(['To be cleaned.'])], 'to be cleaned', { write: () => undefined });
    const before = await outRows();
    expect(before.length).toBeGreaterThan(0);
    const { data: mine } = await h.supabase.from('contacts').select('id').eq('client_id', clientId).eq('phone', phone).single();

    const removed = await cleanupChatRows(h.supabase, clientId, phone, since);

    expect(removed.contacts).toBe(1);
    expect(removed.sheetOutbox).toBe(1);
    expect(removed.usageLog).toBeGreaterThan(0);
    const { data: leftover } = await h.supabase.from('messages').select('id').eq('contact_id', (mine as { id: string }).id);
    expect(leftover).toHaveLength(0);
    const { data: contacts } = await h.supabase.from('contacts').select('id').eq('client_id', clientId).eq('phone', phone);
    expect(contacts).toHaveLength(0);
    expect(logs()).not.toContain(phone);
  }));
});
