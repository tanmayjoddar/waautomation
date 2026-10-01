/**
 * Echo skip tests (Slice 3). Every skip path must log at warn with a reason,
 * and the line must carry no phone number, name or message text.
 *
 * Skips return before any database or Meta use, so these run without either:
 * the supabase client is an unusable stub on purpose, which also proves the
 * skips never reach it. The sending paths are covered live in
 * tests/db/echo.test.ts (fake Meta, real ingest + database).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { handleStoredMessageForEcho, type EchoDeps, type StoredMessageInfo } from '../../src/services/echo.js';
import { createFakeWhatsAppClient, type FakeWhatsAppClient } from '../../src/whatsapp/fake.js';
import { collectingStream } from '../helpers.js';

const PHONE = '919000000002';
const TEXT = 'ECHO_SKIP_CANARY_TEXT_654';

const setup = (): { deps: EchoDeps; fake: FakeWhatsAppClient; text: () => string } => {
  const { stream, text } = collectingStream();
  const fake = createFakeWhatsAppClient();
  const deps: EchoDeps = {
    // Unusable on purpose: a skip must return before touching the database.
    supabase: {} as unknown as SupabaseClient,
    whatsapp: fake,
    logger: createLogger({ level: 'debug', destination: stream }),
    demoClientId: 'demo-client-id',
  };
  return { deps, fake, text };
};

const info = (overrides: Partial<StoredMessageInfo> = {}): StoredMessageInfo => ({
  clientId: 'demo-client-id',
  contactId: 'contact-id',
  contactPhone: PHONE,
  wamid: 'wamid.ECHO.SKIP.1',
  type: 'text',
  text: TEXT,
  ...overrides,
});

const records = (text: string): Array<Record<string, unknown>> =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('echo skips', () => {
  it('a non-text message is skipped with a warn carrying the reason', async () => {
    const { deps, fake, text } = setup();

    const result = await handleStoredMessageForEcho(deps, info({ type: 'audio', text: null }));

    expect(result).toBe('skipped:not-text');
    expect(fake.sent).toHaveLength(0);
    const warn = records(text()).find((r) => r['msg'] === 'echo skipped');
    expect(warn, 'no skip line was logged').toBeDefined();
    expect(warn).toMatchObject({ level: 'warn', reason: 'not-text' });
    const out = text();
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(TEXT);
  });

  it('an empty text is skipped with its own reason', async () => {
    const { deps, fake, text } = setup();

    const result = await handleStoredMessageForEcho(deps, info({ text: '' }));

    expect(result).toBe('skipped:empty-text');
    expect(fake.sent).toHaveLength(0);
    const warn = records(text()).find((r) => r['msg'] === 'echo skipped');
    expect(warn).toMatchObject({ level: 'warn', reason: 'empty-text' });
  });

  it('a text for another client is refused with a warn', async () => {
    const { deps, fake, text } = setup();

    const result = await handleStoredMessageForEcho(deps, info({ clientId: 'some-other-client' }));

    expect(result).toBe('skipped:not-demo-client');
    expect(fake.sent).toHaveLength(0);
    const warn = records(text()).find((r) => typeof r['msg'] === 'string' && (r['msg'] as string).includes('non-demo client'));
    expect(warn, 'no refusal line was logged').toBeDefined();
    expect(warn?.['level']).toBe('warn');
    expect(text()).not.toContain(PHONE);
    expect(text()).not.toContain(TEXT);
  });

  it('a failed out-row save is reported as sent, not as a failed reply', async () => {
    // The customer HAS the reply in this case; only our record of it failed.
    // Saying "echo reply failed" would send the next debugging session to
    // Meta instead of the database.
    const { deps, fake, text } = setup();
    deps.supabase = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: 'db is down', code: 'XX000' } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await handleStoredMessageForEcho(deps, info({}));

    expect(result).toBe('sent-not-saved');
    expect(fake.sent).toHaveLength(1);
    const out = text();
    expect(out).not.toContain('echo reply failed');
    const record = records(out).find((r) => typeof r['msg'] === 'string' && (r['msg'] as string).includes('out row was not saved'));
    expect(record, 'no save-failure line was logged').toBeDefined();
    expect(record?.['level']).toBe('error');
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(TEXT);
  });
});
