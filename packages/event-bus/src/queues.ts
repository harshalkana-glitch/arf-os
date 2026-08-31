/**
 * Queue names and job contracts.
 *
 * A job payload is a contract like any other and is validated on both sides
 * (CLAUDE.md 3.3): a worker must never infer fields from an untyped job body.
 */
import { z } from 'zod';

export const QUEUE_REPORT_INGESTION = 'report-ingestion';

/**
 * Parse a completed TradingView upload.
 *
 * The job carries identifiers only, never file contents: the bytes live in
 * object storage and the worker reads them by key, so a large export never
 * passes through Redis.
 */
export const ReportIngestionJob = z.object({
  outboxEventId: z.string().uuid(),
  organisationId: z.string().uuid(),
  uploadId: z.string().uuid(),
  verificationId: z.string().uuid(),
  artefactId: z.string().uuid(),
});
export type ReportIngestionJob = z.infer<typeof ReportIngestionJob>;

/**
 * Deterministic job id.
 *
 * BullMQ deduplicates on job id, so an at-least-once relay that publishes the
 * same outbox row twice enqueues one job. This is defence in depth rather than
 * the primary guarantee — the pipeline itself is idempotent (CLAUDE.md 3.6) —
 * but it keeps duplicate work off the queue in the common case.
 */
export function ingestionJobId(outboxEventId: string): string {
  // BullMQ rejects a custom job id containing ':', which it uses as its own
  // key separator.
  return `ingest-${outboxEventId}`;
}
