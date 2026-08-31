/**
 * Backtest evidence contracts: trades, equity, runs, metrics, parity.
 *
 * Spec 14.5 fixes the canonical fields of a BacktestRun; spec 13.4 fixes what
 * a parity comparison covers. CLAUDE.md 14 requires every metric to carry an
 * explicit unit, a calculation version, and a stated scope, so that two
 * numbers are never compared across incompatible scopes.
 */
import { z } from 'zod';
import {
  Currency,
  Decimal,
  MetricUnit,
  SchemaVersion,
  Sha256,
  SymbolCode,
  Timeframe,
  UtcTimestamp,
} from './common.js';
import { ParityStatus, RunnerType, TradeDirection } from './enums.js';

/**
 * One closed trade.
 *
 * Money fields are decimal strings (CLAUDE.md 7.4). `grossPnl`, `fees` and
 * `netPnl` are all carried rather than derived, because a TradingView export
 * supplies all three and silently recomputing one would hide a parity defect.
 */
export const Trade = z.object({
  /** Position ordinal within the run, 1-based, as the runner reported it. */
  tradeNumber: z.number().int().positive(),
  direction: TradeDirection,
  entryTime: UtcTimestamp,
  exitTime: UtcTimestamp,
  entryPrice: Decimal,
  exitPrice: Decimal,
  quantity: Decimal,
  grossPnl: Decimal,
  fees: Decimal,
  netPnl: Decimal,
  /** Runner-supplied labels, e.g. "Long entry" / "Stop loss". Never inferred. */
  entryReason: z.string().optional(),
  exitReason: z.string().optional(),
  /** Maximum adverse / favourable excursion, when the export provides them. */
  mae: Decimal.optional(),
  mfe: Decimal.optional(),
  /** Segment this trade was assigned to, once segmentation has run. */
  segmentId: z.string().optional(),
});
export type Trade = z.infer<typeof Trade>;

/**
 * The full closed-trade ledger for one run.
 *
 * Spec 7.6 obliges the Backtest Engineer to detect missing, duplicated,
 * impossible or out-of-order trades, so the ledger records whether those
 * checks ran and what they found rather than assuming a clean import.
 */
export const TradeLedger = z.object({
  schemaVersion: SchemaVersion,
  currency: Currency,
  initialCapital: Decimal,
  trades: z.array(Trade),
  /** Non-fatal problems found while normalising. Never silently dropped. */
  warnings: z.array(z.string()).default([]),
});
export type TradeLedger = z.infer<typeof TradeLedger>;

/**
 * A point on a reconstructed equity curve.
 *
 * Spec 22 item 6 requires equity to be *reconstructed* from the trade ledger
 * rather than read from a report, so that ARF numbers are independent of the
 * source and parity is meaningful.
 */
export const EquityPoint = z.object({
  /** Trade exit that produced this point; 0 is the opening balance. */
  tradeNumber: z.number().int().nonnegative(),
  at: UtcTimestamp,
  equity: Decimal,
  /** Peak equity seen up to and including this point. */
  peak: Decimal,
  /** equity - peak, so drawdown is zero or negative. */
  drawdown: Decimal,
  /** Drawdown as a percentage of peak, zero or negative. */
  drawdownPercent: z.number(),
});
export type EquityPoint = z.infer<typeof EquityPoint>;

/**
 * Everything needed to reproduce a run (spec 3.5, 14.5).
 *
 * Every hash here is load-bearing: a run whose `sourceHash` no longer matches
 * the stored Pine revision is not evidence about that revision.
 */
export const BacktestRunIdentity = z.object({
  runnerType: RunnerType,
  runnerVersion: z.string().min(1),
  sourceHash: Sha256,
  manifestHash: Sha256,
  datasetVersionId: z.string().optional(),
  /** Hash over runner build, dependency versions and execution settings. */
  environmentHash: Sha256.optional(),
  symbol: SymbolCode,
  timeframe: Timeframe,
  randomSeed: z.number().int().optional(),
});
export type BacktestRunIdentity = z.infer<typeof BacktestRunIdentity>;

/** The scope a metric describes. CLAUDE.md 14. */
export const MetricScope = z.enum([
  'RUN',
  'SEGMENT',
  'STRATEGY_VERSION',
  'SYMBOL',
  'PARAMETER_SET',
  'FORWARD_DEPLOYMENT',
  'PORTFOLIO',
]);
export type MetricScope = z.infer<typeof MetricScope>;

/**
 * One computed metric.
 *
 * `source` separates a number ARF calculated from one TradingView reported.
 * CLAUDE.md 18.1 forbids merging them into a single unlabelled value, so the
 * distinction is carried in the data, not just in the UI.
 */
export const MetricSnapshot = z.object({
  schemaVersion: SchemaVersion,
  metricName: z.string().min(1),
  value: Decimal.nullable(),
  unit: MetricUnit,
  /** Bumped whenever a formula changes; old snapshots keep their old version. */
  calculationVersion: z.string().min(1),
  scopeType: MetricScope,
  scopeId: z.string().min(1),
  source: z.enum(['ARF_CALCULATED', 'TRADINGVIEW_REPORTED']),
  computedAt: UtcTimestamp,
  /**
   * Why a value is null — for example too few trades, or a zero-duration
   * period. Spec 14 forbids silently dropping these cases.
   */
  nullReason: z.string().optional(),
});
export type MetricSnapshot = z.infer<typeof MetricSnapshot>;

/**
 * One field-level comparison inside a parity report.
 *
 * `withinTolerance` is stored rather than recomputed at read time, because
 * tolerance policy is versioned (spec 13.4) and a later policy change must
 * not retroactively turn a historical failure into a pass.
 */
export const ParityComparison = z.object({
  field: z.string().min(1),
  arfValue: z.string().nullable(),
  tradingViewValue: z.string().nullable(),
  absoluteDifference: z.string().nullable(),
  withinTolerance: z.boolean(),
  note: z.string().optional(),
});
export type ParityComparison = z.infer<typeof ParityComparison>;

/**
 * Local-runner versus TradingView comparison.
 *
 * CLAUDE.md 15.3: parity starts with *identity* — source hash, settings,
 * symbol, timeframe, date range, costs, sizing, execution mode — and reports
 * the first divergence in the trade sequence, not only aggregate differences.
 * Aggregate metrics matching while trade 47 differs is still a failure.
 */
export const ParityReport = z.object({
  schemaVersion: SchemaVersion,
  status: ParityStatus,
  tolerancePolicyVersion: z.string().min(1),
  /** Identity checks, evaluated before any numeric comparison. */
  identityMatches: z.boolean(),
  identityMismatches: z.array(z.string()).default([]),
  comparisons: z.array(ParityComparison).default([]),
  /**
   * The first trade index at which the two sequences diverge, if any.
   * Null when the sequences agree or when one side has no trade list.
   */
  firstDivergentTradeNumber: z.number().int().positive().nullable(),
  firstDivergenceDetail: z.string().optional(),
  /** Set when status is INSUFFICIENT_DATA, explaining what was missing. */
  insufficientDataReason: z.string().optional(),
  computedAt: UtcTimestamp,
});
export type ParityReport = z.infer<typeof ParityReport>;
