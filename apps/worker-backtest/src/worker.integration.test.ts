/**
 * Worker integration tests.
 *
 * Real PostgreSQL, real Redis, real MinIO. These assert the properties that
 * only appear once the pieces are wired together: that a committed outbox row
 * reaches a queue, that the handler is safe to run twice, and — most
 * importantly — that a worker cannot advance a strategy's lifecycle state.
 *
 * Requires: docker compose -f infra/docker/docker-compose.yml up -d
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, newId, type Database, type DatabaseHandle } from '@arf/db';
import {
  artefacts,
  auditEvents,
  backtestRuns,
  organisations,
  outboxEvents,
  reportUploads,
  strategies,
  strategyVersions,
  tradingviewVerifications,
} from '@arf/db/schema';
import {
  BullMqPublisher,
  QUEUE_REPORT_INGESTION,
  createRedis,
  relayOnce,
  type EventPublisher,
  type OutboxRecord,
} from '@arf/event-bus';
import { S3ObjectStore, verificationUploadKey } from '@arf/backtest-sdk';
import { handleReportIngestion } from './handler.js';

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

let handle: DatabaseHandle;
let db: Database;
let store: S3ObjectStore;
let connection: Redis;
let queue: Queue;
let orgId: string;

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../packages/pine/fixtures/${name}`, import.meta.url)),
    'utf8',
  );

beforeAll(async () => {
  handle = createDatabase({ url: TEST_URL, maxConnections: 6 });
  db = handle.db;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  });

  store = new S3ObjectStore({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: 'auto',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'arf_local',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arf_local_dev_secret',
    bucket: process.env['S3_BUCKET_UPLOADS'] ?? 'arf-uploads',
    forcePathStyle: true,
    presignTtlSeconds: 900,
  });

  connection = createRedis(REDIS_URL);
  queue = new Queue(QUEUE_REPORT_INGESTION, { connection });
  await queue.obliterate({ force: true });

  orgId = newId();
  await db.insert(organisations).values({ id: orgId, name: 'Worker Org', slug: `worker-${orgId}` });
}, 180_000);

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await connection?.quit();
  await handle?.close();
});

const DEFAULTS = { timeZone: 'Etc/UTC', initialCapital: '10000' } as const;

/** Build a verification with a completed upload sitting in object storage. */
async function stageUpload(csv: string): Promise<{
  versionId: string;
  verificationId: string;
  uploadId: string;
}> {
  const strategyId = newId();
  const versionId = newId();
  const verificationId = newId();
  const uploadId = newId();
  const artefactId = newId();

  await db
    .insert(strategies)
    .values({ id: strategyId, organisationId: orgId, name: 'S', family: 'trend_following' });
  await db.insert(strategyVersions).values({
    id: versionId,
    organisationId: orgId,
    strategyId,
    versionNumber: 1,
    state: 'TRADINGVIEW_VERIFICATION',
    pineSourceHash: 'a'.repeat(64),
  });
  await db.insert(tradingviewVerifications).values({
    id: verificationId,
    organisationId: orgId,
    strategyVersionId: versionId,
    status: 'AWAITING_UPLOAD',
    expectedSourceHash: 'a'.repeat(64),
    expectedSymbol: 'BYBIT:BTCUSDT.P',
    expectedTimeframe: '60',
    expectedSettings: {},
  });

  const bytes = new TextEncoder().encode(csv);
  const objectKey = verificationUploadKey(orgId, versionId, verificationId, uploadId, 'trades.csv');
  await store.put(objectKey, bytes, 'text/csv');

  await db.insert(artefacts).values({
    id: artefactId,
    organisationId: orgId,
    objectKey,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'text/csv',
    byteSize: bytes.byteLength,
    kind: 'tradingview_report',
  });
  await db.insert(reportUploads).values({
    id: uploadId,
    organisationId: orgId,
    verificationId,
    artefactId,
    reportKind: 'LIST_OF_TRADES',
    status: 'UPLOADED',
    originalFilename: 'trades.csv',
  });

  return { versionId, verificationId, uploadId };
}

describe('the outbox relay', () => {
  it('publishes a committed event and marks it published', async () => {
    const eventId = newId();
    await db.insert(outboxEvents).values({
      id: eventId,
      organisationId: orgId,
      eventType: 'report_upload.completed',
      aggregateType: 'report_upload',
      aggregateId: newId(),
      payload: { uploadId: newId(), verificationId: newId(), artefactId: newId() },
    });

    const captured: OutboxRecord[] = [];
    const publisher: EventPublisher = {
      publish: async (event) => {
        captured.push(event);
      },
    };

    const result = await relayOnce(db, publisher, { batchSize: 100 });
    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(captured.some((e) => e.id === eventId)).toBe(true);

    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
    expect(row?.publishedAt).not.toBeNull();
  });

  it('does not republish an already-published event', async () => {
    const publisher: EventPublisher = { publish: async () => undefined };
    await relayOnce(db, publisher, { batchSize: 100 });

    const captured: OutboxRecord[] = [];
    const second = await relayOnce(
      db,
      {
        publish: async (e) => {
          captured.push(e);
        },
      },
      { batchSize: 100 },
    );
    expect(second.claimed).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it('records the failure and retries rather than dropping the event', async () => {
    // An event that could not be delivered is evidence of an incident.
    // Deleting it would erase the only trace that it happened.
    const eventId = newId();
    await db.insert(outboxEvents).values({
      id: eventId,
      organisationId: orgId,
      eventType: 'report_upload.completed',
      aggregateType: 'report_upload',
      aggregateId: newId(),
      payload: {},
    });

    const failing: EventPublisher = {
      publish: async () => {
        throw new Error('queue unreachable');
      },
    };
    const result = await relayOnce(db, failing, { batchSize: 100 });
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
    expect(row?.publishedAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('queue unreachable');
  });

  it('stops retrying an event that has exhausted its attempts', async () => {
    const eventId = newId();
    await db.insert(outboxEvents).values({
      id: eventId,
      organisationId: orgId,
      eventType: 'report_upload.completed',
      aggregateType: 'report_upload',
      aggregateId: newId(),
      payload: {},
      attempts: 10,
    });

    const captured: OutboxRecord[] = [];
    await relayOnce(
      db,
      {
        publish: async (e) => {
          captured.push(e);
        },
      },
      { batchSize: 100, maxAttempts: 10 },
    );
    expect(captured.some((e) => e.id === eventId)).toBe(false);

    // Left in place, unpublished, for an operator to find.
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
    expect(row?.publishedAt).toBeNull();
  });
});

describe('the BullMQ publisher', () => {
  it('enqueues a job with a deterministic id so a duplicate relay is a no-op', async () => {
    const publisher = new BullMqPublisher(connection);
    const eventId = newId();
    const record: OutboxRecord = {
      id: eventId,
      organisationId: orgId,
      eventType: 'report_upload.completed',
      eventVersion: 1,
      aggregateType: 'report_upload',
      aggregateId: newId(),
      payload: { uploadId: newId(), verificationId: newId(), artefactId: newId() },
      traceId: null,
      correlationId: null,
      causationId: null,
      attempts: 0,
    };

    // At-least-once delivery means the same event can be offered twice.
    await publisher.publish(record);
    await publisher.publish(record);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const matching = jobs.filter((j) => j.data.outboxEventId === eventId);
    expect(matching).toHaveLength(1);
    await publisher.close();
  });

  it('marks an unrouted event type published rather than failing it', async () => {
    // The outbox is the system's event log; most event types have no queue
    // consumer, and that is not an error.
    const publisher = new BullMqPublisher(connection);
    await expect(
      publisher.publish({
        id: newId(),
        organisationId: orgId,
        eventType: 'strategy_version.transitioned',
        eventVersion: 1,
        aggregateType: 'strategy_version',
        aggregateId: newId(),
        payload: {},
        traceId: null,
        correlationId: null,
        causationId: null,
        attempts: 0,
      }),
    ).resolves.toBeUndefined();
    await publisher.close();
  });
});

describe('the ingestion job handler', () => {
  it('processes a staged upload into a full evidence chain', async () => {
    const { verificationId, uploadId } = await stageUpload(
      fixture('list-of-trades.v2.us.csv'),
    );

    const outcome = await handleReportIngestion(
      { db, store, defaults: DEFAULTS },
      { outboxEventId: newId(), organisationId: orgId, uploadId, verificationId, artefactId: newId() },
    );

    expect(outcome.status).toBe('PROCESSED');
    if (outcome.status !== 'PROCESSED') return;
    expect(outcome.result.tradeCount).toBe(2);

    const [run] = await db
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.id, outcome.result.backtestRunId));
    expect(run?.runnerType).toBe('TRADINGVIEW');
  });

  it('does NOT advance the strategy lifecycle state', async () => {
    // CLAUDE.md 3.2. This is the assertion that matters most in this file: a
    // worker that could promote its own successful job would let the system
    // advance work without policy ever being applied.
    const { versionId, verificationId, uploadId } = await stageUpload(
      fixture('list-of-trades.v2.us.csv'),
    );

    const before = await db
      .select({ state: strategyVersions.state })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId));

    await handleReportIngestion(
      { db, store, defaults: DEFAULTS },
      { outboxEventId: newId(), organisationId: orgId, uploadId, verificationId, artefactId: newId() },
    );

    const after = await db
      .select({ state: strategyVersions.state })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId));

    expect(after[0]?.state).toBe(before[0]?.state);
    expect(after[0]?.state).toBe('TRADINGVIEW_VERIFICATION');
  });

  it('attributes its audit rows to the service, not to a person', async () => {
    const { verificationId, uploadId } = await stageUpload(
      fixture('list-of-trades.v2.us.csv'),
    );
    await handleReportIngestion(
      { db, store, defaults: DEFAULTS },
      { outboxEventId: newId(), organisationId: orgId, uploadId, verificationId, artefactId: newId() },
    );

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.aggregateId, verificationId),
          eq(auditEvents.action, 'verification.processed'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe('SERVICE');
    expect(rows[0]?.actorId).toBe('worker-backtest');
  });

  it('is idempotent: a redelivered job does not create a second run', async () => {
    // Delivery is at-least-once by design, so this must hold.
    const { verificationId, uploadId } = await stageUpload(
      fixture('list-of-trades.v2.us.csv'),
    );
    const job = {
      outboxEventId: newId(),
      organisationId: orgId,
      uploadId,
      verificationId,
      artefactId: newId(),
    };

    const first = await handleReportIngestion({ db, store, defaults: DEFAULTS }, job);
    const second = await handleReportIngestion({ db, store, defaults: DEFAULTS }, job);

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('ALREADY_PROCESSED');

    const runs = await db
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.verificationId, verificationId));
    expect(runs).toHaveLength(1);
  });

  it('treats an unparseable export as terminal and records why', async () => {
    // Retrying a file that will never parse burns the attempt budget and
    // delays the signal that the export itself is wrong.
    const { verificationId, uploadId } = await stageUpload('Nonsense,Header\n1,2\n');

    const outcome = await handleReportIngestion(
      { db, store, defaults: DEFAULTS },
      { outboxEventId: newId(), organisationId: orgId, uploadId, verificationId, artefactId: newId() },
    );

    expect(outcome.status).toBe('REJECTED');

    const [verification] = await db
      .select()
      .from(tradingviewVerifications)
      .where(eq(tradingviewVerifications.id, verificationId));
    expect(verification?.status).toBe('FAILED');
    expect(verification?.failureReason).toBeTruthy();

    // The failure is audited so it is visible in the UI, not only in a
    // dead-letter queue.
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.aggregateId, verificationId),
          eq(auditEvents.action, 'verification.ingestion_failed'),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it('rejects a job naming an upload from another organisation', async () => {
    const { verificationId, uploadId } = await stageUpload(
      fixture('list-of-trades.v2.us.csv'),
    );
    const outcome = await handleReportIngestion(
      { db, store, defaults: DEFAULTS },
      {
        outboxEventId: newId(),
        organisationId: newId(), // a different organisation
        uploadId,
        verificationId,
        artefactId: newId(),
      },
    );
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('upload_not_found');
  });
});
