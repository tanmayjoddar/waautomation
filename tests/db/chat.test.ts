/**
 * Console chat loop tests against a real Supabase project (Slice 3).
 *
 * chatOnce() runs the REAL ingest pipeline (contact upsert, dedupe, store,
 * reply-job enqueue, echo hooks) with a fake WhatsApp client, so these prove
 * the loop end to end without Meta. Everything belongs to a throwaway client
 * named `wa-test-chat-*`, deleted in afterAll. Skips like the other live suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatOnce, cleanupChatRows } from '../../scripts/chat.js';
import type { Message } from '../../src/db/types.js';
import { createLogger } from '../../src/logger.js';
import { collectingStream } from '../helpers.js';
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
const suiteName = ready.ok ? 'console chat (live database, fake WhatsApp)' : `console chat (skipped: ${ready.reason})`;

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
    skipReason = await schemaReadiness(h.supabase);
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
    text: string,
    out: { write(chunk: string): void },
    contactPhone: string = phone,
  ): Promise<{ replies: string[]; stored: number; jobs: number; errors: number }> =>
    chatOnce(
      {
        supabase: h.supabase,
        logger: createLogger({ level: 'debug', destination: stream }),
        demoClientId: clientId,
        demoPhoneNumberId: phoneNumberId,
        contactPhone,
        out,
      },
      text,
    ).then(({ summary, replies }) => ({ replies, stored: summary.stored, jobs: summary.jobsEnqueued, errors: summary.errors }));

  const outRows = async (): Promise<Message[]> => {
    const { data, error } = await h.supabase.from('messages').select('*').eq('client_id', clientId).eq('direction', 'out');
    expect(error, 'cannot read out rows').toBeNull();
    return (data ?? []) as Message[];
  };

  it('one turn stores the inbound, saves the out row with a fake wamid, and answers immediately', test(async () => {
    const chunks: string[] = [];
    const { replies, stored, jobs } = await chat('hello bot', { write: (c: string) => void chunks.push(c) });

    expect(stored).toBe(1);
    expect(jobs).toBe(1);
    expect(replies).toEqual(['I got: hello bot']);

    const rows = await outRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wamid).toMatch(/^wamid\.FAKE\./);
    expect(rows[0]?.text).toBe('I got: hello bot');

    // The printed reply carries the body but no phone number.
    const printed = chunks.join('');
    expect(printed).toContain('I got: hello bot');
    expect(printed).not.toContain(phone);
  }));

  it('a second turn works and answers too', test(async () => {
    const { replies } = await chat('second message', { write: () => undefined });
    expect(replies).toEqual(['I got: second message']);
  }));

  it('survives a restart: rows from an earlier run never collide', test(async () => {
    // The reported bug: the fake counter restarted at wamid.FAKE.1 on every
    // server start while out rows persisted, so the first send after a restart
    // died on the unique (client_id, wamid) constraint and the echo logged
    // "echo reply failed". Simulate that past: a contact holding an old-format
    // fake wamid, then a turn with a brand-new fake client. Own phone, so this
    // test is independent of the other tests' contact.
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
      text: 'I got: from the previous run',
    });
    expect(rowError, 'cannot seed the legacy fake row').toBeNull();

    const { replies, stored, errors } = await chat('after restart', { write: () => undefined }, restartPhone);

    expect(stored).toBe(1);
    expect(errors).toBe(0);
    expect(replies).toEqual(['I got: after restart']);
    // Scoped to this test's contact: earlier tests wrote out rows too.
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
    expect(logs()).not.toContain('out row was not saved');
  }));

  it('cleanup removes the chat contact, its rows and its sheet orphans', test(async () => {
    await chat('to be cleaned', { write: () => undefined });
    const before = await outRows();
    expect(before.length).toBeGreaterThan(0);
    // This test's contact id, captured before cleanup deletes it: the final
    // assertion must be scoped to it, because other tests share this client.
    const { data: mine } = await h.supabase.from('contacts').select('id').eq('client_id', clientId).eq('phone', phone).single();

    const removed = await cleanupChatRows(h.supabase, clientId, phone);

    expect(removed.contacts).toBe(1);
    expect(removed.sheetOutbox).toBe(1);
    const { data: leftover } = await h.supabase.from('messages').select('id').eq('contact_id', (mine as { id: string }).id);
    expect(leftover).toHaveLength(0);
    const { data: contacts } = await h.supabase.from('contacts').select('id').eq('client_id', clientId).eq('phone', phone);
    expect(contacts).toHaveLength(0);
    expect(logs()).not.toContain(phone);
  }));
});
