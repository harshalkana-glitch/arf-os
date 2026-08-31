/**
 * Shared column builders and database-level enums.
 *
 * Defining these once means the money precision, timestamp mode and ID type
 * cannot drift between tables — a numeric(20,8) in one table and a double in
 * another would silently break reproducibility (CLAUDE.md 7.4).
 */
import { numeric, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * A UUIDv7 primary key.
 *
 * PostgreSQL 17 has no built-in `uuidv7()` — that arrives in 18 — so IDs are
 * generated in the application by `newId()` and passed in. There is
 * deliberately no `defaultRandom()`: a v4 default would silently produce
 * non-time-ordered IDs and defeat the ordering CLAUDE.md 7.2 relies on.
 */
export const id = () => uuid('id').primaryKey();

/** A UUIDv7 foreign-key column. */
export const fk = (name: string) => uuid(name);

/**
 * An instant, always stored with a time zone and read back as an ISO-8601
 * string.
 *
 * `mode: 'string'` keeps JavaScript `Date` out of the persistence layer
 * entirely, so no code path can accidentally reinterpret an instant in the
 * server's local zone (CLAUDE.md 7.3). Market-session timezones are stored
 * separately as IANA identifiers.
 */
export const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string', precision: 6 });

/** Creation timestamp defaulted by the database clock, which is UTC. */
export const createdAt = () => ts('created_at').notNull().default(sql`now()`);

/**
 * An authoritative monetary or price value.
 *
 * `numeric` is exact; `double precision` is not. Read back as a string and
 * handed to decimal.js, never to `Number` (CLAUDE.md 7.4). Scale 10 covers
 * crypto tick sizes; precision 28 leaves ample headroom for notional totals.
 */
export const money = (name: string) => numeric(name, { precision: 28, scale: 10 });

/** A quantity, which for crypto may be fractional to 8+ places. */
export const quantity = (name: string) => numeric(name, { precision: 28, scale: 10 });

/** A lowercase hex sha256, fixed width. */
export const hash = (name: string) => ({ name, length: 64 }) as const;

// ---------------------------------------------------------------------------
// Enums. Declaring these in the database rather than as free text means an
// invalid lifecycle state cannot be written even by a direct SQL statement
// (CLAUDE.md 7.1 forbids stringly typed lifecycle states, 9.2 asks for
// database constraints wherever an invariant can be expressed as one).
// ---------------------------------------------------------------------------

export const workflowStateEnum = pgEnum('workflow_state', [
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'INDICATOR_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'COMPILE_CHECK',
  'BASIC_BACKTEST',
  'SEGMENTED_BACKTEST',
  'ROBUSTNESS_VALIDATION',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'FORWARD_TESTING',
  'FINAL_REVIEW',
  'RESEARCH_APPROVED',
  'PAPER_APPROVED',
  'LIVE_CANDIDATE',
  'REJECTED',
  'ARCHIVED',
  'BLOCKED',
]);

export const rbacRoleEnum = pgEnum('rbac_role', [
  'VIEWER',
  'RESEARCHER',
  'DEVELOPER',
  'VALIDATOR',
  'OPERATOR',
  'COMMITTEE_MEMBER',
  'ADMIN',
  'SERVICE_ACCOUNT',
]);

export const agentRoleEnum = pgEnum('agent_role', [
  'CHIEF_RESEARCH_ORCHESTRATOR',
  'IDEA_SCOUT',
  'INDICATOR_RESEARCHER',
  'STRATEGY_ARCHITECT',
  'PINE_ENGINEER',
  'BACKTEST_ENGINEER',
  'ROBUSTNESS_VALIDATOR',
  'FORWARD_TEST_OPERATOR',
  'STRATEGY_JUDGE',
  'DATA_INTEGRITY_ANALYST',
  'PORTFOLIO_RESEARCHER',
]);

export const actorTypeEnum = pgEnum('actor_type', ['HUMAN', 'AGENT', 'SERVICE']);

export const runnerTypeEnum = pgEnum('runner_type', ['LOCAL_RESEARCH_RUNNER', 'TRADINGVIEW']);

export const tradeDirectionEnum = pgEnum('trade_direction', ['LONG', 'SHORT']);

export const parityStatusEnum = pgEnum('parity_status', [
  'PASS',
  'WARN',
  'FAIL',
  'INSUFFICIENT_DATA',
]);

/**
 * Spec 7.9. `LIVE_APPROVED` is absent by design: no agent and no in-system
 * decision can grant it, so the database has no value to represent it.
 */
export const committeeDecisionEnum = pgEnum('committee_decision_type', [
  'REJECT',
  'REWORK_WITH_NEW_VERSION',
  'PAPER_APPROVED',
  'RESEARCH_APPROVED',
  'LIVE_CANDIDATE_FOR_HUMAN_REVIEW',
  'INSUFFICIENT_EVIDENCE',
]);

export const metricScopeEnum = pgEnum('metric_scope', [
  'RUN',
  'SEGMENT',
  'STRATEGY_VERSION',
  'SYMBOL',
  'PARAMETER_SET',
  'FORWARD_DEPLOYMENT',
  'PORTFOLIO',
]);

/** Distinguishes an ARF-computed number from a TradingView-reported one. */
export const metricSourceEnum = pgEnum('metric_source', [
  'ARF_CALCULATED',
  'TRADINGVIEW_REPORTED',
]);

export const metricUnitEnum = pgEnum('metric_unit', [
  'CURRENCY',
  'PERCENT',
  'RATIO',
  'COUNT',
  'DAYS',
  'HOURS',
  'BARS',
  'SECONDS',
]);

/** Leader prompt 10: the protected-data access ledger. */
export const dataProtectionEnum = pgEnum('data_protection_class', [
  'DEVELOPMENT',
  'VALIDATION',
  'FINAL_HOLDOUT',
  'FORWARD',
  'CONTAMINATED',
  'RETIRED',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'PENDING',
  'AWAITING_UPLOAD',
  'PARSING',
  'PARSED',
  'PARITY_COMPUTED',
  'FAILED',
  'CANCELLED',
]);

export const uploadStatusEnum = pgEnum('upload_status', [
  'PRESIGNED',
  'UPLOADED',
  'PARSED',
  'REJECTED',
]);

export const reportKindEnum = pgEnum('report_kind', [
  'PERFORMANCE_SUMMARY',
  'LIST_OF_TRADES',
  'UNKNOWN',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'QUEUED',
  'RUNNING',
  'WAITING_EXTERNAL',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);
