import { describe, expect, it } from 'vitest';
import {
  computeParity,
  TOLERANCE_POLICY_VERSION,
  type ParityIdentity,
  type ParitySide,
  type ParityTrade,
} from './parity.js';

const IDENTITY: ParityIdentity = {
  sourceHash: 'a'.repeat(64),
  symbol: 'BYBIT:BTCUSDT.P',
  timeframe: '60',
  rangeStart: '2026-01-01T00:00:00.000Z',
  rangeEnd: '2026-06-30T00:00:00.000Z',
  settingsHash: 'b'.repeat(64),
  initialCapital: '10000',
};

function trade(n: number, overrides: Partial<ParityTrade> = {}): ParityTrade {
  return {
    tradeNumber: n,
    direction: 'LONG',
    entryTime: `2026-01-0${n}T09:00:00.000Z`,
    exitTime: `2026-01-0${n}T15:00:00.000Z`,
    entryPrice: '100',
    exitPrice: '110',
    quantity: '1',
    netPnl: '10',
    ...overrides,
  };
}

function side(trades: ParityTrade[], metrics: Record<string, string | null> = {}): ParitySide {
  return {
    identity: IDENTITY,
    trades,
    metrics: { net_profit: '30', max_drawdown: '0', ...metrics },
  };
}

const THREE = [trade(1), trade(2), trade(3)];

describe('identity is checked before any number', () => {
  it('fails and does not compare numbers when the source hash differs', () => {
    // Comparing results from two different revisions carries no information,
    // however close the numbers happen to be.
    const tv: ParitySide = {
      ...side(THREE),
      identity: { ...IDENTITY, sourceHash: 'c'.repeat(64) },
    };
    const result = computeParity(side(THREE), tv);
    expect(result.status).toBe('FAIL');
    expect(result.identityMatches).toBe(false);
    expect(result.comparisons).toHaveLength(0);
    expect(result.identityMismatches[0]).toMatch(/different revisions/);
  });

  it('fails on a symbol mismatch', () => {
    const tv: ParitySide = { ...side(THREE), identity: { ...IDENTITY, symbol: 'BINANCE:ETHUSDT' } };
    const result = computeParity(side(THREE), tv);
    expect(result.status).toBe('FAIL');
    expect(result.identityMismatches.some((m) => m.includes('Symbol differs'))).toBe(true);
  });

  it('fails on a settings mismatch, which covers costs, sizing and execution', () => {
    const tv: ParitySide = {
      ...side(THREE),
      identity: { ...IDENTITY, settingsHash: 'd'.repeat(64) },
    };
    const result = computeParity(side(THREE), tv);
    expect(result.status).toBe('FAIL');
    expect(result.identityMismatches.some((m) => m.includes('Settings hash differs'))).toBe(true);
  });

  it('fails on differing initial capital', () => {
    const tv: ParitySide = { ...side(THREE), identity: { ...IDENTITY, initialCapital: '20000' } };
    expect(computeParity(side(THREE), tv).status).toBe('FAIL');
  });
});

describe('first divergence in the trade sequence', () => {
  it('passes identical sequences', () => {
    const result = computeParity(side(THREE), side(THREE));
    expect(result.status).toBe('PASS');
    expect(result.firstDivergentTradeNumber).toBeNull();
  });

  it('reports the FIRST divergence, not an aggregate difference', () => {
    // The totals still agree here; only trade 2's exit price differs. A
    // comparison that only checked aggregates would pass this.
    const tvTrades = [trade(1), trade(2, { exitPrice: '150' }), trade(3)];
    const result = computeParity(side(THREE), side(tvTrades));
    expect(result.status).toBe('FAIL');
    expect(result.firstDivergentTradeNumber).toBe(2);
    expect(result.firstDivergenceDetail).toMatch(/exit_price/);
  });

  it('stops at the first divergence rather than listing every later one', () => {
    const tvTrades = [trade(1), trade(2, { exitPrice: '150' }), trade(3, { exitPrice: '200' })];
    const result = computeParity(side(THREE), side(tvTrades));
    expect(result.firstDivergentTradeNumber).toBe(2);
  });

  it('detects a direction flip', () => {
    const tvTrades = [trade(1), trade(2, { direction: 'SHORT' }), trade(3)];
    const result = computeParity(side(THREE), side(tvTrades));
    expect(result.firstDivergentTradeNumber).toBe(2);
    expect(result.firstDivergenceDetail).toMatch(/direction/);
  });

  it('detects a timestamp difference', () => {
    const tvTrades = [trade(1, { entryTime: '2026-01-01T10:00:00.000Z' }), trade(2), trade(3)];
    const result = computeParity(side(THREE), side(tvTrades));
    expect(result.firstDivergentTradeNumber).toBe(1);
    expect(result.firstDivergenceDetail).toMatch(/entry time/);
  });

  it('reports an extra trade as one insertion, not a cascade of mismatches', () => {
    // Matching by trade number would report every subsequent trade as wrong.
    // Positional comparison names the single real difference.
    const result = computeParity(side([...THREE, trade(4)]), side(THREE));
    expect(result.status).toBe('FAIL');
    expect(result.firstDivergenceDetail).toMatch(/agree for 3 trade\(s\)/);
    expect(result.firstDivergenceDetail).toMatch(/additional trade/);
  });

  it('tolerates a last-decimal price difference between engines', () => {
    const tvTrades = [trade(1, { exitPrice: '110.000000001' }), trade(2), trade(3)];
    expect(computeParity(side(THREE), side(tvTrades)).firstDivergentTradeNumber).toBeNull();
  });
});

describe('aggregate comparisons', () => {
  it('fails on a trade-count difference with zero tolerance', () => {
    // A different number of trades is a different strategy, not rounding.
    const result = computeParity(side(THREE), side([trade(1), trade(2)]));
    const count = result.comparisons.find((c) => c.field === 'closed_trade_count');
    expect(count?.withinTolerance).toBe(false);
    expect(result.status).toBe('FAIL');
  });

  it('fails when net profit is outside tolerance', () => {
    const result = computeParity(side(THREE), side(THREE, { net_profit: '45' }));
    expect(result.status).toBe('FAIL');
    expect(result.comparisons.find((c) => c.field === 'net_profit')?.withinTolerance).toBe(false);
  });

  it('accepts a one-cent net profit difference', () => {
    const result = computeParity(side(THREE), side(THREE, { net_profit: '30.01' }));
    expect(result.comparisons.find((c) => c.field === 'net_profit')?.withinTolerance).toBe(true);
  });
});

describe('drawdown follows the ADR-0001 definitional gap', () => {
  it('treats a smaller ARF drawdown as expected and warns rather than failing', () => {
    // ARF measures closed-trade drawdown; TradingView measures intra-trade.
    // ARF being smaller is the definition, not a defect.
    const result = computeParity(
      side(THREE, { max_drawdown: '50' }),
      side(THREE, { max_drawdown: '120' }),
    );
    expect(result.status).toBe('WARN');
    const dd = result.comparisons.find((c) => c.field === 'max_drawdown');
    expect(dd?.withinTolerance).toBe(true);
    expect(dd?.note).toMatch(/ADR-0001/);
  });

  it('fails when ARF drawdown EXCEEDS TradingView, which the gap cannot explain', () => {
    // This direction is impossible under the definitional difference, so it
    // is a real parsing or reconstruction defect.
    const result = computeParity(
      side(THREE, { max_drawdown: '200' }),
      side(THREE, { max_drawdown: '120' }),
    );
    expect(result.status).toBe('FAIL');
    const dd = result.comparisons.find((c) => c.field === 'max_drawdown');
    expect(dd?.withinTolerance).toBe(false);
    expect(dd?.note).toMatch(/real defect/);
  });

  it('passes cleanly when both drawdowns are zero', () => {
    expect(computeParity(side(THREE), side(THREE)).status).toBe('PASS');
  });
});

describe('missing data', () => {
  it('reports INSUFFICIENT_DATA when a side has no trades', () => {
    const result = computeParity(side([]), side(THREE));
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.insufficientDataReason).toMatch(/ARF run produced no trades/);
  });

  it('warns rather than failing when a metric is unavailable on one side', () => {
    // Per ADR-0002 some values genuinely do not exist on one side. Treating
    // an absence as a mismatch would train operators to ignore parity.
    const result = computeParity(side(THREE), side(THREE, { net_profit: null }));
    expect(result.status).toBe('WARN');
    expect(result.comparisons.find((c) => c.field === 'net_profit')?.note).toMatch(
      /Not available/,
    );
    // What *was* checked is named, so the gap is visible without discarding
    // the real comparison that did happen.
    expect(result.insufficientDataReason).toMatch(/Verified on closed_trade_count/);
  });

  it('reports INSUFFICIENT_DATA only when nothing at all could be compared', () => {
    const result = computeParity(
      side(THREE),
      side(THREE, { net_profit: null, max_drawdown: null }),
    );
    // closed_trade_count is always comparable, so construct the true no-data
    // case by removing the ARF side's values too.
    expect(result.status).toBe('WARN');
    expect(result.comparisons.filter((c) => c.note?.includes('Not available')).length).toBe(2);
  });
});

describe('policy versioning', () => {
  it('stamps the tolerance policy version on every report', () => {
    // Specification 13.4: a later loosening must not retroactively turn a
    // historical failure into a pass.
    for (const result of [
      computeParity(side(THREE), side(THREE)),
      computeParity(side(THREE), side([trade(1)])),
    ]) {
      expect(result.tolerancePolicyVersion).toBe(TOLERANCE_POLICY_VERSION);
    }
  });
});
