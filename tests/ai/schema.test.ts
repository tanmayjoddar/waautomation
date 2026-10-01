/**
 * Reply contract tests (spec 1.9). Every field boundary is pinned: the worker
 * trusts this schema to reject model output, so the schema itself must be
 * proven strict. No network, no database.
 */
import { describe, expect, it } from 'vitest';
import { parseReply, REPLY_JSON_SCHEMA, ReplySchema, stripMarkdownFences } from '../../src/ai/schema.js';

const valid = (): Record<string, unknown> => ({
  reply_parts: ['Namaste! Ji haan, haircut Rs 200 hai.', 'Kab aana chahenge aap?'],
  language: 'hinglish',
  intent: 'question',
  name: 'Rahul',
  service: 'haircut',
  chosen_slot: null,
  confidence: 0.8,
});

describe('ReplySchema', () => {
  it('accepts a fully valid reply', () => {
    expect(() => ReplySchema.parse(valid())).not.toThrow();
  });

  it('rejects reply_parts that are empty, too many, empty-string or too long', () => {
    expect(() => ReplySchema.parse({ ...valid(), reply_parts: [] })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), reply_parts: ['a', 'b', 'c', 'd'] })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), reply_parts: [''] })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), reply_parts: ['x'.repeat(301)] })).toThrow();
  });

  it('rejects unknown language and intent values', () => {
    expect(() => ReplySchema.parse({ ...valid(), language: 'french' })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), intent: 'dance' })).toThrow();
  });

  it('rejects a name over 60 chars and a non-null chosen_slot', () => {
    expect(() => ReplySchema.parse({ ...valid(), name: 'x'.repeat(61) })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), chosen_slot: '2026-10-05T10:00:00+05:30' })).toThrow();
  });

  it('rejects confidence outside 0..1', () => {
    expect(() => ReplySchema.parse({ ...valid(), confidence: -0.1 })).toThrow();
    expect(() => ReplySchema.parse({ ...valid(), confidence: 1.5 })).toThrow();
  });
});

describe('stripMarkdownFences', () => {
  it('strips ```json fences', () => {
    expect(stripMarkdownFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare fences and leaves plain JSON alone', () => {
    expect(stripMarkdownFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripMarkdownFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('parseReply', () => {
  it('parses fenced model output into a Reply', () => {
    const reply = parseReply(`\`\`\`json\n${JSON.stringify(valid())}\n\`\`\``);
    expect(reply.language).toBe('hinglish');
    expect(reply.reply_parts).toHaveLength(2);
  });

  it('throws on non-JSON and on schema violations', () => {
    expect(() => parseReply('Sure, here you go!')).toThrow(/not valid JSON/);
    expect(() => parseReply(JSON.stringify({ ...valid(), intent: 'dance' }))).toThrow();
  });
});

describe('REPLY_JSON_SCHEMA correspondence', () => {
  it('requires exactly the zod shape keys', () => {
    expect([...REPLY_JSON_SCHEMA.required].sort()).toEqual(Object.keys(ReplySchema.shape).sort());
  });

  it('accepts a sample the zod schema accepts', () => {
    const sample = ReplySchema.parse(valid());
    for (const part of sample.reply_parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThanOrEqual(300);
    }
    expect(['bengali', 'hindi', 'english', 'hinglish']).toContain(sample.language);
  });
});
