import { closeBrowser, warmUpBrowser } from './browser';
import { config } from './config';
import { migrate, pool } from './db';
import { scheduleIndiaImport } from './osmImport';
import { buildServer } from './server';

async function main() {
  await migrate();
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  if (config.osmImportEnabled) scheduleIndiaImport(app.log);
  if (config.googleMapsEnabled) warmUpBrowser().catch((err) => app.log.warn({ err }, 'Chromium failed to start'));

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await closeBrowser();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
