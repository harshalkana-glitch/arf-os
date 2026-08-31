/**
 * Development seed.
 *
 * Creates an organisation, a developer identity, and one strategy version with
 * a *real* ingested TradingView export — not fabricated rows. CLAUDE.md 27 is
 * explicit that the platform must not start with a dashboard backed by fake
 * data, so this seed drives the actual ingestion pipeline: the fixture is
 * uploaded to object storage, parsed, reconstructed and parity-checked exactly
 * as an operator's upload would be.
 *
 * Safe to run repeatedly: it creates a fresh organisation each time rather
 * than mutating an existing one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDatabase, newId } from '@arf/db';
import { memberships, organisations, strategies, strategyVersions, users } from '@arf/db/schema';
import {
  S3ObjectStore,
  completeUpload,
  createVerification,
  presignUpload,
  processVerification,
} from '@arf/backtest-sdk';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const { db, close } = createDatabase({ url, maxConnections: 4 });

  try {
    const externalId = process.env['ARF_DEV_USER'] ?? 'dev-user';

    /**
     * Reuse the developer's existing organisation on a re-seed.
     *
     * Creating a second one would leave the dev identity a member of two, and
     * the API deliberately refuses to guess which organisation a request is
     * scoped to — so a naive re-seed would break every page with a 403. That
     * guard is correct; the seed is what has to be idempotent.
     */
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, externalId));

    const actualUserId = existingUser?.id ?? newId();
    if (!existingUser) {
      await db
        .insert(users)
        .values({ id: actualUserId, externalId, email: `${externalId}@local.dev` });
    }

    const [existingMembership] = await db
      .select({ organisationId: memberships.organisationId })
      .from(memberships)
      .where(eq(memberships.userId, actualUserId))
      .limit(1);

    let orgId: string;
    if (existingMembership) {
      orgId = existingMembership.organisationId;
      console.log('reusing existing organisation', orgId);
    } else {
      orgId = newId();
      await db
        .insert(organisations)
        .values({ id: orgId, name: 'Development Org', slug: `dev-${orgId.slice(0, 12)}` });
      await db
        .insert(memberships)
        .values({ id: newId(), organisationId: orgId, userId: actualUserId, role: 'ADMIN' });
    }

    const strategyId = newId();
    const versionId = newId();
    const sourceText = '//@version=6\nstrategy("Example Trend Pullback", overlay=true)\n';
    const sourceHash = createHash('sha256').update(sourceText).digest('hex');

    await db.insert(strategies).values({
      id: strategyId,
      organisationId: orgId,
      name: 'Example Trend Pullback',
      family: 'trend_following',
    });
    await db.insert(strategyVersions).values({
      id: versionId,
      organisationId: orgId,
      strategyId,
      versionNumber: 1,
      state: 'TRADINGVIEW_VERIFICATION',
      pineSourceHash: sourceHash,
      createdByUserId: actualUserId,
    });

    const store = new S3ObjectStore({
      endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
      region: 'auto',
      accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'arf_local',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arf_local_dev_secret',
      bucket: process.env['S3_BUCKET_UPLOADS'] ?? 'arf-uploads',
      forcePathStyle: true,
      presignTtlSeconds: 900,
    });

    const actor = { organisationId: orgId, actorId: actualUserId, actorType: 'HUMAN' as const };

    const verification = await createVerification(db, actor, {
      strategyVersionId: versionId,
      symbol: 'BYBIT:BTCUSDT.P',
      timeframe: '60',
      settings: { commission: 0.06, slippageTicks: 2, pyramiding: 0 },
      chartTimezone: 'Etc/UTC',
      initialCapital: '10000',
    });

    const csv = readFileSync(
      fileURLToPath(
        new URL('../../../packages/pine/fixtures/list-of-trades.v2.us.csv', import.meta.url),
      ),
      'utf8',
    );
    const bytes = new TextEncoder().encode(csv);

    const upload = await presignUpload(db, store, actor, {
      verificationId: verification.id,
      filename: 'list-of-trades.csv',
      contentType: 'text/csv',
      reportKind: 'LIST_OF_TRADES',
      declaredSha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.byteLength,
    });

    // Stands in for the operator's browser PUT to the presigned URL.
    await store.put(upload.objectKey, bytes, 'text/csv');
    await completeUpload(db, store, actor, upload.uploadId);

    const result = await processVerification(db, store, actor, verification.id);

    /**
     * Emit the ids when asked, so an end-to-end run can address the exact
     * records this seed produced rather than scraping them out of a page.
     */
    const outputPath = process.env['SEED_OUTPUT'];
    if (outputPath) {
      writeFileSync(
        outputPath,
        JSON.stringify(
          {
            organisationId: orgId,
            externalId,
            strategyVersionId: versionId,
            backtestRunId: result.backtestRunId,
            verificationId: verification.id,
            tradeCount: result.tradeCount,
            parityStatus: result.parityStatus,
          },
          null,
          2,
        ),
      );
    }

    console.log('seeded:');
    console.log(`  organisation      ${orgId}`);
    console.log(`  dev user          ${externalId}`);
    console.log(`  strategy version  ${versionId}`);
    console.log(`  backtest run      ${result.backtestRunId}`);
    console.log(`  trades ingested   ${result.tradeCount}`);
    console.log(`  parity            ${result.parityStatus}`);
    console.log('');
    console.log(`  open  /strategy-versions/${versionId}`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
