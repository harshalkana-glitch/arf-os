/**
 * Independent core metric calculations.
 *
 * CLAUDE.md 14: pure deterministic functions, explicit units, a calculation
 * version, and no silent dropping of NaN, missing trades, or zero-duration
 * periods. Where a metric is genuinely undefined this module returns `null`
 * with a stated reason rather than 0, Infinity, or NaN — a zero profit factor
 * and an undefined profit factor mean very different things to a validator.
 *
 * These are ARF's own numbers. They are never merged with TradingView's
 * reported values (CLAUDE.md 18.1); the parity report compares the two.
 */
import { Decimal } from 'decimal.js';
import type { MetricUnit, TradeLedger } from '@arf/contracts';
import { reconstructEquity, summariseDrawdown } from './equity.js';

/** Bumped whenever any formula below changes. */
export const CORE_CALCULATION_VERSION = '1.0.0';

export interface MetricValue {
  readonly name: string;
  /** Decimal string, or null when the metric is undefined for this input. */
  readonly value: string | null;
  readonly unit: MetricUnit;
  /** Present only when `value` is null. */
  readonly nullReason?: string;
}

const ZERO = new Decimal(0);

function metric(name: string, value: Decimal | number | string, unit: MetricUnit): MetricValue {
  return { name, value: new Decimal(value).toFixed(), unit };
}

function undefinedMetric(name: string, unit: MetricUnit, reason: string): MetricValue {
  return { name, value: null, unit, nullReason: reason };
}

/**
 * Milliseconds between two ISO-8601 instants.
 *
 * Both are UTC by contract (see `UtcTimestamp`), so this is plain subtraction
 * and never touches local time or DST — CLAUDE.md 7.3.
 */
function durationMs(fromIso: string, toIso: string): number {
  return Date.parse(toIso) - Date.parse(fromIso);
}

/** The month key a trade's exit falls in, in UTC. */
function utcMonthKey(iso: string): string {
  return iso.slice(0, 7);
}

export interface MonthlyReturn {
  /** "YYYY-MM", in UTC. */
  readonly month: string;
  readonly netPnl: string;
  readonly tradeCount: number;
}

export interface CoreMetrics {
  readonly calculationVersion: string;
  readonly metrics: readonly MetricValue[];
  readonly monthlyReturns: readonly MonthlyReturn[];
  readonly warnings: readonly string[];
}

/**
 * Compute the metric set the build prompt requires, from a trade ledger alone.
 *
 * A trade is counted as a win or a loss by its **net** P&L, after fees. A
 * trade that nets exactly zero is neither: counting scratches as wins would
 * inflate win rate, which is precisely the kind of flattering-by-default
 * choice spec 3.1 exists to prevent.
 */
export function computeCoreMetrics(ledger: TradeLedger): CoreMetrics {
  const { points, warnings: equityWarnings } = reconstructEquity(ledger);
  const drawdown = summariseDrawdown(points);
  const warnings = [...equityWarnings];

  const trades = ledger.trades;
  const closed = trades.length;
  const metrics: MetricValue[] = [metric('closed_trade_count', closed, 'COUNT')];

  if (closed === 0) {
    // Spec 12.6 warns below 100 trades; zero trades is not a poor result, it
    // is an absence of evidence, and every ratio below is undefined.
    warnings.push('Ledger contains no closed trades; ratio metrics are undefined.');
    for (const [name, unit] of [
      ['gross_profit', 'CURRENCY'],
      ['gross_loss', 'CURRENCY'],
      ['net_profit', 'CURRENCY'],
      ['profit_factor', 'RATIO'],
      ['win_rate', 'PERCENT'],
      ['average_win', 'CURRENCY'],
      ['average_loss', 'CURRENCY'],
      ['payoff_ratio', 'RATIO'],
      ['max_drawdown', 'CURRENCY'],
      ['max_drawdown_percent', 'PERCENT'],
      ['longest_losing_streak', 'COUNT'],
      ['average_holding_duration_hours', 'HOURS'],
    ] as const) {
      metrics.push(undefinedMetric(name, unit, 'No closed trades'));
    }
    return {
      calculationVersion: CORE_CALCULATION_VERSION,
      metrics,
      monthlyReturns: [],
      warnings,
    };
  }

  let grossProfit = ZERO;
  let grossLoss = ZERO;
  let netProfit = ZERO;
  /**
   * Fees are summed only where every trade reports them. A TradingView export
   * has no per-trade commission column (ADR-0002), and summing the subset that
   * does would understate the total while looking like a real figure.
   */
  let fees = ZERO;
  let tradesWithFees = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let winTotal = ZERO;
  let lossTotal = ZERO;

  let currentLosingStreak = 0;
  let longestLosingStreak = 0;

  let totalDurationMs = 0;
  let timedTrades = 0;
  let zeroDurationTrades = 0;

  const monthly = new Map<string, { net: Decimal; count: number }>();

  for (const t of trades) {
    const net = new Decimal(t.netPnl);
    netProfit = netProfit.plus(net);
    if (t.fees !== undefined && t.fees !== null) {
      fees = fees.plus(new Decimal(t.fees));
      tradesWithFees += 1;
    }

    if (net.gt(0)) {
      wins += 1;
      winTotal = winTotal.plus(net);
      grossProfit = grossProfit.plus(net);
      currentLosingStreak = 0;
    } else if (net.lt(0)) {
      losses += 1;
      lossTotal = lossTotal.plus(net.abs());
      grossLoss = grossLoss.plus(net.abs());
      currentLosingStreak += 1;
      if (currentLosingStreak > longestLosingStreak) longestLosingStreak = currentLosingStreak;
    } else {
      // Exactly zero after fees: neither a win nor a loss. Counted so the
      // three categories always reconcile to the closed-trade count.
      scratches += 1;
      currentLosingStreak = 0;
    }

    const ms = durationMs(t.entryTime, t.exitTime);
    if (Number.isFinite(ms)) {
      if (ms === 0) zeroDurationTrades += 1;
      totalDurationMs += ms;
      timedTrades += 1;
    }

    const key = utcMonthKey(t.exitTime);
    const bucket = monthly.get(key);
    if (bucket) {
      bucket.net = bucket.net.plus(net);
      bucket.count += 1;
    } else {
      monthly.set(key, { net, count: 1 });
    }
  }

  if (scratches > 0) {
    warnings.push(
      `${scratches} trade(s) closed at exactly zero net P&L and are counted as ` +
        'neither wins nor losses.',
    );
  }
  if (zeroDurationTrades > 0) {
    // CLAUDE.md 14 forbids silently dropping zero-duration periods. A trade
    // entering and exiting on the same timestamp usually means same-bar
    // stop-and-target fills, which spec 12.3 flags as an execution concern.
    warnings.push(
      `${zeroDurationTrades} trade(s) have zero holding duration, which may indicate ` +
        'same-bar entry and exit fills.',
    );
  }

  // 'gross' here is the standard backtest sense — the sum of winning trades
  // and the sum of losing trades, which feed profit factor. It is NOT
  // 'before fees'; those per-trade values may be unavailable (ADR-0002).
  metrics.push(
    metric('gross_profit', grossProfit, 'CURRENCY'),
    metric('gross_loss', grossLoss, 'CURRENCY'),
    metric('net_profit', netProfit, 'CURRENCY'),
    tradesWithFees === closed
      ? metric('total_fees', fees, 'CURRENCY')
      : undefinedMetric(
          'total_fees',
          'CURRENCY',
          tradesWithFees === 0
            ? 'This source reports no per-trade commission (see ADR-0002)'
            : `Only ${tradesWithFees} of ${closed} trades report fees; a partial sum would understate the total`,
        ),
    metric('winning_trade_count', wins, 'COUNT'),
    metric('losing_trade_count', losses, 'COUNT'),
    metric('scratch_trade_count', scratches, 'COUNT'),
    metric('win_rate', new Decimal(wins).dividedBy(closed).times(100), 'PERCENT'),
    metric('longest_losing_streak', longestLosingStreak, 'COUNT'),
    metric('max_drawdown', drawdown.maxDrawdown, 'CURRENCY'),
    metric('max_drawdown_percent', drawdown.maxDrawdownPercent, 'PERCENT'),
  );

  // Profit factor is gross profit over gross loss. With no losing trades the
  // ratio is unbounded, not "very good" — reporting Infinity or a large
  // number would let a two-trade sample outrank a robust strategy.
  metrics.push(
    grossLoss.isZero()
      ? undefinedMetric(
          'profit_factor',
          'RATIO',
          'No losing trades; profit factor is unbounded rather than infinite',
        )
      : metric('profit_factor', grossProfit.dividedBy(grossLoss), 'RATIO'),
  );

  metrics.push(
    wins === 0
      ? undefinedMetric('average_win', 'CURRENCY', 'No winning trades')
      : metric('average_win', winTotal.dividedBy(wins), 'CURRENCY'),
  );
  metrics.push(
    losses === 0
      ? undefinedMetric('average_loss', 'CURRENCY', 'No losing trades')
      : metric('average_loss', lossTotal.dividedBy(losses), 'CURRENCY'),
  );

  // Payoff ratio needs both an average win and an average loss to exist.
  if (wins === 0 || losses === 0) {
    metrics.push(
      undefinedMetric(
        'payoff_ratio',
        'RATIO',
        wins === 0 ? 'No winning trades' : 'No losing trades',
      ),
    );
  } else {
    const avgWin = winTotal.dividedBy(wins);
    const avgLoss = lossTotal.dividedBy(losses);
    metrics.push(metric('payoff_ratio', avgWin.dividedBy(avgLoss), 'RATIO'));
  }

  metrics.push(
    timedTrades === 0
      ? undefinedMetric(
          'average_holding_duration_hours',
          'HOURS',
          'No trades carried parseable entry and exit timestamps',
        )
      : metric(
          'average_holding_duration_hours',
          new Decimal(totalDurationMs).dividedBy(timedTrades).dividedBy(3_600_000),
          'HOURS',
        ),
  );

  // Return on initial capital, stated explicitly as a percentage so it can
  // never be confused with the ratio form (CLAUDE.md 7.4).
  const initial = new Decimal(ledger.initialCapital);
  metrics.push(
    initial.lte(0)
      ? undefinedMetric(
          'total_return_percent',
          'PERCENT',
          'Initial capital is not positive',
        )
      : metric('total_return_percent', netProfit.dividedBy(initial).times(100), 'PERCENT'),
  );

  const monthlyReturns: MonthlyReturn[] = [...monthly.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, v]) => ({ month, netPnl: v.net.toFixed(), tradeCount: v.count }));

  return {
    calculationVersion: CORE_CALCULATION_VERSION,
    metrics,
    monthlyReturns,
    warnings,
  };
}

/** Look up one metric by name. Returns undefined if it was not computed. */
export function findMetric(result: CoreMetrics, name: string): MetricValue | undefined {
  return result.metrics.find((m) => m.name === name);
}
