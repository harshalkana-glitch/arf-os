/**
 * Equity and drawdown reconstruction.
 *
 * Spec 22 item 6 and the build prompt both require ARF to *reconstruct* the
 * equity curve from the parsed trade ledger rather than read it from a
 * report. Only then is a parity comparison meaningful: if we copied
 * TradingView's numbers we would be comparing them with themselves.
 *
 * IMPORTANT — a known and deliberate difference from TradingView.
 * This curve is marked to *closed trades*. TradingView's strategy tester
 * tracks equity intra-trade, so its maximum drawdown includes adverse
 * excursion while a position is open. A closed-trade curve therefore reports
 * a drawdown that is equal or smaller. The two are not errors of each other
 * and must not be reconciled by adjusting this calculation; the parity report
 * records the difference and, where MAE data is present, the intra-trade
 * figure is computed separately. See docs/adr/0001.
 */
import { Decimal } from 'decimal.js';
import type { EquityPoint, Trade, TradeLedger } from '@arf/contracts';

/** Bumped whenever a formula here changes. Stored on every snapshot. */
export const EQUITY_CALCULATION_VERSION = '1.0.0';

export interface EquityReconstruction {
  readonly points: readonly EquityPoint[];
  /** Ordering and data-integrity problems found while reconstructing. */
  readonly warnings: readonly string[];
}

/**
 * Chronological order by exit time, with entry time and then the runner's own
 * trade number as deterministic tie-breakers. Two trades closing on the same
 * bar must not reorder between runs, or the equity curve would not be
 * reproducible.
 */
function byExitThenEntryThenNumber(a: Trade, b: Trade): number {
  if (a.exitTime !== b.exitTime) return a.exitTime < b.exitTime ? -1 : 1;
  if (a.entryTime !== b.entryTime) return a.entryTime < b.entryTime ? -1 : 1;
  return a.tradeNumber - b.tradeNumber;
}

/**
 * Build the closed-trade equity curve.
 *
 * The returned series always starts with a point at `tradeNumber: 0` carrying
 * the opening balance, so a curve with no trades is still a valid, plottable
 * series rather than an empty array the UI has to special-case.
 */
export function reconstructEquity(ledger: TradeLedger): EquityReconstruction {
  const warnings: string[] = [];
  const trades = [...ledger.trades].sort(byExitThenEntryThenNumber);

  // Spec 7.6: out-of-order trades are a data-integrity signal, not something
  // to quietly fix. We sort so the curve is correct, and report that we did.
  const wasReordered = trades.some((t, i) => t !== ledger.trades[i]);
  if (wasReordered) {
    warnings.push(
      'Trades were not in chronological exit order in the source ledger; ' +
        'the equity curve was reconstructed in sorted order.',
    );
  }

  const seenNumbers = new Set<number>();
  for (const t of trades) {
    if (seenNumbers.has(t.tradeNumber)) {
      warnings.push(`Duplicate trade number ${t.tradeNumber} in ledger.`);
    }
    seenNumbers.add(t.tradeNumber);
    if (t.exitTime < t.entryTime) {
      warnings.push(`Trade ${t.tradeNumber} exits before it enters.`);
    }
  }

  const initial = new Decimal(ledger.initialCapital);
  if (initial.lte(0)) {
    // Percentage drawdown is undefined against a non-positive base, so this
    // is reported rather than producing silently meaningless percentages.
    warnings.push('Initial capital is not positive; drawdown percentages are undefined.');
  }

  const points: EquityPoint[] = [];
  let equity = initial;
  let peak = initial;

  const openingAt = trades[0]?.entryTime ?? trades[0]?.exitTime;
  points.push({
    tradeNumber: 0,
    at: openingAt ?? '1970-01-01T00:00:00.000Z',
    equity: initial.toFixed(),
    peak: initial.toFixed(),
    drawdown: '0',
    drawdownPercent: 0,
  });

  for (const trade of trades) {
    equity = equity.plus(new Decimal(trade.netPnl));
    if (equity.gt(peak)) peak = equity;

    const drawdown = equity.minus(peak);
    const drawdownPercent = peak.gt(0)
      ? drawdown.dividedBy(peak).times(100).toNumber()
      : 0;

    points.push({
      tradeNumber: trade.tradeNumber,
      at: trade.exitTime,
      equity: equity.toFixed(),
      peak: peak.toFixed(),
      drawdown: drawdown.toFixed(),
      drawdownPercent,
    });
  }

  return { points, warnings };
}

export interface DrawdownSummary {
  /** Largest peak-to-trough fall, as a positive magnitude. */
  readonly maxDrawdown: string;
  /** The same fall as a positive percentage of the peak it fell from. */
  readonly maxDrawdownPercent: number;
  /** Trade number at which the largest drawdown bottomed, if any. */
  readonly troughTradeNumber: number | null;
  /**
   * Longest run of consecutive trades spent below a prior peak, measured in
   * trades rather than days: a closed-trade curve has no opinion about the
   * calendar time between fills.
   */
  readonly longestDrawdownTrades: number;
}

/** Summarise drawdown over a reconstructed curve. */
export function summariseDrawdown(points: readonly EquityPoint[]): DrawdownSummary {
  let worst = new Decimal(0);
  let worstPercent = 0;
  let troughTradeNumber: number | null = null;

  let currentRun = 0;
  let longestRun = 0;

  for (const p of points) {
    const dd = new Decimal(p.drawdown);
    if (dd.lt(worst)) {
      worst = dd;
      worstPercent = p.drawdownPercent;
      troughTradeNumber = p.tradeNumber;
    }
    if (dd.lt(0)) {
      currentRun += 1;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }

  return {
    maxDrawdown: worst.abs().toFixed(),
    maxDrawdownPercent: Math.abs(worstPercent),
    troughTradeNumber,
    longestDrawdownTrades: longestRun,
  };
}
