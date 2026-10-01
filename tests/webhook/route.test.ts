/**
 * Route tests (spec 1.6): the GET handshake, signature enforcement on POST, and
 * the rule that the 200 is sent before any work happens.
 *
 * The Supabase client is a stub and the ingest pipeline is injected, so these
 * tests prove HTTP behaviour only. Nothing here touches a database.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { drainBackgroundWork, type WebhookDeps } from '../../src/webhook/route.js';
import { signPayload } from '../../src/webhook/signature.js';
import { baseEnv, collectingStream } from '../helpers.js';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const PATH = '/webhook';

const supabase = {} as unknown as SupabaseClient;

const metaEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
  baseEnv({
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    GRAPH_API_VERSION: 'v21.0',
    ...overrides,
  });

describe('POST /webhook', () => {
  let server: Server;
  let baseUrl: string;
  let ingest: WebhookDeps['ingest'];
  const { stream, text: logs } = collectingStream();

  beforeAll(async () => {
    const config = loadEnv(metaEnv());
    const app = createApp({
      config,
      logger: createLogger({ level: 'silent', destination: stream }),
      supabase,
      ingest: async (...args) => (ingest ?? (async () => undefined))(...args),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await drainBackgroundWork();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await drainBackgroundWork();
    ingest = undefined;
  });

  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'A', changes: [] }] });

  const post = (raw: string, headers: Record<string, string> = {}, path = PATH): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });

  const signed = (raw: string = body, secret = APP_SECRET): Record<string, string> => ({
    'x-hub-signature-256': signPayload(raw, secret),
  });

  it('accepts a correctly signed payload with 200', async () => {
    ingest = vi.fn(async () => undefined);
    const res = await post(body, signed());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('hands the parsed payload to the ingest pipeline', async () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'A', changes: [{ value: { metadata: { phone_number_id: 'PN-1' } } }] }] };
    ingest = vi.fn(async () => undefined);
    await post(JSON.stringify(payload), signed(JSON.stringify(payload)));
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ logger: expect.anything(), debounceSeconds: expect.any(Number) }), payload);
  });

  describe('signature enforcement', () => {
    it('rejects a missing signature with 401 and does no work', async () => {
      ingest = vi.fn(async () => undefined);
      const res = await post(body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_signature' });
      expect(ingest).not.toHaveBeenCalled();
    });

    it('rejects a signature from the wrong secret', async () => {
      ingest = vi.fn(async () => undefined);
      const res = await post(body, signed(body, 'not-the-secret'));
      expect(res.status).toBe(401);
      expect(ingest).not.toHaveBeenCalled();
    });

    it('rejects a malformed signature header', async () => {
      ingest = vi.fn(async () => undefined);
      for (const value of ['', 'garbage', 'sha1=abc', `sha256=${'z'.repeat(64)}`, `sha256=${'a'.repeat(63)}`]) {
        const res = await post(body, { 'x-hub-signature-256': value });
        expect(res.status, `header ${JSON.stringify(value)}`).toBe(401);
      }
      expect(ingest).not.toHaveBeenCalled();
    });

    it('rejects a signature computed over different bytes, which is why the raw body is kept', async () => {
      ingest = vi.fn(async () => undefined);
      // Signed for the compact form, sent with pretty-printed whitespace: the
      // signature is invalid and must not be forgiven.
      const sent = JSON.stringify({ object: 'whatsapp_business_account', entry: [] }, null, 2);
      const res = await post(sent, signed(JSON.stringify({ object: 'whatsapp_business_account', entry: [] })));
      expect(res.status).toBe(401);
      expect(ingest).not.toHaveBeenCalled();
    });

    it('accepts a body Meta sent with an unusual content type', async () => {
      ingest = vi.fn(async () => undefined);
      const res = await fetch(`${baseUrl}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...signed() },
        body,
      });
      expect(res.status).toBe(200);
    });

    it('never echoes the expected signature or the body in the response', async () => {
      const res = await post(body, { 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` });
      const raw = await res.text();
      expect(raw).not.toContain('a'.repeat(64));
      expect(raw).not.toContain(APP_SECRET);
      expect(raw).not.toContain('whatsapp_business_account');
    });
  });

  describe('malformed requests', () => {
    it('rejects an empty body with 400', async () => {
      ingest = vi.fn(async () => undefined);
      const res = await post('', { 'x-hub-signature-256': signPayload('', APP_SECRET) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'empty_body' });
      expect(ingest).not.toHaveBeenCalled();
    });

    it('answers 200 for a signed body that is not JSON, then logs instead of crashing', async () => {
      ingest = vi.fn(async () => undefined);
      const res = await post('{not json', signed('{not json'));
      expect(res.status).toBe(200);
      await drainBackgroundWork();
      expect(ingest).not.toHaveBeenCalled();
    });

    it('answers 404 for another path', async () => {
      const res = await post(body, signed(), '/webhooks');
      expect(res.status).toBe(404);
    });
  });

  describe('answer first, work second', () => {
    it('responds before the slow work finishes, and the work still finishes', async () => {
      let finished = false;
      ingest = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              finished = true;
              resolve();
            }, 400);
          }),
      );

      const started = Date.now();
      const res = await post(body, signed());
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      // The response must not wait for the 400ms of work below.
      expect(elapsed).toBeLessThan(300);
      expect(finished).toBe(false);

      await drainBackgroundWork();
      expect(finished).toBe(true);
    });

    it('a failing pipeline cannot change the already-sent response', async () => {
      ingest = vi.fn(async () => {
        throw new Error('database is on fire');
      });
      const res = await post(body, signed());
      expect(res.status).toBe(200);
      await expect(drainBackgroundWork()).resolves.toBeUndefined();
    });

    it('two deliveries in flight at once are both drained', async () => {
      ingest = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await Promise.all([post(body, signed()), post(body, signed())]);
      await drainBackgroundWork();
      expect(ingest).toHaveBeenCalledTimes(2);
    });
  });

  describe('logging', () => {
    it('does not print the app secret or a signature', async () => {
      ingest = vi.fn(async () => undefined);
      await post(body, signed());
      await post(body, { 'x-hub-signature-256': 'garbage' });
      await drainBackgroundWork();
      const log = logs();
      expect(log).not.toContain(APP_SECRET);
      expect(log).not.toContain(APP_SECRET.length > 0 ? signPayload(body, APP_SECRET).slice(7, 27) : 'x');
    });
  });

  describe('webhook visibility', () => {
    // The shared server above logs at 'silent', so these tests run their own
    // app with a recording logger: every accepted POST must leave exactly one
    // info line with counts, and that line must carry no customer data.
    let visServer: Server;
    let visBase = '';
    let visIngest: WebhookDeps['ingest'];
    const vis = collectingStream();

    const records = (): Array<Record<string, unknown>> =>
      vis
        .text()
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);

    beforeAll(async () => {
      const config = loadEnv(metaEnv());
      const app = createApp({
        config,
        logger: createLogger({ level: 'debug', destination: vis.stream }),
        supabase,
        ingest: async (...args) => (visIngest ?? (async () => undefined))(...args),
      });
      visServer = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = visServer.address() as AddressInfo;
      visBase = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await drainBackgroundWork();
      await new Promise<void>((resolve) => visServer.close(() => resolve()));
    });

    const visPost = (raw: string, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${visBase}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw,
      });

    it('logs every accepted POST at info with message/status counts and the business number id', async () => {
      visIngest = vi.fn(async () => undefined);
      const phone = '919000000001';
      const text = 'VISIBILITY_CANARY_TEXT_987';
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA-VIS',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550000000', phone_number_id: 'PN-VIS' },
                  messages: [{ from: phone, id: 'wamid.VIS.1', timestamp: '1', type: 'text', text: { body: text } }],
                  statuses: [{ id: 'wamid.VIS.OUT.1', status: 'delivered', timestamp: '1' }],
                },
              },
            ],
          },
        ],
      });

      const res = await visPost(raw, signed(raw));
      expect(res.status).toBe(200);
      await drainBackgroundWork();

      const receipt = records().find((r) => r['msg'] === 'webhook POST received');
      expect(receipt, 'no receipt line was logged').toBeDefined();
      expect(receipt).toMatchObject({ level: 'info', messages: 1, statuses: 1, phoneNumberIds: ['PN-VIS'] });
      // The receipt carries counts and the business id only: no customer data.
      const out = vis.text();
      expect(out).not.toContain(phone);
      expect(out).not.toContain(text);
    });

    it('answers 200 for a signed body that is not JSON, warns, and schedules no work', async () => {
      visIngest = vi.fn(async () => undefined);
      const res = await visPost('{not json', signed('{not json'));
      expect(res.status).toBe(200);
      await drainBackgroundWork();
      expect(visIngest).not.toHaveBeenCalled();
      const warn = records().find((r) => typeof r['msg'] === 'string' && (r['msg'] as string).includes('not valid JSON'));
      expect(warn, 'no invalid-JSON warning was logged').toBeDefined();
      expect(warn?.['level']).toBe('warn');
    });
  });
});

describe('GET /webhook', () => {
  let server: Server;
  let baseUrl: string;
  const { stream } = collectingStream();

  beforeAll(async () => {
    const config = loadEnv(metaEnv());
    const app = createApp({ config, logger: createLogger({ level: 'silent', destination: stream }), supabase });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const verify = (query: string): Promise<Response> => fetch(`${baseUrl}${PATH}?${query}`);

  it('echoes the challenge as plain text for a valid subscription', async () => {
    const res = await verify(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('1158201444');
  });

  it('rejects a wrong verify token with 403', async () => {
    const res = await verify('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1158201444');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('1158201444');
  });

  it('rejects a wrong mode with 403', async () => {
    const res = await verify(`hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(403);
  });

  it('rejects missing parameters with 403', async () => {
    for (const query of ['', 'hub.mode=subscribe', `hub.verify_token=${VERIFY_TOKEN}`, 'hub.challenge=1']) {
      expect((await verify(query)).status, query).toBe(403);
    }
  });

  it('rejects a duplicated challenge instead of echoing a half-answer as 200', async () => {
    const res = await verify(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=a&hub.challenge=b`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('"a"');
  });

  it('rejects an empty challenge', async () => {
    expect((await verify(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=`)).status).toBe(403);
  });
});

describe('POST /webhook without Meta configured', () => {
  let server: Server;
  let baseUrl: string;
  const { stream } = collectingStream();

  beforeAll(async () => {
    // No META_* at all: the WhatsApp feature group stays off.
    const config = loadEnv(baseEnv());
    const app = createApp({ config, logger: createLogger({ level: 'silent', destination: stream }), supabase });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is mounted but cannot be verified when Meta is off', async () => {
    // No token is configured, so nothing can satisfy the handshake.
    const res = await fetch(`${baseUrl}${PATH}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
    expect(res.status).toBe(403);
  });

  it('answers 503 for POST rather than pretending the signature was bad', async () => {
    const res = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=whatever' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'whatsapp_not_configured' });
  });
});