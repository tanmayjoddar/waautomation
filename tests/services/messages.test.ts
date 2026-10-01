import { describe, expect, it } from 'vitest';
import { hasUnanswered, selectUnanswered, type OrderedMessage } from '../../src/services/messages.js';

/** Builds a message with a distinct seq, which is the column the worker orders by. */
const msg = (seq: number, direction: 'in' | 'out', createdAt = `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`): OrderedMessage => ({
  id: `m${seq}`,
  seq,
  direction,
  created_at: createdAt,
});

describe('selectUnanswered', () => {
  it('returns nothing when the last message is outbound (the worker sends nothing)', () => {
    const messages = [msg(1, 'in'), msg(2, 'out')];
    expect(selectUnanswered(messages)).toEqual([]);
    expect(hasUnanswered(messages)).toBe(false);
  });

  it('returns every inbound message when the bot has never replied', () => {
    const messages = [msg(1, 'in'), msg(2, 'in'), msg(3, 'in')];
    expect(selectUnanswered(messages).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(hasUnanswered(messages)).toBe(true);
  });

  it('returns only the inbound messages that came after the last outbound, oldest first', () => {
    const messages = [msg(1, 'in'), msg(2, 'out'), msg(3, 'in'), msg(4, 'in'), msg(5, 'out'), msg(6, 'in')];
    expect(selectUnanswered(messages).map((m) => m.id)).toEqual(['m6']);
  });

  it('a burst of three quick messages before any reply is one unanswered batch', () => {
    const messages = [msg(1, 'in'), msg(2, 'in'), msg(3, 'in')];
    expect(selectUnanswered(messages)).toHaveLength(3);
    expect(hasUnanswered(messages), 'so the worker replies once to all three').toBe(true);
  });

  it('orders by seq, not by created_at, when both arrive in the same millisecond', () => {
    const sameInstant = '2026-01-01T10:00:00.123Z';
    const messages = [
      msg(1, 'in', sameInstant),
      msg(2, 'out', sameInstant),
      msg(3, 'in', sameInstant),
    ];
    expect(selectUnanswered(messages).map((m) => m.id), 'only the message after the reply').toEqual(['m3']);
  });

  it('an inbound after an older outbound still counts as unanswered', () => {
    // Out-of-order arrival is realistic: two workers can read the same history.
    const messages = [msg(1, 'in'), msg(2, 'out'), msg(3, 'in')];
    expect(selectUnanswered(messages).map((m) => m.id)).toEqual(['m3']);
    expect(hasUnanswered(messages)).toBe(true);
  });

  it('an empty history means nothing to answer', () => {
    expect(selectUnanswered([])).toEqual([]);
    expect(hasUnanswered([])).toBe(false);
  });

  it('a history of only outbound messages means nothing to answer', () => {
    const messages = [msg(1, 'out'), msg(2, 'out')];
    expect(selectUnanswered(messages)).toEqual([]);
  });

  it('does not mutate the caller array', () => {
    const messages = [msg(3, 'in'), msg(1, 'out')];
    const copy = [...messages];
    selectUnanswered(messages);
    expect(messages).toEqual(copy);
  });

  it('treats an inbound at the exact instant of the last outbound as already answered', () => {
    const sameInstant = '2026-01-01T10:00:00.500Z';
    const messages = [msg(1, 'in', sameInstant), msg(2, 'out', sameInstant)];
    expect(selectUnanswered(messages)).toEqual([]);
  });
});
