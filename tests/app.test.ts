import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { drainBackgroundWork } from '../src/webhook/route.js';
import { signPayload } from '../src/webhook/signature.js';
import { baseEnv, collectingStream } from './helpers.js';

describe('GET /healthz', () => {
  let server: Server;
  let baseUrl: string;
  const { stream } = collectingStream();

  beforeAll(async () => {
    // The config port is only used by server.ts; the test binds an ephemeral port.
    const config = loadEnv(baseEnv());
    const app = createApp({ config, logger: createLogger({ level: 'silent', destination: stream }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 200 with the enabled features and no secrets', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.env).toBe('test');
    expect(body.features).toMatchObject({ database: true, whatsapp: false, llm: false });
    expect(JSON.stringify(body)).not.toContain('test-service-role-key');
  });

  it('returns 404 json for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('request log line', () => {
  // The shared server above logs at 'silent', so this block runs its own app
  // with a recording logger: every request must leave one debug line with
  // method + path + status, and that line must never contain the query string.
  let server: Server;
  let baseUrl: string;
  const vis = collectingStream();

  const records = (): Array<Record<string, unknown>> =>
    vis
      .text()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    const config = loadEnv(
      baseEnv({
        META_APP_SECRET: 'test-app-secret',
        META_VERIFY_TOKEN: 'test-verify-token-16',
        GRAPH_API_VERSION: 'v21.0',
      }),
    );
    const app = createApp({
      config,
      logger: createLogger({ level: 'debug', destination: vis.stream }),
      supabase: {} as unknown as SupabaseClient,
      ingest: async () => undefined,
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

  it('logs method, path and status for a GET', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const record = records().find((r) => r['msg'] === 'http request' && r['path'] === '/healthz');
    expect(record, 'no request line was logged').toBeDefined();
    expect(record).toMatchObject({ level: 'debug', method: 'GET', status: 200 });
    expect(typeof record?.['durationMs']).toBe('number');
  });

  it('never logs the query string: no verify token, no challenge', async () => {
    const secret = 'test-verify-token-16';
    const res = await fetch(
      `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=CHALLENGE_CANARY_123`,
    );
    expect(res.status).toBe(200);
    const out = vis.text();
    expect(out).not.toContain(secret);
    expect(out).not.toContain('CHALLENGE_CANARY_123');
    const record = records().find((r) => r['msg'] === 'http request' && r['path'] === '/webhook');
    expect(record).toMatchObject({ method: 'GET', status: 200 });
  });

  it('logs a signed webhook POST the same way', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(raw, 'test-app-secret') },
      body: raw,
    });
    expect(res.status).toBe(200);
    await drainBackgroundWork();
    const record = records().find((r) => r['msg'] === 'http request' && r['method'] === 'POST');
    expect(record, 'no POST request line was logged').toBeDefined();
    expect(record).toMatchObject({ path: '/webhook', status: 200 });
  });
});
