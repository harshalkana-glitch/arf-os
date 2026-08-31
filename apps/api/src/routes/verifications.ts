/**
 * TradingView verification routes.
 *
 * The human-assisted workflow from spec 13.2: the operator is shown the exact
 * source hash, symbol, timeframe and settings to run, uploads the exports, and
 * the platform ingests them. CLAUDE.md 3.8 is why this is human-assisted —
 * browser automation is deliberately not a core dependency.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@arf/db';
import { parityReports, reportUploads, tradingviewVerifications } from '@arf/db/schema';
import { assertSameOrganisation, requireRole } from '../auth.js';
import { UnauthorisedError } from '../errors.js';
import { toIso } from '../serialization.js';
import type { ObjectStore } from '../storage.js';
import {
  completeUpload,
  createVerification,
  presignUpload,
  processVerification,
  readRunEvidence,
} from '../services/ingestion.js';

const CreateBody = z.object({
  strategyVersionId: z.string().uuid(),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  settings: z.record(z.string(), z.unknown()).default({}),
  rangeStart: z.string().datetime({ offset: true }).optional(),
  rangeEnd: z.string().datetime({ offset: true }).optional(),
});

const PresignBody = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1),
  reportKind: z.enum(['PERFORMANCE_SUMMARY', 'LIST_OF_TRADES']),
  declaredSha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().positive(),
});

const ProcessBody = z.object({
  /**
   * The chart timezone the export was taken in. Required with no default:
   * guessing shifts every trade and can move it across a segment boundary.
   */
  timeZone: z.string().min(1),
  dayFirst: z.boolean().optional(),
  initialCapital: z.string().regex(/^\d+(\.\d+)?$/),
});

const IdParam = z.object({ id: z.string().uuid() });

export function registerVerificationRoutes(
  app: FastifyInstance,
  db: Database,
  store: ObjectStore,
): void {
  app.post('/v1/verifications', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    requireRole(auth, ['DEVELOPER', 'VALIDATOR', 'OPERATOR', 'ADMIN']);
    const body = CreateBody.parse(request.body);
    const result = await createVerification(db, auth, body);
    return reply.status(201).send(result);
  });

  app.get('/v1/verifications/:id', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = IdParam.parse(request.params);

    const [row] = await db
      .select()
      .from(tradingviewVerifications)
      .where(eq(tradingviewVerifications.id, id))
      .limit(1);
    assertSameOrganisation(auth, row, 'Verification', id);

    const uploads = await db
      .select()
      .from(reportUploads)
      .where(eq(reportUploads.verificationId, id));

    return {
      id: row.id,
      status: row.status,
      strategyVersionId: row.strategyVersionId,
      // Exactly what the operator must reproduce in TradingView.
      expected: {
        sourceHash: row.expectedSourceHash,
        symbol: row.expectedSymbol,
        timeframe: row.expectedTimeframe,
        settings: row.expectedSettings,
        rangeStart: row.expectedRangeStart,
        rangeEnd: row.expectedRangeEnd,
      },
      uploads: uploads.map((u) => ({
        id: u.id,
        reportKind: u.reportKind,
        status: u.status,
        filename: u.originalFilename,
        parserVersion: u.parserVersion,
        // Warnings survive a successful parse (spec 15.2).
        parserWarnings: u.parserWarnings,
        rejectionReason: u.rejectionReason,
      })),
    };
  });

  app.post('/v1/verifications/:id/uploads', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    requireRole(auth, ['DEVELOPER', 'VALIDATOR', 'OPERATOR', 'ADMIN']);
    const { id } = IdParam.parse(request.params);
    const body = PresignBody.parse(request.body);
    const result = await presignUpload(db, store, auth, { verificationId: id, ...body });
    return reply.status(201).send(result);
  });

  app.post('/v1/uploads/:id/complete', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    requireRole(auth, ['DEVELOPER', 'VALIDATOR', 'OPERATOR', 'ADMIN']);
    const { id } = IdParam.parse(request.params);
    return completeUpload(db, store, auth, id);
  });

  /**
   * Run the ingestion pipeline.
   *
   * This is the work the backtest worker will own once the queue exists; the
   * completed upload already emits `report_upload.completed` through the
   * outbox for it to consume. Exposed as an endpoint meanwhile so the pipeline
   * is drivable and testable end to end.
   */
  app.post('/v1/verifications/:id/process', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    requireRole(auth, ['DEVELOPER', 'VALIDATOR', 'OPERATOR', 'ADMIN']);
    const { id } = IdParam.parse(request.params);
    const body = ProcessBody.parse(request.body);
    return processVerification(db, store, auth, id, body);
  });

  app.get('/v1/verifications/:id/parity', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = IdParam.parse(request.params);

    const [verification] = await db
      .select({ organisationId: tradingviewVerifications.organisationId })
      .from(tradingviewVerifications)
      .where(eq(tradingviewVerifications.id, id))
      .limit(1);
    assertSameOrganisation(auth, verification, 'Verification', id);

    const [report] = await db
      .select()
      .from(parityReports)
      .where(
        and(
          eq(parityReports.verificationId, id),
          eq(parityReports.organisationId, auth.organisationId),
        ),
      )
      .orderBy(desc(parityReports.createdAt))
      .limit(1);

    if (!report) {
      return { status: 'NOT_COMPUTED', message: 'Parity has not been computed yet.' };
    }

    return {
      id: report.id,
      status: report.status,
      tolerancePolicyVersion: report.tolerancePolicyVersion,
      identityMatches: report.identityMatches,
      identityMismatches: report.identityMismatches,
      comparisons: report.comparisons,
      // The field that matters most: matching totals with a differing trade
      // sequence is still a failure (CLAUDE.md 15.3).
      firstDivergentTradeNumber: report.firstDivergentTradeNumber,
      firstDivergenceDetail: report.firstDivergenceDetail,
      insufficientDataReason: report.insufficientDataReason,
      createdAt: toIso(report.createdAt),
    };
  });

  /** Reconstructed evidence for a run: trades, equity, ARF-calculated metrics. */
  app.get('/v1/backtest-runs/:id/evidence', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = IdParam.parse(request.params);
    const evidence = await readRunEvidence(db, auth, id);

    return {
      trades: evidence.trades.map((t) => ({
        tradeNumber: t.tradeNumber,
        direction: t.direction,
        entryTime: toIso(t.entryTime),
        exitTime: toIso(t.exitTime),
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        quantity: t.quantity,
        // Null where the source does not report them (ADR-0002). The UI must
        // render these as unavailable, never as zero.
        grossPnl: t.grossPnl,
        fees: t.fees,
        netPnl: t.netPnl,
      })),
      equity: evidence.equity.map((p) => ({
        tradeNumber: p.tradeNumber,
        at: toIso(p.at),
        equity: p.equity,
        drawdown: p.drawdown,
        drawdownPercent: p.drawdownPercent,
        calculationVersion: p.calculationVersion,
      })),
      metrics: evidence.metrics.map((m) => ({
        name: m.metricName,
        value: m.value,
        nullReason: m.nullReason,
        unit: m.unit,
        calculationVersion: m.calculationVersion,
        // Always labelled: an ARF number is never merged with a TradingView
        // reported one (CLAUDE.md 18.1).
        source: m.source,
      })),
    };
  });
}
