/**
 * Campaigns and research tasks.
 *
 * Spec 7.1: a campaign decomposes into discrete hypotheses, each tracked as a
 * task with a state, an assigned role and a budget. Budgets are enforced in
 * application code, not by prompt (CLAUDE.md 3.7), so the ceiling and the
 * running total both live here where a deterministic check can read them.
 */
import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { organisations, users } from './identity';
import {
  agentRoleEnum,
  createdAt,
  fk,
  id,
  jobStatusEnum,
  money,
  ts,
  workflowStateEnum,
} from './columns';

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    state: workflowStateEnum('state').notNull().default('CAMPAIGN_BACKLOG'),

    /** Validated CampaignPlan document (leader prompt 4). */
    plan: jsonb('plan'),

    /**
     * Model-spend ceiling for the whole campaign, in USD. When
     * `modelSpendUsd` reaches it, the orchestrator stops issuing new tasks
     * and asks for a human budget decision (leader prompt 11).
     */
    budgetUsd: money('budget_usd'),
    modelSpendUsd: money('model_spend_usd').notNull().default('0'),
    /** Ceiling on backtest runs, a separate and cheaper-to-check limit. */
    budgetRuns: integer('budget_runs'),
    runsUsed: integer('runs_used').notNull().default(0),

    createdByUserId: fk('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('campaigns_org_state_idx').on(t.organisationId, t.state, t.createdAt)],
);

/**
 * One unit of delegated work.
 *
 * `forbiddenData` is stored on the task rather than implied by the role,
 * because protection is stage-scoped: the same Backtest Engineer role may
 * read the final holdout at one stage and must not at another
 * (leader prompt 10).
 */
export const researchTasks = pgTable(
  'research_tasks',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    campaignId: fk('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    parentTaskId: fk('parent_task_id'),
    role: agentRoleEnum('role').notNull(),
    objective: text('objective').notNull(),
    status: jobStatusEnum('status').notNull().default('QUEUED'),

    strategyId: fk('strategy_id'),
    strategyVersionId: fk('strategy_version_id'),

    /** Tool allowlist for this task (CLAUDE.md 11.4). */
    allowedTools: jsonb('allowed_tools').$type<string[]>().notNull().default([]),
    /** Data classes this task must not receive. */
    forbiddenData: jsonb('forbidden_data').$type<string[]>().notNull().default([]),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default([]),

    /** Set when the task is blocked, with the exact missing input. */
    blockedReason: text('blocked_reason'),

    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('research_tasks_campaign_idx').on(t.campaignId, t.status),
    index('research_tasks_version_idx').on(t.strategyVersionId),
  ],
);
