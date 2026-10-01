/**
 * Express app factory.
 *
 * `/healthz` and, from Slice 2, the Meta webhook.
 *
 * There is deliberately NO global express.json() here: the webhook signature is
 * computed over the exact bytes Meta sent, and a JSON body parser would consume
 * them and make X-Hub-Signature-256 impossible to verify (and impossible to debug
 * when it fails). The webhook route mounts its own raw parser.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { createWebhookRouter, type WebhookDeps } from './webhook/route.js';

export type AppDeps = {
  config: AppConfig;
  logger: Logger;
  /**
   * Needed only by the webhook. A server started without a database (nothing in
   * this project needs one before Slice 2) can leave it out; the webhook then
   * answers 503 instead of pretending to work.
   */
  supabase?: SupabaseClient;
  /** Forwarded to the webhook router; used by tests. */
  hooks?: WebhookDeps['hooks'];
  /** Replaces the ingest pipeline; used by tests. */
  ingest?: WebhookDeps['ingest'];
};

export function createApp({ config, logger, supabase, hooks, ingest }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // One debug line per request: method, path, status, duration. This is the
  // cheapest "is this process serving anything" proof: enable debug logging
  // and every request, including Meta's, shows up here.
  // Path ONLY, never req.url: the query string carries hub.verify_token and
  // hub.challenge, and logging it would print a credential.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.debug(
        { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started },
        'http request',
      );
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      env: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      features: config.features,
    });
  });

  if (supabase) {
    app.use(createWebhookRouter({ config, logger, supabase, hooks, ingest }));
  } else {
    logger.warn({}, 'no Supabase client: /webhook is not mounted');
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  logger.debug({ port: config.port }, 'app created');
  return app;
}