/**
 * Fake WhatsApp client for tests and for later slices' worker tests.
 *
 * Records every call, hands out globally unique wamids, and can be told to
 * fail the next send (or all sends) so failure paths are testable without
 * Meta. Nothing here touches the network.
 *
 * Uniqueness matters: out rows persist in the database while the fake's
 * counter does not survive a server restart, so a plain restarting counter
 * (`wamid.FAKE.1`, ...) collides with earlier runs on the unique
 * (client_id, wamid) constraint. Each client instance therefore mints its own
 * random segment: `wamid.FAKE.<instance>.<n>`.
 */
import type { WhatsAppClient } from './client.js';

export type FakeSentMessage = { to: string; body: string; wamid: string };

export type FakeWhatsAppClient = WhatsAppClient & {
  /** Every sendText call, in order. */
  sent: FakeSentMessage[];
  /** Every markReadAndType call (inbound wamids), in order. */
  reads: string[];
  /** The next sendText rejects with this instead of sending. One-shot. */
  failNextSendWith(error: unknown): void;
  /** Every sendText rejects with this until cleared with null. */
  failAllSendsWith(error: unknown | null): void;
  /** Forgets all recorded calls and failures. Wamids stay unique: the instance segment never repeats. */
  reset(): void;
};

export function createFakeWhatsAppClient(): FakeWhatsAppClient {
  const sent: FakeSentMessage[] = [];
  const reads: string[] = [];
  let nextFailure: unknown = null;
  let persistentFailure: unknown = null;
  let hasNextFailure = false;
  // Fresh randomness per instance (i.e. per server start): two instances never
  // mint the same wamid, so a restart cannot collide with persisted rows.
  const instance = Math.random().toString(36).slice(2, 8);
  let n = 0;

  return {
    sent,
    reads,

    async sendText(to: string, body: string): Promise<{ wamid: string }> {
      if (hasNextFailure) {
        hasNextFailure = false;
        const error = nextFailure;
        nextFailure = null;
        throw error instanceof Error ? error : new Error(String(error));
      }
      if (persistentFailure !== null) {
        throw persistentFailure instanceof Error ? persistentFailure : new Error(String(persistentFailure));
      }
      n += 1;
      const wamid = `wamid.FAKE.${instance}.${n}`;
      sent.push({ to, body, wamid });
      return { wamid };
    },

    async markReadAndType(wamid: string): Promise<void> {
      reads.push(wamid);
    },

    failNextSendWith(error: unknown): void {
      nextFailure = error;
      hasNextFailure = true;
    },

    failAllSendsWith(error: unknown | null): void {
      persistentFailure = error;
    },

    reset(): void {
      sent.length = 0;
      reads.length = 0;
      nextFailure = null;
      persistentFailure = null;
      hasNextFailure = false;
    },
  };
}
