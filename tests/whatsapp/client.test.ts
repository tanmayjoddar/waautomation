/**
 * WhatsApp adapter tests (Slice 3). Every Meta call is a stubbed fetch, so
 * these prove HTTP behaviour only: URL, headers, body shapes, the retry rule
 * (one retry on 5xx/network, none on 4xx), and that failures never log the
 * token or a full phone number. Nothing here touches Meta or a database.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { createWhatsAppClient, WhatsAppApiError } from '../../src/whatsapp/client.js';
import { collectingStream } from '../helpers.js';

const PHONE_NUMBER_ID = '1315124785021815';
const TOKEN = 'test-wa-token-must-never-appear-in-logs';
const GRAPH = 'v21.0';
const TO = '919812345678';
const WAMID = 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA';

type Call = { url: string; init: RequestInit };

/** A fetch stub playing a script: each entry is a Response or a thrown error. */
function stubFetch(script: Array<Response | Error>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return next as Response;
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const metaError = (status: number, code: number): Response =>
  json({ error: { message: 'Something went wrong', code, type: 'OAuthException', fbtrace_id: 'abc' } }, status);

const client = (fetchImpl: typeof fetch, logger?: ReturnType<typeof createLogger>) =>
  createWhatsAppClient({ phoneNumberId: PHONE_NUMBER_ID, token: TOKEN, graphApiVersion: GRAPH, fetchImpl, logger });

/** Our client always sends a plain object, so the stub can read it directly. */
const authOf = (call: Call): string => {
  const headers = call.init.headers as unknown as Record<string, string> | undefined;
  return headers?.['Authorization'] ?? headers?.['authorization'] ?? '';
};

describe('sendText', () => {
  it('POSTs the documented shape and returns Meta\'s wamid', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([
      json({ messaging_product: 'whatsapp', contacts: [{ input: TO, wa_id: TO }], messages: [{ id: WAMID }] }),
    ]);

    const result = await client(fetch).sendText(TO, 'Hi Rahul!');

    expect(result).toEqual({ wamid: WAMID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://graph.facebook.com/${GRAPH}/${PHONE_NUMBER_ID}/messages`);
    expect(authOf(calls[0] as Call)).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Docs want the plus; our contacts store digits without it.
      to: `+${TO}`,
      type: 'text',
      text: { body: 'Hi Rahul!' },
    });
  });

  it('does NOT retry a 4xx and reports Meta\'s error code', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([metaError(400, 131009)]);

    const error = await client(fetch).sendText(TO, 'hi').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect((error as WhatsAppApiError).status).toBe(400);
    expect((error as WhatsAppApiError).metaCode).toBe(131009);
    expect((error as WhatsAppApiError).attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a 429 either: 4xx is 4xx', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([metaError(429, 80007)]);
    await expect(client(fetch).sendText(TO, 'hi')).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(calls).toHaveLength(1);
  });

  it('retries ONCE on a 5xx and then succeeds', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([
      new Response('bad gateway', { status: 502 }),
      json({ messages: [{ id: WAMID }] }),
    ]);

    const result = await client(fetch).sendText(TO, 'hi');
    expect(result).toEqual({ wamid: WAMID });
    expect(calls).toHaveLength(2);
  });

  it('gives up after the single retry on persistent 5xx', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([new Response('x', { status: 500 }), new Response('x', { status: 503 })]);

    const error = await client(fetch).sendText(TO, 'hi').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect((error as WhatsAppApiError).status).toBe(503);
    expect((error as WhatsAppApiError).attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('retries ONCE on a network error and then succeeds', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([new TypeError('fetch failed'), json({ messages: [{ id: WAMID }] })]);

    const result = await client(fetch).sendText(TO, 'hi');
    expect(result).toEqual({ wamid: WAMID });
    expect(calls).toHaveLength(2);
  });

  it('throws when Meta accepts but returns no wamid', async () => {
    const { fetchImpl: fetch } = stubFetch([json({ messages: [] })]);
    await expect(client(fetch).sendText(TO, 'hi')).rejects.toThrow(/no wamid/);
  });

  it('throws on a 200 with an unparseable body', async () => {
    const { fetchImpl: fetch } = stubFetch([new Response('not json', { status: 200 })]);
    await expect(client(fetch).sendText(TO, 'hi')).rejects.toThrow(/unparseable/);
  });

  it('times out and retries once', async () => {
    const calls: Call[] = [];
    const slow = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      throw new Error('unreachable');
    }) as typeof fetch;

    const error = await createWhatsAppClient({
      phoneNumberId: PHONE_NUMBER_ID,
      token: TOKEN,
      graphApiVersion: GRAPH,
      fetchImpl: slow,
      timeoutMs: 50,
    })
      .sendText(TO, 'hi')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect((error as WhatsAppApiError).status).toBeNull();
    expect((error as WhatsAppApiError).attempts).toBe(2);
    expect(calls).toHaveLength(2);
  }, 15000);

  it('failure logs never contain the token or the full phone number', async () => {
    const { stream, text: logs } = collectingStream();
    const logger = createLogger({ level: 'debug', destination: stream });
    const { fetchImpl: fetch } = stubFetch([metaError(401, 190)]);

    await client(fetch, logger).sendText(TO, 'hi').catch(() => undefined);

    const out = logs();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TO);
    // The masked form is what debugging gets instead.
    expect(out).toContain('91********78');
  });
});

describe('markReadAndType', () => {
  it('POSTs the documented read+typing shape', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([json({ success: true })]);

    await client(fetch).markReadAndType(WAMID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://graph.facebook.com/${GRAPH}/${PHONE_NUMBER_ID}/messages`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: WAMID,
      typing_indicator: { type: 'text' },
    });
  });

  it('does NOT retry an invalid wamid (131009)', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([metaError(400, 131009)]);

    const error = await client(fetch).markReadAndType('wamid.BOGUS').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect((error as WhatsAppApiError).metaCode).toBe(131009);
    expect(calls).toHaveLength(1);
  });

  it('throws when Meta answers 200 without success:true', async () => {
    const { fetchImpl: fetch } = stubFetch([json({ success: false })]);
    await expect(client(fetch).markReadAndType(WAMID)).rejects.toThrow(/did not confirm/);
  });

  it('treats a network failure as retryable, once', async () => {
    const { fetchImpl: fetch, calls } = stubFetch([new TypeError('fetch failed'), json({ success: true })]);
    await client(fetch).markReadAndType(WAMID);
    expect(calls).toHaveLength(2);
  });
});

describe('redaction guard', () => {
  it('the logger itself masks phone-like values under the keys this adapter logs', () => {
    const { stream, text: logs } = collectingStream();
    const logger = createLogger({ level: 'debug', destination: stream });
    // Belt and suspenders with the adapter's own maskPhone: even if a future
    // caller logs a raw `to`, it must not appear in full.
    logger.info({ to: TO }, 'probe');
    const out = logs();
    expect(out).not.toContain(TO);
    expect(out).toContain('91********78');
  });
});
