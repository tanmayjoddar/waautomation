/**
 * Prompt builder tests (spec 1.9 minus slots). Pins every rule the worker
 * depends on: tenant scoping, no slot promises, trims, caps, and the
 * injection guard. No network, no database.
 */
import { describe, expect, it } from 'vitest';
import type { Knowledge } from '../../src/db/types.js';
import {
  buildSystemPrompt,
  formatKnowledge,
  PROMPT_LIMITS,
  trimHistory,
  trimUserText,
  trimUserTextWithNote,
  TRUNCATION_NOTE,
} from '../../src/ai/prompt.js';

const knowledge = (content: string, title = 'Haircut'): Knowledge => ({
  id: 'k1',
  client_id: 'c1',
  kind: 'price',
  title,
  content,
  created_at: '2026-01-01T00:00:00Z',
});

describe('buildSystemPrompt', () => {
  it('names the bot, business and time, and carries the knowledge', () => {
    const prompt = buildSystemPrompt({
      botName: 'Seva',
      businessName: 'Demo Salon',
      nowLabel: '2026-10-02 15:04 (Asia/Kolkata)',
      knowledge: [knowledge('Rs 200')],
      knowledgeTruncated: false,
    });
    expect(prompt).toContain('Seva');
    expect(prompt).toContain('Demo Salon');
    expect(prompt).toContain('2026-10-02 15:04 (Asia/Kolkata)');
    expect(prompt).toContain('Rs 200');
  });

  it('has no slots section and forbids promising times', () => {
    const prompt = buildSystemPrompt({
      botName: 'Seva',
      businessName: 'Demo Salon',
      nowLabel: 'now',
      knowledge: [],
      knowledgeTruncated: false,
    });
    expect(prompt).not.toMatch(/AVAILABLE SLOTS|slots_block/i);
    expect(prompt).toContain('never promise a time slot');
    expect(prompt).toContain('our team will confirm the time');
  });

  it('says the team will confirm when there is no knowledge', () => {
    const prompt = buildSystemPrompt({ botName: 'S', businessName: 'B', nowLabel: 'now', knowledge: [], knowledgeTruncated: false });
    expect(prompt).toContain('say our team will confirm this shortly');
  });

  it('declares scope refusal, AI honesty and the injection guard', () => {
    const prompt = buildSystemPrompt({ botName: 'S', businessName: 'B', nowLabel: 'now', knowledge: [], knowledgeTruncated: false });
    expect(prompt).toContain('Talk ONLY about B');
    expect(prompt).toContain('You are an AI assistant');
    expect(prompt).toContain('INJECTION GUARD');
  });

  it('takes no customer text: nothing to leak or inject', () => {
    const prompt = buildSystemPrompt({ botName: 'S', businessName: 'B', nowLabel: 'now', knowledge: [], knowledgeTruncated: false });
    expect(prompt).not.toContain('CUSTOMER_WORDS_CANARY');
  });
});

describe('caps and trims', () => {
  it('caps knowledge at 8000 chars and reports truncation', () => {
    const big = knowledge('x'.repeat(9000));
    const { block, truncated } = formatKnowledge([big]);
    expect(block.length).toBeLessThanOrEqual(PROMPT_LIMITS.MAX_KNOWLEDGE_CHARS);
    expect(truncated).toBe(true);
    const { truncated: small } = formatKnowledge([knowledge('short')]);
    expect(small).toBe(false);
  });

  it('trims user text to 1000 chars', () => {
    expect(trimUserText('x'.repeat(1001)).length).toBe(1000);
    expect(trimUserText('short')).toBe('short');
  });

  it('trims with an honest note and reports truncation', () => {
    expect(trimUserTextWithNote('short')).toEqual({ text: 'short', truncated: false });
    const long = trimUserTextWithNote('x'.repeat(1001));
    expect(long.truncated).toBe(true);
    expect(long.text).toContain(TRUNCATION_NOTE);
    expect(long.text.length).toBeLessThanOrEqual(1000 + TRUNCATION_NOTE.length + 1);
  });

  it('keeps the last 10 history turns, each at most 500 chars', () => {
    const history = Array.from({ length: 15 }, (_, i) => ({ role: 'user' as const, text: `m${i} ` + 'y'.repeat(600) }));
    const trimmed = trimHistory(history);
    expect(trimmed).toHaveLength(10);
    expect(trimmed[0]?.text.startsWith('m5')).toBe(true);
    for (const turn of trimmed) expect(turn.text.length).toBeLessThanOrEqual(500);
  });
});
