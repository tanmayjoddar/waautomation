import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvError, loadEnv, loadEnvFromFile, parseDotEnv } from '../src/config.js';
import { baseEnv } from './helpers.js';

describe('loadEnv - always required', () => {
  it('accepts a minimal env and applies the spec defaults', () => {
    const config = loadEnv(baseEnv());
    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(3000);
    expect(config.timings).toEqual({ sheetSyncIntervalSeconds: 10, debounceSeconds: 3, maxVoiceBytes: 1_500_000 });
    expect(config.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(config.logLevel).toBe('info');
  });

  it('fails fast and names the missing variable when SUPABASE_URL is absent', () => {
    let error: unknown;
    try {
      loadEnv({ SUPABASE_SERVICE_ROLE_KEY: 'x' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).problems.join('\n')).toContain('SUPABASE_URL');
    expect((error as Error).message).toContain('.env.example');
  });

  it('reports every problem at once, not one per restart', () => {
    let error: unknown;
    try {
      loadEnv({ PORT: 'not-a-port', QUIET_HOURS_START: '25:00' });
    } catch (err) {
      error = err;
    }
    const problems = (error as EnvError).problems.join('\n');
    expect(problems).toContain('PORT');
    expect(problems).toContain('QUIET_HOURS_START');
    expect(problems).toContain('SUPABASE_URL');
  });

  it('never echoes a secret value back in the error message', () => {
    const secret = 'super-secret-service-role-value';
    let message = '';
    try {
      loadEnv({ ...baseEnv(), SUPABASE_URL: 'not a url', SUPABASE_SERVICE_ROLE_KEY: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(secret);
  });
});

describe('loadEnv - feature groups', () => {
  it('leaves every optional feature off when no related variable is set', () => {
    const { features } = loadEnv(baseEnv());
    expect(features).toEqual({
      database: true,
      whatsapp: false,
      whatsappDemo: false,
      llm: false,
      stt: false,
      sheets: false,
      telegram: false,
    });
  });

  it('enables a feature when its whole group is present', () => {
    const config = loadEnv(
      baseEnv({
        LLM_PROVIDER: 'fake',
        LLM_API_KEY: 'not-used',
        LLM_MODEL: 'canned',
      }),
    );
    expect(config.features.llm).toBe(true);
    expect(config.llm).toEqual({ provider: 'fake', apiKey: 'not-used', model: 'canned' });
    expect(config.stt).toBeNull();
  });

  it('rejects a half-filled group instead of silently disabling it', () => {
    let error: unknown;
    try {
      loadEnv(baseEnv({ LLM_API_KEY: 'sk-something' }));
    } catch (err) {
      error = err;
    }
    const problems = (error as EnvError).problems.join('\n');
    expect(problems).toContain('LLM_API_KEY');
    expect(problems).toContain('LLM_PROVIDER');
    expect(problems).toContain('LLM_MODEL');
  });

  it('keeps demo-mode credentials separate from the WhatsApp group', () => {
    const config = loadEnv(
      baseEnv({
        META_APP_SECRET: 'meta-secret',
        META_VERIFY_TOKEN: 'a-long-verify-token',
        GRAPH_API_VERSION: 'v21.0',
        WA_PHONE_NUMBER_ID: '1234567890',
        WA_TOKEN: 'EAAG-demo-token',
      }),
    );
    expect(config.features.whatsapp).toBe(true);
    expect(config.features.whatsappDemo).toBe(true);
    expect(config.meta).toEqual({
      appSecret: 'meta-secret',
      verifyToken: 'a-long-verify-token',
      graphApiVersion: 'v21.0',
    });
    expect(config.whatsappDemo).toEqual({ phoneNumberId: '1234567890', token: 'EAAG-demo-token' });
  });

  it('rejects a short META_VERIFY_TOKEN and a malformed GRAPH_API_VERSION', () => {
    let error: unknown;
    try {
      loadEnv(
        baseEnv({ META_APP_SECRET: 's', META_VERIFY_TOKEN: 'short', GRAPH_API_VERSION: '21.0' }),
      );
    } catch (err) {
      error = err;
    }
    const problems = (error as EnvError).problems.join('\n');
    expect(problems).toContain('META_VERIFY_TOKEN');
    expect(problems).toContain('GRAPH_API_VERSION');
  });
});

describe('loadEnv - encryption key', () => {
  it('decodes a base64 32-byte key to a Buffer', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const config = loadEnv(baseEnv({ ENCRYPTION_KEY: key }));
    expect(config.encryptionKey).toBeInstanceOf(Buffer);
    expect(config.encryptionKey?.length).toBe(32);
  });

  it('rejects a key that is not 32 bytes', () => {
    let error: unknown;
    try {
      loadEnv(baseEnv({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }));
    } catch (err) {
      error = err;
    }
    expect((error as EnvError).problems.join('\n')).toContain('ENCRYPTION_KEY');
  });

  it('rejects a key that is not base64 at all', () => {
    let error: unknown;
    try {
      loadEnv(baseEnv({ ENCRYPTION_KEY: 'openssl-rand-base64-32' }));
    } catch (err) {
      error = err;
    }
    expect((error as EnvError).problems.join('\n')).toContain('ENCRYPTION_KEY');
  });
});

describe('loadEnv - production rules', () => {
  it('requires PUBLIC_BASE_URL, ENCRYPTION_KEY and the WhatsApp group in production', () => {
    let error: unknown;
    try {
      loadEnv(baseEnv({ NODE_ENV: 'production' }));
    } catch (err) {
      error = err;
    }
    const problems = (error as EnvError).problems.join('\n');
    expect(problems).toContain('PUBLIC_BASE_URL');
    expect(problems).toContain('ENCRYPTION_KEY');
    expect(problems).toContain('WhatsApp Cloud API');
  });

  it('boots in production when everything required is there', () => {
    const config = loadEnv(
      baseEnv({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://wa.example.com',
        ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        META_APP_SECRET: 'meta-secret',
        META_VERIFY_TOKEN: 'a-long-verify-token',
        GRAPH_API_VERSION: 'v21.0',
      }),
    );
    expect(config.isProduction).toBe(true);
    expect(config.publicBaseUrl).toBe('https://wa.example.com');
  });
});

describe('Google service account key', () => {
  it('turns the literal \\n of a .env value into real newlines', () => {
    const config = loadEnv(
      baseEnv({
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'bot@project.iam.gserviceaccount.com',
        GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nline1\\nline2\\n-----END PRIVATE KEY-----\\n',
      }),
    );
    expect(config.sheets?.privateKey).toContain('\n');
    expect(config.sheets?.privateKey).not.toContain('\\n');
  });
});

describe('.env parsing', () => {
  it('handles comments, blank lines, inline comments and quotes', () => {
    const parsed = parseDotEnv(
      [
        '# a comment',
        '',
        'PORT=3000',
        'PUBLIC_BASE_URL=   # inline comment',
        'META_VERIFY_TOKEN="quoted # not a comment"',
        "OTHER='single'",
        'BROKEN_LINE',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PORT: '3000',
      PUBLIC_BASE_URL: '',
      META_VERIFY_TOKEN: 'quoted # not a comment',
      OTHER: 'single',
    });
  });

  it('lets the real process env win over the file', () => {
    const config = loadEnvFromFile('.env', baseEnv({ PORT: '4321' }));
    expect(config.port).toBe(4321);
  });

  it('works when no .env file exists at all', () => {
    const config = loadEnvFromFile('does-not-exist.env', baseEnv());
    expect(config.port).toBe(3000);
  });
});

describe('.env.example stays in sync with config.ts', () => {
  const envExampleKeys = (): string[] => {
    const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    return Object.keys(parseDotEnv(text));
  };

  it('documents every variable the app reads', () => {
    const documented = envExampleKeys();
    for (const key of ENV_KEYS) expect(documented, `.env.example is missing ${key}`).toContain(key);
  });

  it('documents no variable the app ignores', () => {
    const known = ENV_KEYS as string[];
    for (const key of envExampleKeys()) expect(known, `.env.example has unknown ${key}`).toContain(key);
  });

  it('leaves every credential in .env.example blank', () => {
    const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const values = parseDotEnv(text);
    const credentials = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ANON_KEY',
      'META_APP_SECRET',
      'META_VERIFY_TOKEN',
      'GRAPH_API_VERSION',
      'WA_PHONE_NUMBER_ID',
      'WA_TOKEN',
      'ENCRYPTION_KEY',
      'LLM_PROVIDER',
      'LLM_API_KEY',
      'LLM_MODEL',
      'STT_PROVIDER',
      'STT_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_PRIVATE_KEY',
      'PUBLIC_BASE_URL',
    ];
    for (const key of credentials) {
      expect(values[key] ?? '', `.env.example must not contain a value for ${key}`).toBe('');
    }
  });
});
