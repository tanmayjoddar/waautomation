import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createLogger } from '../src/logger.js';
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
