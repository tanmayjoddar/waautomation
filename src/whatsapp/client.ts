/**
 * WhatsApp Cloud API adapter (spec 1.7). ALL Meta API calls live in this file,
 * so an API change touches one place.
 *
 * Written against (check these if Meta changes something):
 *  - send text:        https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages/
 *  - send guide:        https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/
 *  - mark as read:      https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read/
 *  - typing indicator:  https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
 *  - endpoint reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *                        POST /{Version}/{Phone-Number-ID}/messages
 *
 * Two deviations from the spec's starter shapes, both from the current docs:
 *  - sendText includes `"recipient_type": "individual"` (the reference marks it
 *    required, the starter shape omitted it);
 *  - `to` is sent as `+<digits>`. Our contacts store E.164 digits WITHOUT the
 *    plus, and the docs warn that omitting it makes Meta prepend the BUSINESS
 *    number's country code, which misdelivers.
 *
 * Reliability contract (spec 1.7 + Slice 3 requirements):
 *  - every call has a timeout (default 10s);
 *  - exactly ONE retry on 5xx or network errors (timeout included);
 *  - NO retry on 4xx (a bad request stays bad; retrying error 131009 or an
 *    invalid token only burns rate limit and confuses the logs);
 *  - structured error logging that never contains the token or a full phone
 *    number (the recipient is logged masked, `91*****78`).
 *
 * [VERIFY]: the failure envelope is assumed to be the standard Graph API shape
 * `{ "error": { "message", "code", "error_subcode?", "type?", "fbtrace_id?" } }`.
 * WhatsApp documents individual error CODES (e.g. 131009 for a bad message_id)
 * but not a different envelope; if Meta ever returns something else here, the
 * `unknown Meta error shape` branch below is what fires.
 */
import type { Logger } from 'pino';
import { maskPhone } from '../logger.js';

/** The narrow surface the rest of the app (and later slices) programs against. */
export type WhatsAppClient = {
  /** Sends a free-text message inside the 24h window. Resolves with Meta's wamid. */
  sendText(to: string, body: string): Promise<{ wamid: string }>;
  /** Marks an inbound message read and shows "typing...". Fire-and-forget. */
  markReadAndType(wamid: string): Promise<void>;
};

export type WhatsAppClientOptions = {
  phoneNumberId: string;
  /** Bearer token. Stored, never logged, never included in any log field. */
  token: string;
  /** e.g. 'v21.0', from GRAPH_API_VERSION. */
  graphApiVersion: string;
  /** Per-attempt timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
};

/** Thrown when a Meta call fails after the allowed attempts. */
export class WhatsAppApiError extends Error {
  /** HTTP status, or null when no response arrived (network/timeout). */
  readonly status: number | null;
  /** Meta's `error.code` when the body parsed, e.g. 131009. */
  readonly metaCode: number | null;
  /** 'sendText' | 'markReadAndType'. */
  readonly op: string;
  /** How many HTTP attempts were made (1 or 2). */
  readonly attempts: number;

  constructor(op: string, status: number | null, metaCode: number | null, attempts: number, message: string) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.op = op;
    this.status = status;
    this.metaCode = metaCode;
    this.attempts = attempts;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Exactly one retry: two attempts maximum, whatever happens. */
const MAX_ATTEMPTS = 2;

type MetaFailure = { status: number | null; metaCode: number | null; detail: string };

/** Best effort at Meta's failure shape; never throws on unexpected bodies. */
function readMetaFailure(status: number | null, bodyText: string): MetaFailure {
  if (status === null) return { status: null, metaCode: null, detail: 'no response from Meta' };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status, metaCode: null, detail: `unparseable error body (${bodyText.length} chars)` };
  }
  const err = (parsed as { error?: unknown })?.error;
  if (typeof err !== 'object' || err === null) {
    return { status, metaCode: null, detail: 'unknown Meta error shape' };
  }
  const record = err as Record<string, unknown>;
  return {
    status,
    metaCode: typeof record['code'] === 'number' ? record['code'] : null,
    detail: typeof record['message'] === 'string' ? record['message'] : 'Meta error without a message',
  };
}

/** Retryable = the request might succeed if tried again: 5xx or no response. */
const isRetryable = (status: number | null): boolean => status === null || status >= 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 300ms between the single retry: enough to ride out a blip, not a queue. */
const RETRY_DELAY_MS = 300;

async function post(
  options: Required<Pick<WhatsAppClientOptions, 'phoneNumberId' | 'token' | 'graphApiVersion' | 'timeoutMs'>> &
    Pick<WhatsAppClientOptions, 'fetchImpl' | 'logger'>,
  op: 'sendText' | 'markReadAndType',
  body: Record<string, unknown>,
  logContext: Record<string, unknown>,
): Promise<unknown> {
  const url = `https://graph.facebook.com/${options.graphApiVersion}/${options.phoneNumberId}/messages`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastFailure: MetaFailure = { status: null, metaCode: null, detail: 'not attempted' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response | null = null;
    let responseText = '';
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // AbortSignal.timeout is Node 18+. The token and the phone number never
        // enter the log line; `logContext` carries the masked recipient.
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      responseText = await res.text();
    } catch (err) {
      // Network error, DNS failure, or the timeout above fired: retryable.
      lastFailure = { status: null, metaCode: null, detail: err instanceof Error ? err.message : String(err) };
    }

    if (res !== null) {
      if (res.ok) {
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          throw new WhatsAppApiError(op, res.status, null, attempt, `${op}: Meta returned 200 with an unparseable body`);
        }
      }
      lastFailure = readMetaFailure(res.status, responseText);
      if (!isRetryable(res.status)) {
        // 4xx: the request itself is wrong (bad token, bad wamid, bad number).
        // Retrying cannot help, so fail loud and fast.
        options.logger?.warn(
          { op, attempt, ...logContext, status: res.status, metaCode: lastFailure.metaCode },
          'WhatsApp API call rejected (no retry on 4xx)',
        );
        throw new WhatsAppApiError(op, res.status, lastFailure.metaCode, attempt, `${op}: ${lastFailure.detail}`);
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      options.logger?.warn(
        { op, attempt, ...logContext, status: lastFailure.status, metaCode: lastFailure.metaCode },
        'WhatsApp API call failed, retrying once',
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  options.logger?.error(
    { op, attempts: MAX_ATTEMPTS, ...logContext, status: lastFailure.status, metaCode: lastFailure.metaCode },
    'WhatsApp API call failed after the retry',
  );
  throw new WhatsAppApiError(
    op,
    lastFailure.status,
    lastFailure.metaCode,
    MAX_ATTEMPTS,
    `${op}: ${lastFailure.detail}`,
  );
}

/** Our contacts store E.164 digits without '+'; Meta wants the plus. */
const toRecipient = (to: string): string => `+${to.trim().replace(/^\+/, '')}`;

export function createWhatsAppClient(options: WhatsAppClientOptions): WhatsAppClient {
  const shared = {
    phoneNumberId: options.phoneNumberId,
    token: options.token,
    graphApiVersion: options.graphApiVersion,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  };

  return {
    async sendText(to: string, body: string): Promise<{ wamid: string }> {
      const recipient = toRecipient(to);
      const parsed = (await post(shared, 'sendText', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body },
      },
      // Masked on purpose: the pino phone redaction would catch a `to` key,
      // but this log line must be safe under ANY logger. It travels under
      // `toMasked` (not a phone path) because pino would otherwise replace
      // even the pre-masked value with [redacted], losing the debug value.
      { toMasked: maskPhone(recipient), phoneNumberId: options.phoneNumberId })) as {
        messages?: Array<{ id?: unknown }>;
      };
      const wamid = parsed?.messages?.[0]?.id;
      if (typeof wamid !== 'string' || wamid === '') {
        throw new WhatsAppApiError('sendText', 200, null, 1, 'sendText: Meta accepted the message but returned no wamid');
      }
      return { wamid };
    },

    async markReadAndType(wamid: string): Promise<void> {
      const parsed = (await post(shared, 'markReadAndType', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
        typing_indicator: { type: 'text' },
      },
      { wamid, phoneNumberId: options.phoneNumberId })) as { success?: unknown };
      // A wamid is a Meta id, not customer PII (ingest already logs wamids).
      if (parsed?.success !== true) {
        throw new WhatsAppApiError('markReadAndType', 200, null, 1, 'markReadAndType: Meta did not confirm the read receipt');
      }
    },
  };
}
