/**
 * Process entry point: load config, create the logger, start the HTTP server.
 * Workers (jobs/worker.ts, jobs/sheetSync.ts) are started in later slices.
 */
import { createApp } from './app.js';
import { EnvError, getConfig, type AppConfig } from './config.js';
import { createServiceClient } from './db/supabase.js';
import { createLogger, type LogLevel } from './logger.js';
import { drainBackgroundWork } from './webhook/route.js';

function main(): void {
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

  const app = createApp({ config, logger, supabase });
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

main();