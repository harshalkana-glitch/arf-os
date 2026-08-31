/**
 * Evidence: artefacts, TradingView verification, runs, trades, equity, metrics.
 *
 * Spec 14.6: PostgreSQL holds metadata and the structured ledger; large raw
 * artefacts (CSV uploads, source bundles, logs) live in object storage and
 * are referenced by key and checksum. The raw upload is always preserved —
 * CLAUDE.md 15.2 requires it, so a parser bug can be re-run against the
 * original bytes rather than against an already-normalised copy.
 */
import {
  boolean,
  char,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { organisations, users } from './identity';
import { strategyVersions } from './strategy';
import {
  createdAt,
  fk,
  id,
  jobStatusEnum,
  metricScopeEnum,
  metricSourceEnum,
  metricUnitEnum,
  money,
  parityStatusEnum,
  quantity,
  reportKindEnum,
  runnerTypeEnum,
  tradeDirectionEnum,
  ts,
  uploadStatusEnum,
  verificationStatusEnum,
} from './columns';

/**
 * A stored file. Content-addressed by sha256 so an identical upload is
 * recognised rather than duplicated, and so a stored artefact can be proven
 * unaltered (spec 17.4, tamper-evident audit).
 */
export const artefacts = pgTable(
  'artefacts',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    objectKey: text('object_key').notNull(),
    contentSha256: char('content_sha256', { length: 64 }).notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('artefacts_object_key_key').on(t.objectKey),
    index('artefacts_sha_idx').on(t.organisationId, t.contentSha256),
  ],
);

/**
 * A human-assisted TradingView verification task (spec 13.2).
 *
 * The operator is shown the exact source hash, symbol, timeframe, settings
 * and date range, runs it in TradingView, and uploads the exports. These
 * expected values are frozen on the row at creation so a later change to the
 * strategy version cannot retroactively alter what was asked for.
 */
export const tradingviewVerifications = pgTable(
  'tradingview_verifications',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    status: verificationStatusEnum('status').notNull().default('PENDING'),

    expectedSourceHash: char('expected_source_hash', { length: 64 }).notNull(),
    expectedSymbol: text('expected_symbol').notNull(),
    expectedTimeframe: text('expected_timeframe').notNull(),
    expectedSettings: jsonb('expected_settings').notNull(),
    expectedRangeStart: ts('expected_range_start'),
    expectedRangeEnd: ts('expected_range_end'),

    /**
     * How to read the export the operator will produce.
     *
     * The chart timezone is captured here, at creation, because a TradingView
     * export carries wall-clock times with no zone. A wrong zone shifts every
     * trade by hours and can move it across a segment boundary, so it is a
     * property of this specific verification rather than a process-level
     * default a worker happens to be started with.
     */
    chartTimezone: text('chart_timezone').notNull(),
    /** Set only when the export uses day-first dates that are ambiguous. */
    dateFormatDayFirst: boolean('date_format_day_first'),
    /** The account size the operator configured, for equity reconstruction. */
    initialCapital: money('initial_capital').notNull(),

    requestedByUserId: fk('requested_by_user_id').references(() => users.id),
    completedAt: ts('completed_at'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('tv_verifications_version_idx').on(t.strategyVersionId),
    index('tv_verifications_status_idx').on(t.organisationId, t.status),
  ],
);

/**
 * One uploaded TradingView export.
 *
 * `parserWarnings` is never emptied on success: spec 15.2 requires warnings
 * to survive alongside a parsed result, because an ambiguous locale that
 * parsed *successfully* is still a parity risk.
 */
export const reportUploads = pgTable(
  'report_uploads',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    verificationId: fk('verification_id')
      .notNull()
      .references(() => tradingviewVerifications.id),
    artefactId: fk('artefact_id').references(() => artefacts.id),
    reportKind: reportKindEnum('report_kind').notNull().default('UNKNOWN'),
    status: uploadStatusEnum('status').notNull().default('PRESIGNED'),
    originalFilename: text('original_filename'),
    /** Checksum the client declared, compared against the stored object. */
    declaredSha256: char('declared_sha256', { length: 64 }),
    parserVersion: text('parser_version'),
    parserWarnings: jsonb('parser_warnings').$type<string[]>().notNull().default([]),
    rejectionReason: text('rejection_reason'),
    uploadedByUserId: fk('uploaded_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    uploadedAt: ts('uploaded_at'),
  },
  (t) => [index('report_uploads_verification_idx').on(t.verificationId, t.reportKind)],
);

/**
 * A backtest run.
 *
 * Spec 14.5 fixes these fields. Every hash is required for a completed run:
 * without them the result cannot be tied to specific code, data and
 * environment, and spec 3.5 reproducibility fails.
 */
export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    /** Set when this run came from a TradingView verification upload. */
    verificationId: fk('verification_id').references(() => tradingviewVerifications.id),

    runnerType: runnerTypeEnum('runner_type').notNull(),
    runnerVersion: text('runner_version').notNull(),
    sourceHash: char('source_hash', { length: 64 }).notNull(),
    manifestHash: char('manifest_hash', { length: 64 }),
    datasetVersionId: fk('dataset_version_id'),
    environmentHash: char('environment_hash', { length: 64 }),
    randomSeed: integer('random_seed'),

    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    segmentId: text('segment_id'),
    parameterSetId: fk('parameter_set_id'),
    parameters: jsonb('parameters').notNull().default({}),
    costModel: jsonb('cost_model').notNull(),
    executionModel: jsonb('execution_model').notNull(),

    initialCapital: money('initial_capital').notNull(),
    currency: text('currency').notNull(),

    status: jobStatusEnum('status').notNull().default('QUEUED'),
    /** Runner warnings, preserved verbatim and never normalised away. */
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    artefactPrefix: text('artefact_prefix'),

    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('backtest_runs_version_idx').on(t.strategyVersionId, t.createdAt),
    index('backtest_runs_status_idx').on(t.organisationId, t.status),
    index('backtest_runs_source_hash_idx').on(t.sourceHash),
  ],
);

/**
 * A closed trade.
 *
 * gross, fees and net are all stored rather than derived: a TradingView
 * export supplies all three, and recomputing one would mask a parity defect
 * in the other two.
 */
export const trades = pgTable(
  'trades',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    backtestRunId: fk('backtest_run_id')
      .notNull()
      .references(() => backtestRuns.id),
    tradeNumber: integer('trade_number').notNull(),
    direction: tradeDirectionEnum('direction').notNull(),
    entryTime: ts('entry_time').notNull(),
    exitTime: ts('exit_time').notNull(),
    entryPrice: money('entry_price').notNull(),
    exitPrice: money('exit_price').notNull(),
    quantity: quantity('quantity').notNull(),
    // Nullable: unavailable from a TradingView export (ADR-0002).
    grossPnl: money('gross_pnl'),
    fees: money('fees'),
    netPnl: money('net_pnl').notNull(),
    mae: money('mae'),
    mfe: money('mfe'),
    entryReason: text('entry_reason'),
    exitReason: text('exit_reason'),
    segmentId: text('segment_id'),
  },
  (t) => [
    // A run's trade numbers are unique: a duplicate would double-count P&L
    // in the reconstructed equity curve.
    unique('trades_run_number_key').on(t.backtestRunId, t.tradeNumber),
    index('trades_run_exit_idx').on(t.backtestRunId, t.exitTime),
  ],
);

/**
 * A point on the reconstructed equity curve.
 *
 * Drawdown is stored alongside equity so the UI never recomputes it with a
 * different definition than the one recorded in ADR-0001.
 */
export const equityPoints = pgTable(
  'equity_points',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    backtestRunId: fk('backtest_run_id')
      .notNull()
      .references(() => backtestRuns.id),
    tradeNumber: integer('trade_number').notNull(),
    at: ts('at').notNull(),
    equity: money('equity').notNull(),
    peak: money('peak').notNull(),
    drawdown: money('drawdown').notNull(),
    drawdownPercent: doublePrecision('drawdown_percent').notNull(),
    calculationVersion: text('calculation_version').notNull(),
  },
  (t) => [
    unique('equity_points_run_trade_key').on(t.backtestRunId, t.tradeNumber),
    index('equity_points_run_idx').on(t.backtestRunId, t.at),
  ],
);

/**
 * One computed metric.
 *
 * `source` keeps ARF's own calculation separate from TradingView's reported
 * figure. The unique constraint includes it, so both can coexist for the same
 * metric and scope — which is exactly what parity needs — while a duplicate
 * of either is rejected.
 */
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    metricName: text('metric_name').notNull(),
    /** Null when the metric is undefined for its input; see nullReason. */
    value: money('value'),
    nullReason: text('null_reason'),
    unit: metricUnitEnum('unit').notNull(),
    calculationVersion: text('calculation_version').notNull(),
    scopeType: metricScopeEnum('scope_type').notNull(),
    scopeId: fk('scope_id').notNull(),
    source: metricSourceEnum('source').notNull(),
    computedAt: createdAt(),
  },
  (t) => [
    unique('metric_snapshots_identity_key').on(
      t.scopeType,
      t.scopeId,
      t.metricName,
      t.source,
      t.calculationVersion,
    ),
    index('metric_snapshots_scope_idx').on(t.scopeType, t.scopeId),
  ],
);

/**
 * A local-runner versus TradingView parity report.
 *
 * `firstDivergentTradeNumber` is the field that matters most: CLAUDE.md 15.3
 * requires the first divergence to be reported, because matching totals with
 * a differing trade sequence is still a failure.
 */
export const parityReports = pgTable(
  'parity_reports',
  {
    id: id(),
    organisationId: fk('organisation_id')
      .notNull()
      .references(() => organisations.id),
    strategyVersionId: fk('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id),
    verificationId: fk('verification_id').references(() => tradingviewVerifications.id),
    arfRunId: fk('arf_run_id').references(() => backtestRuns.id),
    tradingviewRunId: fk('tradingview_run_id').references(() => backtestRuns.id),

    status: parityStatusEnum('status').notNull(),
    tolerancePolicyVersion: text('tolerance_policy_version').notNull(),
    identityMatches: jsonb('identity_matches').$type<boolean>().notNull(),
    identityMismatches: jsonb('identity_mismatches').$type<string[]>().notNull().default([]),
    comparisons: jsonb('comparisons').$type<unknown[]>().notNull().default([]),
    firstDivergentTradeNumber: integer('first_divergent_trade_number'),
    firstDivergenceDetail: text('first_divergence_detail'),
    insufficientDataReason: text('insufficient_data_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('parity_reports_version_idx').on(t.strategyVersionId, t.createdAt)],
);
