/**
 * Which messages still need an answer.
 *
 * WORKER RULE (spec 1.8 + the rule you asked for):
 *   unanswered = inbound messages that came AFTER the last outbound message.
 *   If there are none, the job must be marked done and NOTHING must be sent.
 *   A worker that wakes up after the conversation already moved on must not
 *   send a stale reply.
 *
 * Pure functions on purpose: no database, no clock, no WhatsApp. The worker
 * loads the rows (scoped by client_id + contact_id) and hands them here.
 */
import type { Message } from '../db/types.js';

export type OrderedMessage = Pick<Message, 'id' | 'seq' | 'direction' | 'created_at'> & {
  direction: 'in' | 'out';
};

/**
 * Total order: seq first (monotonic, unique), created_at as a fallback for rows
 * that predate the seq column. Never sorts by id: a uuid is not ordered.
 */
function bySeq(a: OrderedMessage, b: OrderedMessage): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.created_at.localeCompare(b.created_at);
}

/** True when the two messages must be treated as the same moment. */
const sameInstant = (a: OrderedMessage, b: OrderedMessage): boolean =>
  a.seq === b.seq && a.created_at === b.created_at;

/**
 * The inbound messages that have not been answered yet, oldest first.
 *
 * - No outbound message at all: every inbound message is unanswered.
 * - An inbound message sitting exactly on the last outbound message's instant
 *   counts as already answered (it arrived first; the reply came after).
 */
export function selectUnanswered(messages: readonly OrderedMessage[]): OrderedMessage[] {
  const ordered = [...messages].sort(bySeq);
  const lastOutboundIndex = ordered.reduce(
    (found, message, index) => (message.direction === 'out' ? index : found),
    -1,
  );
  if (lastOutboundIndex === -1) return ordered.filter((m) => m.direction === 'in');

  const lastOutbound = ordered[lastOutboundIndex] as OrderedMessage;
  return ordered.filter(
    (message, index) =>
      index > lastOutboundIndex &&
      message.direction === 'in' &&
      !sameInstant(message, lastOutbound),
  );
}

/** The case the worker must handle by sending nothing at all. */
export function hasUnanswered(messages: readonly OrderedMessage[]): boolean {
  return selectUnanswered(messages).length > 0;
}
