/**
 * Which WhatsApp client a send gets (Slice 3).
 *
 *  - live: the real Meta adapter. Needs the META_* group for the Graph version.
 *  - console: a fake client for testing while Meta delivery is unavailable
 *    (e.g. a locked test account). Sends are recorded, the out row is still
 *    saved with a fake wamid, and the would-be reply is printed to STDOUT.
 *
 * Two rules with no exceptions:
 *  1. Console mode is DEMO-CLIENT-ONLY. The target's phone_number_id must equal
 *     the configured WA_PHONE_NUMBER_ID; anything else throws before any
 *     client is built. A flag typo can therefore never message a real tenant.
 *  2. The reply body goes to stdout via a plain write, NEVER through the
 *     logger: reply bodies are customer text, and customer text must not enter
 *     logs. The print carries no phone number either, not even masked.
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { createWhatsAppClient, type WhatsAppClient } from './client.js';
import { createFakeWhatsAppClient, type FakeWhatsAppClient } from './fake.js';

/** Who the send is for. Tokens arrive per client (demo mode: WA_TOKEN). */
export type SendTarget = {
  clientId: string;
  phoneNumberId: string;
  token: string;
};

export type ResolveOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Where console mode prints replies. Defaults to process.stdout. */
  out?: { write(chunk: string): void };
};

export type ConsoleWhatsAppClient = WhatsAppClient & { fake: FakeWhatsAppClient };

/** Fake-backed client that prints each would-be reply to `out` (never logs). */
export function consoleClient(
  fake: FakeWhatsAppClient = createFakeWhatsAppClient(),
  out: { write(chunk: string): void } = process.stdout,
): ConsoleWhatsAppClient {
  return {
    fake,
    async sendText(to: string, body: string): Promise<{ wamid: string }> {
      const result = await fake.sendText(to, body);
      out.write(`[console SEND_MODE=console] reply that would be sent:\n${body}\n`);
      return result;
    },
    async markReadAndType(wamid: string): Promise<void> {
      await fake.markReadAndType(wamid);
      // Said out loud because the alternative is confusing: in console mode
      // nothing reaches the phone, so there is no blue tick and no "typing..."
      // to watch. The read IS recorded on the fake for tests.
      out.write('[console] mark-as-read + typing indicator skipped (console mode: nothing reaches the phone)\n');
    },
  };
}

/**
 * Builds the client for one send target. Throws (before building anything)
 * when console mode is asked for a non-demo client, or when live mode lacks
 * the META_* group.
 */
export function resolveWhatsAppClient(
  config: AppConfig,
  logger: Logger,
  target: SendTarget,
  opts: ResolveOptions = {},
): WhatsAppClient {
  if (config.sendMode === 'console') {
    const demoNumberId = config.whatsappDemo?.phoneNumberId ?? null;
    if (demoNumberId === null || target.phoneNumberId !== demoNumberId) {
      // No token, no phone number, no client id in the message: the refusal
      // itself must not leak addressing information either.
      throw new Error('SEND_MODE=console is allowed for the demo client only. Set SEND_MODE=live for anything else.');
    }
    logger.info({ clientId: target.clientId }, 'console send mode: replies print to stdout, nothing reaches Meta');
    return consoleClient(createFakeWhatsAppClient(), opts.out ?? process.stdout);
  }

  if (config.meta === null) {
    throw new Error('SEND_MODE=live needs the META_* group (META_APP_SECRET, META_VERIFY_TOKEN, GRAPH_API_VERSION).');
  }
  return createWhatsAppClient({
    phoneNumberId: target.phoneNumberId,
    token: target.token,
    graphApiVersion: config.meta.graphApiVersion,
    fetchImpl: opts.fetchImpl,
    logger,
  });
}
