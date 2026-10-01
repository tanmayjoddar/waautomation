/**
 * Process entry point: load config, create the logger, start the HTTP server.
 * Workers (jobs/worker.ts, jobs/sheetSync.ts) are started in later slices.
 */
import { createApp } from './app.js';
import { EnvError, getConfig, type AppConfig } from './config.js';
import { createLogger, type LogLevel } from './logger.js';

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
  const app = createApp({ config, logger });
  const server = app.listen(config.port, () => {
    const base = config.publicBaseUrl ?? `http://localhost:${config.port}`;
    logger.info({ port: config.port, baseUrl: base }, 'listening');
    // Handy in the terminal, harmless in production logs.
    process.stdout.write(`listening on ${base}  (GET /healthz)\n`);
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    // Do not hang forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
