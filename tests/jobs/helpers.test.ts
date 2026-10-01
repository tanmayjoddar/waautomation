/**
 * Pipeline pure-helper tests: amount extraction, prompt-leak detection, team
 * confirmation, UTC-midnight math. No network, no database; the live pipeline
 * is covered in tests/jobs/pipeline.test.ts with a fake LLM.
 */
import { describe, expect, it } from 'vitest';
import { ensureTeamConfirm, extractAmounts, promptLeak, utcMidnightIso } from '../../src/jobs/pipeline.js';

describe('extractAmounts', () => {
  it('finds rupee amounts in every common form', () => {
    expect(extractAmounts(['Haircut Rs 200, shave ₹100'])).toEqual(['200', '100']);
    expect(extractAmounts(['INR 2,500 for the package'])).toEqual(['2500']);
    expect(extractAmounts(['500 rupees only'])).toEqual(['500']);
  });

  it('ignores bare numbers and times', () => {
    expect(extractAmounts(['come at 10:30', 'call 98765'])).toEqual([]);
  });
});

describe('promptLeak', () => {
  const system = `You are Seva. ${'x'.repeat(100)} KNOWLEDGE: Haircut Rs 200. ${'y'.repeat(100)}`;

  it('detects a 40+ char verbatim copy', () => {
    expect(promptLeak(system, [`prefix ${'x'.repeat(50)} suffix`])).toBe(true);
  });

  it('ignores short matches', () => {
    expect(promptLeak(system, ['Haircut Rs 200'])).toBe(false);
    expect(promptLeak(system, ['totally original reply text here'])).toBe(false);
  });
});

describe('ensureTeamConfirm', () => {
  it('leaves replies that already mention confirmation', () => {
    const parts = ['Yes, confirmed for Saturday!'];
    expect(ensureTeamConfirm(parts)).toBe(parts);
  });

  it('appends the team line when there is room', () => {
    expect(ensureTeamConfirm(['We can do Saturday.'])).toEqual(['We can do Saturday.', 'Our team will confirm the time shortly.']);
  });

  it('folds the team line into the last part at 3 parts', () => {
    const out = ensureTeamConfirm(['one', 'two', 'three']);
    expect(out).toHaveLength(3);
    expect(out[2]).toContain('Our team will confirm the time shortly.');
  });
});

describe('utcMidnightIso', () => {
  it('returns UTC midnight for a known instant', () => {
    expect(utcMidnightIso(Date.parse('2026-10-02T15:04:00+05:30'))).toBe('2026-10-02T00:00:00.000Z');
  });
});
