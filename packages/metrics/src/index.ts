/**
 * @arf/metrics
 *
 * Independent metric calculations (CLAUDE.md 14). Pure functions only: no
 * database access, no I/O, no clock reads. Every value carries a unit, and a
 * metric that is undefined for its input is returned as null with a reason
 * rather than coerced to zero.
 */
export {
  EQUITY_CALCULATION_VERSION,
  reconstructEquity,
  summariseDrawdown,
  type DrawdownSummary,
  type EquityReconstruction,
} from './equity.js';

export {
  CORE_CALCULATION_VERSION,
  computeCoreMetrics,
  findMetric,
  type CoreMetrics,
  type MetricValue,
  type MonthlyReturn,
} from './core.js';
