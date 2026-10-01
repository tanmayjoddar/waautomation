/**
 * The webhook route (spec 1.6).
 *
 *   GET  /webhook  -> Meta's one-time verification handshake
 *   POST /webhook  -> verify the signature, answer 200, then work in the background
 *
 * Two details that are easy to get wrong and expensive to discover:
 *
 *  1. The signature covers the exact bytes Meta sent. express.json() would throw
 *     those away, so this route mounts its own raw parser and parses the buffer
 *     itself. app.ts deliberately has no global body parser for this reason.
 *
 *  2. The 200 goes out before any database work. Meta gives a webhook a short
 *     budget and retries whatever does not answer in time, and a retry is a
 *     duplicate delivery. The pending work is tracked so tests (and a graceful
 *     shutdown) can wait for it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import express, { type Express, type Request, type Response, type Router } from 'express';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { ingestWebhookPayload, type IngestDeps, type IngestSummary } from './ingest.js';
import { SIGNATURE_HEADER, verifySignature } from './signature.js';

/** Meta payloads are small; anything larger is abuse or a mistake. */
const RAW_BODY_LIMIT = '2mb';

const rawBody = express.raw({ type: '*/*', limit: RAW_BODY_LIMIT });

/**
 * What a delivery holds, counted without interpreting it (ingest interprets).
 * Deliberately shallow and total: a weird shape counts as zero, never throws.
 * Only the business's own phone_number_ids are collected, never anything
 * customer-identifying, so this object is safe to log whole.
 */
function countDelivery(payload: unknown): { entries: number; messages: number; statuses: number; phoneNumberIds: string[] } {
  const counts = { entries: 0, messages: 0, statuses: 0, phoneNumberIds: [] as string[] };
  const root = payload as { entry?: unknown };
  if (typeof root !== 'object' || root === null || !Array.isArray(root.entry)) return counts;
  counts.entries = root.entry.length;
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: unknown })?.value as
        | { messages?: unknown; statuses?: unknown; metadata?: unknown }
        | undefined;
      if (typeof value !== 'object' || value === null) continue;
      if (Array.isArray(value.messages)) counts.messages += value.messages.length;
      if (Array.isArray(value.statuses)) counts.statuses += value.statuses.length;
      const id = (value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
      if (typeof id === 'string' && id !== '' && !counts.phoneNumberIds.includes(id)) counts.phoneNumberIds.push(id);
    }
  }
  return counts;
}

/**
 * Work started after a response was sent. Kept so tests can await it and so
 * shutdown can wait for in-flight deliveries.
 */
const pending = new Set<Promise<unknown>>();

/** Schedules post-response work and remembers it. Failures never escape. */
export function runInBackground(work: () => Promise<unknown>): Promise<unknown> {
  const promise = (async () => work())().catch(() => undefined);
  pending.add(promise);
  void promise.finally(() => {
    pending.delete(promise);
  });
  return promise;
}

/** Resolves once every scheduled post-response task has settled. */
export async function drainBackgroundWork(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

export type WebhookDeps = {
  config: AppConfig;
  logger: Logger;
  supabase: SupabaseClient;
  /** Post-response hooks for the later slices (typing indicator, unsupported reply). */
  hooks?: IngestDeps['hooks'];
  /** Replaces the ingest pipeline. Route-level tests use this. */
  ingest?: (deps: IngestDeps, payload: unknown) => Promise<unknown>;
};

/** Meta's verification handshake: echo hub.challenge only for the right token. */
function handleVerification(config: AppConfig, req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = config.meta?.verifyToken;
  // A duplicated parameter arrives as an array, and echoing a half-answer as 200
  // would look like a successful verification to Meta while failing silently.
  if (mode !== 'subscribe' || expected === undefined || token !== expected || typeof challenge !== 'string' || challenge === '') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // Spec: the challenge is echoed as PLAIN TEXT, not JSON.
  res.status(200).type('text/plain').send(challenge);
}

export function createWebhookRouter(deps: WebhookDeps): Router {
  const { config, logger } = deps;
  const router = express.Router();

  router.get('/webhook', (req, res) => handleVerification(config, req, res));

  router.post('/webhook', rawBody, (req, res) => {
    if (config.meta === null) {
      // Not a security problem, an unconfigured deployment: say so plainly
      // instead of pretending the signature was wrong.
      res.status(503).json({ error: 'whatsapp_not_configured' });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length === 0) {
      logger.warn({}, 'webhook POST with an empty body: rejected');
      res.status(400).json({ error: 'empty_body' });
      return;
    }

    const header = req.headers[SIGNATURE_HEADER];
    const verdict = verifySignature(header, body, config.meta.appSecret);
    if (!verdict.ok) {
      // The response says nothing about which part of the header was wrong.
      logger.warn({ reason: verdict.reason }, 'webhook signature rejected');
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    // Answer first, work second (spec 1.6 step 2).
    res.status(200).json({ received: true });

    // Parse here, synchronously, so every accepted POST leaves exactly one
    // info line even if the background work never runs: counts plus the
    // business number ids seen, never customer data. Whether each id matched
    // a client is logged by ingest ('webhook change routed' vs the unknown-id
    // warning), which owns the database.
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      // The signature was valid, so Meta did its job; we simply cannot read it.
      logger.warn({}, 'signed webhook body was not valid JSON: answered 200, nothing to process');
      return;
    }
    logger.info(countDelivery(payload), 'webhook POST received');

    const ingestDeps: IngestDeps = {
      supabase: deps.supabase,
      logger,
      debounceSeconds: config.timings.debounceSeconds,
      hooks: deps.hooks,
    };

    void runInBackground(async () => {
      try {
        const summary = (await (deps.ingest ?? ingestWebhookPayload)(ingestDeps, payload)) as IngestSummary | undefined;
        if (summary) deps.logger.debug({ summary }, 'webhook background work finished');
      } catch (err) {
        // Never let this reach the response: it is already sent.
        logger.error({ err }, 'webhook background work failed');
      }
    });
  });

  return router;
}