/**
 * Integration tests for the database-level invariants.
 *
 * CLAUDE.md 21.2 requires these to run against real PostgreSQL. Mocking would
 * prove nothing: the point of these tests is that the *database* refuses the
 * write, so that an application bug cannot destroy an audit trail or mutate
 * tested evidence.
 *
 * Requires the local stack:
 *   docker compose -f infra/docker/docker-compose.yml up -d
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, newId, type DatabaseHandle } from './client';
import { auditEvents, committeeDecisions, organisations, strategies, strategyVersions } from './schema/index';

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://arf:arf_local_dev@localhost:5433/arf_test';

let handle: DatabaseHandle;
let orgId: string;

/** Assert that a promise rejects, and return the error message. */
async function expectRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the database to reject this write, but it succeeded');
}

beforeAll(async () => {
  handle = createDatabase({ url: TEST_URL, maxConnections: 4 });
  await migrate(handle.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });

  orgId = newId();
  await handle.db.insert(organisations).values({
    id: orgId,
    name: 'Test Org',
    slug: `test-${orgId.slice(0, 8)}`,
  });
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

/** Create a strategy and one version, optionally already tested. */
async function makeVersion(opts: { tested: boolean }): Promise<string> {
  const strategyId = newId();
  const versionId = newId();
  await handle.db.insert(strategies).values({
    id: strategyId,
    organisationId: orgId,
    name: 'Test Strategy',
    family: 'trend_following',
  });
  await handle.db.insert(strategyVersions).values({
    id: versionId,
    organisationId: orgId,
    strategyId,
    versionNumber: 1,
    state: 'PINE_DEVELOPMENT',
    definitionHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    pineSourceHash: 'c'.repeat(64),
    ...(opts.tested ? { firstTestedAt: new Date().toISOString() } : {}),
  });
  return versionId;
}

describe('audit_events is append-only', () => {
  it('accepts inserts', async () => {
    await handle.db.insert(auditEvents).values({
      id: newId(),
      organisationId: orgId,
      actorType: 'HUMAN',
      actorId: 'user-1',
      action: 'strategy_version.created',
      aggregateType: 'strategy_version',
      aggregateId: newId(),
    });
    const rows = await handle.db.select().from(auditEvents);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses UPDATE even from a direct SQL statement', async () => {
    const id = newId();
    await handle.db.insert(auditEvents).values({
      id,
      organisationId: orgId,
      actorType: 'HUMAN',
      actorId: 'user-1',
      action: 'protected_data.read',
      aggregateType: 'strategy_version',
      aggregateId: newId(),
    });
    const message = await expectRejection(
      handle.db.execute(sql`update audit_events set action = 'tampered' where id = ${id}`),
    );
    expect(message).toMatch(/append-only/);
  });

  it('refuses DELETE', async () => {
    const id = newId();
    await handle.db.insert(auditEvents).values({
      id,
      organisationId: orgId,
      actorType: 'AGENT',
      actorId: 'agent-1',
      action: 'gate.failed',
      aggregateType: 'strategy_version',
      aggregateId: newId(),
    });
    const message = await expectRejection(
      handle.db.execute(sql`delete from audit_events where id = ${id}`),
    );
    expect(message).toMatch(/append-only/);
  });
});

describe('strategy version immutability', () => {
  it('allows content edits before the version has been tested', async () => {
    const id = await makeVersion({ tested: false });
    await handle.db.execute(
      sql`update strategy_versions set pine_source_hash = ${'d'.repeat(64)} where id = ${id}`,
    );
    const [row] = await handle.db
      .select({ h: strategyVersions.pineSourceHash })
      .from(strategyVersions)
      .where(sql`${strategyVersions.id} = ${id}`);
    expect(row?.h).toBe('d'.repeat(64));
  });

  it('refuses to change the source hash once tested', async () => {
    const id = await makeVersion({ tested: true });
    const message = await expectRejection(
      handle.db.execute(
        sql`update strategy_versions set pine_source_hash = ${'e'.repeat(64)} where id = ${id}`,
      ),
    );
    expect(message).toMatch(/immutable/);
    expect(message).toMatch(/child version/);
  });

  it('refuses to change the definition hash once tested', async () => {
    const id = await makeVersion({ tested: true });
    const message = await expectRejection(
      handle.db.execute(
        sql`update strategy_versions set definition_hash = ${'f'.repeat(64)} where id = ${id}`,
      ),
    );
    expect(message).toMatch(/immutable/);
  });

  it('still allows the lifecycle state to advance on a tested version', async () => {
    // The version must keep moving through the workflow; only its content is
    // frozen. A trigger that froze the whole row would deadlock the pipeline.
    const id = await makeVersion({ tested: true });
    await handle.db.execute(
      sql`update strategy_versions set state = 'TRADINGVIEW_VERIFICATION' where id = ${id}`,
    );
    const [row] = await handle.db
      .select({ s: strategyVersions.state })
      .from(strategyVersions)
      .where(sql`${strategyVersions.id} = ${id}`);
    expect(row?.s).toBe('TRADINGVIEW_VERIFICATION');
  });

  it('refuses to clear first_tested_at, which would lift the freeze', async () => {
    const id = await makeVersion({ tested: true });
    const message = await expectRejection(
      handle.db.execute(sql`update strategy_versions set first_tested_at = null where id = ${id}`),
    );
    expect(message).toMatch(/write-once/);
  });

  it('refuses DELETE of a strategy version', async () => {
    const id = await makeVersion({ tested: true });
    const message = await expectRejection(
      handle.db.execute(sql`delete from strategy_versions where id = ${id}`),
    );
    expect(message).toMatch(/append-only/);
  });
});

describe('contamination can only be added', () => {
  it('allows marking a dataset contaminated', async () => {
    const id = await makeVersion({ tested: true });
    const datasetId = newId();
    await handle.db.execute(
      sql`update strategy_versions set contaminated_dataset_ids = ${JSON.stringify([datasetId])}::jsonb where id = ${id}`,
    );
    const [row] = await handle.db
      .select({ c: strategyVersions.contaminatedDatasetIds })
      .from(strategyVersions)
      .where(sql`${strategyVersions.id} = ${id}`);
    expect(row?.c).toEqual([datasetId]);
  });

  it('refuses to un-mark contaminated data', async () => {
    // Spec 26: never mark reused data as unseen. Removing an entry here would
    // let a version claim a holdout it had already been shown.
    const id = await makeVersion({ tested: true });
    const datasetId = newId();
    await handle.db.execute(
      sql`update strategy_versions set contaminated_dataset_ids = ${JSON.stringify([datasetId])}::jsonb where id = ${id}`,
    );
    const message = await expectRejection(
      handle.db.execute(
        sql`update strategy_versions set contaminated_dataset_ids = '[]'::jsonb where id = ${id}`,
      ),
    );
    expect(message).toMatch(/never be marked unseen/);
  });
});

describe('committee decisions are append-only', () => {
  async function insertDecision(overrides: Record<string, unknown> = {}): Promise<string> {
    const versionId = await makeVersion({ tested: true });
    const id = newId();
    await handle.db.insert(committeeDecisions).values({
      id,
      organisationId: orgId,
      strategyVersionId: versionId,
      decision: 'REJECT',
      fromState: 'PAPER_APPROVAL_REVIEW',
      toState: 'REJECTED',
      policyVersion: 'policy-1',
      summary: 'Insufficient out-of-sample evidence.',
      positiveCase: 'In-sample profit factor was 1.8.',
      rejectionCase: 'Out-of-sample degradation exceeded the policy threshold.',
      actorType: 'HUMAN',
      actorId: 'user-1',
      ...overrides,
    });
    return id;
  }

  it('refuses UPDATE of a recorded decision', async () => {
    const id = await insertDecision();
    const message = await expectRejection(
      handle.db.execute(sql`update committee_decisions set decision = 'PAPER_APPROVED' where id = ${id}`),
    );
    expect(message).toMatch(/append-only/);
  });

  it('requires a reason when a decision is a human override', async () => {
    const versionId = await makeVersion({ tested: true });
    const message = await expectRejection(
      handle.db.insert(committeeDecisions).values({
        id: newId(),
        organisationId: orgId,
        strategyVersionId: versionId,
        decision: 'PAPER_APPROVED',
        fromState: 'PAPER_APPROVAL_REVIEW',
        toState: 'PAPER_APPROVED',
        policyVersion: 'policy-1',
        summary: 'Overridden.',
        positiveCase: 'Operator judgement.',
        rejectionCase: 'Validator recommended rejection.',
        actorType: 'HUMAN',
        actorId: 'user-1',
        humanOverride: true,
        // overrideReason deliberately omitted
      }),
    );
    expect(message).toMatch(/committee_decisions_override_reason/);
  });

  it('accepts an override that carries its reason', async () => {
    const id = await insertDecision({
      humanOverride: true,
      overrideReason: 'Research director accepted the documented risk.',
    });
    expect(id).toBeTruthy();
  });
});

describe('metric snapshots must be a value or an explained absence', () => {
  it('rejects a null value with no reason', async () => {
    const message = await expectRejection(
      handle.db.execute(sql`
        insert into metric_snapshots
          (id, organisation_id, metric_name, value, null_reason, unit,
           calculation_version, scope_type, scope_id, source)
        values (${newId()}, ${orgId}, 'profit_factor', null, null, 'RATIO',
                '1.0.0', 'RUN', ${newId()}, 'ARF_CALCULATED')
      `),
    );
    expect(message).toMatch(/metric_snapshots_value_xor_reason/);
  });

  it('rejects a value that also carries a null reason', async () => {
    const message = await expectRejection(
      handle.db.execute(sql`
        insert into metric_snapshots
          (id, organisation_id, metric_name, value, null_reason, unit,
           calculation_version, scope_type, scope_id, source)
        values (${newId()}, ${orgId}, 'profit_factor', 1.5, 'No losing trades', 'RATIO',
                '1.0.0', 'RUN', ${newId()}, 'ARF_CALCULATED')
      `),
    );
    expect(message).toMatch(/metric_snapshots_value_xor_reason/);
  });

  it('accepts an undefined metric that explains itself', async () => {
    await handle.db.execute(sql`
      insert into metric_snapshots
        (id, organisation_id, metric_name, value, null_reason, unit,
         calculation_version, scope_type, scope_id, source)
      values (${newId()}, ${orgId}, 'profit_factor', null, 'No losing trades', 'RATIO',
              '1.0.0', 'RUN', ${newId()}, 'ARF_CALCULATED')
    `);
  });

  it('allows ARF and TradingView values to coexist for the same metric', async () => {
    // Parity depends on holding both; the unique key includes `source` so
    // they do not collide, while a duplicate of either is still rejected.
    const scopeId = newId();
    const insert = (source: string, value: string) => sql`
      insert into metric_snapshots
        (id, organisation_id, metric_name, value, unit,
         calculation_version, scope_type, scope_id, source)
      values (${newId()}, ${orgId}, 'net_profit', ${value}, 'CURRENCY',
              '1.0.0', 'RUN', ${scopeId}, ${source})
    `;
    await handle.db.execute(insert('ARF_CALCULATED', '220'));
    await handle.db.execute(insert('TRADINGVIEW_REPORTED', '220.5'));

    const message = await expectRejection(handle.db.execute(insert('ARF_CALCULATED', '999')));
    expect(message).toMatch(/metric_snapshots_identity_key/);
  });
});

describe('idempotency keys are unique per organisation and endpoint', () => {
  it('rejects a reused key on the same endpoint', async () => {
    const key = `key-${newId()}`;
    const insert = () => sql`
      insert into idempotency_records
        (id, organisation_id, idempotency_key, actor_id, endpoint, request_hash)
      values (${newId()}, ${orgId}, ${key}, 'user-1', 'POST /v1/campaigns', ${'a'.repeat(64)})
    `;
    await handle.db.execute(insert());
    const message = await expectRejection(handle.db.execute(insert()));
    expect(message).toMatch(/idempotency_key_unique/);
  });
});
