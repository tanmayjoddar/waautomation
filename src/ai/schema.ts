/**
 * The AI's output contract (spec 1.9), validated with zod on every call.
 *
 * chosen_slot is z.null() in this slice: the model must not pick times yet
 * (Slot logic is Slice 7). A non-null value fails validation like any other
 * contract breach: one retry, then fallback.
 */
import { z } from 'zod';

export const ReplySchema = z.object({
  reply_parts: z.array(z.string().min(1).max(300)).min(1).max(3),
  language: z.enum(['bengali', 'hindi', 'english', 'hinglish']),
  intent: z.enum(['question', 'book', 'human', 'other']),
  name: z.string().max(60).nullable(),
  service: z.string().nullable(),
  chosen_slot: z.null(),
  confidence: z.number().min(0).max(1),
});

export type Reply = z.infer<typeof ReplySchema>;

/**
 * The same contract as a JSON Schema object, for providers with a structured
 * output option (Anthropic output_config). Hand-maintained next to the zod
 * schema; the test below pins them together so they cannot drift silently.
 */
export const REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply_parts: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, minItems: 1, maxItems: 3 },
    language: { type: 'string', enum: ['bengali', 'hindi', 'english', 'hinglish'] },
    intent: { type: 'string', enum: ['question', 'book', 'human', 'other'] },
    name: { type: ['string', 'null'], maxLength: 60 },
    service: { type: ['string', 'null'] },
    chosen_slot: { type: 'null' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['reply_parts', 'language', 'intent', 'name', 'service', 'chosen_slot', 'confidence'],
  additionalProperties: false,
} as const;

/** Strips markdown fences some models add around JSON despite instructions. */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Parses model text into a Reply: strip fences, JSON.parse, zod-validate. */
export function parseReply(text: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(text));
  } catch {
    throw new Error('reply is not valid JSON');
  }
  return ReplySchema.parse(parsed);
}
