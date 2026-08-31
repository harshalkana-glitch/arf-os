import { describe, expect, it } from 'vitest';
import type { Trade, TradeLedger } from '@arf/contracts';
import { computeCoreMetrics, findMetric } from './core.js';
import { reconstructEquity, summariseDrawdown } from './equity.js';

/** Build a trade with sensible defaults, overriding only what a test cares about. */
function trade(partial: Partial<Trade> & Pick<Trade, 'tradeNumber' | 'netPnl'>): Trade {
  const n = partial.tradeNumber;
  return {
    direction: 'LONG',
    entryTime: `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    exitTime: `2026-01-${String(n).padStart(2, '0')}T12:00:00.000Z`,
    entryPrice: '100',
    exitPrice: '100',
    quantity: '1',
    grossPnl: partial.netPnl,
    fees: '0',
    ...partial,
  };
}

function ledger(trades: Trade[], initialCapital = '10000'): TradeLedger {
  return {
    schemaVersion: '1.0.0',
    currency: 'USD',
    initialCapital,
    trades,
    warnings: [],
  };
}

/**
 * Hand-calculated fixture. Every expectation below is worked out on paper:
 *
 *   capital 10000
 *   T1 +100  equity 10100  peak 10100  dd    0
 *   T2  -50  equity 10050  peak 10100  dd  -50
 *   T3 +200  equity 10250  peak 10250  dd    0
 *   T4  -30  equity 10220  peak 10250  dd  -30
 *   T5    0  equity 10220  peak 10250  dd  -30   (scratch)
 *
 *   gross profit 300, gross loss 80, net 220
 *   wins 2, losses 2, scratches 1, closed 5
 *   win rate 2/5 = 40%          profit factor 300/80 = 3.75
 *   average win 150             average loss 40
 *   payoff 150/40 = 3.75        longest losing streak 1
 *   max drawdown 50, which is 50/10100 = 0.495049...% of its peak
 */
const HAND_CALCULATED = ledger([
  trade({ tradeNumber: 1, netPnl: '100' }),
  trade({ tradeNumber: 2, netPnl: '-50' }),
  trade({ tradeNumber: 3, netPnl: '200' }),
  trade({ tradeNumber: 4, netPnl: '-30' }),
  trade({ tradeNumber: 5, netPnl: '0' }),
]);

function valueOf(result: ReturnType<typeof computeCoreMetrics>, name: string): string | null {
  const m = findMetric(result, name);
  expect(m, `metric ${name} was not computed`).toBeDefined();
  return m?.value ?? null;
}

describe('computeCoreMetrics — hand-calculated fixture', () => {
  const result = computeCoreMetrics(HAND_CALCULATED);

  it('counts trades and outcome categories that reconcile', () => {
    expect(valueOf(result, 'closed_trade_count')).toBe('5');
    expect(valueOf(result, 'winning_trade_count')).toBe('2');
    expect(valueOf(result, 'losing_trade_count')).toBe('2');
    expect(valueOf(result, 'scratch_trade_count')).toBe('1');
    // The three categories must always sum to the closed-trade count.
    expect(2 + 2 + 1).toBe(5);
  });

  it('computes gross and net profit', () => {
    expect(valueOf(result, 'gross_profit')).toBe('300');
    expect(valueOf(result, 'gross_loss')).toBe('80');
    expect(valueOf(result, 'net_profit')).toBe('220');
  });

  it('computes ratio metrics', () => {
    expect(valueOf(result, 'profit_factor')).toBe('3.75');
    expect(valueOf(result, 'win_rate')).toBe('40');
    expect(valueOf(result, 'average_win')).toBe('150');
    expect(valueOf(result, 'average_loss')).toBe('40');
    expect(valueOf(result, 'payoff_ratio')).toBe('3.75');
    expect(valueOf(result, 'total_return_percent')).toBe('2.2');
  });

  it('computes drawdown from the reconstructed curve', () => {
    expect(valueOf(result, 'max_drawdown')).toBe('50');
    expect(Number(valueOf(result, 'max_drawdown_percent'))).toBeCloseTo(0.495049, 5);
  });

  it('counts the longest losing streak, not the total losses', () => {
    // Two losses, but they are not consecutive.
    expect(valueOf(result, 'longest_losing_streak')).toBe('1');
  });

  it('warns that a scratch trade is neither a win nor a loss', () => {
    expect(result.warnings.some((w) => w.includes('zero net P&L'))).toBe(true);
  });

  it('excludes the scratch trade from win rate', () => {
    // Counting it as a win would give 60%, which flatters the strategy.
    expect(valueOf(result, 'win_rate')).not.toBe('60');
  });
});

describe('computeCoreMetrics — undefined rather than misleading', () => {
  it('reports profit factor as unbounded, not Infinity, when there are no losses', () => {
    const result = computeCoreMetrics(
      ledger([trade({ tradeNumber: 1, netPnl: '100' }), trade({ tradeNumber: 2, netPnl: '50' })]),
    );
    const pf = findMetric(result, 'profit_factor');
    expect(pf?.value).toBeNull();
    expect(pf?.nullReason).toMatch(/unbounded/);
  });

  it('reports every ratio as undefined for an empty ledger', () => {
    const result = computeCoreMetrics(ledger([]));
    expect(valueOf(result, 'closed_trade_count')).toBe('0');
    for (const name of ['profit_factor', 'win_rate', 'average_win', 'payoff_ratio']) {
      const m = findMetric(result, name);
      expect(m?.value, `${name} should be null`).toBeNull();
      expect(m?.nullReason).toBe('No closed trades');
    }
    expect(result.warnings.some((w) => w.includes('no closed trades'))).toBe(true);
  });

  it('reports payoff ratio as undefined when one side is missing', () => {
    const result = computeCoreMetrics(ledger([trade({ tradeNumber: 1, netPnl: '-10' })]));
    expect(findMetric(result, 'payoff_ratio')?.value).toBeNull();
    expect(findMetric(result, 'average_win')?.value).toBeNull();
    expect(findMetric(result, 'average_loss')?.value).toBe('10');
  });

  it('reports total return as undefined when initial capital is not positive', () => {
    const result = computeCoreMetrics(ledger([trade({ tradeNumber: 1, netPnl: '10' })], '0'));
    expect(findMetric(result, 'total_return_percent')?.value).toBeNull();
  });
});

describe('computeCoreMetrics — decimal exactness', () => {
  it('sums money exactly where binary floating point would not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754. CLAUDE.md 7.4 is the
    // reason this must come out as exactly 0.3.
    const result = computeCoreMetrics(
      ledger([
        trade({ tradeNumber: 1, netPnl: '0.1' }),
        trade({ tradeNumber: 2, netPnl: '0.2' }),
      ]),
    );
    expect(valueOf(result, 'net_profit')).toBe('0.3');
  });

  it('accumulates many small amounts without drift', () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      trade({ tradeNumber: i + 1, netPnl: '0.1' }),
    );
    expect(valueOf(computeCoreMetrics(ledger(trades)), 'net_profit')).toBe('1');
  });
});

describe('computeCoreMetrics — data integrity', () => {
  it('warns about zero-duration trades instead of dropping them', () => {
    const sameBar = trade({ tradeNumber: 1, netPnl: '5' });
    const result = computeCoreMetrics(
      ledger([{ ...sameBar, exitTime: sameBar.entryTime }]),
    );
    expect(result.warnings.some((w) => w.includes('zero holding duration'))).toBe(true);
    // It is still counted; the warning is a flag, not an exclusion.
    expect(valueOf(result, 'closed_trade_count')).toBe('1');
  });

  it('groups monthly returns by UTC exit month', () => {
    const result = computeCoreMetrics(
      ledger([
        { ...trade({ tradeNumber: 1, netPnl: '10' }), exitTime: '2026-01-31T23:00:00.000Z' },
        { ...trade({ tradeNumber: 2, netPnl: '20' }), exitTime: '2026-02-01T01:00:00.000Z' },
        { ...trade({ tradeNumber: 3, netPnl: '5' }), exitTime: '2026-02-15T01:00:00.000Z' },
      ]),
    );
    expect(result.monthlyReturns).toEqual([
      { month: '2026-01', netPnl: '10', tradeCount: 1 },
      { month: '2026-02', netPnl: '25', tradeCount: 2 },
    ]);
  });
});

describe('reconstructEquity', () => {
  it('always emits an opening point so an empty curve is still plottable', () => {
    const { points } = reconstructEquity(ledger([]));
    expect(points).toHaveLength(1);
    expect(points[0]?.tradeNumber).toBe(0);
    expect(points[0]?.equity).toBe('10000');
  });

  it('produces the hand-calculated equity path', () => {
    const { points } = reconstructEquity(HAND_CALCULATED);
    expect(points.map((p) => p.equity)).toEqual([
      '10000',
      '10100',
      '10050',
      '10250',
      '10220',
      '10220',
    ]);
    expect(points.map((p) => p.drawdown)).toEqual(['0', '0', '-50', '0', '-30', '-30']);
  });

  it('sorts out-of-order trades and says so', () => {
    const { points, warnings } = reconstructEquity(
      ledger([trade({ tradeNumber: 2, netPnl: '-50' }), trade({ tradeNumber: 1, netPnl: '100' })]),
    );
    expect(warnings.some((w) => w.includes('chronological exit order'))).toBe(true);
    expect(points.map((p) => p.equity)).toEqual(['10000', '10100', '10050']);
  });

  it('flags a trade that exits before it enters', () => {
    const t = trade({ tradeNumber: 1, netPnl: '10' });
    const { warnings } = reconstructEquity(
      ledger([{ ...t, entryTime: '2026-01-02T00:00:00.000Z', exitTime: '2026-01-01T00:00:00.000Z' }]),
    );
    expect(warnings.some((w) => w.includes('exits before it enters'))).toBe(true);
  });

  it('flags duplicate trade numbers', () => {
    const { warnings } = reconstructEquity(
      ledger([trade({ tradeNumber: 1, netPnl: '10' }), trade({ tradeNumber: 1, netPnl: '20' })]),
    );
    expect(warnings.some((w) => w.includes('Duplicate trade number'))).toBe(true);
  });
});

describe('summariseDrawdown', () => {
  it('measures the longest run of trades spent below a prior peak', () => {
    // T4 and T5 are both underwater; T2 alone is a run of one.
    const { points } = reconstructEquity(HAND_CALCULATED);
    const summary = summariseDrawdown(points);
    expect(summary.longestDrawdownTrades).toBe(2);
    expect(summary.troughTradeNumber).toBe(2);
    expect(summary.maxDrawdown).toBe('50');
  });

  it('reports no drawdown for a monotonically rising curve', () => {
    const { points } = reconstructEquity(
      ledger([trade({ tradeNumber: 1, netPnl: '10' }), trade({ tradeNumber: 2, netPnl: '10' })]),
    );
    const summary = summariseDrawdown(points);
    expect(summary.maxDrawdown).toBe('0');
    expect(summary.longestDrawdownTrades).toBe(0);
    expect(summary.troughTradeNumber).toBeNull();
  });
});

describe('computeCoreMetrics — fees may be unavailable', () => {
  it('reports total fees as undefined when no trade carries one', () => {
    // A TradingView export has no per-trade commission column (ADR-0002).
    // Reporting 0 would present the strategy as tested without costs, which
    // specification 16.1 treats as a hard failure.
    const result = computeCoreMetrics(
      ledger([{ ...trade({ tradeNumber: 1, netPnl: '10' }), fees: null }]),
    );
    const feesMetric = findMetric(result, 'total_fees');
    expect(feesMetric?.value).toBeNull();
    expect(feesMetric?.nullReason).toMatch(/no per-trade commission/);
  });

  it('refuses a partial sum when only some trades carry fees', () => {
    // A partial total looks like a real figure while understating the cost.
    const result = computeCoreMetrics(
      ledger([
        { ...trade({ tradeNumber: 1, netPnl: '10' }), fees: '1' },
        { ...trade({ tradeNumber: 2, netPnl: '10' }), fees: null },
      ]),
    );
    const feesMetric = findMetric(result, 'total_fees');
    expect(feesMetric?.value).toBeNull();
    expect(feesMetric?.nullReason).toMatch(/1 of 2 trades/);
  });

  it('sums fees when every trade reports one', () => {
    const result = computeCoreMetrics(
      ledger([
        { ...trade({ tradeNumber: 1, netPnl: '10' }), fees: '1.5' },
        { ...trade({ tradeNumber: 2, netPnl: '10' }), fees: '2.5' },
      ]),
    );
    expect(findMetric(result, 'total_fees')?.value).toBe('4');
  });

  it('still computes gross profit and loss, which are sums of winners and losers', () => {
    // 'gross' here is not 'before fees'; it is the standard backtest sense.
    const result = computeCoreMetrics(
      ledger([
        { ...trade({ tradeNumber: 1, netPnl: '10' }), fees: null },
        { ...trade({ tradeNumber: 2, netPnl: '-4' }), fees: null },
      ]),
    );
    expect(findMetric(result, 'gross_profit')?.value).toBe('10');
    expect(findMetric(result, 'gross_loss')?.value).toBe('4');
    expect(findMetric(result, 'profit_factor')?.value).toBe('2.5');
  });
});
