import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('.env file: quoted values and escaped newlines', () => {
  const sheets = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'bot@project.iam.gserviceaccount.com',
  } as const;

  it('reads a double-quoted private key and converts every \\n into a real newline', () => {
    const { sheets: parsed } = loadEnv(
      baseEnv({
        ...sheets,
        GOOGLE_PRIVATE_KEY:
          '"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\nabc\\n-----END PRIVATE KEY-----\\n"',
      }),
    );
    expect(parsed?.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nabc\n-----END PRIVATE KEY-----\n',
    );
    expect(parsed?.privateKey.split('\n').filter(Boolean)).toHaveLength(4);
    expect(parsed?.privateKey).not.toContain('\\n');
    expect(parsed?.privateKey).not.toContain('"');
  });

  it('reads a single-quoted private key the same way', () => {
    const { sheets: parsed } = loadEnv(
      baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: "'-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----'" }),
    );
    expect(parsed?.privateKey).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    expect(parsed?.privateKey).not.toContain('\\n');
  });

  it('keeps a # inside a quoted value instead of treating it as a comment', () => {
    // Proved on the .env reader, where comment handling belongs.
    expect(parseDotEnv('A="line#one\\nline#two"').A).toBe('line#one\\nline#two');
    expect(parseDotEnv('A=one # two').A, 'whitespace before # starts a comment').toBe('one');
    expect(parseDotEnv('A=line#one').A, 'no whitespace, so the # belongs to the value').toBe('line#one');
  });

  it('strips an inline comment from an unquoted value but not from a quoted one', () => {
    expect(parseDotEnv('A=one # two').A).toBe('one');
    expect(parseDotEnv('A="one # two"').A).toBe('one # two');
  });

  it('preserves a quoted value that has leading and trailing spaces', () => {
    expect(parseDotEnv('A="  spaced  "').A).toBe('  spaced  ');
    expect(parseDotEnv('A=  spaced  ').A).toBe('spaced');
  });

  it('handles a real multi-line PEM block pasted into the file', () => {
    const text = [
      'GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'abc',
      'def',
      '-----END PRIVATE KEY-----"',
    ].join('\n');
    // `.env` cannot hold a multi-line value, so the paste is broken by the file
    // format itself. Assert the honest failure: only the first line survives,
    // and that fragment is not silently accepted as a private key.
    expect(parseDotEnv(text).GOOGLE_PRIVATE_KEY).toBe('"-----BEGIN PRIVATE KEY-----');
    expect(() => loadEnv(baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: parseDotEnv(text).GOOGLE_PRIVATE_KEY }))).toThrow(
      EnvError,
    );
  });

  it('the config value ends up as one usable line per PEM row', () => {
    const config = loadEnv(
      baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nabc\\ndef\\n-----END PRIVATE KEY-----"' }),
    );
    const key = config.sheets?.privateKey as string;
    expect(key.split('\n').filter((line) => line !== '')).toEqual([
      '-----BEGIN PRIVATE KEY-----',
      'abc',
      'def',
      '-----END PRIVATE KEY-----',
    ]);
    expect(key).toContain('BEGIN PRIVATE KEY');
  });

  it('rejects a half-filled Sheets group instead of running with a broken key', () => {
    // Email without key (or the reverse) is a mistake worth failing on: the
    // feature is either fully configured or off.
    expect(() => loadEnv(baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: '' }))).toThrow(EnvError);
    expect(() =>
      loadEnv(baseEnv({ GOOGLE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"' })),
    ).toThrow(EnvError);
  });

  it('leaves Sheets off when neither variable is set', () => {
    const config = loadEnv(baseEnv({}));
    expect(config.features.sheets).toBe(false);
    expect(config.sheets).toBeNull();
  });

  it('accepts a real multi-line key when it comes from the shell, and rejects the truncated .env paste', () => {
    // Docker `-e`, a hosting secret editor or process.env can hold a genuine
    // multi-line PEM, and that is valid: the surrounding quotes are stripped and
    // the real newlines survive.
    const fromShell = [
      '"-----BEGIN PRIVATE KEY-----',
      'abc',
      'def',
      '-----END PRIVATE KEY-----"',
    ].join('\n');
    const config = loadEnv(baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: fromShell }));
    expect(config.sheets?.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----',
    );

    // The .env path is different: only the first line of that paste survives
    // parsing, leaving a fragment that must be refused rather than shipped to
    // Google as a broken credential.
    const truncated = parseDotEnv(
      ['GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----', 'abc', 'def', '-----END PRIVATE KEY-----"'].join('\n'),
    ).GOOGLE_PRIVATE_KEY;
    expect(() => loadEnv(baseEnv({ ...sheets, GOOGLE_PRIVATE_KEY: truncated ?? '' }))).toThrow(/does not look like/);
  });
});

describe('Supabase key roles', () => {
  const serviceKey = (role: string): string =>
    `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ role, iss: 'supabase' }),
    ).toString('base64url')}.signature`;

  it('accepts the documented new-style secret and publishable keys', () => {
    const config = loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc123' }));
    expect(config.supabase.serviceRoleKey).toBe('sb_secret_abc123');
  });

  it('accepts a legacy service_role JWT', () => {
    expect(loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: serviceKey('service_role') })).supabase.serviceRoleKey).toBeTruthy();
  });

  it('rejects a publishable key in the service-role slot', () => {
    expect(() => loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abc123' }))).toThrow(
      /publishable\/anon key/,
    );
    expect(() => loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: serviceKey('anon') }))).toThrow(/publishable\/anon key/);
  });

  it('rejects a secret key in the anon slot, because that key bypasses RLS', () => {
    expect(() =>
      loadEnv(baseEnv({ SUPABASE_ANON_KEY: 'sb_secret_abc123' })),
    ).toThrow(/bypasses RLS/);
    expect(() => loadEnv(baseEnv({ SUPABASE_ANON_KEY: serviceKey('service_role') }))).toThrow(/bypasses RLS/);
  });

  it('accepts a publishable key in the anon slot', () => {
    const config = loadEnv(baseEnv({ SUPABASE_ANON_KEY: 'sb_publishable_abc123' }));
    expect(config.supabase.anonKey).toBe('sb_publishable_abc123');
  });

  it('does not complain about a key format it does not recognise', () => {
    // Failing on an unknown format would break a future key type this code has
    // never heard of; only the known-bad combinations are rejected.
    expect(loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'something-new' })).supabase.serviceRoleKey).toBe(
      'something-new',
    );
  });

  it('never puts key material in the error message', () => {
    let message = '';
    try {
      loadEnv(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_super_secret_value' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(message).not.toContain('super_secret_value');
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
    // Written to a scratch file on purpose: reading the repository's real .env
    // would make this test depend on whatever the developer has configured.
    const file = path.join(os.tmpdir(), `wa-env-test-${process.pid}.env`);
    fs.writeFileSync(file, ['PORT=9999', 'LOG_LEVEL=error', 'NODE_ENV=production', ''].join('\n'));
    try {
      const config = loadEnvFromFile(file, baseEnv({ PORT: '4321', NODE_ENV: 'test' }));
      expect(config.port, 'the real environment wins').toBe(4321);
      expect(config.logLevel, 'a value only the file has is still used').toBe('error');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('reads a copied .env.example without complaining about its blank values', () => {
    // The .env.example workflow is: copy the file, fill in the database keys.
    // Every optional variable is left blank, which must not look like an error.
    const example = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    const filled = example
      .split('\n')
      .map((line) => {
        const match = /^([A-Z0-9_]+)=/.exec(line);
        const key = match?.[1];
        if (key === undefined) return line;
        if (required.includes(key)) return `${key}=https://example.supabase.co`;
        return `${key}=`;
      })
      .join('\n');
    const config = loadEnv(baseEnv(parseDotEnv(filled)));
    expect(config.port).toBe(3000);
    expect(config.supabase.url).toBe('https://example.supabase.co');
    expect(config.features.llm, 'a blank LLM_API_KEY must not enable the feature').toBe(false);
    expect(config.llm).toBeNull();
    expect(config.features.whatsapp, 'blank Meta values must not enable WhatsApp').toBe(false);
    expect(config.meta).toBeNull();
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
