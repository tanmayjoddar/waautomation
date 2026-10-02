/**
 * Process entry point: load config, create the logger, start the HTTP server
 * and (Slice 4) the reply worker. Workers for sheets live in later slices.
 */
import { createApp } from './app.js';
import { EnvError, getConfig, type AppConfig } from './config.js';
import { createServiceClient } from './db/supabase.js';
import { createLogger, type LogLevel } from './logger.js';
import type { Logger } from 'pino';
import type { Express } from 'express';
import { createLlmAdapter, validateLlmModels } from './ai/index.js';
import { startWorker, type WorkerHandle } from './jobs/worker.js';
import { drainBackgroundWork } from './webhook/route.js';

function listen(app: Express, config: AppConfig, logger: Logger, worker: WorkerHandle | null): void {
  const server = app.listen(config.port, () => {
    const base = config.publicBaseUrl ?? `http://localhost:${config.port}`;
    logger.info({ port: config.port, baseUrl: base }, 'listening');
    // Handy in the terminal, harmless in production logs.
    process.stdout.write(`listening on ${base}  (GET /healthz)\n`);
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Webhook work that started after a 200 is already sent: let it finish, or
    // the message is lost and Meta will not redeliver it. The worker stops
    // claiming first (15s cap on in-flight jobs), then the webhook drains.
    const forced = setTimeout(() => process.exit(0), 20_000);
    forced.unref();

    server.close(() => {
      void (async () => {
        if (worker !== null) await worker.stop();
        await drainBackgroundWork();
        clearTimeout(forced);
        process.exit(0);
      })().catch(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof EnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel as LogLevel });
  // The webhook needs it; creating the client does no network I/O, so a database
  // that is down is reported per request instead of stopping the server from
  // starting.
  const supabase = createServiceClient(config);

  // Slice 4 worker: answers queued reply jobs. Off unless enabled AND the LLM
  // trio is configured; either way the webhook is unaffected. Warned once, not
  // on every poll, so a keyless dev server stays quiet. Model names are
  // validated against the provider before the first claim: a typo fails here,
  // loudly, instead of failing every job quietly later.
  let worker: WorkerHandle | null = null;
  if (!config.worker.enabled) {
    logger.debug({}, 'worker disabled: WORKER_ENABLED is false');
  } else if (config.llm === null) {
    logger.warn({}, 'worker not started: set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL to enable replies');
  } else {
    try {
      await validateLlmModels(config.llm, logger);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'worker not started: fix the LLM model configuration',
      );
      listen(createApp({ config, logger, supabase }), config, logger, null);
      return;
    }
    worker = startWorker({ supabase, logger, config, llm: createLlmAdapter(config.llm, logger) });
    logger.info(
      { pollMs: config.worker.pollMs, concurrency: config.worker.concurrency, provider: config.llm.provider },
      'reply worker started',
    );
  }

  listen(createApp({ config, logger, supabase }), config, logger, worker);
}

void main();
