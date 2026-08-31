/**
 * Strategy Definition Language.
 *
 * Spec 9. The SDL is the contract between the Strategy Architect and the
 * Pine Engineer. Spec 9.2 constrains it hard:
 *   - no free-form executable logic,
 *   - every field schema-validated,
 *   - every parameter typed with a declared range,
 *   - the Pine Engineer may not add undeclared parameters,
 *   - any SDL change creates a new strategy version.
 *
 * The last rule is enforced in the workflow package, not here; this module
 * provides the canonical shape that makes such a change detectable by hash.
 */
import { z } from 'zod';
import { SchemaVersion, SymbolCode, Timeframe, Timezone, Decimal } from './common.js';

export const StrategyFamily = z.enum([
  'trend_following',
  'mean_reversion',
  'breakout',
  'momentum',
  'carry',
  'seasonality',
  'volatility',
  'market_structure',
  'statistical_arbitrage',
  'other',
]);
export type StrategyFamily = z.infer<typeof StrategyFamily>;

export const Direction = z.enum(['long', 'short']);
export type Direction = z.infer<typeof Direction>;

export const AssetClass = z.enum([
  'crypto',
  'forex',
  'futures',
  'indices',
  'metals',
  'equities',
]);
export type AssetClass = z.infer<typeof AssetClass>;

/**
 * Spec 11.2 and 3.8: non-standard charts such as Heikin Ashi or Renko produce
 * synthetic prices that are not tradable fills. Only standard OHLC is allowed
 * without an approved exception.
 */
export const ChartType = z.enum(['standard_ohlc', 'non_standard_requires_exception']);
export type ChartType = z.infer<typeof ChartType>;

/**
 * A parameter the Backtest Engineer is permitted to search.
 *
 * Spec 12.4 forbids unbounded searches, so numeric parameters must declare
 * both bounds and the default must sit inside them.
 */
export const ParameterSpec = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Parameter keys are lower_snake_case'),
    type: z.enum(['int', 'float', 'bool']),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
    rationale: z.string().min(1, 'Every parameter needs a stated rationale'),
  })
  .superRefine((p, ctx) => {
    const fail = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });

    if (p.type === 'bool') {
      if (typeof p.default !== 'boolean') {
        fail('A bool parameter needs a boolean default', 'default');
      }
      return;
    }
    if (typeof p.default !== 'number') {
      fail('A numeric parameter needs a numeric default', 'default');
      return;
    }
    if (p.type === 'int' && !Number.isInteger(p.default)) {
      fail('An int parameter default must be an integer', 'default');
    }
    // Spec 12.4 and CLAUDE.md 12.2 treat an unbounded optimisable input as a
    // hard error, so bounds are required rather than optional.
    if (p.min === undefined || p.max === undefined) {
      fail('Numeric parameters must declare both min and max', 'min');
      return;
    }
    if (p.min > p.max) {
      fail('min must not exceed max', 'min');
    }
    if (p.default < p.min || p.default > p.max) {
      fail('default must lie within [min, max]', 'default');
    }
  });
export type ParameterSpec = z.infer<typeof ParameterSpec>;

export const StopLossSpec = z.object({
  type: z.enum(['atr_multiple', 'percent', 'fixed_points', 'structure']),
  valueParameter: z.string().optional(),
  value: z.number().optional(),
});
export type StopLossSpec = z.infer<typeof StopLossSpec>;

export const TakeProfitSpec = z.object({
  type: z.enum(['risk_multiple', 'atr_multiple', 'percent', 'fixed_points']),
  valueParameter: z.string().optional(),
  value: z.number().optional(),
});
export type TakeProfitSpec = z.infer<typeof TakeProfitSpec>;

export const RiskSpec = z.object({
  sizingModel: z.enum(['percent_of_equity', 'fixed_quantity', 'fixed_cash', 'risk_percent']),
  sizePercent: z.number().positive().max(100).optional(),
  sizeValue: Decimal.optional(),
  leverage: z.number().positive().default(1),
  stopLoss: StopLossSpec,
  takeProfit: TakeProfitSpec,
  /**
   * Spec 11.6 default. Setting this false requires a separate risk review,
   * which the workflow package gates on.
   */
  oneStopOneTarget: z.boolean().default(true),
});
export type RiskSpec = z.infer<typeof RiskSpec>;

export const CostSpec = z.object({
  commissionType: z.enum(['percent', 'per_contract', 'per_order', 'cash_per_order']),
  commissionValue: z.number().nonnegative(),
  slippageTicks: z.number().int().nonnegative(),
  fundingTreatment: z.string().optional(),
  spreadApproximation: z.number().nonnegative().optional(),
});
export type CostSpec = z.infer<typeof CostSpec>;

/**
 * Spec 11.2 execution defaults. Every field defaults to the conservative
 * value, so any deviation is explicit in the stored document rather than
 * implied by omission.
 */
export const ExecutionSpec = z.object({
  entryOrder: z.enum(['market_next_bar', 'limit', 'stop']),
  pyramiding: z.number().int().min(0).default(0),
  allowReversal: z.boolean().default(false),
  processOnClose: z.boolean().default(false),
  calcOnEveryTick: z.boolean().default(false),
});
export type ExecutionSpec = z.infer<typeof ExecutionSpec>;

export const SegmentSpec = z.object({
  warmupBars: z.number().int().nonnegative(),
  selectionMode: z.enum([
    'fixed_train_validation_test',
    'rolling_walk_forward',
    'anchored_walk_forward',
  ]),
  embargoBars: z.number().int().nonnegative().default(0),
});
export type SegmentSpec = z.infer<typeof SegmentSpec>;

export const MarketSpec = z.object({
  assetClass: AssetClass,
  symbols: z.array(SymbolCode).min(1),
  timeframe: Timeframe,
  timezone: Timezone,
  /** TradingView session string, e.g. "0000-2359:1234567". */
  session: z.string().min(1),
  chartType: ChartType.default('standard_ohlc'),
});
export type MarketSpec = z.infer<typeof MarketSpec>;

/**
 * The complete Strategy Definition.
 *
 * `falsification` is required and non-empty because spec 7.4 obliges the
 * architect to pre-register the conditions that would disprove the
 * hypothesis, before any result is visible.
 */
export const StrategyDefinition = z
  .object({
    schemaVersion: SchemaVersion,
    strategy: z.object({
      name: z.string().min(1),
      family: StrategyFamily,
      thesis: z.string().min(1, 'A one-sentence falsifiable thesis is required'),
      directions: z.array(Direction).min(1),
    }),
    market: MarketSpec,
    signals: z.record(z.string(), z.unknown()),
    execution: ExecutionSpec,
    risk: RiskSpec,
    costs: CostSpec,
    parameters: z.array(ParameterSpec),
    segments: SegmentSpec,
    falsification: z
      .array(z.string().min(1))
      .min(1, 'Pre-registered falsification conditions are mandatory'),
  })
  .superRefine((sdl, ctx) => {
    // Duplicate keys would make the parameter manifest ambiguous and break
    // the parameter-set hash used to identify a run.
    const declared = new Set<string>();
    for (const p of sdl.parameters) {
      if (declared.has(p.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate parameter key: ${p.key}`,
          path: ['parameters'],
        });
      }
      declared.add(p.key);
    }
    // A risk model referencing an undeclared parameter would leave the Pine
    // Engineer to invent it, which spec 9.2 forbids.
    const refs: ReadonlyArray<readonly [string, string | undefined]> = [
      ['risk.stopLoss', sdl.risk.stopLoss.valueParameter],
      ['risk.takeProfit', sdl.risk.takeProfit.valueParameter],
    ];
    for (const [label, ref] of refs) {
      if (ref !== undefined && !declared.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} references undeclared parameter "${ref}"`,
          path: ['risk'],
        });
      }
    }
  });
export type StrategyDefinition = z.infer<typeof StrategyDefinition>;

/**
 * The frozen parameter manifest for one strategy version, produced from the
 * SDL at freeze time. The Pine Engineer implements exactly these inputs.
 */
export const ParameterManifest = z.object({
  schemaVersion: SchemaVersion,
  parameters: z.array(ParameterSpec),
});
export type ParameterManifest = z.infer<typeof ParameterManifest>;
