/**
 * Backtest worker.
 *
 * Runs two things: the outbox relay, which moves committed domain events onto
 * the queue, and the BullMQ worker that consumes report-ingestion jobs.
 *
 * They live in one process for now because the relay is cheap and running it
 * beside its only consumer keeps deployment simple. It is safe to run several
 * copies: the relay claims rows with FOR UPDATE SKIP LOCKED, so instances take
 * disjoint batches rather than duplicating each other.
 */
import { Worker } from 'bullmq';
import { createDatabase } from '@arf/db';
import {
  BullMqPublisher,
  QUEUE_REPORT_INGESTION,
  ReportIngestionJob,
  createRedis,
  startRelay,
} from '@arf/event-bus';
import { S3ObjectStore } from '@arf/backtest-sdk';
import { handleReportIngestion } from './handler.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function log(message: string, context?: Record<string, unknown>): void {
  // Structured, single-line (CLAUDE.md 20). Never interpolate a payload.
  console.log(JSON.stringify({ level: 'info', service: 'worker-backtest', message, ...context }));
}

async function main(): Promise<void> {
  const { db, close } = createDatabase({ url: required('DATABASE_URL'), maxConnections: 5 });
  const connection = createRedis(required('REDIS_URL'));
  const publisher = new BullMqPublisher(connection);

  const store = new S3ObjectStore({
    endpoint: required('S3_ENDPOINT'),
    region: process.env['S3_REGION'] ?? 'auto',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    bucket: required('S3_BUCKET_UPLOADS'),
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
    presignTtlSeconds: Number(process.env['S3_PRESIGN_TTL_SECONDS'] ?? 900),
  });

  const relay = startRelay(db, publisher, {
    intervalMs: Number(process.env['OUTBOX_POLL_MS'] ?? 1_000),
    onResult: (result) => {
      if (result.published > 0 || result.failed > 0) log('outbox relayed', { ...result });
    },
    onError: (error: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'worker-backtest',
          message: 'outbox relay failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  const worker = new Worker(
    QUEUE_REPORT_INGESTION,
    async (job) => {
      // The job body is a contract and is validated, never trusted
      // (CLAUDE.md 3.3).
      const parsed = ReportIngestionJob.parse(job.data);
      return handleReportIngestion(
        {
          db,
          store,
          defaults: {
            timeZone: process.env['INGESTION_DEFAULT_TIMEZONE'] ?? 'Etc/UTC',
            initialCapital: process.env['INGESTION_DEFAULT_CAPITAL'] ?? '10000',
          },
          log,
        },
        parsed,
      );
    },
    { connection, concurrency: Number(process.env['WORKER_CONCURRENCY'] ?? 4) },
  );

  worker.on('failed', (job, error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'worker-backtest',
        message: 'job failed',
        jobId: job?.id,
        attempts: job?.attemptsMade,
        error: error.message,
      }),
    );
  });

  log('worker started', { queue: QUEUE_REPORT_INGESTION });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        // Drain in order: stop claiming, finish in-flight jobs, then close.
        await relay.stop();
        await worker.close();
        await publisher.close();
        await connection.quit();
        await close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
