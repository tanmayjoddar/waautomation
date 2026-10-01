/**
 * Process entry point: load config, create the logger, start the HTTP server.
 * Workers (jobs/worker.ts, jobs/sheetSync.ts) are started in later slices.
 */
import { createApp } from './app.js';
import { EnvError, getConfig, type AppConfig } from './config.js';
import { createServiceClient } from './db/supabase.js';
import { createLogger, type LogLevel } from './logger.js';
import type { Logger } from 'pino';
import type { Express } from 'express';
import { createEchoHooks } from './services/echo.js';
import { drainBackgroundWork } from './webhook/route.js';

function listen(app: Express, config: AppConfig, logger: Logger): void {
  const server = app.listen(config.port, () => {
    const base = config.publicBaseUrl ?? `http://localhost:${config.port}`;
    logger.info({ port: config.port, baseUrl: base }, 'listening');
    // Handy in the terminal, harmless in production logs.
    process.stdout.write(`listening on ${base}  (GET /healthz)\n`);
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Webhook work that started after a 200 is already sent: let it finish, or
    // the message is lost and Meta will not redeliver it.
    const forced = setTimeout(() => process.exit(0), 5000);
    forced.unref();

    server.close(() => {
      void drainBackgroundWork().finally(() => {
        clearTimeout(forced);
        process.exit(0);
      });
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

  // Slice 3: temporary echo for the demo client. Resolved BEFORE listening so a
  // delivery can never land before the wiring exists. A database that is down
  // at startup only disables the echo (logged below); the webhook itself still
  // answers and stores, per request. Slice 4 deletes this block and echo.ts.
  const hooks = await createEchoHooks({ config, logger, supabase }).catch((err: unknown) => {
    logger.error({ err }, 'echo wiring failed: continuing without echo');
    return undefined;
  });

  listen(createApp({ config, logger, supabase, hooks }), config, logger);
}

void main();