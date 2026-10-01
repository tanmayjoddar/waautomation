/**
 * Environment loading and validation.
 *
 * Rules (see .env.example):
 *  - fail fast, with a readable message and the NAME of every problem;
 *  - never print, log or embed a secret value, not even in an error message;
 *  - a feature is ON only when its whole group of variables is present, so a
 *    half-configured integration is a startup error instead of a 2am surprise.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* schema                                                                     */
/* -------------------------------------------------------------------------- */

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in 24h format (e.g. 22:00)');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z
    .string()
    .url('must be a full https URL in production, e.g. https://wa.example.com')
    .optional(),

  SUPABASE_URL: z.string().url('must be the Supabase project URL, e.g. https://abc.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),

  META_APP_SECRET: z.string().min(1).optional(),
  META_VERIFY_TOKEN: z
    .string()
    .min(16, 'must be at least 16 characters; generate one with `openssl rand -hex 24`')
    .optional(),
  GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like v21.0 (check the current version in Meta docs [VERIFY])')
    .optional(),
  WA_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WA_TOKEN: z.string().min(1).optional(),
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'base64 of 32 bytes; generate one with `openssl rand -base64 32`')
    .optional(),

  LLM_PROVIDER: z.enum(['gemini', 'anthropic', 'openai', 'fake']).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),

  STT_PROVIDER: z.enum(['openai-whisper', 'gemini', 'google', 'sarvam', 'fake']).optional(),
  STT_API_KEY: z.string().min(1).optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email('must be the service account email address').optional(),
  GOOGLE_PRIVATE_KEY: z.string().min(1).optional(),
  SHEETS_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),

  DEBOUNCE_SECONDS: z.coerce.number().int().min(0).default(3),
  MAX_VOICE_BYTES: z.coerce.number().int().min(1).default(1_500_000),
  QUIET_HOURS_START: timeString.default('22:00'),
  QUIET_HOURS_END: timeString.default('07:00'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof z.infer<typeof envSchema>)[];

type RawEnv = Record<string, string | undefined>;
type Env = z.infer<typeof envSchema>;

/**
 * Feature groups. A group is ON when at least one of its variables is present;
 * then ALL of them are required. `WA_TOKEN`/demo mode is a group of its own so
 * a multi-client deployment does not have to ship a demo token.
 */
const FEATURE_GROUPS = [
  {
    key: 'whatsapp',
    label: 'WhatsApp Cloud API (webhook + signature verification)',
    keys: ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'GRAPH_API_VERSION'],
  },
  {
    key: 'whatsappDemo',
    label: 'WhatsApp demo mode (single client, uses WA_TOKEN)',
    keys: ['WA_PHONE_NUMBER_ID', 'WA_TOKEN'],
  },
  {
    key: 'llm',
    label: 'LLM (AI brain)',
    keys: ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL'],
  },
  {
    key: 'stt',
    label: 'speech-to-text (voice notes)',
    keys: ['STT_PROVIDER', 'STT_API_KEY'],
  },
  {
    key: 'sheets',
    label: 'Google Sheets client copy',
    keys: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'],
  },
  {
    key: 'telegram',
    label: 'Telegram staff alerts',
    keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; keys: readonly string[] }>;

export type FeatureKey = (typeof FEATURE_GROUPS)[number]['key'];

/* -------------------------------------------------------------------------- */
/* config shape                                                               */
/* -------------------------------------------------------------------------- */

export type Features = Record<FeatureKey, boolean> & { database: true };

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  publicBaseUrl: string | null;
  logLevel: Env['LOG_LEVEL'];
  supabase: { url: string; serviceRoleKey: string; anonKey: string | null };
  meta: { appSecret: string; verifyToken: string; graphApiVersion: string } | null;
  whatsappDemo: { phoneNumberId: string; token: string } | null;
  encryptionKey: Buffer | null;
  llm: { provider: 'gemini' | 'anthropic' | 'openai' | 'fake'; apiKey: string; model: string } | null;
  stt: { provider: 'openai-whisper' | 'gemini' | 'google' | 'sarvam' | 'fake'; apiKey: string } | null;
  telegram: { botToken: string; chatId: string } | null;
  sheets: { serviceAccountEmail: string; privateKey: string } | null;
  timings: { sheetSyncIntervalSeconds: number; debounceSeconds: number; maxVoiceBytes: number };
  quietHours: { start: string; end: string };
  features: Features;
};

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when the environment cannot be used. `problems` never contains values. */
export class EnvError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      [
        'Invalid environment configuration:',
        ...problems.map((p) => `  - ${p}`),
        '',
        'Copy .env.example to .env and fill in the blanks, then start again.',
        'Never paste secret values into a chat or commit .env.',
      ].join('\n'),
    );
    this.name = 'EnvError';
    this.problems = problems;
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * Removes one matching pair of surrounding quotes.
 *
 * `parseDotEnv` already does this for values that come from a `.env` file, but a
 * value can also arrive from the shell, a Docker `-e` flag or a hosting
 * platform's secret editor, and those often keep the quotes. Google documents
 * `GOOGLE_PRIVATE_KEY="-----BEGIN ...\n..."` with the quotes, so stripping them
 * here is what makes that documented form work.
 */
const unquote = (v: string): string => {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
};

/**
 * Normalises a raw env map before validation:
 *
 * - unquotes values (see `unquote`);
 * - turns `KEY=` into "not set".
 *
 * The second rule matters a lot in practice: `.env.example` ships every optional
 * variable with an empty value, so a developer who copies it to `.env` and fills
 * in only the database keys would otherwise get a dozen "must contain at least 1
 * character(s)" errors for values they never intended to set. An empty variable
 * is indistinguishable from an unset one, so it is treated as unset.
 */
function normalizeEnv(source: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw === undefined) {
      out[key] = undefined;
      continue;
    }
    const value = unquote(raw);
    out[key] = value.trim() === '' ? undefined : value;
  }
  return out;
}

/** Google service account keys arrive with literal "\n" in .env. */
const unescapeNewlines = (v: string): string => v.replace(/\\n/g, '\n');

/**
 * Which Postgres role a Supabase key actually acts as, decided locally from the
 * key's own format. No signature check is needed or wanted: this only catches
 * the copy/paste mistake of the two keys landing in each other's variable, and it
 * never leaves this process.
 *
 * Worth the ~15 lines: a publishable key in the service-role slot does not fail
 * loudly, it fails as "new row violates row-level security policy" from whichever
 * INSERT runs first, which is a very slow way to learn about it.
 */
type SupabaseKeyRole = 'service_role' | 'anon' | 'unknown';

export function supabaseKeyRole(key: string | undefined): SupabaseKeyRole {
  if (!present(key)) return 'unknown';
  const value = key as string;
  if (value.startsWith('sb_secret_')) return 'service_role';
  if (value.startsWith('sb_publishable_')) return 'anon';
  if (!value.startsWith('eyJ')) return 'unknown';
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      role?: unknown;
    };
    if (payload.role === 'service_role' || payload.role === 'anon') return payload.role;
  } catch {
    // A key we cannot read is somebody else's problem to detect, not ours.
  }
  return 'unknown';
}

function decodeEncryptionKey(raw: string | undefined, problems: string[]): Buffer | null {
  if (!present(raw)) return null;
  const trimmed = (raw as string).trim();
  const buf = Buffer.from(trimmed, 'base64');
  // Buffer.from silently ignores invalid base64 characters, so compare lengths
  // and re-encode as well.
  const canonical = (s: string): string => s.replace(/=+$/, '');
  if (buf.length !== 32 || canonical(buf.toString('base64')) !== canonical(trimmed)) {
    problems.push('ENCRYPTION_KEY: must be base64 of exactly 32 bytes (`openssl rand -base64 32`)');
    return null;
  }
  return buf;
}

/* -------------------------------------------------------------------------- */
/* loaders                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Validate an environment map. Throws `EnvError` listing every problem found.
 * The input object is never mutated and secret values are never echoed back.
 */
export function loadEnv(source: RawEnv = process.env): AppConfig {
  const problems: string[] = [];
  const env = normalizeEnv(source);

  // 1. feature-group completeness, checked on the raw values so a typo in a
  //    half-filled group is reported before zod's per-field messages.
  const features = {
    database: true,
    whatsapp: false,
    whatsappDemo: false,
    llm: false,
    stt: false,
    sheets: false,
    telegram: false,
  } as Features;

  for (const group of FEATURE_GROUPS) {
    const given = group.keys.filter((k) => present(env[k]));
    if (given.length === 0) continue;
    const missing = group.keys.filter((k) => !present(env[k]));
    if (missing.length > 0) {
      problems.push(
        `${group.label}: ${given.join(', ')} is set, so the whole group is required. Missing: ${missing.join(', ')}`,
      );
      continue;
    }
    features[group.key] = true;
  }

  // A pasted PEM block is the single most common Google Sheets setup mistake:
  // `.env` cannot hold a real multi-line value, so only the first line survives
  // and Google rejects the key with an opaque error much later. A valid key always
  // *starts* with `-----BEGIN`, so requiring that also catches a stray quote left
  // behind by a broken paste.
  const rawPrivateKey = env.GOOGLE_PRIVATE_KEY;
  if (present(rawPrivateKey) && !(rawPrivateKey as string).trimStart().startsWith('-----BEGIN')) {
    problems.push(
      'GOOGLE_PRIVATE_KEY: does not look like a private key. Put it on ONE line with \\n escapes, e.g. "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"',
    );
  }

  // The two Supabase keys must not be swapped: each one decides whether RLS
  // applies, and the failure mode of a swap is a confusing database error (or a
  // browser holding a key that bypasses RLS).
  if (supabaseKeyRole(env.SUPABASE_SERVICE_ROLE_KEY) === 'anon') {
    problems.push(
      'SUPABASE_SERVICE_ROLE_KEY: holds the publishable/anon key, which cannot bypass RLS and will fail every write. Use the secret (service_role) key from Project Settings -> API Keys.',
    );
  }
  if (supabaseKeyRole(env.SUPABASE_ANON_KEY) === 'service_role') {
    problems.push(
      'SUPABASE_ANON_KEY: holds the secret/service_role key, which bypasses RLS. A key used by a browser or dashboard must be the publishable (anon) one.',
    );
  }

  // 2. field-level validation
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.join('.') || '(root)';
      // Deliberately not interpolated with the received value: keep secrets out.
      problems.push(`${name}: ${issue.message}`);
    }
  }

  // 3. production-only rules
  if (parsed.success && parsed.data.NODE_ENV === 'production') {
    for (const key of ['PUBLIC_BASE_URL', 'ENCRYPTION_KEY'] as const) {
      if (!present(parsed.data[key])) {
        problems.push(`${key}: required when NODE_ENV=production`);
      }
    }
    if (!features.whatsapp) {
      problems.push(
        'WhatsApp Cloud API: required when NODE_ENV=production (META_APP_SECRET, META_VERIFY_TOKEN, GRAPH_API_VERSION)',
      );
    }
  }

  const encryptionKey = decodeEncryptionKey(parsed.success ? parsed.data.ENCRYPTION_KEY : undefined, problems);

  if (!parsed.success || problems.length > 0) throw new EnvError(problems);

  const e = parsed.data;
  const val = (v: string | undefined): string | null => (present(v) ? (v as string) : null);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    publicBaseUrl: val(e.PUBLIC_BASE_URL),
    logLevel: e.LOG_LEVEL,
    supabase: {
      url: e.SUPABASE_URL,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      anonKey: val(e.SUPABASE_ANON_KEY),
    },
    meta: features.whatsapp
      ? {
          appSecret: e.META_APP_SECRET as string,
          verifyToken: e.META_VERIFY_TOKEN as string,
          graphApiVersion: e.GRAPH_API_VERSION as string,
        }
      : null,
    whatsappDemo: features.whatsappDemo
      ? { phoneNumberId: e.WA_PHONE_NUMBER_ID as string, token: e.WA_TOKEN as string }
      : null,
    encryptionKey,
    llm: features.llm
      ? {
          provider: e.LLM_PROVIDER as 'gemini' | 'anthropic' | 'openai' | 'fake',
          apiKey: e.LLM_API_KEY as string,
          model: e.LLM_MODEL as string,
        }
      : null,
    stt: features.stt
      ? {
          provider: e.STT_PROVIDER as 'openai-whisper' | 'gemini' | 'google' | 'sarvam' | 'fake',
          apiKey: e.STT_API_KEY as string,
        }
      : null,
    telegram: features.telegram
      ? { botToken: e.TELEGRAM_BOT_TOKEN as string, chatId: e.TELEGRAM_CHAT_ID as string }
      : null,
    sheets: features.sheets
      ? {
          serviceAccountEmail: e.GOOGLE_SERVICE_ACCOUNT_EMAIL as string,
          privateKey: unescapeNewlines(e.GOOGLE_PRIVATE_KEY as string),
        }
      : null,
    timings: {
      sheetSyncIntervalSeconds: e.SHEETS_SYNC_INTERVAL_SECONDS,
      debounceSeconds: e.DEBOUNCE_SECONDS,
      maxVoiceBytes: e.MAX_VOICE_BYTES,
    },
    quietHours: { start: e.QUIET_HOURS_START, end: e.QUIET_HOURS_END },
    features,
  };
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseDotEnv(text: string): RawEnv {
  const out: RawEnv = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value.startsWith('#')) {
      value = '';
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` (if present) merged under the real process env, then validate.
 * Real env wins over the file so a shell/CI variable is never silently ignored.
 */
export function loadEnvFromFile(file = '.env', source: RawEnv = process.env): AppConfig {
  let fromFile: RawEnv = {};
  try {
    fromFile = parseDotEnv(readFileSync(file, 'utf8'));
  } catch {
    // no .env file: rely on the process env only
  }
  return loadEnv({ ...fromFile, ...source });
}

let cached: AppConfig | null = null;

/** Cached config for the running process. */
export function getConfig(): AppConfig {
  cached ??= loadEnvFromFile();
  return cached;
}
