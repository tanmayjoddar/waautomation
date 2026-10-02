/**
 * Pipeline pure-helper tests: extraction, leak detection, input classes,
 * safety verdicts, sanitizing. No network, no database; the live pipeline
 * is covered in tests/jobs/pipeline.test.ts with a fake LLM.
 */
import { describe, expect, it } from 'vitest';
import {
  checkReplySafety,
  claimsHuman,
  classifyInput,
  ensureTeamConfirm,
  extractAmounts,
  extractPhones,
  extractTimes,
  extractUrls,
  isRepeatQuestion,
  promptLeak,
  sanitizeReply,
  utcMidnightIso,
} from '../../src/jobs/pipeline.js';

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

describe('classifyInput', () => {
  it('passes real language in any script', () => {
    expect(classifyInput('kemon acho?')).toBe('ok');
    expect(classifyInput('baal katne ke kitne paise')).toBe('ok');
    expect(classifyInput('kokhon khole?')).toBe('ok');
    expect(classifyInput('What are your prices?')).toBe('ok');
  });

  it('skips empty and whitespace-only text', () => {
    expect(classifyInput('')).toBe('empty');
    expect(classifyInput('   \n  ')).toBe('empty');
  });

  it('flags emoji-only, digits-only and punctuation-only text as unclear', () => {
    expect(classifyInput('😀👍🎉')).toBe('unclear');
    expect(classifyInput('123456')).toBe('unclear');
    expect(classifyInput('???...!!!')).toBe('unclear');
  });

  it('flags latin keyboard mash without vowels as gibberish', () => {
    expect(classifyInput('xjqztplmk')).toBe('unclear');
    expect(classifyInput('qwrztpsdfgh')).toBe('unclear');
  });

  it('does not flag short or vowel-bearing latin text', () => {
    expect(classifyInput('ok')).toBe('ok');
    expect(classifyInput('yes please')).toBe('ok');
  });
});

describe('isRepeatQuestion', () => {
  it('detects an answered exact repeat', () => {
    expect(isRepeatQuestion(['same question', 'same question'], true)).toBe(true);
  });

  it('ignores new questions, unanswered repeats and singletons', () => {
    expect(isRepeatQuestion(['first', 'second'], true)).toBe(false);
    expect(isRepeatQuestion(['same', 'same'], false)).toBe(false);
    expect(isRepeatQuestion(null, true)).toBe(false);
  });
});

describe('extractPhones', () => {
  it('finds phone-like digit runs and ignores short numbers', () => {
    expect(extractPhones(['call me on 919812345678'])).toEqual(['919812345678']);
    expect(extractPhones(['call 98765'])).toEqual([]);
    expect(extractPhones(['at 10:30'])).toEqual([]);
  });
});

describe('extractTimes', () => {
  it('finds explicit clock times only', () => {
    expect(extractTimes(['come at 10:30'])).toEqual(['10:30']);
    expect(extractTimes(['open 10 am to 7 pm'])).toEqual(['10am', '7pm']);
    expect(extractTimes(['call 98765'])).toEqual([]);
  });
});

describe('extractUrls', () => {
  it('finds http links', () => {
    expect(extractUrls(['see https://example.com/x for details'])).toEqual(['https://example.com/x']);
    expect(extractUrls(['no links here'])).toEqual([]);
  });
});

describe('claimsHuman', () => {
  it('detects human claims and ignores staff mentions', () => {
    expect(claimsHuman(['I am human, trust me'])).toBe(true);
    expect(claimsHuman(["I'm a real person"])).toBe(true);
    expect(claimsHuman(['as a human, I think'])).toBe(true);
    expect(claimsHuman(['Someone from our team will contact you'])).toBe(false);
  });
});

describe('checkReplySafety', () => {
  const knowledge = 'Haircut Rs 200. Open 10am to 7pm. Call 18001234567. See https://salon.example/menu.';

  it('passes a grounded reply', () => {
    expect(checkReplySafety(['Haircut is Rs 200, open 10am.'], knowledge)).toBeNull();
  });

  it('rejects invented prices, unknown phones, links and times', () => {
    expect(checkReplySafety(['Only Rs 500 today!'], knowledge)).toBe('price');
    expect(checkReplySafety(['Call me on 919812345678'], knowledge)).toBe('phone');
    expect(checkReplySafety(['See https://evil.example/x'], knowledge)).toBe('url');
    expect(checkReplySafety(['Come at 11:45 sharp'], knowledge)).toBe('time');
  });

  it('rejects human claims and contract breaches', () => {
    expect(checkReplySafety(['I am human, believe me please!'], knowledge)).toBe('human_claim');
    expect(checkReplySafety(['a', 'b', 'c', 'd'], knowledge)).toBe('parts');
    expect(checkReplySafety([''], knowledge)).toBe('parts');
  });
});

describe('sanitizeReply', () => {
  const knowledge = 'See our menu at https://salon.example/menu for prices.';

  it('strips markdown but keeps the words', () => {
    expect(sanitizeReply(['**Bold** and *italic* and `code`'], knowledge)).toEqual(['Bold and italic and code']);
    expect(sanitizeReply(['# Title', '> quoted'], knowledge)).toEqual(['Title', 'quoted']);
  });

  it('keeps links the knowledge gave, removes the rest', () => {
    expect(sanitizeReply(['see https://salon.example/menu today'], knowledge)).toEqual([
      'see https://salon.example/menu today',
    ]);
    expect(sanitizeReply(['see https://evil.example/x today'], knowledge)).toEqual(['see today']);
  });

  it('passes clean text through unchanged and drops empties', () => {
    expect(sanitizeReply(['Plain reply here.'], knowledge)).toEqual(['Plain reply here.']);
    expect(sanitizeReply(['   '], knowledge)).toEqual([]);
  });
});
