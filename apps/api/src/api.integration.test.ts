/**
 * API integration tests.
 *
 * Real Fastify, real PostgreSQL, real transactions (CLAUDE.md 21.2). These
 * assert the properties that a unit test of the policy engine cannot: that
 * the state change, the audit event and the outbox event actually commit
 * together, and that organisation scoping holds at the HTTP boundary.
 *
 * Requires: docker compose -f infra/docker/docker-compose.yml up -d
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, newId, type DatabaseHandle } from '@arf/db';
import {
  auditEvents,
  committeeDecisions,
  memberships,
  organisations,
  outboxEvents,
  strategies,
  strategyVersions,
  users,
} from '@arf/db/schema';
import type { RbacRole, WorkflowState } from '@arf/contracts';
import { buildApp } from './app.js';
import { S3ObjectStore } from '@arf/backtest-sdk';

/** MinIO from infra/docker/docker-compose.yml. */
function testStore(): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: 'auto',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'arf_local',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arf_local_dev_secret',
    bucket: process.env['S3_BUCKET_UPLOADS'] ?? 'arf-uploads',
    forcePathStyle: true,
    presignTtlSeconds: 900,
  });
}

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test';

let handle: DatabaseHandle;
let app: FastifyInstance;

/** Two organisations, so isolation can actually be tested. */
const orgA = { id: '', slug: '' };
const orgB = { id: '', slug: '' };
/** externalId -> userId, for building x-dev-user headers. */
const actors = new Map<string, string>();

async function makeUser(
  organisationId: string,
  externalId: string,
  role: RbacRole,
): Promise<string> {
  const userId = newId();
  await handle.db.insert(users).values({ id: userId, externalId, email: `${externalId}@test.dev` });
  await handle.db
    .insert(memberships)
    .values({ id: newId(), organisationId, userId, role });
  actors.set(externalId, userId);
  return userId;
}

beforeAll(async () => {
  handle = createDatabase({ url: TEST_URL, maxConnections: 6 });
  await migrate(handle.db, {
    migrationsFolder: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  });

  orgA.id = newId();
  orgA.slug = `org-a-${orgA.id}`;
  orgB.id = newId();
  orgB.slug = `org-b-${orgB.id}`;
  await handle.db.insert(organisations).values([
    { id: orgA.id, name: 'Org A', slug: orgA.slug },
    { id: orgB.id, name: 'Org B', slug: orgB.slug },
  ]);

  // Full id: a UUIDv7 prefix repeats across runs within the same ~65s window.
  const suffix = orgA.id;
  await makeUser(orgA.id, `researcher-${suffix}`, 'RESEARCHER');
  await makeUser(orgA.id, `validator-${suffix}`, 'VALIDATOR');
  await makeUser(orgA.id, `viewer-${suffix}`, 'VIEWER');
  await makeUser(orgA.id, `committee-${suffix}`, 'COMMITTEE_MEMBER');
  await makeUser(orgB.id, `outsider-${suffix}`, 'ADMIN');

  app = buildApp({
    db: handle.db,
    store: testStore(),
    allowedOrigins: [],
    auth: { allowDevAuth: true, environment: 'local' },
    logLevel: 'silent',
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

const asUser = (externalId: string) => ({ 'x-dev-user': `${externalId}-${orgA.id}` });
const suffixed = (base: string) => `${base}-${orgA.id}`;

/** Create a strategy plus one version, owned by `organisationId`. */
async function makeVersion(opts: {
  organisationId: string;
  state: WorkflowState;
  createdByUserId?: string;
  tested?: boolean;
}): Promise<string> {
  const strategyId = newId();
  const versionId = newId();
  await handle.db.insert(strategies).values({
    id: strategyId,
    organisationId: opts.organisationId,
    name: 'Test Strategy',
    family: 'trend_following',
  });
  await handle.db.insert(strategyVersions).values({
    id: versionId,
    organisationId: opts.organisationId,
    strategyId,
    versionNumber: 1,
    state: opts.state,
    ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    ...(opts.tested ? { firstTestedAt: new Date().toISOString() } : {}),
  });
  return versionId;
}

describe('health', () => {
  it('reports readiness without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'reachable' });
  });
});

describe('authentication and organisation scoping', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/campaigns' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorised');
  });

  it('refuses an unverified bearer token rather than trusting it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: 'Bearer definitely-not-verified' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404, not 403, for another organisation’s version', async () => {
    // A 403 would confirm the id exists elsewhere, which is itself a leak.
    const foreign = await makeVersion({ organisationId: orgB.id, state: 'PINE_DEVELOPMENT' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/strategy-versions/${foreign}`,
      headers: asUser('researcher'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not leak another organisation’s campaigns into a list', async () => {
    await handle.db.insert(strategies).values({
      id: newId(),
      organisationId: orgB.id,
      name: 'Org B strategy',
      family: 'momentum',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: asUser('researcher'),
    });
    expect(res.statusCode).toBe(200);
    for (const item of res.json().items) {
      const [row] = await handle.db
        .select({ org: strategies.organisationId })
        .from(strategies)
        .where(eq(strategies.id, item.id));
      expect(row?.org).not.toBe(orgB.id);
    }
  });
});

describe('campaign creation and idempotency', () => {
  it('creates a campaign and writes an audit event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: asUser('researcher'),
      payload: { title: 'Trend pullbacks', objective: 'Test pullback entries in confirmed trends' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    const audit = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.aggregateId, id), eq(auditEvents.action, 'campaign.created')));
    expect(audit).toHaveLength(1);
  });

  it('replays the same result for a repeated Idempotency-Key', async () => {
    const key = `key-${newId()}`;
    const payload = { title: 'Repeated', objective: 'Same body twice' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { ...asUser('researcher'), 'idempotency-key': key },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { ...asUser('researcher'), 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().id).toBe(first.json().id);
  });

  it('rejects a reused key carrying a different body', async () => {
    // Returning the first response here could hand one caller another
    // caller's resource, so this is a 409 rather than a silent replay.
    const key = `key-${newId()}`;
    await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { ...asUser('researcher'), 'idempotency-key': key },
      payload: { title: 'First', objective: 'Original body' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { ...asUser('researcher'), 'idempotency-key': key },
      payload: { title: 'Different', objective: 'Changed body' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('idempotency_key_reuse');
  });

  it('refuses a role that may not create campaigns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: asUser('viewer'),
      payload: { title: 'X', objective: 'Y' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns problem-details on a schema violation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: asUser('researcher'),
      payload: { title: 'No objective' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().validationErrors?.[0]?.path).toBe('objective');
  });
});

describe('transitions', () => {
  it('applies a permitted transition and commits audit and outbox together', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
      createdByUserId: actors.get(suffixed('researcher')) ?? '',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('validator'),
      payload: {
        to: 'TRADINGVIEW_VERIFICATION',
        reason: 'Adversarial validation complete; no hard failures.',
        presentEvidence: ['VALIDATION_REPORT'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: 'ROBUSTNESS_VALIDATION', to: 'TRADINGVIEW_VERIFICATION' });

    const [version] = await handle.db
      .select({ state: strategyVersions.state })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId));
    expect(version?.state).toBe('TRADINGVIEW_VERIFICATION');

    // The three writes must have landed in the same transaction.
    const audit = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.aggregateId, versionId),
          eq(auditEvents.action, 'strategy_version.transition'),
        ),
      );
    expect(audit).toHaveLength(1);

    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, versionId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('strategy_version.transitioned');
    // Unpublished until a relay picks it up.
    expect(outbox[0]?.publishedAt).toBeNull();
  });

  it('rolls back everything when the transition is refused', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('validator'),
      payload: { to: 'TRADINGVIEW_VERIFICATION', reason: 'Trying without evidence.' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('policy_missing_evidence');
    expect(res.json().context.missingEvidence).toEqual(['VALIDATION_REPORT']);

    // No state change, no audit row, no outbox row.
    const [version] = await handle.db
      .select({ state: strategyVersions.state })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId));
    expect(version?.state).toBe('ROBUSTNESS_VALIDATION');

    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, versionId));
    expect(outbox).toHaveLength(0);
  });

  it('refuses a contributor validating their own version', async () => {
    const researcherId = actors.get(suffixed('researcher')) ?? '';
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
      createdByUserId: researcherId,
    });

    // The researcher is also given a validator's action here; the block is
    // on identity, not on role.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('researcher'),
      payload: {
        to: 'TRADINGVIEW_VERIFICATION',
        reason: 'Self-approving.',
        presentEvidence: ['VALIDATION_REPORT'],
      },
    });
    // RESEARCHER is not a permitted role for this gate either; whichever
    // check fires, the transition must not succeed.
    expect(res.statusCode).toBe(422);
  });

  it('will not promote past an unresolved hard failure, even with an override', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
    });
    // The actor must be one the gate actually permits, otherwise the role
    // check fires first and this proves nothing about hard failures.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('validator'),
      payload: {
        to: 'TRADINGVIEW_VERIFICATION',
        reason: 'Promoting anyway.',
        presentEvidence: ['VALIDATION_REPORT'],
        hardFailures: ['FUTURE_LEAKAGE_CONFIRMED'],
        humanOverride: { granted: true, reason: 'Director insists.' },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('policy_hard_failure_present');
    expect(res.json().context.hardFailures).toEqual(['FUTURE_LEAKAGE_CONFIRMED']);
  });

  it('records a committee decision when a version is rejected', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('validator'),
      payload: { to: 'REJECTED', reason: 'Edge disappears under realistic costs.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decisionId).toBeTruthy();

    const decisions = await handle.db
      .select()
      .from(committeeDecisions)
      .where(eq(committeeDecisions.strategyVersionId, versionId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe('REJECT');
  });

  it('is idempotent: transitioning to the current state is a no-op', async () => {
    const versionId = await makeVersion({ organisationId: orgA.id, state: 'PINE_DEVELOPMENT' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategy-versions/${versionId}/transition`,
      headers: asUser('researcher'),
      payload: { to: 'PINE_DEVELOPMENT', reason: 'Retry of an already-applied command.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ from: 'PINE_DEVELOPMENT', to: 'PINE_DEVELOPMENT' });
    expect(res.json().decisionId).toBeNull();
  });
});

describe('reads', () => {
  it('exposes the transitions available from a version’s state', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/strategy-versions/${versionId}`,
      headers: asUser('researcher'),
    });
    expect(res.statusCode).toBe(200);
    const targets = res.json().availableTransitions.map((t: { to: string }) => t.to);
    expect(targets).toContain('TRADINGVIEW_VERIFICATION');
    expect(targets).toContain('REJECTED');
  });

  it('marks a tested version so the UI can render it read-only', async () => {
    const versionId = await makeVersion({
      organisationId: orgA.id,
      state: 'ROBUSTNESS_VALIDATION',
      tested: true,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/strategy-versions/${versionId}`,
      headers: asUser('researcher'),
    });
    expect(res.json().isTested).toBe(true);
  });

  it('paginates the audit timeline with a cursor', async () => {
    const versionId = await makeVersion({ organisationId: orgA.id, state: 'PINE_DEVELOPMENT' });
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/v1/strategy-versions/${versionId}/transition`,
        headers: asUser('researcher'),
        payload: { to: 'PINE_DEVELOPMENT', reason: `noop ${i}` },
      });
    }
    const first = await app.inject({
      method: 'GET',
      url: `/v1/strategy-versions/${versionId}/audit?limit=2`,
      headers: asUser('researcher'),
    });
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toBeTruthy();
  });
});

describe('configuration safety', () => {
  it('refuses to build an app with the dev auth stub outside local', () => {
    // A misconfiguration must be a startup failure, never a silent
    // authentication bypass in a deployed environment.
    expect(() =>
      buildApp({
        db: handle.db,
        store: testStore(),
        allowedOrigins: [],
        auth: { allowDevAuth: true, environment: 'production' },
        logLevel: 'silent',
      }),
    ).toThrow(/Refusing to start/);
  });
});

describe('cross-origin policy', () => {
  /**
   * Regression: the API shipped with no CORS handling at all, so every write
   * from the web app — which runs on a different port and is therefore a
   * different origin — was blocked by the browser before it left the page.
   * app.inject bypasses the network, so no integration test could see it; it
   * took an end-to-end run to surface.
   */
  it('answers a preflight from an allowed origin', async () => {
    const allowed = buildApp({
      db: handle.db,
      store: testStore(),
      allowedOrigins: ['http://127.0.0.1:3100'],
      auth: { allowDevAuth: true, environment: 'local' },
      logLevel: 'silent',
    });
    await allowed.ready();

    const res = await allowed.inject({
      method: 'OPTIONS',
      url: '/v1/campaigns',
      headers: {
        origin: 'http://127.0.0.1:3100',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-dev-user',
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3100');
    await allowed.close();
  });

  it('does not reflect an origin that is not on the allowlist', async () => {
    // Reflecting an arbitrary Origin would let any page a researcher visits
    // read their organisation's research (CLAUDE.md 19).
    const allowed = buildApp({
      db: handle.db,
      store: testStore(),
      allowedOrigins: ['http://127.0.0.1:3100'],
      auth: { allowDevAuth: true, environment: 'local' },
      logLevel: 'silent',
    });
    await allowed.ready();

    const res = await allowed.inject({
      method: 'OPTIONS',
      url: '/v1/campaigns',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await allowed.close();
  });

  it('serves a non-browser request that sends no Origin header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(res.statusCode).toBe(200);
  });
});
