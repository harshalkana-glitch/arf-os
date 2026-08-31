import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseListOfTrades, TradeParseError } from './parse-trades.js';
import { UnknownColumnsError } from './adapters/list-of-trades.js';
import { AmbiguousNumberError, detectDecimalSeparator, parseNumber } from './numeric.js';
import { detectDelimiter, parseCsv, parseCsvAuto } from './csv.js';
import {
  NonexistentLocalTimeError,
  parseTradingViewDateTime,
  zonedWallTimeToUtc,
} from './timezone.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

describe('decimal separator detection', () => {
  it('reads the last separator as decimal when both are present', () => {
    expect(detectDecimalSeparator(['1,234.56']).separator).toBe('.');
    expect(detectDecimalSeparator(['1.234,56']).separator).toBe(',');
  });

  it('treats a repeated separator as grouping', () => {
    // "1.234.567" can only be grouped by '.', so ',' must be the decimal.
    expect(detectDecimalSeparator(['1.234.567']).separator).toBe(',');
  });

  it('reads a non-three-digit tail as a decimal fraction', () => {
    expect(detectDecimalSeparator(['1,5']).separator).toBe(',');
    expect(detectDecimalSeparator(['0.75']).separator).toBe('.');
  });

  it('refuses to guess when the only evidence is ambiguous', () => {
    // "1,234" is either 1234 or 1.234 and nothing in the file settles it.
    // Guessing here would silently scale a P&L figure by 1000.
    expect(() => detectDecimalSeparator(['1,234'])).toThrow(AmbiguousNumberError);
  });

  it('resolves an ambiguous value when the file contains unambiguous evidence', () => {
    expect(detectDecimalSeparator(['1,234', '9,5']).separator).toBe(',');
    expect(detectDecimalSeparator(['1,234', '1,234.56']).separator).toBe('.');
  });

  it('refuses a file that mixes both conventions', () => {
    expect(() => detectDecimalSeparator(['1.234,56', '1,234.56'])).toThrow(AmbiguousNumberError);
  });

  it('accepts a file with no separators at all', () => {
    expect(detectDecimalSeparator(['100', '-25']).separator).toBe('.');
  });
});

describe('number parsing', () => {
  it('parses both conventions to the same exact value', () => {
    expect(parseNumber('1,234.56', '.')).toBe('1234.56');
    expect(parseNumber('1.234,56', ',')).toBe('1234.56');
  });

  it('keeps precision that a float would lose', () => {
    expect(parseNumber('0.1', '.')).toBe('0.1');
    expect(parseNumber('12345678.87654321', '.')).toBe('12345678.87654321');
  });

  it('handles negatives, including accounting parentheses', () => {
    expect(parseNumber('-51.50', '.')).toBe('-51.5');
    expect(parseNumber('(51.50)', '.')).toBe('-51.5');
    expect(parseNumber('−51.50', '.')).toBe('-51.5'); // unicode minus
  });

  it('strips currency decoration', () => {
    expect(parseNumber('$1,250.50', '.')).toBe('1250.5');
    expect(parseNumber('1 250,50 €', ',')).toBe('1250.5');
  });

  it('rejects a value that is not a number', () => {
    expect(() => parseNumber('n/a', '.')).toThrow();
    expect(() => parseNumber('1.2.3', '.')).toThrow();
  });
});

describe('csv tokenizing', () => {
  it('detects a semicolon delimiter from the header', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });

  it('ignores delimiters inside quoted fields when detecting', () => {
    // The header is used precisely because it holds no decimal commas.
    expect(detectDelimiter('"a,b";c;d')).toBe(';');
  });

  it('does not split on a delimiter inside a quoted field', () => {
    const rows = parseCsv('a,b\n"1,234",5\n', ',');
    expect(rows[1]).toEqual(['1,234', '5']);
  });

  it('handles escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n', ',');
    expect(rows[1]?.[0]).toBe('say "hi"');
  });

  it('strips a BOM', () => {
    const { rows } = parseCsvAuto('﻿a,b\n1,2\n');
    expect(rows[0]?.[0]).toBe('a');
  });

  it('rejects a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a,b\n"unterminated,2\n', ',')).toThrow(/inside a quoted field/);
  });
});

describe('timezone conversion', () => {
  it('converts a wall clock in a named zone to UTC', () => {
    // 09:00 in New York in January is UTC-5.
    const { iso } = zonedWallTimeToUtc(
      { year: 2026, month: 1, day: 5, hour: 9, minute: 0, second: 0 },
      'America/New_York',
    );
    expect(iso).toBe('2026-01-05T14:00:00.000Z');
  });

  it('applies the correct offset on the other side of a DST change', () => {
    // The same wall clock in July is UTC-4, an hour different from January.
    const { iso } = zonedWallTimeToUtc(
      { year: 2026, month: 7, day: 5, hour: 9, minute: 0, second: 0 },
      'America/New_York',
    );
    expect(iso).toBe('2026-07-05T13:00:00.000Z');
  });

  it('rejects a local time that does not exist in the spring-forward gap', () => {
    // 02:30 on the US spring-forward date never occurs; accepting it would
    // silently place the trade an hour from where the file claims.
    expect(() =>
      zonedWallTimeToUtc(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
        'America/New_York',
      ),
    ).toThrow(NonexistentLocalTimeError);
  });

  it('warns when a local time occurs twice at the fall-back', () => {
    // 01:30 happens twice on the US fall-back date. The export cannot say
    // which, so the earlier instant is used and the ambiguity is recorded.
    const result = zonedWallTimeToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      'America/New_York',
    );
    expect(result.warnings.some((w) => w.includes('occurs twice'))).toBe(true);
    expect(result.iso).toBe('2026-11-01T05:30:00.000Z'); // EDT, the earlier one
  });

  it('treats UTC exports as UTC', () => {
    const { iso } = parseTradingViewDateTime('2026-01-05 09:00', 'Etc/UTC');
    expect(iso).toBe('2026-01-05T09:00:00.000Z');
  });

  it('rejects an unparseable date', () => {
    expect(() => parseTradingViewDateTime('not a date', 'Etc/UTC')).toThrow();
  });

  it('refuses a slash date whose order cannot be determined', () => {
    // 03/08/2026 is 3 August or 8 March depending on locale.
    expect(() => parseTradingViewDateTime('03/08/2026 10:00', 'Etc/UTC')).toThrow(/ambiguous/);
  });

  it('accepts a slash date when the locale is stated', () => {
    const { iso } = parseTradingViewDateTime('03/08/2026 10:00', 'Etc/UTC', { dayFirst: true });
    expect(iso).toBe('2026-08-03T10:00:00.000Z');
  });
});

describe('parsing the modern US export', () => {
  const result = parseListOfTrades(fixture('list-of-trades.v2.us.csv'), { timeZone: 'Etc/UTC' });

  it('selects the v2 adapter', () => {
    expect(result.adapterId).toBe('tradingview.list-of-trades.v2');
    expect(result.delimiter).toBe(',');
    expect(result.decimalSeparator).toBe('.');
    expect(result.currency).toBe('USD');
  });

  it('pairs entry and exit rows into closed trades', () => {
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]).toMatchObject({
      tradeNumber: 1,
      direction: 'LONG',
      entryPrice: '1250.5',
      exitPrice: '1310.25',
      quantity: '2',
      netPnl: '119.5',
      entryTime: '2026-01-05T09:00:00.000Z',
      exitTime: '2026-01-05T15:00:00.000Z',
    });
    expect(result.trades[1]).toMatchObject({ direction: 'SHORT', netPnl: '-51.5' });
  });

  it('excludes an open position and says why', () => {
    // Trade 3 has an entry and no exit: it is unrealised, and including it
    // would put an open position into a realised equity curve.
    expect(result.trades.some((t) => t.tradeNumber === 3)).toBe(false);
    expect(result.warnings.some((w) => w.includes('Trade 3') && w.includes('open position'))).toBe(
      true,
    );
  });

  it('records that per-trade fees are unavailable', () => {
    expect(result.warnings.some((w) => w.includes('commission is not present'))).toBe(true);
  });
});

describe('parsing the legacy European export', () => {
  const result = parseListOfTrades(fixture('list-of-trades.v1.eu.csv'), {
    timeZone: 'Europe/Berlin',
    dayFirst: true,
  });

  it('selects the legacy adapter and the European conventions', () => {
    expect(result.adapterId).toBe('tradingview.list-of-trades.v1');
    expect(result.delimiter).toBe(';');
    expect(result.decimalSeparator).toBe(',');
    expect(result.currency).toBe('EUR');
  });

  it('produces the same numeric values as the US export', () => {
    // The two fixtures describe the same trades in different locales. If the
    // locale handling is wrong, these numbers diverge by a factor of 1000.
    expect(result.trades[0]).toMatchObject({
      tradeNumber: 1,
      direction: 'LONG',
      entryPrice: '1250.5',
      exitPrice: '1310.25',
      netPnl: '119.5',
    });
    expect(result.trades[1]?.netPnl).toBe('-51.5');
  });

  it('converts day-first dates in a non-UTC zone', () => {
    // 05/01/2026 09:00 Berlin in January is UTC+1.
    expect(result.trades[0]?.entryTime).toBe('2026-01-05T08:00:00.000Z');
  });
});

describe('refusing rather than guessing', () => {
  it('rejects an export whose required columns are unknown', () => {
    const csv = 'Some,Unknown,Header\n1,2,3\n';
    expect(() => parseListOfTrades(csv, { timeZone: 'Etc/UTC' })).toThrow(UnknownColumnsError);
  });

  it('names the missing fields and the headers it saw', () => {
    const csv = 'Trade #,Type,Date/Time\n1,Entry long,2026-01-05 09:00\n';
    try {
      parseListOfTrades(csv, { timeZone: 'Etc/UTC' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownColumnsError);
      expect((error as UnknownColumnsError).message).toContain('will not guess');
      expect((error as UnknownColumnsError).missing).toContain('price');
    }
  });

  it('warns about an unrecognised extra column instead of ignoring it silently', () => {
    const csv =
      'Trade #,Type,Date/Time,Price USD,Position size (qty),Net P&L USD,Mystery Column\n' +
      '1,Entry long,2026-01-05 09:00,100,1,,x\n' +
      '1,Exit long,2026-01-05 10:00,110,1,10,y\n';
    const result = parseListOfTrades(csv, { timeZone: 'Etc/UTC' });
    expect(result.warnings.some((w) => w.includes('Mystery Column'))).toBe(true);
  });

  it('throws when no closed trade can be reconstructed', () => {
    const csv =
      'Trade #,Type,Date/Time,Price USD,Position size (qty),Net P&L USD\n' +
      '1,Entry long,2026-01-05 09:00,100,1,\n';
    expect(() => parseListOfTrades(csv, { timeZone: 'Etc/UTC' })).toThrow(TradeParseError);
  });

  it('excludes a trade whose entry and exit directions disagree', () => {
    const csv =
      'Trade #,Type,Date/Time,Price USD,Position size (qty),Net P&L USD\n' +
      '1,Entry long,2026-01-05 09:00,100,1,\n' +
      '1,Exit short,2026-01-05 10:00,110,1,10\n' +
      '2,Entry long,2026-01-06 09:00,100,1,\n' +
      '2,Exit long,2026-01-06 10:00,110,1,10\n';
    const result = parseListOfTrades(csv, { timeZone: 'Etc/UTC' });
    expect(result.trades).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('mismatched directions'))).toBe(true);
  });
});
