/**
 * Transactional outbox relay.
 *
 * CLAUDE.md 9.3: a domain event that must follow a transaction is written in
 * that same transaction, and a relay publishes it afterwards. This is the
 * relay.
 *
 * Delivery is **at-least-once**, and deliberately so. The alternative — mark
 * published, then publish — loses events on a crash between the two, and
 * losing a parse job silently is worse than running one twice. Every consumer
 * must therefore be idempotent (CLAUDE.md 3.6); the pipeline's own idempotency
 * is what makes a duplicate harmless.
 *
 * Concurrency safety comes from `FOR UPDATE SKIP LOCKED`: several relay
 * instances can poll the same table and each takes a disjoint batch instead of
 * blocking on, or duplicating, the others' rows.
 */
import { and, asc, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '@arf/db';
import { outboxEvents } from '@arf/db/schema';

export interface OutboxRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly traceId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly attempts: number;
}

/** Where a relayed event goes. Abstracted so the relay is testable without Redis. */
export interface EventPublisher {
  publish(event: OutboxRecord): Promise<void>;
}

export interface RelayOptions {
  /** Rows claimed per pass. */
  readonly batchSize?: number;
  /**
   * Attempts after which a row stops being retried.
   *
   * The row is left unpublished rather than deleted: an event that could not
   * be delivered is evidence of an incident, and dropping it would erase the
   * only trace that it happened.
   */
  readonly maxAttempts?: number;
}

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly exhausted: number;
}

/**
 * Publish one batch of pending events.
 *
 * Returns counts rather than throwing on a publish failure: one bad event must
 * not stop the rest of the batch, and the caller decides whether repeated
 * failures are worth alerting on.
 */
export async function relayOnce(
  db: Database,
  publisher: EventPublisher,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 10;

  return db.transaction(async (tx) => {
    // Claim a batch. SKIP LOCKED lets concurrent relays take disjoint rows
    // rather than serialising behind each other.
    const claimed = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.publishedAt),
          or(
            lt(outboxEvents.attempts, maxAttempts),
            // attempts is never null, but be explicit rather than relying on it.
            isNull(outboxEvents.attempts),
          ),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    let published = 0;
    let failed = 0;
    let exhausted = 0;

    for (const row of claimed) {
      const record: OutboxRecord = {
        id: row.id,
        organisationId: row.organisationId,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        traceId: row.traceId,
        correlationId: row.correlationId,
        causationId: row.causationId,
        attempts: row.attempts,
      };

      try {
        await publisher.publish(record);
        await tx
          .update(outboxEvents)
          .set({ publishedAt: new Date().toISOString(), lastError: null })
          .where(sql`${outboxEvents.id} = ${row.id}`);
        published += 1;
      } catch (error: unknown) {
        const attempts = row.attempts + 1;
        await tx
          .update(outboxEvents)
          .set({
            attempts,
            // The message only; a stack could carry connection details.
            lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
          })
          .where(sql`${outboxEvents.id} = ${row.id}`);
        failed += 1;
        if (attempts >= maxAttempts) exhausted += 1;
      }
    }

    return { claimed: claimed.length, published, failed, exhausted };
  });
}

export interface RelayRunner {
  stop(): Promise<void>;
}

/**
 * Poll continuously until stopped.
 *
 * Polling rather than LISTEN/NOTIFY: NOTIFY is not delivered to a client that
 * is not connected at the time, so a relay restarting would miss whatever was
 * emitted while it was down — exactly the gap the outbox exists to close.
 * Polling is duller and cannot lose a row.
 */
export function startRelay(
  db: Database,
  publisher: EventPublisher,
  options: RelayOptions & {
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
    readonly onResult?: (result: RelayResult) => void;
  } = {},
): RelayRunner {
  const intervalMs = options.intervalMs ?? 1_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await relayOnce(db, publisher, options);
      options.onResult?.(result);
      // Drain a backlog without waiting a full interval between batches.
      if (result.claimed > 0 && !stopped) {
        queueMicrotask(() => void tick());
        return;
      }
    } catch (error: unknown) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
