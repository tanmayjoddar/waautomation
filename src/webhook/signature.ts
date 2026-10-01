/**
 * X-Hub-Signature-256 verification (spec 1.6 step 1).
 *
 * Meta signs the EXACT bytes it sent: `sha256=` + HMAC-SHA256(raw body,
 * app secret). Any re-serialisation changes the bytes and therefore the
 * signature, which is why the webhook route must keep the raw body (see
 * app.ts) instead of parsing JSON first.
 *
 * Design rules:
 *  - compare with crypto.timingSafeEqual, never `===`, so the number of matching
 *    bytes cannot be measured from response timing;
 *  - a MISSING or malformed header is rejected, never treated as "skip the check";
 *  - nothing here logs the expected or the provided signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The only header and the only algorithm Meta uses for this webhook. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export type SignatureResult = { ok: true } | { ok: false; reason: 'missing_header' | 'malformed_header' | 'mismatch' };

/** Builds the value Meta would send. Used by the verifier's tests and by the simulator. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

/**
 * Verifies one request.
 *
 * @param header    the raw header value; anything that is not exactly
 *                  `sha256=<64 hex chars>` is rejected before the comparison
 * @param rawBody   the request bytes, untouched
 */
export function verifySignature(
  header: string | string[] | undefined | null,
  rawBody: Buffer,
  appSecret: string,
): SignatureResult {
  // A repeated header is ambiguous: Meta sends exactly one. Refusing is safer
  // than picking one and hoping the other was not the real one.
  if (header === undefined || header === null) return { ok: false, reason: 'missing_header' };
  if (Array.isArray(header)) return { ok: false, reason: 'malformed_header' };

  const match = /^sha256=(.*)$/.exec(header.trim());
  if (!match) return { ok: false, reason: 'malformed_header' };

  const providedHex = match[1] as string;
  if (!SHA256_HEX.test(providedHex)) return { ok: false, reason: 'malformed_header' };

  if (appSecret.length === 0) return { ok: false, reason: 'mismatch' };

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  // The regex above guarantees both sides are 32 bytes, so timingSafeEqual can
  // never throw on a length mismatch here.
  const provided = Buffer.from(providedHex, 'hex');
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };

  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}