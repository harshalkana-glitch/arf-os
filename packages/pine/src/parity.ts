/**
 * Local-runner versus TradingView parity.
 *
 * CLAUDE.md 15.3 fixes the order: parity starts with *identity* — source
 * hash, settings, symbol, timeframe, date range, costs, sizing, execution
 * mode — and reports the **first divergence** in the trade sequence, not only
 * aggregate metric differences.
 *
 * That ordering is the whole point. Two runs can agree on net profit, trade
 * count and drawdown while disagreeing about which trades happened; averaged
 * differences hide that, and a trade-by-trade walk exposes it. A parity report
 * that only compares totals will pass a strategy whose fills are wrong.
 *
 * Identity is checked before any number, because comparing results from two
 * different source revisions is meaningless regardless of how close the
 * numbers come out.
 */
import { Decimal } from 'decimal.js';
import type { ParityStatus } from '@arf/contracts';

/**
 * Bumped on any change to the tolerances or rules below.
 *
 * Stored on every report. Specification 13.4 makes tolerance policy versioned
 * so a later loosening cannot retroactively turn a historical failure into a
 * pass.
 */
export const TOLERANCE_POLICY_VERSION = '2026-09-01.1';

export interface ParityTrade {
  readonly tradeNumber: number;
  readonly direction: 'LONG' | 'SHORT';
  readonly entryTime: string;
  readonly exitTime: string;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly quantity: string;
  readonly netPnl: string;
}

export interface ParityIdentity {
  readonly sourceHash: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly rangeStart: string | null;
  readonly rangeEnd: string | null;
  /** Canonical hash of the cost model, sizing and execution settings. */
  readonly settingsHash: string | null;
  readonly initialCapital: string | null;
}

export interface ParitySide {
  readonly identity: ParityIdentity;
  readonly trades: readonly ParityTrade[];
  /** Metric name -> value. Absent entries are treated as unavailable. */
  readonly metrics: Readonly<Record<string, string | null>>;
}

export interface FieldComparison {
  readonly field: string;
  readonly arfValue: string | null;
  readonly tradingViewValue: string | null;
  readonly absoluteDifference: string | null;
  readonly withinTolerance: boolean;
  readonly note?: string;
}

export interface ParityResult {
  readonly status: ParityStatus;
  readonly tolerancePolicyVersion: string;
  readonly identityMatches: boolean;
  readonly identityMismatches: readonly string[];
  readonly comparisons: readonly FieldComparison[];
  readonly firstDivergentTradeNumber: number | null;
  readonly firstDivergenceDetail: string | null;
  readonly insufficientDataReason: string | null;
}

interface Tolerance {
  /** Absolute allowance, in the value's own units. */
  readonly absolute: string;
  /** Relative allowance as a fraction of the TradingView value. */
  readonly relative: number;
}

/**
 * Per-field tolerances.
 *
 * Prices allow a tick of slack because the two engines round differently at
 * the last decimal. P&L allows a slightly wider relative band because it
 * compounds price and quantity rounding. Trade count allows nothing: a
 * different number of trades is a different strategy, not a rounding
 * difference.
 */
const TOLERANCES: Readonly<Record<string, Tolerance>> = {
  closed_trade_count: { absolute: '0', relative: 0 },
  net_profit: { absolute: '0.01', relative: 0.001 },
  entry_price: { absolute: '0.00000001', relative: 0.0001 },
  exit_price: { absolute: '0.00000001', relative: 0.0001 },
  quantity: { absolute: '0.00000001', relative: 0.0001 },
  trade_net_pnl: { absolute: '0.01', relative: 0.001 },
};

const DEFAULT_TOLERANCE: Tolerance = { absolute: '0.01', relative: 0.001 };

function toleranceFor(field: string): Tolerance {
  return TOLERANCES[field] ?? DEFAULT_TOLERANCE;
}

function withinTolerance(field: string, arf: Decimal, tv: Decimal): boolean {
  const tolerance = toleranceFor(field);
  const difference = arf.minus(tv).abs();
  if (difference.lte(new Decimal(tolerance.absolute))) return true;
  if (tolerance.relative === 0) return false;
  const allowed = tv.abs().times(tolerance.relative);
  return difference.lte(allowed);
}

function compareNumeric(
  field: string,
  arfRaw: string | null | undefined,
  tvRaw: string | null | undefined,
): FieldComparison {
  if (arfRaw === null || arfRaw === undefined || tvRaw === null || tvRaw === undefined) {
    return {
      field,
      arfValue: arfRaw ?? null,
      tradingViewValue: tvRaw ?? null,
      absoluteDifference: null,
      // Absent on one side is not a mismatch; it is an absence, and the
      // overall status becomes INSUFFICIENT_DATA rather than FAIL.
      withinTolerance: true,
      note: 'Not available on one side; excluded from the comparison.',
    };
  }
  const arf = new Decimal(arfRaw);
  const tv = new Decimal(tvRaw);
  return {
    field,
    arfValue: arf.toFixed(),
    tradingViewValue: tv.toFixed(),
    absoluteDifference: arf.minus(tv).abs().toFixed(),
    withinTolerance: withinTolerance(field, arf, tv),
  };
}

/** Compare the identity of the two runs. Anything here failing voids the rest. */
function compareIdentity(arf: ParityIdentity, tv: ParityIdentity): string[] {
  const mismatches: string[] = [];

  if (arf.sourceHash !== tv.sourceHash) {
    mismatches.push(
      `Source hash differs (ARF ${arf.sourceHash.slice(0, 12)}…, ` +
        `TradingView ${tv.sourceHash.slice(0, 12)}…). These are different revisions.`,
    );
  }
  if (arf.symbol !== tv.symbol) {
    mismatches.push(`Symbol differs: ${arf.symbol} versus ${tv.symbol}.`);
  }
  if (arf.timeframe !== tv.timeframe) {
    mismatches.push(`Timeframe differs: ${arf.timeframe} versus ${tv.timeframe}.`);
  }
  if (
    arf.settingsHash !== null &&
    tv.settingsHash !== null &&
    arf.settingsHash !== tv.settingsHash
  ) {
    mismatches.push('Settings hash differs: costs, sizing or execution mode do not match.');
  }
  if (
    arf.initialCapital !== null &&
    tv.initialCapital !== null &&
    !new Decimal(arf.initialCapital).eq(new Decimal(tv.initialCapital))
  ) {
    mismatches.push(
      `Initial capital differs: ${arf.initialCapital} versus ${tv.initialCapital}.`,
    );
  }
  if (arf.rangeStart !== null && tv.rangeStart !== null && arf.rangeStart !== tv.rangeStart) {
    mismatches.push(`Range start differs: ${arf.rangeStart} versus ${tv.rangeStart}.`);
  }
  if (arf.rangeEnd !== null && tv.rangeEnd !== null && arf.rangeEnd !== tv.rangeEnd) {
    mismatches.push(`Range end differs: ${arf.rangeEnd} versus ${tv.rangeEnd}.`);
  }

  return mismatches;
}

interface Divergence {
  readonly tradeNumber: number;
  readonly detail: string;
}

/**
 * Walk both trade sequences in order and return the first disagreement.
 *
 * Compared in sequence position rather than by trade number, because a runner
 * that emits an extra trade shifts every subsequent number; matching on number
 * would then report dozens of false differences instead of the one real
 * insertion.
 */
function findFirstDivergence(
  arfTrades: readonly ParityTrade[],
  tvTrades: readonly ParityTrade[],
): Divergence | null {
  const length = Math.min(arfTrades.length, tvTrades.length);

  for (let i = 0; i < length; i += 1) {
    const a = arfTrades[i];
    const t = tvTrades[i];
    if (!a || !t) break;
    const at = `Trade ${i + 1} (ARF #${a.tradeNumber}, TradingView #${t.tradeNumber})`;

    if (a.direction !== t.direction) {
      return { tradeNumber: a.tradeNumber, detail: `${at}: direction ${a.direction} versus ${t.direction}.` };
    }
    if (a.entryTime !== t.entryTime) {
      return { tradeNumber: a.tradeNumber, detail: `${at}: entry time ${a.entryTime} versus ${t.entryTime}.` };
    }
    if (a.exitTime !== t.exitTime) {
      return { tradeNumber: a.tradeNumber, detail: `${at}: exit time ${a.exitTime} versus ${t.exitTime}.` };
    }
    for (const [field, av, tv] of [
      ['entry_price', a.entryPrice, t.entryPrice],
      ['exit_price', a.exitPrice, t.exitPrice],
      ['quantity', a.quantity, t.quantity],
      ['trade_net_pnl', a.netPnl, t.netPnl],
    ] as const) {
      if (!withinTolerance(field, new Decimal(av), new Decimal(tv))) {
        return {
          tradeNumber: a.tradeNumber,
          detail: `${at}: ${field} ${av} versus ${tv}, outside tolerance.`,
        };
      }
    }
  }

  if (arfTrades.length !== tvTrades.length) {
    const shorter = Math.min(arfTrades.length, tvTrades.length);
    const extraSide = arfTrades.length > tvTrades.length ? 'ARF' : 'TradingView';
    const next = (arfTrades.length > tvTrades.length ? arfTrades : tvTrades)[shorter];
    return {
      tradeNumber: next?.tradeNumber ?? shorter + 1,
      detail:
        `Sequences agree for ${shorter} trade(s), then ${extraSide} has ` +
        `${Math.abs(arfTrades.length - tvTrades.length)} additional trade(s). ` +
        `The first extra is #${next?.tradeNumber ?? shorter + 1}.`,
    };
  }

  return null;
}

/**
 * Compare a drawdown pair using the definitional gap from ADR-0001.
 *
 * ARF measures drawdown on closed trades; TradingView measures it
 * intra-trade. TradingView's figure should therefore be greater than or equal
 * to ARF's, and a difference in that direction is explainable rather than a
 * defect. A difference in the *opposite* direction cannot arise from the
 * definitional gap and is a genuine parsing or reconstruction error.
 */
function compareDrawdown(arfRaw: string | null, tvRaw: string | null): FieldComparison {
  if (arfRaw === null || tvRaw === null) {
    return {
      field: 'max_drawdown',
      arfValue: arfRaw,
      tradingViewValue: tvRaw,
      absoluteDifference: null,
      withinTolerance: true,
      note: 'Not available on one side; excluded from the comparison.',
    };
  }
  const arf = new Decimal(arfRaw).abs();
  const tv = new Decimal(tvRaw).abs();
  const difference = arf.minus(tv).abs();
  const base = {
    field: 'max_drawdown',
    arfValue: arf.toFixed(),
    tradingViewValue: tv.toFixed(),
    absoluteDifference: difference.toFixed(),
  } as const;

  // Agreement within tolerance is a clean match. The definitional gap only
  // needs explaining when it actually produced a visible difference; noting
  // it on an exact match would downgrade a genuine PASS to a WARN.
  if (withinTolerance('max_drawdown', arf, tv)) {
    return { ...base, withinTolerance: true };
  }

  if (arf.lt(tv)) {
    return {
      ...base,
      withinTolerance: true,
      note:
        'ARF measures drawdown on closed trades and TradingView measures it ' +
        'intra-trade, so ARF being smaller is expected (ADR-0001).',
    };
  }

  return {
    ...base,
    withinTolerance: false,
    note:
      'ARF drawdown exceeds TradingView drawdown. This cannot arise from the ' +
      'closed-trade versus intra-trade definition and indicates a real defect.',
  };
}

/**
 * Compute the parity report.
 *
 * Status is the worst of the checks: identity failure or a trade-sequence
 * divergence is FAIL; an aggregate metric outside tolerance is FAIL; missing
 * data on one side with everything else agreeing is INSUFFICIENT_DATA; an
 * explainable drawdown difference alone is WARN.
 */
export function computeParity(arf: ParitySide, tradingView: ParitySide): ParityResult {
  const identityMismatches = compareIdentity(arf.identity, tradingView.identity);
  const identityMatches = identityMismatches.length === 0;

  if (!identityMatches) {
    // Numbers from two different revisions or symbols carry no information,
    // so they are deliberately not compared at all.
    return {
      status: 'FAIL',
      tolerancePolicyVersion: TOLERANCE_POLICY_VERSION,
      identityMatches: false,
      identityMismatches,
      comparisons: [],
      firstDivergentTradeNumber: null,
      firstDivergenceDetail:
        'Identity check failed; trade and metric comparison was not attempted.',
      insufficientDataReason: null,
    };
  }

  if (arf.trades.length === 0 || tradingView.trades.length === 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      tolerancePolicyVersion: TOLERANCE_POLICY_VERSION,
      identityMatches: true,
      identityMismatches: [],
      comparisons: [],
      firstDivergentTradeNumber: null,
      firstDivergenceDetail: null,
      insufficientDataReason:
        arf.trades.length === 0
          ? 'The ARF run produced no trades to compare.'
          : 'The TradingView export produced no trades to compare.',
    };
  }

  const divergence = findFirstDivergence(arf.trades, tradingView.trades);

  const comparisons: FieldComparison[] = [
    compareNumeric(
      'closed_trade_count',
      String(arf.trades.length),
      String(tradingView.trades.length),
    ),
    compareNumeric('net_profit', arf.metrics['net_profit'], tradingView.metrics['net_profit']),
    compareDrawdown(
      arf.metrics['max_drawdown'] ?? null,
      tradingView.metrics['max_drawdown'] ?? null,
    ),
  ];

  const unavailable = comparisons.filter((c) => c.note?.includes('Not available') === true);
  const failed = comparisons.filter((c) => !c.withinTolerance);

  let status: ParityStatus;
  let insufficientDataReason: string | null = null;

  if (divergence !== null || failed.length > 0) {
    status = 'FAIL';
  } else if (unavailable.length > 0) {
    status = 'INSUFFICIENT_DATA';
    insufficientDataReason = `Fields unavailable on one side: ${unavailable
      .map((c) => c.field)
      .join(', ')}.`;
  } else if (comparisons.some((c) => c.note?.includes('ADR-0001') === true)) {
    // Everything agrees, but the drawdown definitions differ by design. WARN
    // rather than PASS so the difference is visible and not mistaken for an
    // exact match.
    status = 'WARN';
  } else {
    status = 'PASS';
  }

  return {
    status,
    tolerancePolicyVersion: TOLERANCE_POLICY_VERSION,
    identityMatches: true,
    identityMismatches: [],
    comparisons,
    firstDivergentTradeNumber: divergence?.tradeNumber ?? null,
    firstDivergenceDetail: divergence?.detail ?? null,
    insufficientDataReason,
  };
}
