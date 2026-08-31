/**
 * BullMQ publisher and connection helpers.
 *
 * Kept behind the EventPublisher interface so the relay can be tested without
 * Redis, and so replacing the queue technology later touches one file rather
 * than every call site.
 */
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { EventPublisher, OutboxRecord } from './relay.js';
import { QUEUE_REPORT_INGESTION, ingestionJobId } from './queues.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null`; with a retry limit set, a
 * blocking command that outlives it throws and kills the worker.
 */
export function createRedis(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/** Routes a domain event to the queue that handles it. */
export class BullMqPublisher implements EventPublisher {
  private readonly ingestion: Queue;

  constructor(connection: Redis) {
    this.ingestion = new Queue(QUEUE_REPORT_INGESTION, { connection });
  }

  async publish(event: OutboxRecord): Promise<void> {
    if (event.eventType !== 'report_upload.completed') {
      // Unrouted event types are not an error: the outbox is the system's
      // event log, and most events have no queue consumer. Marking it
      // published is correct — it was offered and nothing wanted it.
      return;
    }

    const payload = event.payload as Record<string, unknown>;
    await this.ingestion.add(
      'parse-report',
      {
        outboxEventId: event.id,
        organisationId: event.organisationId,
        uploadId: payload['uploadId'],
        verificationId: payload['verificationId'],
        artefactId: payload['artefactId'],
      },
      {
        jobId: ingestionJobId(event.id),
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        // Failures are kept far longer than successes: a dead-lettered parse
        // is evidence of a defect and must remain inspectable.
        removeOnFail: { age: 7 * 86_400 },
      },
    );
  }

  async close(): Promise<void> {
    await this.ingestion.close();
  }
}
