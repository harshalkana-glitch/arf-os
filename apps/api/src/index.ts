/**
 * API entry point.
 *
 * Configuration is read once, here, and passed down. Nothing deeper in the
 * tree touches process.env, so a test can construct the whole app with
 * explicit dependencies (CLAUDE.md 7.1).
 */
import { createDatabase } from '@arf/db';
import { buildApp } from './app.js';
import { S3ObjectStore } from '@arf/backtest-sdk';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const environment = process.env['ARF_ENVIRONMENT'] ?? 'local';
  const { db, close } = createDatabase({ url: required('DATABASE_URL') });

  const store = new S3ObjectStore({
    endpoint: required('S3_ENDPOINT'),
    region: process.env['S3_REGION'] ?? 'auto',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    bucket: required('S3_BUCKET_UPLOADS'),
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
    presignTtlSeconds: Number(process.env['S3_PRESIGN_TTL_SECONDS'] ?? 900),
  });

  const app = buildApp({
    db,
    store,
    auth: {
      // The stub is only ever offered locally, and buildApp refuses to
      // construct if this is true in any other environment.
      allowDevAuth: environment === 'local',
      environment,
    },
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  });

  const port = Number(process.env['API_PORT'] ?? 3001);
  const host = process.env['API_HOST'] ?? '127.0.0.1';

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await close();
        process.exit(0);
      })();
    });
  }

  await app.listen({ port, host });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
