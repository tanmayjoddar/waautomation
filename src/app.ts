/**
 * Express app factory.
 *
 * Slice 0 builds only the health endpoint. The webhook route (Slice 2) mounts
 * its own raw body parser, so there is deliberately NO global express.json()
 * here: adding it now would make the raw body unreadable and silently break
 * X-Hub-Signature-256 verification later.
 */
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';

export type AppDeps = {
  config: AppConfig;
  logger: Logger;
};

export function createApp({ config, logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      env: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      features: config.features,
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  logger.debug({ port: config.port }, 'app created');
  return app;
}
