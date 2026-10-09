// Local Postgres for development, no Docker needed: `npm run db:dev`, then `npm run dev` in another terminal.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = join(process.cwd(), '.pgdata');
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 5433, persistent: true });

async function main() {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  await pg.createDatabase('hospitals').catch(() => {}); // already exists
  console.log('Postgres ready at postgres://postgres:postgres@localhost:5433/hospitals (Ctrl+C to stop)');
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
