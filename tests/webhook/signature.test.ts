import { describe, expect, it } from 'vitest';
import { SIGNATURE_HEADER, signPayload, verifySignature } from '../../src/webhook/signature.js';

const SECRET = 'test-app-secret';
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const buffer = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('signPayload', () => {
  it('produces the sha256=<hex> form Meta sends', () => {
    expect(signPayload(BODY, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('gives the same signature for a string and for its bytes', () => {
    expect(signPayload(BODY, SECRET)).toBe(signPayload(buffer(BODY), SECRET));
  });

  it('changes when a single character changes', () => {
    expect(signPayload(BODY, SECRET)).not.toBe(signPayload(`${BODY} `, SECRET));
  });

  it('changes when the secret changes', () => {
    expect(signPayload(BODY, SECRET)).not.toBe(signPayload(BODY, 'other-secret'));
  });
});

describe('verifySignature: accepts what Meta sends', () => {
  it('accepts a correct signature', () => {
    const header = signPayload(BODY, SECRET);
    expect(verifySignature(header, buffer(BODY), SECRET)).toEqual({ ok: true });
  });

  it('accepts uppercase hex, which is the same bytes', () => {
    const header = signPayload(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256=');
    expect(header).toMatch(/^sha256=[0-9A-F]{64}$/);
    expect(verifySignature(header, buffer(BODY), SECRET)).toEqual({ ok: true });
  });

  it('tolerates surrounding whitespace in the header', () => {
    const header = signPayload(BODY, SECRET);
    expect(verifySignature(`  ${header}  `, buffer(BODY), SECRET)).toEqual({ ok: true });
  });
});

describe('verifySignature: rejects', () => {
  const rejects = (header: string | string[] | undefined | null, body = BODY, secret = SECRET): string => {
    const result = verifySignature(header, buffer(body), secret);
    expect(result.ok, 'expected a rejection').toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('a missing header, and says so', () => {
    expect(rejects(undefined)).toBe('missing_header');
    expect(rejects(null)).toBe('missing_header');
  });

  it('a signature over different bytes', () => {
    expect(rejects(signPayload(BODY, SECRET), `${BODY} `)).toBe('mismatch');
  });

  it('a signature made with a different secret', () => {
    expect(rejects(signPayload(BODY, 'guess'), BODY, SECRET)).toBe('mismatch');
  });

  it('an empty app secret cannot be used to pass', () => {
    // Guards the "verification disabled" failure mode: no secret must never mean
    // "signature accepted".
    expect(rejects(signPayload(BODY, ''), BODY, '')).toBe('mismatch');
  });

  it('a header without the sha256= prefix', () => {
    expect(rejects(`abc123${'0'.repeat(64)}`)).toBe('malformed_header');
  });

  it('the wrong algorithm (sha1)', () => {
    const legacy = signPayload(BODY, SECRET).replace('sha256=', 'sha1=');
    expect(rejects(legacy)).toBe('malformed_header');
  });

  it('a truncated digest', () => {
    expect(rejects(`sha256=${'a'.repeat(63)}`)).toBe('malformed_header');
  });

  it('an over-long digest', () => {
    expect(rejects(`sha256=${'a'.repeat(65)}`)).toBe('malformed_header');
  });

  it('non-hex characters', () => {
    expect(rejects(`sha256=${'z'.repeat(64)}`)).toBe('malformed_header');
  });

  it('an empty header', () => {
    expect(rejects('')).toBe('malformed_header');
  });

  it('a doubled prefix', () => {
    expect(rejects(`sha256=sha256=${'a'.repeat(64)}`)).toBe('malformed_header');
  });

  it('a repeated header, rather than guessing which one was real', () => {
    expect(rejects([signPayload(BODY, SECRET), signPayload(BODY, SECRET)])).toBe('malformed_header');
  });

  it('a lowercase-looking hex signature with a stray character', () => {
    expect(rejects(`sha256=${'a'.repeat(63)}!`)).toBe('malformed_header');
  });

it('does not let an empty body ride on a signature of other bytes', () => {
expect(rejects(signPayload('x', SECRET), '')).toBe('mismatch');
expect(rejects(undefined, '')).toBe('missing_header');
});
});

describe('signature header name', () => {
  it('is the lowercase name Node exposes for X-Hub-Signature-256', () => {
    expect(SIGNATURE_HEADER).toBe('x-hub-signature-256');
  });
});