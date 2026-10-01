/**
 * Fake WhatsApp client for tests and for later slices' worker tests.
 *
 * Records every call, hands out deterministic wamids (`wamid.FAKE.1`, ...), and
 * can be told to fail the next send (or all sends) so failure paths are
 * testable without Meta. Nothing here touches the network.
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
  /** Forgets all recorded calls and failures; the wamid counter keeps going so ids stay unique per test file. */
  reset(): void;
};

let counter = 0;

export function createFakeWhatsAppClient(): FakeWhatsAppClient {
  const sent: FakeSentMessage[] = [];
  const reads: string[] = [];
  let nextFailure: unknown = null;
  let persistentFailure: unknown = null;
  let hasNextFailure = false;

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
      counter += 1;
      const wamid = `wamid.FAKE.${counter}`;
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
