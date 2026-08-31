/**
 * Governance: decisions, audit, outbox, idempotency.
 *
 * These four tables are what make the platform auditable rather than merely
 * functional, so each carries a constraint the application cannot bypass:
 * audit is append-only by trigger, the outbox makes event emission atomic
 * with the transaction that caused it, and idempotency records are unique by
 * key.
 */
import { char, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations, users } from './identity';
import { strategyVersions } from './strategy';
import {
  actorTypeEnum,
  committeeDecisionEnum,
  createdAt,
  fk,
  id,
  ts,
  workflowStateEnum,
} from './columns';

/**
 * A research decision on one exact strategy version.
 *
 * Spec 7.9: the judge states both the positive case and the rejection case,
 * and both are required columns — a decision that records only the supporting
 * argument is not reviewable. `humanOverride` is visible by design
 * (CLAUDE.md 18.3): an override must never look like a normal approval.
 */
export const committeeDecisions = pgTable(
  'committee_decisions',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),

    decision: committeeDecisionEnum('decision').notNull(),
    fromState: workflowStateEnum('from_state').notNull(),
    toState: workflowStateEnum('to_state').notNull(),
    policyVersion: text('policy_version').notNull(),

    reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
    summary: text('summary').notNull(),
    /** The strongest case *for*. Required. */
    positiveCase: text('positive_case').notNull(),
    /** The strongest case *against*, even when approving. Required. */
    rejectionCase: text('rejection_case').notNull(),
    supportingEvidenceIds: jsonb('supporting_evidence_ids').$type<string[]>().notNull().default([]),
    contradictingEvidenceIds: jsonb('contradicting_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    conditions: jsonb('conditions').$type<string[]>().notNull().default([]),
    falsificationConditions: jsonb('falsification_conditions')
      .$type<string[]>()
      .notNull()
      .default([]),
    reviewDate: ts('review_date'),

    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    decidedByUserId: fk('decided_by_user_id').references(() => users.id),
    humanOverride: jsonb('human_override').$type<boolean>().notNull().default(false),
    overrideReason: text('override_reason'),

    createdAt: createdAt(),
  },
  (t) => [index('committee_decisions_version_idx').on(t.strategyVersionId, t.createdAt)],
);

/**
 * Append-only audit log.
 *
 * CLAUDE.md 9.4 fixes the required fields. UPDATE and DELETE are blocked by
 * trigger (migrations/0001_immutability.sql), so a tampered trail requires
 * database-superuser access rather than an application bug.
 *
 * Spec 3.5 and 17.4: every protected-data read writes a row here.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: fk('aggregate_id').notNull(),
    priorState: jsonb('prior_state'),
    newState: jsonb('new_state'),
    reason: text('reason'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_aggregate_idx').on(t.aggregateType, t.aggregateId, t.createdAt),
    index('audit_events_org_idx').on(t.organisationId, t.createdAt),
    index('audit_events_action_idx').on(t.action, t.createdAt),
  ],
);

/**
 * Transactional outbox.
 *
 * CLAUDE.md 9.3: a domain event that must follow a transaction is written in
 * that same transaction and published afterwards by a relay. Without this, a
 * crash between commit and publish loses the event, and a publish before
 * commit emits an event for work that then rolls back.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: fk('aggregate_id').notNull(),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    traceId: text('trace_id'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    /** Null until the relay has published it. */
    publishedAt: ts('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    // The relay polls unpublished rows in creation order; a partial index
    // keeps that scan proportional to the backlog, not the whole table.
    index('outbox_unpublished_idx')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
    index('outbox_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);

/**
 * Idempotency records for side-effecting commands.
 *
 * CLAUDE.md 17.5: the key, actor and a hash of the request are stored, and
 * reuse of a key with a *different* body is rejected rather than silently
 * returning the first response — that would hide a client bug and could
 * return one caller's result to another.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    idempotencyKey: text('idempotency_key').notNull(),
    actorId: text('actor_id').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status'),
    /** Reference to the created resource, not the full response body. */
    resourceType: text('resource_type'),
    resourceId: fk('resource_id'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    // Scoped by organisation and endpoint so two orgs cannot collide on a
    // client-chosen key.
    unique('idempotency_key_unique').on(t.organisationId, t.endpoint, t.idempotencyKey),
  ],
);
