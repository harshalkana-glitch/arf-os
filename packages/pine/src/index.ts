/**
 * @arf/pine
 *
 * Pine manifest helpers, static checks, and TradingView report ingestion
 * (CLAUDE.md 12). The parser never guesses: an unrecognised column, an
 * ambiguous decimal separator or an ambiguous date order is a refusal, not a
 * best effort, because each of those failure modes corrupts results silently
 * rather than loudly.
 */
export {
  parseCsv,
  parseCsvAuto,
  detectDelimiter,
  stripBom,
  CsvParseError,
  type Delimiter,
} from './csv.js';

export {
  detectDecimalSeparator,
  parseNumber,
  isBlank,
  AmbiguousNumberError,
  InvalidNumberError,
  type DecimalSeparator,
  type SeparatorDecision,
} from './numeric.js';

export {
  zonedWallTimeToUtc,
  parseTradingViewDateTime,
  InvalidTimezoneError,
  NonexistentLocalTimeError,
  type WallClock,
  type ZonedConversion,
} from './timezone.js';

export {
  resolveColumns,
  normaliseHeader,
  currencyFromHeaders,
  LIST_OF_TRADES_ADAPTERS,
  UnknownColumnsError,
  type ColumnAdapter,
  type ColumnMapping,
  type TradeField,
} from './adapters/list-of-trades.js';

export {
  parseListOfTrades,
  PARSER_VERSION,
  TradeParseError,
  type ParsedTrade,
  type ParseTradesOptions,
  type ParseTradesResult,
} from './parse-trades.js';

export {
  computeParity,
  TOLERANCE_POLICY_VERSION,
  type FieldComparison,
  type ParityIdentity,
  type ParityResult,
  type ParitySide,
  type ParityTrade,
} from './parity.js';
