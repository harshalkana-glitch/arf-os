/**
 * End-to-end ingestion test.
 *
 * Real Fastify, real PostgreSQL, real MinIO. This is the vertical slice the
 * build prompt defines, exercised the whole way through:
 *
 *   verification -> presigned upload -> checksum verification ->
 *   raw artefact preserved -> parse -> trade ledger ->
 *   equity reconstruction -> independent metrics -> parity
 *
 * Requires: docker compose -f infra/docker/docker-compose.yml up -d
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, newId, type DatabaseHandle } from '@arf/db';
import {
  artefacts,
  memberships,
  organisations,
  outboxEvents,
  strategies,
  strategyVersions,
  users,
} from '@arf/db/schema';
import { buildApp } from './app.js';
import { S3ObjectStore } from '@arf/backtest-sdk';

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test';

let handle: DatabaseHandle;
let app: FastifyInstance;
let store: S3ObjectStore;
let orgId: string;
let devUser: string;

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../packages/pine/fixtures/${name}`, import.meta.url)),
    'utf8',
  );

beforeAll(async () => {
  handle = createDatabase({ url: TEST_URL, maxConnections: 6 });
  await migrate(handle.db, {
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

  orgId = newId();
  await handle.db
    .insert(organisations)
    .values({ id: orgId, name: 'Ingestion Org', slug: `ingest-${orgId}` });

  devUser = `operator-${orgId}`;
  const userId = newId();
  await handle.db.insert(users).values({ id: userId, externalId: devUser, email: 'op@test.dev' });
  await handle.db
    .insert(memberships)
    .values({ id: newId(), organisationId: orgId, userId, role: 'OPERATOR' });

  app = buildApp({
    db: handle.db,
    store,
    auth: { allowDevAuth: true, environment: 'local' },
    logLevel: 'silent',
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

const asOperator = () => ({ 'x-dev-user': devUser });

const SOURCE_HASH = 'f'.repeat(64);

async function makeVersion(): Promise<string> {
  const strategyId = newId();
  const versionId = newId();
  await handle.db.insert(strategies).values({
    id: strategyId,
    organisationId: orgId,
    name: 'Ingestion Strategy',
    family: 'trend_following',
  });
  await handle.db.insert(strategyVersions).values({
    id: versionId,
    organisationId: orgId,
    strategyId,
    versionNumber: 1,
    state: 'TRADINGVIEW_VERIFICATION',
    pineSourceHash: SOURCE_HASH,
  });
  return versionId;
}

/** Run the full flow and return the ids it produced. */
async function ingest(csv: string, filename = 'trades.csv') {
  const versionId = await makeVersion();

  const created = await app.inject({
    method: 'POST',
    url: '/v1/verifications',
    headers: asOperator(),
    payload: {
      strategyVersionId: versionId,
      symbol: 'BYBIT:BTCUSDT.P',
      timeframe: '60',
      settings: { commission: 0.06, slippage: 2 },
    },
  });
  expect(created.statusCode).toBe(201);
  const verificationId = created.json().id;

  const bytes = new TextEncoder().encode(csv);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const presigned = await app.inject({
    method: 'POST',
    url: `/v1/verifications/${verificationId}/uploads`,
    headers: asOperator(),
    payload: {
      filename,
      contentType: 'text/csv',
      reportKind: 'LIST_OF_TRADES',
      declaredSha256: sha256,
      byteSize: bytes.byteLength,
    },
  });
  expect(presigned.statusCode).toBe(201);
  const { uploadId, objectKey } = presigned.json();

  // Stand in for the browser PUT to the presigned URL.
  await store.put(objectKey, bytes, 'text/csv');

  return { versionId, verificationId, uploadId, objectKey, sha256 };
}

describe('the full ingestion pipeline', () => {
  it('goes from upload to parity, computing every number independently', async () => {
    const { verificationId, uploadId, sha256 } = await ingest(
      fixture('list-of-trades.v2.us.csv'),
    );

    const completed = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().sha256).toBe(sha256);

    // The raw bytes are preserved and content-addressed (CLAUDE.md 15.1).
    const [artefact] = await handle.db
      .select()
      .from(artefacts)
      .where(eq(artefacts.id, completed.json().artefactId));
    expect(artefact?.contentSha256).toBe(sha256);

    // Completion emits through the outbox for the parse worker to consume.
    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, uploadId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('report_upload.completed');

    const processed = await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/process`,
      headers: asOperator(),
      payload: { timeZone: 'Etc/UTC', initialCapital: '10000' },
    });
    expect(processed.statusCode).toBe(200);
    const { backtestRunId, tradeCount } = processed.json();
    // Three trades in the fixture, one of them still open.
    expect(tradeCount).toBe(2);

    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/backtest-runs/${backtestRunId}/evidence`,
      headers: asOperator(),
    });
    expect(evidence.statusCode).toBe(200);
    const body = evidence.json();

    // Trades, reconstructed from the raw file.
    expect(body.trades).toHaveLength(2);
    expect(body.trades[0]).toMatchObject({ tradeNumber: 1, direction: 'LONG', netPnl: '119.5000000000' });

    // Fees and gross are null, not zero (ADR-0002).
    expect(body.trades[0].fees).toBeNull();
    expect(body.trades[0].grossPnl).toBeNull();

    // Equity: an opening point plus one per closed trade.
    expect(body.equity).toHaveLength(3);
    expect(body.equity[0]).toMatchObject({ tradeNumber: 0, equity: '10000.0000000000' });
    // 10000 + 119.50 - 51.50 = 10068
    expect(body.equity[2].equity).toBe('10068.0000000000');

    // Metrics are ARF-calculated and labelled as such.
    const byName = new Map<string, { value: string | null; source: string; nullReason?: string }>(
      body.metrics.map((m: { name: string }) => [m.name, m]),
    );
    expect(byName.get('net_profit')?.value).toBe('68.0000000000');
    expect(byName.get('net_profit')?.source).toBe('ARF_CALCULATED');
    expect(byName.get('closed_trade_count')?.value).toBe('2.0000000000');

    // total_fees is undefined-with-reason, never zero.
    expect(byName.get('total_fees')?.value).toBeNull();
    expect(byName.get('total_fees')?.nullReason).toMatch(/no per-trade commission/);
  });

  it('computes parity against the reported cumulative total, not against itself', async () => {
    // ARF sums the per-trade P&L column; TradingView reports its own running
    // total in a separate column. Those agreeing is a real check of the
    // reconstruction. Comparing ARF's number with ARF's number would always
    // pass and would prove nothing.
    const { verificationId, uploadId } = await ingest(fixture('list-of-trades.v2.us.csv'));
    await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/process`,
      headers: asOperator(),
      payload: { timeZone: 'Etc/UTC', initialCapital: '10000' },
    });

    const parity = await app.inject({
      method: 'GET',
      url: `/v1/verifications/${verificationId}/parity`,
      headers: asOperator(),
    });
    expect(parity.statusCode).toBe(200);
    const report = parity.json();

    expect(report.identityMatches).toBe(true);
    expect(report.firstDivergentTradeNumber).toBeNull();

    // ARF's reconstructed 68.00 versus TradingView's reported cumulative 68.00.
    const netProfit = report.comparisons.find(
      (c: { field: string }) => c.field === 'net_profit',
    );
    expect(netProfit.arfValue).toBe('68');
    expect(netProfit.tradingViewValue).toBe('68');
    expect(netProfit.withinTolerance).toBe(true);
  });

  it('detects a reconstruction that disagrees with the reported total', async () => {
    // The cumulative column is doctored so the reported running total no
    // longer matches the sum of the per-trade column. This is exactly the
    // class of defect the check exists to catch.
    const doctored = fixture('list-of-trades.v2.us.csv').replace('68.00', '999.00');
    const { verificationId, uploadId } = await ingest(doctored, 'doctored.csv');
    await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/process`,
      headers: asOperator(),
      payload: { timeZone: 'Etc/UTC', initialCapital: '10000' },
    });

    const parity = await app.inject({
      method: 'GET',
      url: `/v1/verifications/${verificationId}/parity`,
      headers: asOperator(),
    });
    expect(parity.json().status).toBe('FAIL');
  });

  it('parses the European export to the same numbers as the US one', async () => {
    // The two fixtures describe the same trades in different locales. If
    // locale handling is wrong these diverge by a factor of 1000.
    const { verificationId, uploadId } = await ingest(
      fixture('list-of-trades.v1.eu.csv'),
      'eu.csv',
    );
    await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    const processed = await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/process`,
      headers: asOperator(),
      payload: { timeZone: 'Europe/Berlin', dayFirst: true, initialCapital: '10000' },
    });
    expect(processed.statusCode).toBe(200);

    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/backtest-runs/${processed.json().backtestRunId}/evidence`,
      headers: asOperator(),
    });
    const body = evidence.json();
    expect(body.trades[0].netPnl).toBe('119.5000000000');
    expect(body.trades[1].netPnl).toBe('-51.5000000000');
    // Berlin is UTC+1 in January.
    expect(body.trades[0].entryTime).toBe('2026-01-05T08:00:00.000Z');
  });
});

describe('upload validation', () => {
  it('rejects a file whose checksum does not match what was declared', async () => {
    // A mismatch means the stored object is not what was authorised:
    // truncated, corrupted, or substituted.
    const versionId = await makeVersion();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/verifications',
      headers: asOperator(),
      payload: { strategyVersionId: versionId, symbol: 'X:Y', timeframe: '60', settings: {} },
    });
    const verificationId = created.json().id;

    const presigned = await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/uploads`,
      headers: asOperator(),
      payload: {
        filename: 'trades.csv',
        contentType: 'text/csv',
        reportKind: 'LIST_OF_TRADES',
        // A checksum for content we will not actually upload.
        declaredSha256: 'a'.repeat(64),
        byteSize: 100,
      },
    });
    const { uploadId, objectKey } = presigned.json();
    await store.put(objectKey, new TextEncoder().encode('different content'), 'text/csv');

    const completed = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    expect(completed.statusCode).toBe(422);
    expect(completed.json().detail).toMatch(/declared checksum/);
  });

  it('rejects a content type that is not a CSV export', async () => {
    const versionId = await makeVersion();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/verifications',
      headers: asOperator(),
      payload: { strategyVersionId: versionId, symbol: 'X:Y', timeframe: '60', settings: {} },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/verifications/${created.json().id}/uploads`,
      headers: asOperator(),
      payload: {
        filename: 'report.pdf',
        contentType: 'application/pdf',
        reportKind: 'LIST_OF_TRADES',
        declaredSha256: 'a'.repeat(64),
        byteSize: 100,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a verification for a version with no Pine revision', async () => {
    const strategyId = newId();
    const versionId = newId();
    await handle.db
      .insert(strategies)
      .values({ id: strategyId, organisationId: orgId, name: 'No pine', family: 'other' });
    await handle.db.insert(strategyVersions).values({
      id: versionId,
      organisationId: orgId,
      strategyId,
      versionNumber: 1,
      state: 'PINE_DEVELOPMENT',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/verifications',
      headers: asOperator(),
      payload: { strategyVersionId: versionId, symbol: 'X:Y', timeframe: '60', settings: {} },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/no Pine revision/);
  });

  it('is idempotent when an upload is completed twice', async () => {
    const { uploadId } = await ingest(fixture('list-of-trades.v2.us.csv'));
    const first = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().artefactId).toBe(first.json().artefactId);
  });
});

describe('the verification task tells the operator exactly what to run', () => {
  it('freezes and returns the expected identity', async () => {
    // Spec 13.2: the operator is shown the exact source, symbol, timeframe
    // and settings, and a later change to the version cannot alter them.
    const { verificationId } = await ingest(fixture('list-of-trades.v2.us.csv'));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/verifications/${verificationId}`,
      headers: asOperator(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expected).toMatchObject({
      sourceHash: SOURCE_HASH,
      symbol: 'BYBIT:BTCUSDT.P',
      timeframe: '60',
    });
  });

  it('keeps parser warnings visible after a successful parse', async () => {
    const { verificationId, uploadId } = await ingest(fixture('list-of-trades.v2.us.csv'));
    await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/complete`,
      headers: asOperator(),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/verifications/${verificationId}/process`,
      headers: asOperator(),
      payload: { timeZone: 'Etc/UTC', initialCapital: '10000' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/verifications/${verificationId}`,
      headers: asOperator(),
    });
    const upload = res.json().uploads[0];
    expect(upload.status).toBe('PARSED');
    // A file that parsed with an excluded open position is still worth
    // flagging (spec 15.2), so warnings are not cleared on success.
    expect(upload.parserWarnings.some((w: string) => w.includes('open position'))).toBe(true);
  });
});
