/**
 * Send-mode factory tests (Slice 3). No Meta, no database: the live path gets
 * a stubbed fetch, the console path gets a capturing writable.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { consoleClient, resolveWhatsAppClient } from '../../src/whatsapp/sendMode.js';
import { baseEnv } from '../helpers.js';

const DEMO_NUMBER_ID = 'demo-phone-number-id';
const DEMO_TOKEN = 'demo-token-must-never-appear-in-logs';
const OTHER_NUMBER_ID = 'other-phone-number-id';
const TO = '919812345678';

const logger = () => createLogger({ level: 'silent' });

const demoEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
  baseEnv({
    META_APP_SECRET: 'test-app-secret',
    META_VERIFY_TOKEN: 'test-verify-token-16',
    GRAPH_API_VERSION: 'v21.0',
    WA_PHONE_NUMBER_ID: DEMO_NUMBER_ID,
    WA_TOKEN: DEMO_TOKEN,
    ...overrides,
  });

describe('resolveWhatsAppClient', () => {
  it('live mode builds a real client that POSTs to the target number id', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push({ url: String(url) });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.LIVE.1' }] }), { status: 200 });
    }) as typeof fetch;
    const config = loadEnv(demoEnv({ SEND_MODE: 'live' }));

    const client = resolveWhatsAppClient(config, logger(), { clientId: 'c1', phoneNumberId: DEMO_NUMBER_ID, token: DEMO_TOKEN }, { fetchImpl });
    const result = await client.sendText(TO, 'hi');

    expect(result).toEqual({ wamid: 'wamid.LIVE.1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`/${DEMO_NUMBER_ID}/messages`);
  });

  it('live mode without the META_* group throws before any send', async () => {
    const config = loadEnv(baseEnv({ WA_PHONE_NUMBER_ID: DEMO_NUMBER_ID, WA_TOKEN: DEMO_TOKEN }));
    expect(() =>
      resolveWhatsAppClient(config, logger(), { clientId: 'c1', phoneNumberId: DEMO_NUMBER_ID, token: DEMO_TOKEN }),
    ).toThrow(/META_\*/);
  });

  it('console mode sends via the fake, prints the body, never the phone', async () => {
    const chunks: string[] = [];
    const config = loadEnv(demoEnv({ SEND_MODE: 'console' }));

    const client = resolveWhatsAppClient(
      config,
      logger(),
      { clientId: 'c1', phoneNumberId: DEMO_NUMBER_ID, token: DEMO_TOKEN },
      { out: { write: (c: string) => void chunks.push(c) } },
    );
    const result = await client.sendText(TO, 'would-be reply');
    await client.markReadAndType('wamid.IN.1');

    expect(result.wamid).toMatch(/^wamid\.FAKE\.\d+$/);
    const out = chunks.join('');
    expect(out).toContain('would-be reply');
    expect(out).not.toContain(TO);
    expect(out).not.toContain(DEMO_TOKEN);
  });

  it('console mode refuses any non-demo client, without leaking addressing info', () => {
    const config = loadEnv(demoEnv({ SEND_MODE: 'console' }));
    expect(() =>
      resolveWhatsAppClient(config, logger(), { clientId: 'c2', phoneNumberId: OTHER_NUMBER_ID, token: 'other-token' }),
    ).toThrow(/demo client only/);
  });

  it('console mode with no demo configured refuses everything', () => {
    const config = loadEnv(baseEnv({ SEND_MODE: 'console' }));
    expect(() =>
      resolveWhatsAppClient(config, logger(), { clientId: 'c1', phoneNumberId: DEMO_NUMBER_ID, token: DEMO_TOKEN }),
    ).toThrow(/demo client only/);
  });
});

describe('consoleClient', () => {
  it('prints to the given writable, not the logger', async () => {
    // consoleClient takes no logger at all: there is no path by which a reply
    // body could enter the logs.
    const chunks: string[] = [];
    const client = consoleClient(undefined, { write: (c: string) => void chunks.push(c) });

    const result = await client.sendText(TO, 'hello console');

    expect(result.wamid).toMatch(/^wamid\.FAKE\.\d+$/);
    expect(chunks.join('')).toContain('hello console');
    expect(chunks.join('')).not.toContain(TO);
  });
});
