/**
 * Parse a TradingView "List of Trades" export into closed trades.
 *
 * The export writes two rows per trade sharing a Trade # — one "Entry long"
 * and one "Exit long" (or short) — and puts the realised P&L on the exit row.
 * This module pairs them, converts times to UTC, and reports anything it
 * could not reconcile instead of dropping it (CLAUDE.md 14, 15.2).
 *
 * An open position at the end of a backtest produces an entry row with no
 * exit. Such a trade is NOT a closed trade and is excluded from the ledger,
 * with a warning: silently including it would put an unrealised position into
 * a realised equity curve.
 */
import { parseCsvAuto, type Delimiter } from './csv.js';
import {
  detectDecimalSeparator,
  isBlank,
  parseNumber,
  type DecimalSeparator,
} from './numeric.js';
import { parseTradingViewDateTime } from './timezone.js';
import {
  currencyFromHeaders,
  resolveColumns,
  type ColumnMapping,
  type TradeField,
} from './adapters/list-of-trades.js';

export const PARSER_VERSION = 'tradingview.list-of-trades.1.0.0';

export interface ParsedTrade {
  readonly tradeNumber: number;
  readonly direction: 'LONG' | 'SHORT';
  readonly entryTime: string;
  readonly exitTime: string;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly quantity: string;
  /**
   * Net of commission, as TradingView reports it.
   *
   * Gross P&L and fees are deliberately absent: this export does not contain
   * a per-trade commission column, and deriving one would be fabrication.
   * See docs/adr/0002.
   */
  readonly netPnl: string;
  readonly entrySignal: string | null;
  readonly exitSignal: string | null;
  readonly runUp: string | null;
  readonly drawdown: string | null;
}

export interface ParseTradesOptions {
  /**
   * The chart timezone the export was taken in. Required, with no default:
   * guessing shifts every trade by hours and silently moves trades across
   * segment boundaries.
   */
  readonly timeZone: string;
  /** Set when the export uses day-first dates and both components are ≤ 12. */
  readonly dayFirst?: boolean;
}

export interface ParseTradesResult {
  readonly parserVersion: string;
  readonly adapterId: string;
  readonly delimiter: Delimiter;
  readonly decimalSeparator: DecimalSeparator;
  readonly currency: string | null;
  readonly trades: readonly ParsedTrade[];
  /**
   * Non-fatal findings. Never cleared on success — a file that parsed with an
   * ambiguous timestamp is still a parity risk (spec 15.2).
   */
  readonly warnings: readonly string[];
}

export class TradeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeParseError';
  }
}

interface RawRow {
  readonly tradeNumber: number;
  readonly type: string;
  readonly dateTime: string;
  readonly cells: readonly string[];
  readonly lineNumber: number;
}

function cell(
  row: readonly string[],
  mapping: ColumnMapping,
  field: TradeField,
): string | undefined {
  const index = mapping.indices[field];
  return index === undefined ? undefined : row[index];
}

/** "Entry long" / "Exit short" -> its two components. */
function classifyType(raw: string): { side: 'ENTRY' | 'EXIT'; direction: 'LONG' | 'SHORT' } | null {
  const t = raw.toLowerCase();
  const side = t.includes('entry') ? 'ENTRY' : t.includes('exit') ? 'EXIT' : null;
  const direction = t.includes('long') ? 'LONG' : t.includes('short') ? 'SHORT' : null;
  if (!side || !direction) return null;
  return { side, direction };
}

export function parseListOfTrades(
  text: string,
  options: ParseTradesOptions,
): ParseTradesResult {
  const warnings: string[] = [];
  const { rows, delimiter } = parseCsvAuto(text);

  const headerRow = rows[0];
  if (!headerRow) throw new TradeParseError('The export contains no header row.');
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) throw new TradeParseError('The export contains no trade rows.');

  const mapping = resolveColumns(headerRow);
  const currency = currencyFromHeaders(headerRow);
  if (mapping.unmappedHeaders.length > 0) {
    // Reported, not guessed at: an unrecognised column may be meaningful in a
    // newer export vintage and should prompt a new adapter.
    warnings.push(
      `Ignored ${mapping.unmappedHeaders.length} unrecognised column(s): ` +
        mapping.unmappedHeaders.join(', '),
    );
  }

  // Decide the decimal separator from every numeric cell in the file at once.
  const numericFields: TradeField[] = ['price', 'quantity', 'netPnl', 'runUp', 'drawdown'];
  const numericSamples: string[] = [];
  for (const row of dataRows) {
    for (const field of numericFields) {
      const value = cell(row, mapping, field);
      if (value !== undefined && !isBlank(value)) numericSamples.push(value);
    }
  }
  const { separator, evidence } = detectDecimalSeparator(numericSamples);
  if (evidence) {
    warnings.push(`Decimal separator "${separator}" inferred from value "${evidence}".`);
  }

  // ---- Group rows by trade number.

  const grouped = new Map<number, RawRow[]>();
  dataRows.forEach((row, i) => {
    const rawNumber = cell(row, mapping, 'tradeNumber');
    const rawType = cell(row, mapping, 'type');
    const rawDateTime = cell(row, mapping, 'dateTime');
    if (rawNumber === undefined || rawType === undefined || rawDateTime === undefined) {
      warnings.push(`Row ${i + 2} is missing a required cell and was skipped.`);
      return;
    }
    const tradeNumber = Number(rawNumber.replace(/[^\d]/g, ''));
    if (!Number.isInteger(tradeNumber) || tradeNumber <= 0) {
      warnings.push(`Row ${i + 2} has an unreadable trade number ${JSON.stringify(rawNumber)}.`);
      return;
    }
    const list = grouped.get(tradeNumber) ?? [];
    list.push({ tradeNumber, type: rawType, dateTime: rawDateTime, cells: row, lineNumber: i + 2 });
    grouped.set(tradeNumber, list);
  });

  // ---- Pair each group into one closed trade.

  const trades: ParsedTrade[] = [];
  const num = (row: RawRow, field: TradeField): string | null => {
    const value = cell(row.cells, mapping, field);
    if (value === undefined || isBlank(value)) return null;
    return parseNumber(value, separator);
  };

  for (const tradeNumber of [...grouped.keys()].sort((a, b) => a - b)) {
    const group = grouped.get(tradeNumber) ?? [];
    const classified = group.map((row) => ({ row, kind: classifyType(row.type) }));

    const unknown = classified.filter((c) => c.kind === null);
    for (const u of unknown) {
      warnings.push(
        `Trade ${tradeNumber}: unrecognised Type ${JSON.stringify(u.row.type)} on line ` +
          `${u.row.lineNumber}; the row was skipped.`,
      );
    }

    const entry = classified.find((c) => c.kind?.side === 'ENTRY');
    const exit = classified.find((c) => c.kind?.side === 'EXIT');

    if (!entry) {
      warnings.push(`Trade ${tradeNumber} has no entry row and was excluded.`);
      continue;
    }
    if (!exit) {
      // An open position at the end of the backtest. Excluding it keeps the
      // ledger to *closed* trades, which is what the equity curve reconstructs.
      warnings.push(
        `Trade ${tradeNumber} has no exit row; it is an open position at the end of ` +
          'the test and is excluded from the closed-trade ledger.',
      );
      continue;
    }
    if (entry.kind && exit.kind && entry.kind.direction !== exit.kind.direction) {
      warnings.push(
        `Trade ${tradeNumber} has mismatched directions (${entry.kind.direction} entry, ` +
          `${exit.kind.direction} exit) and was excluded.`,
      );
      continue;
    }

    const entryTime = parseTradingViewDateTime(entry.row.dateTime, options.timeZone, {
      ...(options.dayFirst === undefined ? {} : { dayFirst: options.dayFirst }),
    });
    const exitTime = parseTradingViewDateTime(exit.row.dateTime, options.timeZone, {
      ...(options.dayFirst === undefined ? {} : { dayFirst: options.dayFirst }),
    });
    warnings.push(...entryTime.warnings, ...exitTime.warnings);

    const entryPrice = num(entry.row, 'price');
    const exitPrice = num(exit.row, 'price');
    // Quantity may appear on either row depending on vintage.
    const quantity = num(exit.row, 'quantity') ?? num(entry.row, 'quantity');
    // P&L sits on the exit row; some exports repeat it on both.
    const netPnl = num(exit.row, 'netPnl') ?? num(entry.row, 'netPnl');

    if (entryPrice === null || exitPrice === null || quantity === null || netPnl === null) {
      warnings.push(
        `Trade ${tradeNumber} is missing a price, quantity or P&L value and was excluded.`,
      );
      continue;
    }

    trades.push({
      tradeNumber,
      direction: entry.kind?.direction ?? 'LONG',
      entryTime: entryTime.iso,
      exitTime: exitTime.iso,
      entryPrice,
      exitPrice,
      quantity,
      netPnl,
      entrySignal: cell(entry.row.cells, mapping, 'signal') ?? null,
      exitSignal: cell(exit.row.cells, mapping, 'signal') ?? null,
      runUp: num(exit.row, 'runUp'),
      drawdown: num(exit.row, 'drawdown'),
    });
  }

  if (trades.length === 0) {
    throw new TradeParseError(
      `No closed trades could be reconstructed from this export. ${warnings.join(' ')}`,
    );
  }

  warnings.push(
    'Per-trade commission is not present in a TradingView List of Trades export; ' +
      'P&L values are net of fees and gross P&L is unavailable (see ADR-0002).',
  );

  return {
    parserVersion: PARSER_VERSION,
    adapterId: mapping.adapter.id,
    delimiter,
    decimalSeparator: separator,
    currency,
    trades,
    warnings,
  };
}
