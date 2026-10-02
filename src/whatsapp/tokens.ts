/**
 * Per-client WhatsApp credentials (spec 1.12: encrypted at rest with AES-GCM).
 *
 * Demo/single-client mode uses WA_TOKEN straight from config. Every other
 * client uses its own token, stored AES-GCM encrypted in wa_token_enc and
 * decrypted here with ENCRYPTION_KEY. Format (defined here, only writer so
 * far): base64url(iv, 12 bytes) + '.' + base64url(ciphertext+tag).
 */
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Client } from '../db/types.js';

export type SendCredentials = { phoneNumberId: string; token: string };

export function encryptToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptToken(key: Buffer, encoded: string): string {
  const [ivB64, ctB64] = encoded.split('.');
  if (!ivB64 || !ctB64) throw new Error('wa_token_enc has an unknown format');
  const raw = Buffer.from(ctB64, 'base64url');
  // GCM appends a 16-byte auth tag; Node wants it via setAuthTag, not inside
  // the ciphertext.
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Credentials for sending as this client. Demo client -> WA_TOKEN; anyone
 * else -> their own decrypted token. Throws when sending is impossible, so a
 * misconfigured tenant fails LOUD at send time instead of sending as nobody.
 */
export function resolveSendCredentials(
  config: AppConfig,
  client: Client,
  opts: { allowMissingToken?: boolean } = {},
): SendCredentials {
  if (config.whatsappDemo !== null && client.phone_number_id === config.whatsappDemo.phoneNumberId) {
    return { phoneNumberId: config.whatsappDemo.phoneNumberId, token: config.whatsappDemo.token };
  }
  if (!client.phone_number_id) throw new Error(`client ${client.id} has no phone_number_id: cannot send`);
  // Console-mode fake sends never touch Meta, so tenants explicitly
  // allowlisted for console (eval) need no stored token. Live mode always
  // requires one: failing here (before any LLM call) is what makes a
  // tokenless production client fail fast instead of burning retries.
  if (!client.wa_token_enc) {
    if (opts.allowMissingToken === true && config.sendMode === "console") {
      return { phoneNumberId: client.phone_number_id, token: "" };
    }
    throw new Error(`client ${client.id} has no WhatsApp token stored: cannot send`);
  }
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY is required to decrypt per-client WhatsApp tokens');
  return { phoneNumberId: client.phone_number_id, token: decryptToken(config.encryptionKey, client.wa_token_enc) };
}
