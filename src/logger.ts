/**
 * Structured logging (pino).
 *
 * Two redaction layers, because the spec's security checklist (1.12) requires
 * that logs never contain tokens or phone numbers:
 *  1. pino `redact` for anything that looks like a credential;
 *  2. the censor function also masks phone numbers, so a phone that lands in a
 *     log field named like a phone is never printed in full.
 * Phone masking keeps the country prefix and the last 2 digits, which is enough
 * to debug a webhook without identifying a customer.
 */
import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions as PinoOptions } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Keys whose values are credentials, at any depth. */
const SECRET_PATHS = [
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'access_token',
  '*.access_token',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'secret',
  '*.secret',
  'appSecret',
  '*.appSecret',
  'verifyToken',
  '*.verifyToken',
  'serviceRoleKey',
  '*.serviceRoleKey',
  'anonKey',
  '*.anonKey',
  'botToken',
  '*.botToken',
  'encryptionKey',
  '*.encryptionKey',
  'privateKey',
  '*.privateKey',
  'waToken',
  '*.waToken',
  'wa_token_enc',
  '*.wa_token_enc',
  'password',
  '*.password',
  'authorization',
  'req.headers.authorization',
  'headers.authorization',
  'config',
  'config.*',
  'env',
  'env.*',
];

/** Keys that hold phone numbers, at any depth. */
const PHONE_PATHS = [
  'phone',
  '*.phone',
  'from',
  '*.from',
  'to',
  '*.to',
  'wa_id',
  '*.wa_id',
  'waId',
  '*.waId',
  'phoneNumber',
  '*.phoneNumber',
  'display_phone_number',
  '*.display_phone_number',
  'msisdn',
  '*.msisdn',
  'contactPhone',
  '*.contactPhone',
];

const PHONE_KEYS = new Set([
  'phone',
  'from',
  'to',
  'wa_id',
  'waId',
  'phoneNumber',
  'display_phone_number',
  'msisdn',
  'contactPhone',
  'recipient',
  'sender',
]);

/** 8-15 digits, optionally with a leading +, i.e. E.164. */
const looksLikePhone = (v: string): boolean => /^\+?\d{8,15}$/.test(v.trim());

/** `919812345678` -> `91*****78`. Short values are fully masked. */
export function maskPhone(value: string): string {
  const v = value.trim().replace(/^\+/, '');
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${v.slice(0, 2)}${'*'.repeat(v.length - 4)}${v.slice(-2)}`;
}

function isPhoneKey(key: string | undefined): boolean {
  return key !== undefined && PHONE_KEYS.has(key);
}

/**
 * pino calls the censor with (value, path), where `path` is the array of keys
 * leading to the value; the leaf key is the last element.
 */
function censor(value: unknown, path: string[] = []): string {
  const key = path[path.length - 1];
  if (isPhoneKey(key) && typeof value === 'string') {
    return looksLikePhone(value) ? maskPhone(value) : '[redacted]';
  }
  if (typeof value === 'string' && looksLikePhone(value)) return maskPhone(value);
  return '[redacted]';
}

/** Minimal writable target; a plain object like this is enough for tests. */
export type LogDestination = { write(chunk: string): void };

export type CreateLoggerOptions = {
  level?: LogLevel;
  /** Defaults to stdout. Tests pass a collecting stream. */
  destination?: LogDestination;
  base?: Record<string, unknown>;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: PinoOptions & { level: string } = {
    level: options.level ?? 'info',
    base: { service: 'wa-agent', ...options.base },
    redact: { paths: [...SECRET_PATHS, ...PHONE_PATHS], censor, remove: false },
    serializers: { err: stdSerializers.err },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: stdTimeFunctions.isoTime,
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}
