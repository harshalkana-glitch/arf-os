import { describe, expect, it } from 'vitest';
import { ParameterSpec, StrategyDefinition } from './sdl.js';
import { canonicalHash } from './hashing.js';

/**
 * The worked example from AI_RESEARCH_HEDGE_FUND_SPEC.md section 9.1, used as
 * the primary fixture. If the schema ever stops accepting the spec's own
 * example, either the schema or the spec has drifted and one must be fixed.
 *
 * Invalid variants are built by spreading rather than by mutating a widened
 * clone, so each test states exactly which field it is corrupting and the
 * fixture itself stays strongly typed.
 */
const SPEC_EXAMPLE = {
  schemaVersion: '1.0.0',
  strategy: {
    name: 'Example Trend Pullback',
    family: 'trend_following',
    thesis: 'Enter pullbacks in a confirmed higher-timeframe trend.',
    directions: ['long', 'short'],
  },
  market: {
    assetClass: 'crypto',
    symbols: ['BYBIT:BTCUSDT.P'],
    timeframe: '60',
    timezone: 'Etc/UTC',
    session: '0000-2359:1234567',
    chartType: 'standard_ohlc',
  },
  signals: {
    trend: {
      type: 'ema_relation',
      fastLength: { parameter: 'fast_length' },
      slowLength: { parameter: 'slow_length' },
    },
    longEntry: 'trend_fast_above_slow AND pullback_recovery AND confirmed_bar',
    shortEntry: 'trend_fast_below_slow AND pullback_rejection AND confirmed_bar',
  },
  execution: {
    entryOrder: 'market_next_bar',
    pyramiding: 0,
    allowReversal: false,
    processOnClose: false,
    calcOnEveryTick: false,
  },
  risk: {
    sizingModel: 'percent_of_equity',
    sizePercent: 10,
    leverage: 3,
    stopLoss: { type: 'atr_multiple', valueParameter: 'stop_atr' },
    takeProfit: { type: 'risk_multiple', valueParameter: 'target_r' },
    oneStopOneTarget: true,
  },
  costs: { commissionType: 'percent', commissionValue: 0.06, slippageTicks: 2 },
  parameters: [
    { key: 'fast_length', type: 'int', default: 20, min: 10, max: 50, step: 5, rationale: 'Fast EMA window' },
    { key: 'slow_length', type: 'int', default: 100, min: 60, max: 200, step: 10, rationale: 'Slow EMA window' },
    { key: 'stop_atr', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.25, rationale: 'Stop distance in ATR' },
    { key: 'target_r', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.25, rationale: 'Target as multiple of risk' },
  ],
  segments: { warmupBars: 300, selectionMode: 'rolling_walk_forward', embargoBars: 10 },
  falsification: [
    'Out-of-sample net profit is non-positive.',
    'Performance exists only in one calendar segment.',
    'Neighbouring parameters collapse.',
    'Realistic costs remove the edge.',
  ],
};

/** Messages of every issue a failed parse produced, for readable assertions. */
function issuesOf(input: unknown): string[] {
  const result = StrategyDefinition.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('StrategyDefinition', () => {
  it('accepts the worked example from spec section 9.1', () => {
    const parsed = StrategyDefinition.parse(SPEC_EXAMPLE);
    expect(parsed.strategy.name).toBe('Example Trend Pullback');
    expect(parsed.parameters).toHaveLength(4);
    expect(parsed.execution.pyramiding).toBe(0);
  });

  it('requires pre-registered falsification conditions', () => {
    // Spec 7.4: the architect pre-registers what would disprove the
    // hypothesis, before any result is visible.
    expect(issuesOf({ ...SPEC_EXAMPLE, falsification: [] })).toContain(
      'Pre-registered falsification conditions are mandatory',
    );
  });

  it('requires a thesis', () => {
    const strategy = { ...SPEC_EXAMPLE.strategy, thesis: '' };
    expect(issuesOf({ ...SPEC_EXAMPLE, strategy })).toContain(
      'A one-sentence falsifiable thesis is required',
    );
  });

  it('rejects a risk model referencing an undeclared parameter', () => {
    const risk = {
      ...SPEC_EXAMPLE.risk,
      stopLoss: { type: 'atr_multiple', valueParameter: 'not_declared' },
    };
    const messages = issuesOf({ ...SPEC_EXAMPLE, risk });
    expect(messages.some((m) => m.includes('not_declared'))).toBe(true);
  });

  it('rejects duplicate parameter keys', () => {
    const parameters = [...SPEC_EXAMPLE.parameters, SPEC_EXAMPLE.parameters[0]];
    const messages = issuesOf({ ...SPEC_EXAMPLE, parameters });
    expect(messages.some((m) => m.includes('Duplicate parameter key'))).toBe(true);
  });

  it('rejects a non-standard chart type that has not been excepted', () => {
    // Spec 11.2: synthetic chart prices are not tradable fills.
    const market = { ...SPEC_EXAMPLE.market, chartType: 'heikin_ashi' };
    expect(StrategyDefinition.safeParse({ ...SPEC_EXAMPLE, market }).success).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    const market = { ...SPEC_EXAMPLE.market, timezone: 'Not/AZone' };
    expect(StrategyDefinition.safeParse({ ...SPEC_EXAMPLE, market }).success).toBe(false);
  });

  it('rejects a symbol without a venue prefix', () => {
    const market = { ...SPEC_EXAMPLE.market, symbols: ['BTCUSDT'] };
    expect(StrategyDefinition.safeParse({ ...SPEC_EXAMPLE, market }).success).toBe(false);
  });

  it('applies conservative execution defaults when fields are omitted', () => {
    // Spec 11.2: pyramiding 0, confirmed-bar calculation, no tick evaluation.
    const execution = { entryOrder: 'market_next_bar' };
    const parsed = StrategyDefinition.parse({ ...SPEC_EXAMPLE, execution });
    expect(parsed.execution.pyramiding).toBe(0);
    expect(parsed.execution.calcOnEveryTick).toBe(false);
    expect(parsed.execution.processOnClose).toBe(false);
    expect(parsed.execution.allowReversal).toBe(false);
  });

  it('hashes identically regardless of key order', () => {
    // A reordered document is the same strategy version and must not create
    // a spurious new one.
    const { schemaVersion, strategy, ...rest } = SPEC_EXAMPLE;
    const reordered = { ...rest, strategy, schemaVersion };
    expect(canonicalHash(StrategyDefinition.parse(SPEC_EXAMPLE))).toBe(
      canonicalHash(StrategyDefinition.parse(reordered)),
    );
  });

  it('hashes differently when a parameter bound changes', () => {
    // Spec 3.2: a parameter change is a material change and must produce a
    // new strategy version. The differing hash is what detects that.
    const first = SPEC_EXAMPLE.parameters[0];
    const parameters = [{ ...first, max: 60 }, ...SPEC_EXAMPLE.parameters.slice(1)];
    expect(canonicalHash(StrategyDefinition.parse(SPEC_EXAMPLE))).not.toBe(
      canonicalHash(StrategyDefinition.parse({ ...SPEC_EXAMPLE, parameters })),
    );
  });

  it('hashes differently when the cost model changes', () => {
    const costs = { ...SPEC_EXAMPLE.costs, slippageTicks: 3 };
    expect(canonicalHash(StrategyDefinition.parse(SPEC_EXAMPLE))).not.toBe(
      canonicalHash(StrategyDefinition.parse({ ...SPEC_EXAMPLE, costs })),
    );
  });
});

describe('ParameterSpec', () => {
  const base = { key: 'fast_length', type: 'int', default: 20, min: 10, max: 50, rationale: 'x' };

  it('accepts a well-formed numeric parameter', () => {
    expect(ParameterSpec.safeParse(base).success).toBe(true);
  });

  it('rejects a numeric parameter with no declared bounds', () => {
    // Spec 12.4 / CLAUDE.md 12.2: an unbounded optimisable input is a hard error.
    const { min, max, ...unbounded } = base;
    expect(ParameterSpec.safeParse(unbounded).success).toBe(false);
  });

  it('rejects a default outside the declared range', () => {
    expect(ParameterSpec.safeParse({ ...base, default: 99 }).success).toBe(false);
  });

  it('rejects an inverted range', () => {
    expect(ParameterSpec.safeParse({ ...base, min: 50, max: 10 }).success).toBe(false);
  });

  it('rejects a non-integer default on an int parameter', () => {
    expect(ParameterSpec.safeParse({ ...base, default: 20.5 }).success).toBe(false);
  });

  it('requires a rationale', () => {
    const { rationale, ...noRationale } = base;
    expect(ParameterSpec.safeParse(noRationale).success).toBe(false);
  });

  it('rejects keys that are not lower_snake_case', () => {
    expect(ParameterSpec.safeParse({ ...base, key: 'fastLength' }).success).toBe(false);
  });

  it('accepts a bool parameter without numeric bounds', () => {
    const result = ParameterSpec.safeParse({
      key: 'use_filter',
      type: 'bool',
      default: true,
      rationale: 'Toggle the regime filter',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bool parameter with a numeric default', () => {
    const result = ParameterSpec.safeParse({
      key: 'use_filter',
      type: 'bool',
      default: 1,
      rationale: 'Toggle the regime filter',
    });
    expect(result.success).toBe(false);
  });
});
