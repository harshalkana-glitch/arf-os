/**
 * Strategy version routes.
 *
 * CLAUDE.md 17.1: handlers authenticate, authorise, validate, call an
 * application service, map the typed result and return. No SQL and no
 * workflow rules live here — the transition policy is in @arf/workflow and
 * the transactional command is in services/transition.ts.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@arf/db';
import { auditEvents, strategyVersions } from '@arf/db/schema';
import { EvidenceKind, HardFailure, WorkflowState } from '@arf/contracts';
import { availableTransitions } from '@arf/workflow';
import { assertSameOrganisation } from '../auth.js';
import { UnauthorisedError } from '../errors.js';
import { applyTransition } from '../services/transition.js';

const TransitionBody = z.object({
  to: WorkflowState,
  reason: z.string().min(1, 'A transition must state its reason'),
  evidenceIds: z.array(z.string().uuid()).default([]),
  presentEvidence: z.array(EvidenceKind).default([]),
  hardFailures: z.array(HardFailure).default([]),
  humanApprovalRecorded: z.boolean().default(false),
  humanOverride: z
    .object({ granted: z.literal(true), reason: z.string().min(1) })
    .optional(),
});

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Cursor is the last seen created_at, exclusive (CLAUDE.md 17.2). */
  before: z.string().datetime({ offset: true }).optional(),
});

export function registerStrategyVersionRoutes(app: FastifyInstance, db: Database): void {
  /** Read one version, with the transitions currently available from it. */
  app.get('/v1/strategy-versions/:id', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const [row] = await db
      .select()
      .from(strategyVersions)
      .where(
        and(eq(strategyVersions.id, id), eq(strategyVersions.organisationId, auth.organisationId)),
      )
      .limit(1);

    assertSameOrganisation(auth, row, 'Strategy version', id);

    return {
      id: row.id,
      strategyId: row.strategyId,
      versionNumber: row.versionNumber,
      state: row.state,
      parentVersionId: row.parentVersionId,
      definitionHash: row.definitionHash,
      manifestHash: row.manifestHash,
      pineSourceHash: row.pineSourceHash,
      contaminatedDatasetIds: row.contaminatedDatasetIds,
      // Immutable once tested; the UI renders the source read-only on this.
      isTested: row.firstTestedAt !== null,
      createdAt: row.createdAt,
      availableTransitions: availableTransitions(row.state).map((r) => ({
        to: r.to,
        requiredEvidence: r.requiredEvidence,
        allowedRoles: r.allowedRoles,
        requiresHumanApproval: r.requiresHumanApproval,
        requiresIndependentActor: r.requiresIndependentActor,
        rationale: r.rationale,
      })),
    };
  });

  /**
   * Apply a lifecycle transition.
   *
   * A policy refusal returns 422 with the structured detail attached, so a
   * client can list exactly what is missing (CLAUDE.md 18.3) rather than
   * showing an opaque failure.
   */
  app.post('/v1/strategy-versions/:id/transition', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = TransitionBody.parse(request.body);

    const result = await applyTransition(db, auth, {
      strategyVersionId: id,
      to: body.to,
      reason: body.reason,
      evidenceIds: body.evidenceIds,
      presentEvidence: body.presentEvidence,
      hardFailures: body.hardFailures,
      humanApprovalRecorded: body.humanApprovalRecorded,
      traceId: request.id,
      ...(body.humanOverride
        ? { humanOverride: { granted: true, reason: body.humanOverride.reason } }
        : {}),
    });

    // 200 rather than 201: a transition mutates an existing aggregate and
    // creates no addressable resource of its own.
    return reply.status(200).send(result);
  });

  /**
   * The audit timeline for a version.
   *
   * Cursor-paginated on created_at descending. Audit rows are append-only, so
   * a cursor can never skip a row that was inserted behind it.
   */
  app.get('/v1/strategy-versions/:id/audit', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = AuditQuery.parse(request.query);

    const [version] = await db
      .select({ organisationId: strategyVersions.organisationId })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, id))
      .limit(1);
    assertSameOrganisation(auth, version, 'Strategy version', id);

    const conditions = [
      eq(auditEvents.organisationId, auth.organisationId),
      eq(auditEvents.aggregateType, 'strategy_version'),
      eq(auditEvents.aggregateId, id),
    ];
    if (query.before) conditions.push(lt(auditEvents.createdAt, query.before));

    // Fetch one extra row to determine whether another page exists, without
    // a second count query.
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;

    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actorId: r.actorId,
        priorState: r.priorState,
        newState: r.newState,
        reason: r.reason,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.createdAt ?? null) : null,
    };
  });
}
