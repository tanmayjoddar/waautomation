/**
 * Token encryption tests (spec 1.12: per-client tokens encrypted at rest).
 * Roundtrip, wrong-key failure, format rejection, and credential resolution
 * (demo vs per-client vs impossible). No network, no database.
 */
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import type { Client } from '../../src/db/types.js';
import { decryptToken, encryptToken, resolveSendCredentials } from '../../src/whatsapp/tokens.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

const config = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    whatsappDemo: { phoneNumberId: 'demo-pn', token: 'demo-token' },
    encryptionKey: KEY,
    ...overrides,
  }) as AppConfig;

const client = (overrides: Partial<Client> = {}): Client =>
  ({
    id: 'client-id',
    business_name: 'Demo',
    phone_number_id: 'demo-pn',
    waba_id: null,
    wa_token_enc: null,
    default_language: 'hinglish',
    timezone: 'Asia/Kolkata',
    plan: 'starter',
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }) as Client;

describe('token encryption', () => {
  it('round-trips a token', () => {
    const enc = encryptToken(KEY, 'secret-token-value');
    expect(enc).not.toContain('secret-token-value');
    expect(decryptToken(KEY, enc)).toBe('secret-token-value');
  });

  it('two encryptions differ (random IV)', () => {
    expect(encryptToken(KEY, 'same')).not.toBe(encryptToken(KEY, 'same'));
  });

  it('rejects the wrong key and a bad format', () => {
    const enc = encryptToken(KEY, 'secret');
    expect(() => decryptToken(Buffer.from('ffffffffffffffffffffffffffffffff', 'utf8'), enc)).toThrow();
    expect(() => decryptToken(KEY, 'not-a-pair')).toThrow(/unknown format/);
  });
});

describe('resolveSendCredentials', () => {
  it('demo client uses WA_TOKEN', () => {
    expect(resolveSendCredentials(config(), client())).toEqual({ phoneNumberId: 'demo-pn', token: 'demo-token' });
  });

  it('other clients use their decrypted token', () => {
    const enc = encryptToken(KEY, 'client-secret');
    const creds = resolveSendCredentials(config(), client({ phone_number_id: 'other-pn', wa_token_enc: enc }));
    expect(creds).toEqual({ phoneNumberId: 'other-pn', token: 'client-secret' });
  });

  it('throws when sending is impossible, without leaking the secret', () => {
    expect(() => resolveSendCredentials(config(), client({ phone_number_id: null }))).toThrow(/no phone_number_id/);
    expect(() => resolveSendCredentials(config(), client({ phone_number_id: 'x', wa_token_enc: null }))).toThrow(/no WhatsApp token/);
    expect(() =>
      resolveSendCredentials(config({ encryptionKey: null }), client({ phone_number_id: 'x', wa_token_enc: 'e.k' })),
    ).toThrow(/ENCRYPTION_KEY/);
  });
});
