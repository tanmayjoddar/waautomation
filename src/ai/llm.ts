/**
 * LLM adapter contract + shared HTTP core (Slice 4).
 *
 * One interface for every provider; the worker programs against this, never
 * against provider shapes. Plain fetch everywhere: no SDK knows all three
 * providers, and an SDK would hide the exact bytes we must control (timeout,
 * Retry-After, no-logging).
 *
 * Reliability contract:
 *  - per-call timeout via AbortController (LLM_TIMEOUT_MS);
 *  - retry ONLY 429 / 5xx / network errors, max 2 retries, exponential backoff
 *    with jitter, honouring Retry-After (seconds or HTTP date, capped at 30s);
 *  - NEVER retry other 4xx: 401 means a bad key and 404 a bad model, and
 *    retrying those burns quota while logging the same line. They fail fast
 *    with a clear message, logged once.
 *  - never log prompts, replies, keys or phone numbers: error logs carry
 *    status codes and provider codes only.
 */
import type { Logger } from 'pino';

export type LlmRole = 'user' | 'assistant';

export type LlmMessage = { role: LlmRole; text: string };

export type GenerateInput = {
  /** Full system prompt. Never logged. */
  system: string;
  /** Older turns first. Customer text inside is data, already trimmed by the caller. */
  history: LlmMessage[];
  /** The current customer text. Never logged. */
  userText: string;
  maxTokens: number;
  timeoutMs: number;
};

export type GenerateResult = {
  /** Raw model text (JSON string when a structured option was used). Never logged. */
  text: string;
  inputTokens: number;
  outputTokens: number;
};

/** The narrow surface the worker programs against. */
export type LlmAdapter = {
  readonly provider: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
};

export class LlmError extends Error {
  /** HTTP status, or null when no response arrived (network/timeout). */
  readonly status: number | null;
  /** Provider's own error code when the body parsed. */
  readonly providerCode: string | number | null;
  /** False for 4xx (except 429): retrying cannot help. */
  readonly retryable: boolean;

  constructor(message: string, status: number | null, providerCode: string | number | null, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

export type HttpOptions = {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Base backoff between retries. Tests pass a small value; default 500ms. */
  baseDelayMs?: number;
  op?: string;
};

/** Retry-After: delta-seconds or an HTTP date, capped so one slow shed never parks a worker slot. */
const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMs(value: string | null): number | null {
  if (value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_AFTER_MS));
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Initial try + 2 retries. */
const MAX_ATTEMPTS = 4;

/** Best effort at a provider error body; never throws, never includes content. */
function readErrorBody(status: number, text: string): { code: string | number | null; message: string } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: null, message: `HTTP ${status} with an unparseable body` };
  }
  // OpenAI/Gemini shape: { error: { message, code } }.
  const openai = (parsed as { error?: unknown })?.error;
  if (typeof openai === 'object' && openai !== null) {
    const record = openai as Record<string, unknown>;
    return {
      code: typeof record['code'] === 'string' || typeof record['code'] === 'number' ? record['code'] : status,
      message: typeof record['message'] === 'string' ? record['message'] : `HTTP ${status}`,
    };
  }
  // Anthropic shape: { type: 'error', error: { type, message } }.
  const anthropic = (parsed as { error?: unknown })?.error;
  if (typeof anthropic === 'object' && anthropic !== null) {
    const record = anthropic as Record<string, unknown>;
    return {
      code: typeof record['type'] === 'string' ? record['type'] : status,
      message: typeof record['message'] === 'string' ? record['message'] : `HTTP ${status}`,
    };
  }
  return { code: status, message: `HTTP ${status}` };
}

const isAuthOrModelError = (status: number): boolean => status === 401 || status === 403 || status === 404;

/**
 * POST JSON with the Slice 4 retry policy. Returns the parsed body on 2xx.
 * Throws LlmError otherwise (after retries when allowed).
 */
export async function postJsonWithRetry(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: HttpOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseDelay = options.baseDelayMs ?? 1000;
  const op = options.op ?? 'llm.generate';
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();

      if (res.ok) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new LlmError(`${op}: provider returned 200 with an unparseable body`, res.status, null, false);
        }
      }

      const failure = readErrorBody(res.status, text);
      const retryable = res.status === 429 || res.status >= 500;
      if (isAuthOrModelError(res.status)) {
        // Logged once, never retried: the key or the model name is wrong and
        // every retry would fail identically while burning quota.
        options.logger?.error(
          { op, status: res.status, providerCode: failure.code },
          `${op}: ${res.status === 404 ? 'unknown model' : 'invalid API key'} (not retried)`,
        );
      } else {
        options.logger?.warn({ op, attempt, status: res.status, providerCode: failure.code }, `${op}: attempt failed`);
      }
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new LlmError(`${op}: ${failure.message}`, res.status, failure.code, retryable);
      }
      const retryAfter = res.headers.get('retry-after');
      const wait = retryAfterMs(retryAfter) ?? Math.min(baseDelay * 2 ** (attempt - 1) + Math.random() * 250, MAX_RETRY_AFTER_MS);
      await sleep(wait);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      // Network error, DNS failure, or our own timeout: always retryable.
      options.logger?.warn({ op, attempt, detail: err instanceof Error ? err.message : String(err) }, `${op}: attempt failed`);
      if (attempt >= MAX_ATTEMPTS) {
        throw new LlmError(`${op}: no response (network or timeout)`, null, null, true);
      }
      await sleep(Math.min(baseDelay * 2 ** (attempt - 1) + Math.random() * 250, MAX_RETRY_AFTER_MS));
    } finally {
      clearTimeout(timer);
    }
  }
}
