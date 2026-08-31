/**
 * Campaign routes.
 *
 * Demonstrates the two cross-cutting command concerns the specification
 * requires of every mutating endpoint: idempotency (CLAUDE.md 17.5) and
 * cursor pagination on the collection read (17.2).
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canonicalHash } from '@arf/contracts';
import type { Database } from '@arf/db';
import { newId } from '@arf/db';
import { auditEvents, campaigns, idempotencyRecords } from '@arf/db/schema';
import { requireRole } from '../auth.js';
import { IdempotencyConflictError, UnauthorisedError } from '../errors.js';

const CreateCampaignBody = z.object({
  title: z.string().min(1),
  objective: z.string().min(1, 'A campaign must state a falsifiable objective'),
  budgetUsd: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  budgetRuns: z.number().int().positive().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().datetime({ offset: true }).optional(),
});

export function registerCampaignRoutes(app: FastifyInstance, db: Database): void {
  app.post('/v1/campaigns', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    requireRole(auth, ['RESEARCHER', 'ADMIN']);

    const body = CreateCampaignBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    const requestHash = canonicalHash(body);

    /**
     * Idempotency, CLAUDE.md 17.5.
     *
     * The record is written in the same transaction as the campaign, so a
     * retry either finds a completed record and replays its result, or finds
     * nothing because the original transaction rolled back. A key reused with
     * a *different* body is a client bug and is rejected rather than silently
     * returning the first response — returning it could hand one caller
     * another caller's resource.
     */
    if (typeof key === 'string' && key.length > 0) {
      const [existing] = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.organisationId, auth.organisationId),
            eq(idempotencyRecords.endpoint, 'POST /v1/campaigns'),
            eq(idempotencyRecords.idempotencyKey, key),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        return reply.status(200).send({ id: existing.resourceId, replayed: true });
      }
    }

    const campaignId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(campaigns).values({
        id: campaignId,
        organisationId: auth.organisationId,
        title: body.title,
        objective: body.objective,
        state: 'CAMPAIGN_BACKLOG',
        createdByUserId: auth.userId,
        ...(body.budgetUsd ? { budgetUsd: body.budgetUsd } : {}),
        ...(body.budgetRuns ? { budgetRuns: body.budgetRuns } : {}),
      });

      await tx.insert(auditEvents).values({
        id: newId(),
        organisationId: auth.organisationId,
        actorType: 'HUMAN',
        actorId: auth.userId,
        action: 'campaign.created',
        aggregateType: 'campaign',
        aggregateId: campaignId,
        newState: { title: body.title, state: 'CAMPAIGN_BACKLOG' },
        traceId: request.id,
      });

      if (typeof key === 'string' && key.length > 0) {
        await tx.insert(idempotencyRecords).values({
          id: newId(),
          organisationId: auth.organisationId,
          idempotencyKey: key,
          actorId: auth.userId,
          endpoint: 'POST /v1/campaigns',
          requestHash,
          responseStatus: 201,
          resourceType: 'campaign',
          resourceId: campaignId,
          completedAt: new Date().toISOString(),
        });
      }
    });

    return reply.status(201).send({ id: campaignId, replayed: false });
  });

  app.get('/v1/campaigns', async (request) => {
    const auth = request.auth;
    if (!auth) throw new UnauthorisedError();
    const query = ListQuery.parse(request.query);

    const conditions = [eq(campaigns.organisationId, auth.organisationId)];
    if (query.before) conditions.push(lt(campaigns.createdAt, query.before));

    const rows = await db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    return {
      items: page.map((c) => ({
        id: c.id,
        title: c.title,
        objective: c.objective,
        state: c.state,
        budgetUsd: c.budgetUsd,
        modelSpendUsd: c.modelSpendUsd,
        createdAt: c.createdAt,
      })),
      nextCursor:
        rows.length > query.limit ? (page[page.length - 1]?.createdAt ?? null) : null,
    };
  });
}
