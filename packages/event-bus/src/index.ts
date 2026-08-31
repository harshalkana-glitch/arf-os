/**
 * @arf/event-bus
 *
 * Reliable delivery of domain events emitted through the transactional
 * outbox. Delivery is at-least-once by design, so every consumer must be
 * idempotent (CLAUDE.md 3.6).
 */
export {
  relayOnce,
  startRelay,
  type EventPublisher,
  type OutboxRecord,
  type RelayOptions,
  type RelayResult,
  type RelayRunner,
} from './relay.js';

export { QUEUE_REPORT_INGESTION, ReportIngestionJob, ingestionJobId } from './queues.js';
export { BullMqPublisher, createRedis } from './bullmq.js';
