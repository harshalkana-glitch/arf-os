/**
 * Versioned column adapters for the TradingView "List of Trades" export.
 *
 * CLAUDE.md 15.2: columns are mapped through *versioned* adapters and an
 * unknown required column is rejected rather than guessed. Each adapter
 * declares the header aliases it recognises; a header that matches no alias
 * is reported by name so a new export vintage produces a clear failure and a
 * new adapter, not a silently mis-mapped column.
 *
 * A note on what this export does and does not contain.
 * TradingView's List of Trades reports **net** profit per trade — after
 * commission — and carries no per-trade commission column. Gross P&L and fees
 * are therefore genuinely unavailable from this file, and this adapter leaves
 * them null rather than inventing them. See docs/adr/0002.
 */

/** A logical field the parser needs, independent of export vintage. */
export type TradeField =
  | 'tradeNumber'
  | 'type'
  | 'dateTime'
  | 'signal'
  | 'price'
  | 'quantity'
  | 'netPnl'
  | 'netPnlPercent'
  | 'runUp'
  | 'drawdown'
  | 'cumulativePnl';

export interface ColumnAdapter {
  readonly id: string;
  readonly description: string;
  /**
   * Lower-cased header aliases per field. Matching is on a normalised header
   * (lower case, collapsed whitespace, currency suffix removed), so
   * "Profit USDT" and "Profit USD" resolve to the same field without the
   * adapter enumerating every quote currency.
   */
  readonly aliases: Readonly<Record<TradeField, readonly string[]>>;
  readonly required: readonly TradeField[];
}

/**
 * Normalise a header cell for matching.
 *
 * Strips a trailing currency code, because TradingView suffixes money columns
 * with the account currency ("Net P&L USDT"). The currency itself is captured
 * separately from the header rather than being thrown away.
 */
export function normaliseHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(usd|usdt|usdc|eur|gbp|jpy|btc|eth)$/i, '')
    .replace(/\s+%$/, ' %')
    .trim();
}

/** Extract the account currency from a money column header, if present. */
export function currencyFromHeaders(headers: readonly string[]): string | null {
  for (const header of headers) {
    const match = /\b(usdt|usdc|usd|eur|gbp|jpy|btc|eth)\b\s*$/i.exec(header.trim());
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

/**
 * Modern export (2023 onwards): "Net P&L", "Position size".
 */
export const LIST_OF_TRADES_V2: ColumnAdapter = {
  id: 'tradingview.list-of-trades.v2',
  description: 'TradingView List of Trades, 2023 onwards (Net P&L / Position size)',
  aliases: {
    tradeNumber: ['trade #', 'trade#', 'trade number'],
    type: ['type'],
    dateTime: ['date/time', 'date time', 'datetime'],
    signal: ['signal'],
    price: ['price'],
    quantity: ['position size (qty)', 'position size', 'quantity', 'contracts'],
    netPnl: ['net p&l', 'net pnl', 'p&l'],
    netPnlPercent: ['net p&l %', 'net pnl %', 'p&l %'],
    runUp: ['run-up', 'run up'],
    drawdown: ['drawdown'],
    cumulativePnl: ['cumulative p&l', 'cumulative pnl'],
  },
  required: ['tradeNumber', 'type', 'dateTime', 'price', 'quantity', 'netPnl'],
};

/**
 * Legacy export: "Profit", "Contracts", "Cum. Profit".
 */
export const LIST_OF_TRADES_V1: ColumnAdapter = {
  id: 'tradingview.list-of-trades.v1',
  description: 'TradingView List of Trades, legacy (Profit / Contracts)',
  aliases: {
    tradeNumber: ['trade #', 'trade#', 'trade number'],
    type: ['type'],
    dateTime: ['date/time', 'date time', 'datetime'],
    signal: ['signal'],
    price: ['price'],
    quantity: ['contracts', 'quantity'],
    netPnl: ['profit'],
    netPnlPercent: ['profit %'],
    runUp: ['run-up', 'run up'],
    drawdown: ['drawdown'],
    cumulativePnl: ['cum. profit', 'cumulative profit'],
  },
  required: ['tradeNumber', 'type', 'dateTime', 'price', 'quantity', 'netPnl'],
};

export const LIST_OF_TRADES_ADAPTERS: readonly ColumnAdapter[] = [
  LIST_OF_TRADES_V2,
  LIST_OF_TRADES_V1,
];

export interface ColumnMapping {
  readonly adapter: ColumnAdapter;
  /** Field -> column index. */
  readonly indices: Readonly<Partial<Record<TradeField, number>>>;
  /** Headers that matched no known field, kept for the warning log. */
  readonly unmappedHeaders: readonly string[];
}

export class UnknownColumnsError extends Error {
  constructor(
    readonly missing: readonly TradeField[],
    readonly headers: readonly string[],
  ) {
    super(
      `This export is missing required columns (${missing.join(', ')}). ` +
        `Headers found: ${headers.join(' | ')}. ` +
        'A new export format needs a new versioned adapter; the parser will not guess.',
    );
    this.name = 'UnknownColumnsError';
  }
}

/**
 * Resolve headers against the first adapter that satisfies every required
 * field. Adapters are tried newest first, so a modern export is never matched
 * by a legacy adapter that happens to share a column name.
 */
export function resolveColumns(headers: readonly string[]): ColumnMapping {
  const normalised = headers.map(normaliseHeader);
  let bestMissing: readonly TradeField[] = [];

  for (const adapter of LIST_OF_TRADES_ADAPTERS) {
    const indices: Partial<Record<TradeField, number>> = {};
    const matchedColumns = new Set<number>();

    for (const [field, aliases] of Object.entries(adapter.aliases) as Array<
      [TradeField, readonly string[]]
    >) {
      const index = normalised.findIndex(
        (h, i) => !matchedColumns.has(i) && aliases.some((alias) => h === alias),
      );
      if (index >= 0) {
        indices[field] = index;
        matchedColumns.add(index);
      }
    }

    const missing = adapter.required.filter((field) => indices[field] === undefined);
    if (missing.length === 0) {
      const unmapped = headers.filter((_, i) => !matchedColumns.has(i));
      return { adapter, indices, unmappedHeaders: unmapped };
    }
    if (bestMissing.length === 0 || missing.length < bestMissing.length) {
      bestMissing = missing;
    }
  }

  throw new UnknownColumnsError(bestMissing, headers);
}
