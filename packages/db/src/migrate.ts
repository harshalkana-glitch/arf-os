/**
 * Migration runner.
 *
 * Spec 20.3: migrations run as a dedicated release step, never implicitly on
 * service boot, so a rolling deploy cannot have two versions racing to apply
 * the same migration.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  const handle = createDatabase({ url, maxConnections: 1 });
  try {
        // fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/...'
    // which fs cannot open.
    const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
    await migrate(handle.db, { migrationsFolder });
    console.log('migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
