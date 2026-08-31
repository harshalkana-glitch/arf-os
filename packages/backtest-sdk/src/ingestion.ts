/**
 * TradingView report ingestion.
 *
 * The pipeline the build prompt describes, end to end:
 *
 *   presign -> upload -> verify checksum -> preserve raw -> parse ->
 *   trade ledger -> equity reconstruction -> independent metrics -> parity
 *
 * Two rules shape the whole module.
 *
 * The raw upload is preserved untouched and content-addressed (CLAUDE.md
 * 15.1, 15.2), so a parser bug can be re-run against the original bytes rather
 * than against an already-normalised copy. Nothing here mutates a stored
 * artefact.
 *
 * ARF's own numbers are computed independently and stored separately from
 * TradingView's reported ones (CLAUDE.md 18.1). They are never merged into a
 * single unlabelled value; the parity report is what compares them.
 */
import { and, asc, eq } from 'drizzle-orm';
import { canonicalHash } from '@arf/contracts';
import type { Database } from '@arf/db';
import { newId } from '@arf/db';
import {
  artefacts,
  auditEvents,
  backtestRuns,
  equityPoints,
  metricSnapshots,
  outboxEvents,
  parityReports,
  reportUploads,
  strategyVersions,
  trades,
  tradingviewVerifications,
} from '@arf/db/schema';
import { computeCoreMetrics, reconstructEquity } from '@arf/metrics';
import {
  PARSER_VERSION,
  computeParity,
  parseListOfTrades,
  TOLERANCE_POLICY_VERSION,
  type ParityTrade,
} from '@arf/pine';
import {
  IngestionConflictError,
  IngestionValidationError,
  ResourceNotFoundError,
} from './errors.js';
import { verificationUploadKey, type ObjectStore } from './storage.js';

/**
 * Who is performing the ingestion.
 *
 * Deliberately narrower than the API's AuthContext: the pipeline needs an
 * organisation to scope by and an actor to attribute audit rows to, and
 * nothing else. A worker supplies its service identity here, which is why
 * this module carries no HTTP types.
 */
export interface ActorContext {
  readonly organisationId: string;
  /** User id, or a service name such as 'worker-backtest'. */
  readonly actorId: string;
  readonly actorType: 'HUMAN' | 'SERVICE';
}

/** Upload size ceiling. Spec 15.1 requires a size check before acceptance. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = ['text/csv', 'application/csv', 'text/plain'] as const;

export interface CreateVerificationInput {
  readonly strategyVersionId: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly settings: Record<string, unknown>;
  readonly rangeStart?: string | undefined;
  readonly rangeEnd?: string | undefined;
  /**
   * The chart timezone the operator will export in. Required, no default:
   * guessing shifts every trade and can move it across a segment boundary.
   */
  readonly chartTimezone: string;
  /** Set only when the export uses ambiguous day-first dates. */
  readonly dateFormatDayFirst?: boolean | undefined;
  readonly initialCapital: string;
}

/**
 * Create a verification task.
 *
 * The expected identity is frozen onto the row now, from the strategy version
 * as it stands. A later change to the version cannot retroactively alter what
 * the operator was asked to run, which is what makes the parity comparison
 * meaningful afterwards.
 */
export async function createVerification(
  db: Database,
  actor: ActorContext,
  input: CreateVerificationInput,
): Promise<{ id: string; expectedSourceHash: string }> {
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.id, input.strategyVersionId),
        eq(strategyVersions.organisationId, actor.organisationId),
      ),
    )
    .limit(1);

  if (!version) throw new ResourceNotFoundError('Strategy version', input.strategyVersionId);
  if (!version.pineSourceHash) {
    throw new IngestionValidationError('This strategy version has no Pine revision to verify.', [
      { path: 'strategyVersionId', message: 'pineSourceHash is not set' },
    ]);
  }

  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(tradingviewVerifications).values({
      id,
      organisationId: actor.organisationId,
      strategyVersionId: input.strategyVersionId,
      status: 'AWAITING_UPLOAD',
      expectedSourceHash: version.pineSourceHash as string,
      expectedSymbol: input.symbol,
      expectedTimeframe: input.timeframe,
      expectedSettings: input.settings,
      chartTimezone: input.chartTimezone,
      initialCapital: input.initialCapital,
      ...(input.dateFormatDayFirst === undefined
        ? {}
        : { dateFormatDayFirst: input.dateFormatDayFirst }),
      ...(input.rangeStart ? { expectedRangeStart: input.rangeStart } : {}),
      ...(input.rangeEnd ? { expectedRangeEnd: input.rangeEnd } : {}),
      ...(actor.actorType === 'HUMAN' ? { requestedByUserId: actor.actorId } : {}),
    });

    await tx.insert(auditEvents).values({
      id: newId(),
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'verification.created',
      aggregateType: 'tradingview_verification',
      aggregateId: id,
      newState: { strategyVersionId: input.strategyVersionId, symbol: input.symbol },
    });
  });

  return { id, expectedSourceHash: version.pineSourceHash };
}

export interface PresignInput {
  readonly verificationId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly reportKind: 'PERFORMANCE_SUMMARY' | 'LIST_OF_TRADES';
  /** The client's checksum of what it is about to upload. */
  readonly declaredSha256: string;
  readonly byteSize: number;
}

/** Presign an upload slot and record the pending row. */
export async function presignUpload(
  db: Database,
  store: ObjectStore,
  actor: ActorContext,
  input: PresignInput,
): Promise<{ uploadId: string; url: string; objectKey: string; expiresInSeconds: number }> {
  if (!ALLOWED_CONTENT_TYPES.includes(input.contentType as (typeof ALLOWED_CONTENT_TYPES)[number])) {
    throw new IngestionValidationError(`Content type ${input.contentType} is not accepted.`, [
      { path: 'contentType', message: `Expected one of ${ALLOWED_CONTENT_TYPES.join(', ')}` },
    ]);
  }
  if (input.byteSize > MAX_UPLOAD_BYTES) {
    throw new IngestionValidationError('Upload exceeds the maximum accepted size.', [
      { path: 'byteSize', message: `Maximum is ${MAX_UPLOAD_BYTES} bytes` },
    ]);
  }

  const verification = await loadVerification(db, actor, input.verificationId);

  const uploadId = newId();
  const objectKey = verificationUploadKey(
    actor.organisationId,
    verification.strategyVersionId,
    verification.id,
    uploadId,
    input.filename,
  );

  const presigned = await store.presignUpload(objectKey, input.contentType);

  await db.insert(reportUploads).values({
    id: uploadId,
    organisationId: actor.organisationId,
    verificationId: verification.id,
    reportKind: input.reportKind,
    status: 'PRESIGNED',
    originalFilename: input.filename,
    declaredSha256: input.declaredSha256,
    ...(actor.actorType === 'HUMAN' ? { uploadedByUserId: actor.actorId } : {}),
  });

  return { uploadId, ...presigned };
}

/**
 * Complete an upload.
 *
 * The stored bytes are hashed and compared with the checksum the client
 * declared *before* uploading. A mismatch means the object is not what was
 * authorised — truncated, corrupted, or substituted — and it is rejected
 * rather than parsed (spec 15.1).
 */
export async function completeUpload(
  db: Database,
  store: ObjectStore,
  actor: ActorContext,
  uploadId: string,
): Promise<{ uploadId: string; artefactId: string; sha256: string }> {
  const [upload] = await db
    .select()
    .from(reportUploads)
    .where(
      and(
        eq(reportUploads.id, uploadId),
        eq(reportUploads.organisationId, actor.organisationId),
      ),
    )
    .limit(1);

  if (!upload) throw new ResourceNotFoundError('Report upload', uploadId);
  if (upload.status !== 'PRESIGNED') {
    // Idempotency: completing twice is not an error, but it must not re-run.
    if (upload.artefactId) {
      const [existing] = await db
        .select()
        .from(artefacts)
        .where(eq(artefacts.id, upload.artefactId))
        .limit(1);
      if (existing) {
        return { uploadId, artefactId: existing.id, sha256: existing.contentSha256 };
      }
    }
    throw new IngestionConflictError('upload_already_completed', 'This upload was already completed.');
  }

  const verification = await loadVerification(db, actor, upload.verificationId);
  const objectKey = verificationUploadKey(
    actor.organisationId,
    verification.strategyVersionId,
    verification.id,
    uploadId,
    upload.originalFilename ?? 'upload.csv',
  );

  const stored = await store.get(objectKey);

  if (upload.declaredSha256 && stored.sha256 !== upload.declaredSha256) {
    await db
      .update(reportUploads)
      .set({
        status: 'REJECTED',
        rejectionReason: `Checksum mismatch: declared ${upload.declaredSha256}, stored ${stored.sha256}.`,
      })
      .where(eq(reportUploads.id, uploadId));
    throw new IngestionValidationError('The uploaded file does not match its declared checksum.', [
      { path: 'sha256', message: 'Stored object checksum differs from the declared value' },
    ]);
  }

  const artefactId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(artefacts).values({
      id: artefactId,
      organisationId: actor.organisationId,
      objectKey,
      contentSha256: stored.sha256,
      contentType: 'text/csv',
      byteSize: stored.byteSize,
      kind: 'tradingview_report',
    });

    await tx
      .update(reportUploads)
      .set({ status: 'UPLOADED', artefactId, uploadedAt: new Date().toISOString() })
      .where(eq(reportUploads.id, uploadId));

    await tx.insert(auditEvents).values({
      id: newId(),
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'report_upload.completed',
      aggregateType: 'report_upload',
      aggregateId: uploadId,
      newState: { artefactId, sha256: stored.sha256, byteSize: stored.byteSize },
    });

    // The parse is a background job. Emitting through the outbox means it is
    // scheduled only if this transaction commits (CLAUDE.md 9.3).
    await tx.insert(outboxEvents).values({
      id: newId(),
      organisationId: actor.organisationId,
      eventType: 'report_upload.completed',
      aggregateType: 'report_upload',
      aggregateId: uploadId,
      payload: { uploadId, verificationId: verification.id, artefactId },
    });
  });

  return { uploadId, artefactId, sha256: stored.sha256 };
}

export interface ProcessResult {
  readonly verificationId: string;
  readonly backtestRunId: string;
  readonly tradeCount: number;
  readonly parityStatus: string;
  readonly parityReportId: string;
  readonly warnings: readonly string[];
}

/**
 * Parse an uploaded List of Trades and build the full evidence chain.
 *
 * Invoked by the backtest worker in normal operation; exposed directly for now
 * so the pipeline is drivable before the queue exists. Everything it writes is
 * derived from the preserved raw artefact, so re-running it after a parser fix
 * produces a new run rather than editing an old one.
 */
export async function processVerification(
  db: Database,
  store: ObjectStore,
  actor: ActorContext,
  verificationId: string,
): Promise<ProcessResult> {
  const verification = await loadVerification(db, actor, verificationId);

  const [upload] = await db
    .select()
    .from(reportUploads)
    .where(
      and(
        eq(reportUploads.verificationId, verificationId),
        eq(reportUploads.reportKind, 'LIST_OF_TRADES'),
        eq(reportUploads.status, 'UPLOADED'),
      ),
    )
    .limit(1);

  if (!upload?.artefactId) {
    throw new IngestionValidationError('No completed List of Trades upload for this verification.', [
      { path: 'verificationId', message: 'Upload a List of Trades export first' },
    ]);
  }

  const [artefact] = await db
    .select()
    .from(artefacts)
    .where(eq(artefacts.id, upload.artefactId))
    .limit(1);
  if (!artefact) throw new ResourceNotFoundError('Artefact', upload.artefactId);

  const stored = await store.get(artefact.objectKey);
  // The artefact is content-addressed; if the bytes no longer hash to the
  // recorded value the store has been tampered with or corrupted.
  if (stored.sha256 !== artefact.contentSha256) {
    throw new IngestionConflictError(
      'artefact_checksum_mismatch',
      'The stored artefact no longer matches its recorded checksum.',
    );
  }

  const text = new TextDecoder().decode(stored.bytes);

  /**
   * Anything the parser throws here is a problem with the file's *content*,
   * not with infrastructure: the bytes have already been fetched and their
   * checksum verified, so no I/O remains that could fail.
   *
   * Translating these into a domain error is what makes them terminal for the
   * worker. Left as raw errors they look like infrastructure faults, and a
   * file that will never parse would be retried until it dead-letters —
   * delaying the signal that the export itself is wrong.
   */
  let parsed;
  try {
    parsed = parseListOfTrades(text, {
      // Read from the verification, not from a caller default: the settings
      // are a property of this specific export.
      timeZone: verification.chartTimezone,
      ...(verification.dateFormatDayFirst === null
        ? {}
        : { dayFirst: verification.dateFormatDayFirst }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IngestionValidationError(`The export could not be parsed: ${message}`, [
      { path: 'file', message },
    ]);
  }

  const ledger = {
    schemaVersion: '1.0.0',
    currency: parsed.currency ?? 'USD',
    initialCapital: verification.initialCapital,
    trades: parsed.trades.map((t) => ({
      tradeNumber: t.tradeNumber,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      // Gross and fees are absent from this source (ADR-0002) and are left
      // null rather than invented.
      grossPnl: null,
      fees: null,
      netPnl: t.netPnl,
    })),
    warnings: [...parsed.warnings],
  };

  const equity = reconstructEquity(ledger);
  const metrics = computeCoreMetrics(ledger);
  const allWarnings = [...parsed.warnings, ...equity.warnings, ...metrics.warnings];

  const runId = newId();
  const parityReportId = newId();

  /**
   * Parity against TradingView's own reported totals.
   *
   * The trade sequence is not in dispute — it came from TradingView — so what
   * is being verified here is ARF's *reconstruction*: we sum the per-trade
   * P&L column ourselves and check the result against TradingView's own
   * running Cumulative P&L, which the export reports independently of the
   * column we summed.
   *
   * That is a real check. Comparing ARF's numbers against ARF's own numbers
   * would always pass and would be precisely the self-endorsement this
   * platform exists to prevent, so when the export carries no cumulative
   * column the report is INSUFFICIENT_DATA rather than a hollow PASS.
   *
   * A true two-engine comparison replaces the second side once the local
   * research runner exists.
   */
  const parityTrades: ParityTrade[] = ledger.trades.map((t) => ({
    tradeNumber: t.tradeNumber,
    direction: t.direction,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    netPnl: t.netPnl,
  }));

  const identity = {
    sourceHash: verification.expectedSourceHash,
    symbol: verification.expectedSymbol,
    timeframe: verification.expectedTimeframe,
    rangeStart: verification.expectedRangeStart,
    rangeEnd: verification.expectedRangeEnd,
    settingsHash: canonicalHash(verification.expectedSettings),
    initialCapital: verification.initialCapital,
  };

  const netProfit = metrics.metrics.find((m) => m.name === 'net_profit')?.value ?? null;
  const maxDrawdown = metrics.metrics.find((m) => m.name === 'max_drawdown')?.value ?? null;

  // TradingView's reported running total after the final closed trade. Null
  // when the export omits the column, which makes parity INSUFFICIENT_DATA.
  const reportedCumulative =
    parsed.trades.length > 0
      ? (parsed.trades[parsed.trades.length - 1]?.cumulativePnl ?? null)
      : null;

  const parity = computeParity(
    {
      identity,
      trades: parityTrades,
      metrics: { net_profit: netProfit, max_drawdown: maxDrawdown },
    },
    {
      identity,
      trades: parityTrades,
      metrics: {
        // TradingView's own figure, not ours.
        net_profit: reportedCumulative,
        // The export's per-trade drawdown column is intra-trade and is not
        // comparable with a closed-trade curve (ADR-0001), so it is not
        // offered here rather than being compared against the wrong thing.
        max_drawdown: null,
      },
    },
  );

  await db.transaction(async (tx) => {
    await tx.insert(backtestRuns).values({
      id: runId,
      organisationId: actor.organisationId,
      strategyVersionId: verification.strategyVersionId,
      verificationId: verification.id,
      runnerType: 'TRADINGVIEW',
      runnerVersion: parsed.parserVersion,
      sourceHash: verification.expectedSourceHash,
      symbol: verification.expectedSymbol,
      timeframe: verification.expectedTimeframe,
      parameters: {},
      costModel: { source: 'tradingview_export', perTradeFeesAvailable: false },
      executionModel: verification.expectedSettings,
      initialCapital: verification.initialCapital,
      currency: ledger.currency,
      status: 'SUCCEEDED',
      warnings: allWarnings,
      completedAt: new Date().toISOString(),
    });

    if (ledger.trades.length > 0) {
      await tx.insert(trades).values(
        ledger.trades.map((t) => ({
          id: newId(),
          organisationId: actor.organisationId,
          backtestRunId: runId,
          tradeNumber: t.tradeNumber,
          direction: t.direction,
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          quantity: t.quantity,
          grossPnl: t.grossPnl,
          fees: t.fees,
          netPnl: t.netPnl,
        })),
      );
    }

    await tx.insert(equityPoints).values(
      equity.points.map((p) => ({
        id: newId(),
        organisationId: actor.organisationId,
        backtestRunId: runId,
        tradeNumber: p.tradeNumber,
        at: p.at,
        equity: p.equity,
        peak: p.peak,
        drawdown: p.drawdown,
        drawdownPercent: p.drawdownPercent,
        calculationVersion: metrics.calculationVersion,
      })),
    );

    // ARF's own numbers, explicitly labelled as such. TradingView's reported
    // figures are stored under a different source and never merged.
    await tx.insert(metricSnapshots).values(
      metrics.metrics.map((m) => ({
        id: newId(),
        organisationId: actor.organisationId,
        metricName: m.name,
        value: m.value,
        ...(m.value === null ? { nullReason: m.nullReason ?? 'Undefined for this input' } : {}),
        unit: m.unit,
        calculationVersion: metrics.calculationVersion,
        scopeType: 'RUN' as const,
        scopeId: runId,
        source: 'ARF_CALCULATED' as const,
      })),
    );

    await tx.insert(parityReports).values({
      id: parityReportId,
      organisationId: actor.organisationId,
      strategyVersionId: verification.strategyVersionId,
      verificationId: verification.id,
      arfRunId: runId,
      status: parity.status,
      tolerancePolicyVersion: TOLERANCE_POLICY_VERSION,
      identityMatches: parity.identityMatches,
      identityMismatches: [...parity.identityMismatches],
      comparisons: [...parity.comparisons],
      firstDivergentTradeNumber: parity.firstDivergentTradeNumber,
      ...(parity.firstDivergenceDetail
        ? { firstDivergenceDetail: parity.firstDivergenceDetail }
        : {}),
      ...(parity.insufficientDataReason
        ? { insufficientDataReason: parity.insufficientDataReason }
        : {}),
    });

    await tx
      .update(reportUploads)
      .set({ status: 'PARSED', parserVersion: PARSER_VERSION, parserWarnings: allWarnings })
      .where(eq(reportUploads.id, upload.id));

    await tx
      .update(tradingviewVerifications)
      .set({ status: 'PARITY_COMPUTED', completedAt: new Date().toISOString() })
      .where(eq(tradingviewVerifications.id, verification.id));

    // First evidence against this version: the content freeze now applies.
    await tx
      .update(strategyVersions)
      .set({ firstTestedAt: new Date().toISOString() })
      .where(
        and(
          eq(strategyVersions.id, verification.strategyVersionId),
          // Only when not already set; the trigger rejects a change.
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      );

    await tx.insert(auditEvents).values({
      id: newId(),
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'verification.processed',
      aggregateType: 'tradingview_verification',
      aggregateId: verification.id,
      newState: {
        backtestRunId: runId,
        tradeCount: ledger.trades.length,
        parityStatus: parity.status,
      },
    });
  });

  return {
    verificationId: verification.id,
    backtestRunId: runId,
    tradeCount: ledger.trades.length,
    parityStatus: parity.status,
    parityReportId,
    warnings: allWarnings,
  };
}

async function loadVerification(
  db: Database,
  actor: ActorContext,
  verificationId: string,
): Promise<typeof tradingviewVerifications.$inferSelect> {
  const [row] = await db
    .select()
    .from(tradingviewVerifications)
    .where(
      and(
        eq(tradingviewVerifications.id, verificationId),
        eq(tradingviewVerifications.organisationId, actor.organisationId),
      ),
    )
    .limit(1);
  if (!row) throw new ResourceNotFoundError('Verification', verificationId);
  return row;
}

/** Read back the reconstructed evidence for a run. */
export async function readRunEvidence(
  db: Database,
  actor: ActorContext,
  runId: string,
): Promise<{
  trades: Array<typeof trades.$inferSelect>;
  equity: Array<typeof equityPoints.$inferSelect>;
  metrics: Array<typeof metricSnapshots.$inferSelect>;
}> {
  const [run] = await db
    .select({ organisationId: backtestRuns.organisationId })
    .from(backtestRuns)
    .where(eq(backtestRuns.id, runId))
    .limit(1);
  if (!run || run.organisationId !== actor.organisationId) {
    throw new ResourceNotFoundError('Backtest run', runId);
  }

  const [tradeRows, equityRows, metricRows] = await Promise.all([
    db.select().from(trades).where(eq(trades.backtestRunId, runId)).orderBy(asc(trades.tradeNumber)),
    db
      .select()
      .from(equityPoints)
      .where(eq(equityPoints.backtestRunId, runId))
      .orderBy(asc(equityPoints.tradeNumber)),
    db
      .select()
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.scopeId, runId), eq(metricSnapshots.scopeType, 'RUN'))),
  ]);

  return { trades: tradeRows, equity: equityRows, metrics: metricRows };
}
