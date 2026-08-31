/**
 * The report-ingestion job handler.
 *
 * CLAUDE.md 3.2 is the rule that shapes this file: **workers do not change
 * strategy lifecycle state.** This handler executes a job, stores output
 * artefacts, and stops. Whether a successful parse means a version may advance
 * to PAPER_APPROVAL_REVIEW is a policy question, and policy is applied by the
 * API through @arf/workflow — never here.
 *
 * Separating it that way is what stops a worker from quietly promoting work
 * because its own job happened to succeed.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@arf/db';
import { newId } from '@arf/db';
import { auditEvents, backtestRuns, reportUploads, tradingviewVerifications } from '@arf/db/schema';
import {
  IngestionError,
  processVerification,
  type ObjectStore,
  type ProcessResult,
} from '@arf/backtest-sdk';
import type { ReportIngestionJob } from '@arf/event-bus';

/** Identity this worker attributes its audit rows to. */
export const WORKER_ACTOR = 'worker-backtest' as const;

export interface HandlerDependencies {
  readonly db: Database;
  readonly store: ObjectStore;
  readonly log?: (message: string, context?: Record<string, unknown>) => void;
}

export type HandlerOutcome =
  | { readonly status: 'PROCESSED'; readonly result: ProcessResult }
  | { readonly status: 'ALREADY_PROCESSED'; readonly backtestRunId: string }
  | { readonly status: 'REJECTED'; readonly code: string; readonly message: string };

/**
 * Handle one ingestion job.
 *
 * Delivery is at-least-once (see @arf/event-bus), so this must be safe to run
 * twice. It is, in two layers: an upload already in PARSED state short-circuits
 * to the run it produced, and the pipeline's own writes are keyed so a repeat
 * cannot duplicate a trade ledger.
 *
 * A domain rejection — an unparseable file, a checksum mismatch — is a
 * terminal outcome, not a retry. Retrying a file that will never parse just
 * burns the attempt budget and delays the dead-letter that tells someone the
 * export is wrong. Infrastructure failures are rethrown so BullMQ retries them.
 */
export async function handleReportIngestion(
  deps: HandlerDependencies,
  job: ReportIngestionJob,
): Promise<HandlerOutcome> {
  const { db, store } = deps;

  const [upload] = await db
    .select()
    .from(reportUploads)
    .where(
      and(
        eq(reportUploads.id, job.uploadId),
        eq(reportUploads.organisationId, job.organisationId),
      ),
    )
    .limit(1);

  if (!upload) {
    // The row is gone or belongs to another organisation. Neither is
    // retryable, and neither should crash the worker.
    return {
      status: 'REJECTED',
      code: 'upload_not_found',
      message: `Upload ${job.uploadId} was not found for this organisation.`,
    };
  }

  if (upload.status === 'PARSED') {
    const [existing] = await db
      .select({ id: backtestRuns.id })
      .from(backtestRuns)
      .where(
        and(
          eq(backtestRuns.verificationId, job.verificationId),
          eq(backtestRuns.organisationId, job.organisationId),
        ),
      )
      .limit(1);
    deps.log?.('ingestion job already processed', { uploadId: job.uploadId });
    return { status: 'ALREADY_PROCESSED', backtestRunId: existing?.id ?? '' };
  }

  if (upload.status === 'REJECTED') {
    return {
      status: 'REJECTED',
      code: 'upload_rejected',
      message: upload.rejectionReason ?? 'This upload was rejected before parsing.',
    };
  }

  try {
    const result = await processVerification(
      db,
      store,
      {
        organisationId: job.organisationId,
        actorId: WORKER_ACTOR,
        actorType: 'SERVICE',
      },
      // The chart timezone and initial capital live on the verification row,
      // so the same file is read identically whichever worker picks it up.
      job.verificationId,
    );
    deps.log?.('ingestion job processed', {
      verificationId: job.verificationId,
      tradeCount: result.tradeCount,
      parityStatus: result.parityStatus,
    });
    return { status: 'PROCESSED', result };
  } catch (error: unknown) {
    if (error instanceof IngestionError) {
      // A domain rejection is terminal. It is recorded on the verification and
      // audited so the failure is visible in the UI rather than only in a
      // dead-letter queue.
      await markFailed(db, job, error);
      return { status: 'REJECTED', code: error.code, message: error.message };
    }
    // Anything else — a dropped database connection, object storage being
    // unreachable — is infrastructure. Rethrow so BullMQ retries with backoff.
    throw error;
  }
}

async function markFailed(
  db: Database,
  job: ReportIngestionJob,
  error: IngestionError,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(tradingviewVerifications)
      .set({ status: 'FAILED', failureReason: error.message.slice(0, 1000) })
      .where(eq(tradingviewVerifications.id, job.verificationId));

    await tx.insert(auditEvents).values({
      id: newId(),
      organisationId: job.organisationId,
      actorType: 'SERVICE',
      actorId: WORKER_ACTOR,
      action: 'verification.ingestion_failed',
      aggregateType: 'tradingview_verification',
      aggregateId: job.verificationId,
      newState: { code: error.code, message: error.message.slice(0, 1000) },
      reason: 'Ingestion could not complete.',
    });
  });
}
