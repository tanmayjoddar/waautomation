/**
 * LLM adapter tests (Slice 4). Every provider call is a stubbed fetch: these
 * prove request shapes, token parsing, error mapping and the retry policy
 * (429/5xx/network retry with backoff, 4xx never retried). Nothing here
 * touches a provider or a database.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { createAnthropicAdapter } from '../../src/ai/anthropic.js';
import { createFakeLlm } from '../../src/ai/fake.js';
import { createGeminiAdapter } from '../../src/ai/gemini.js';
import { createOpenAIAdapter } from '../../src/ai/openai.js';
import { LlmError, type GenerateInput } from '../../src/ai/llm.js';
import { collectingStream } from '../helpers.js';

type Call = { url: string; init: RequestInit };

const input = (overrides: Partial<GenerateInput> = {}): GenerateInput => ({
  system: 'SYSTEM_CANARY_PROMPT',
  history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }],
  userText: 'hello',
  maxTokens: 400,
  timeoutMs: 5000,
  ...overrides,
});

/** A fetch stub playing a script: each entry is a Response (with optional headers) or a thrown error. */
function stubFetch(script: Array<{ response: Response; headers?: Record<string, string> } | Error>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    const { response, headers } = next as { response: Response; headers?: Record<string, string> };
    if (!headers) return response;
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
    return out;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): { response: Response } => ({
  response: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
});

const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const authHeaders = (call: Call): Record<string, string> => {
  const raw = call.init.headers as unknown as Record<string, string>;
  return raw;
};

describe('gemini adapter', () => {
  const okBody = {
    candidates: [{ content: { parts: [{ text: '{"reply_parts":["hi"]}' }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 },
  };

  it('POSTs the generateContent shape and parses text + tokens', async () => {
    const { fetchImpl, calls } = stubFetch([json(okBody)]);
    const adapter = createGeminiAdapter({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl, baseDelayMs: 5 });

    const result = await adapter.generate(input());

    expect(result).toEqual({ text: '{"reply_parts":["hi"]}', inputTokens: 100, outputTokens: 25 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(authHeaders(calls[0] as Call)['x-goog-api-key']).toBe('k');
    expect(bodyOf(calls[0] as Call)).toMatchObject({
      system_instruction: { parts: [{ text: 'SYSTEM_CANARY_PROMPT' }] },
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 400 },
    });
    const contents = bodyOf(calls[0] as Call)['contents'] as Array<{ role: string }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('never sends the key in the URL', async () => {
    const { fetchImpl, calls } = stubFetch([json(okBody)]);
    await createGeminiAdapter({ apiKey: 'SECRET_KEY_CANARY', model: 'm', fetchImpl, baseDelayMs: 5 }).generate(input());
    expect(calls[0]?.url).not.toContain('SECRET_KEY_CANARY');
  });
});

describe('anthropic adapter', () => {
  const okBody = {
    content: [{ type: 'text', text: '{"reply_parts":["hi"]}' }],
    usage: { input_tokens: 90, output_tokens: 20 },
  };

  it('POSTs the messages shape with system + structured output and parses tokens', async () => {
    const { fetchImpl, calls } = stubFetch([json(okBody)]);
    const adapter = createAnthropicAdapter({ apiKey: 'k', model: 'claude-x', fetchImpl, baseDelayMs: 5 });

    const result = await adapter.generate(input());

    expect(result).toEqual({ text: '{"reply_parts":["hi"]}', inputTokens: 90, outputTokens: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(authHeaders(calls[0] as Call)['x-api-key']).toBe('k');
    expect(authHeaders(calls[0] as Call)['anthropic-version']).toBe('2023-06-01');
    expect(bodyOf(calls[0] as Call)).toMatchObject({
      model: 'claude-x',
      max_tokens: 400,
      system: 'SYSTEM_CANARY_PROMPT',
      output_config: { format: { type: 'json_schema' } },
    });
  });
});

describe('openai adapter', () => {
  const okBody = {
    choices: [{ message: { content: '{"reply_parts":["hi"]}' } }],
    usage: { prompt_tokens: 80, completion_tokens: 15 },
  };

  it('POSTs the chat-completions shape and parses tokens', async () => {
    const { fetchImpl, calls } = stubFetch([json(okBody)]);
    const adapter = createOpenAIAdapter({ apiKey: 'k', model: 'gpt-x', fetchImpl, baseDelayMs: 5 });

    const result = await adapter.generate(input());

    expect(result).toEqual({ text: '{"reply_parts":["hi"]}', inputTokens: 80, outputTokens: 15 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(authHeaders(calls[0] as Call)['Authorization']).toBe('Bearer k');
    expect(bodyOf(calls[0] as Call)).toMatchObject({
      model: 'gpt-x',
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });
    const messages = bodyOf(calls[0] as Call)['messages'] as Array<{ role: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[messages.length - 1]?.role).toBe('user');
  });
});

describe('retry policy (provider-independent, exercised on gemini)', () => {
  const mk = (fetchImpl: typeof fetch) =>
    createGeminiAdapter({ apiKey: 'k', model: 'm', fetchImpl, baseDelayMs: 5 });

  it('never retries a 401 and reports an invalid key clearly', async () => {
    const { stream, text: logs } = collectingStream();
    const logger = createLogger({ level: 'debug', destination: stream });
    const { fetchImpl, calls } = stubFetch([
      { response: new Response(JSON.stringify({ error: { message: 'bad key', code: 401 } }), { status: 401 }) },
    ]);
    const adapter = createGeminiAdapter({ apiKey: 'k', model: 'm', fetchImpl, logger, baseDelayMs: 5 });

    const error = await adapter.generate(input()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(logs()).toContain('invalid API key');
    expect(logs()).not.toContain('SYSTEM_CANARY_PROMPT');
  });

  it('never retries a 404 and reports an unknown model', async () => {
    const { fetchImpl, calls } = stubFetch([
      { response: new Response(JSON.stringify({ error: { message: 'not found', code: 404 } }), { status: 404 }) },
    ]);
    const error = await mk(fetchImpl).generate(input()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 once, honouring Retry-After, then succeeds', async () => {
    const ok = {
      candidates: [{ content: { parts: [{ text: 't' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
    const rateLimited = {
      response: new Response(JSON.stringify({ error: { message: 'slow down', code: 429 } }), { status: 429 }),
      headers: { 'retry-after': '0' },
    };
    const { fetchImpl, calls } = stubFetch([rateLimited, json(ok)]);

    const result = await mk(fetchImpl).generate(input());
    expect(result.text).toBe('t');
    expect(calls).toHaveLength(2);
  });

  it('gives up after 2 retries on persistent 5xx', async () => {
    // Fresh Response per attempt: a body can only be read once.
    const down = (): { response: Response } => ({ response: new Response('x', { status: 500 }) });
    const { fetchImpl, calls } = stubFetch([down(), down(), down(), down()]);
    const error = await mk(fetchImpl).generate(input()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it('retries a network error, then succeeds', async () => {
    const ok = {
      candidates: [{ content: { parts: [{ text: 't' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
    const { fetchImpl, calls } = stubFetch([new TypeError('fetch failed'), json(ok)]);
    const result = await mk(fetchImpl).generate(input());
    expect(result.text).toBe('t');
    expect(calls).toHaveLength(2);
  });

  it('throws on a 200 with no usable text', async () => {
    const { fetchImpl } = stubFetch([json({ candidates: [] })]);
    await expect(mk(fetchImpl).generate(input())).rejects.toThrow(/empty response/);
  });
});

describe('fake adapter', () => {
  it('plays a script, records inputs, then repeats a canned reply', async () => {
    const boom = new Error('provider is down');
    const fake = createFakeLlm([{ text: '{"a":1}', inputTokens: 5, outputTokens: 6 }, boom]);

    const first = await fake.generate(input({ userText: 'one' }));
    expect(first).toEqual({ text: '{"a":1}', inputTokens: 5, outputTokens: 6 });
    await expect(fake.generate(input({ userText: 'two' }))).rejects.toBe(boom);
    const third = await fake.generate(input({ userText: 'three' }));
    expect(third.text).toContain('reply_parts');

    expect(fake.calls.map((c) => c.userText)).toEqual(['one', 'two', 'three']);
  });
});
