/**
 * Locale-safe numeric parsing for TradingView exports.
 *
 * CLAUDE.md 15.2: the parser must "reject ambiguous numeric formats" and
 * "never guess an unknown column's meaning". This module is where that rule
 * lives, and it is the highest-risk code in the ingestion path: a wrong
 * decimal separator does not fail loudly, it silently multiplies a P&L figure
 * by a thousand and produces a beautiful, entirely fictional equity curve.
 *
 * The approach is to decide the decimal separator ONCE for a whole file, from
 * values that can only be read one way, and to refuse the file outright if the
 * only evidence available is ambiguous.
 *
 * Worked examples of the evidence rules:
 *
 *   "1.234,56"  both separators present    -> decimal is the LAST one  (',')
 *   "1,234.56"  both separators present    -> decimal is the LAST one  ('.')
 *   "1.234.567" one separator, repeated    -> that one groups, decimal is ','
 *   "1,5"       one separator, 1 trailing  -> that one is the decimal  (',')
 *   "1,234"     one separator, 3 trailing  -> AMBIGUOUS: 1234 or 1.234
 */
import { Decimal } from 'decimal.js';

export type DecimalSeparator = '.' | ',';

export class AmbiguousNumberError extends Error {
  constructor(
    message: string,
    readonly samples: readonly string[],
  ) {
    super(message);
    this.name = 'AmbiguousNumberError';
  }
}

export class InvalidNumberError extends Error {
  constructor(readonly raw: string) {
    super(`Not a recognisable number: ${JSON.stringify(raw)}`);
    this.name = 'InvalidNumberError';
  }
}

/** What a single value tells us about the file's decimal separator. */
type Evidence =
  | { kind: 'decimal'; separator: DecimalSeparator }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

/** Strip currency symbols, spaces, percent signs and TradingView's sign glyphs. */
function stripDecoration(raw: string): string {
  return raw
    .replace(/[  \s]/g, '')
    .replace(/[+]/g, '')
    // Unicode minus and en-dash appear in some locale exports.
    .replace(/[−–]/g, '-')
    .replace(/[^0-9.,\-()]/g, '')
    // Accounting negatives: (1 234,56)
    .replace(/^\((.*)\)$/, '-$1');
}

function classify(raw: string): Evidence {
  const cleaned = stripDecoration(raw);
  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) return { kind: 'none' };

  // Both present: the rightmost separator is the decimal point, because a
  // group separator can never appear after the decimal marker.
  if (dots > 0 && commas > 0) {
    return {
      kind: 'decimal',
      separator: cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',',
    };
  }

  const sep: DecimalSeparator = dots > 0 ? '.' : ',';
  const count = dots > 0 ? dots : commas;

  // A repeated separator must be grouping, so the other one is the decimal.
  if (count > 1) return { kind: 'decimal', separator: sep === '.' ? ',' : '.' };

  const trailing = cleaned.length - cleaned.lastIndexOf(sep) - 1;
  // Exactly three trailing digits is the ambiguous case: "1,234" is either
  // one thousand two hundred and thirty-four, or one point two three four.
  if (trailing === 3) return { kind: 'ambiguous' };

  // Any other trailing length can only be a decimal fraction.
  return { kind: 'decimal', separator: sep };
}

export interface SeparatorDecision {
  readonly separator: DecimalSeparator;
  /** A value that determined the choice, for the parser warning log. */
  readonly evidence: string | null;
}

/**
 * Decide the decimal separator for a whole file.
 *
 * Throws `AmbiguousNumberError` when the file contains values that could be
 * read two ways and nothing else in the file settles it. Refusing is correct:
 * a 1000x error in net profit is far worse than a failed upload.
 */
export function detectDecimalSeparator(values: readonly string[]): SeparatorDecision {
  let decided: DecimalSeparator | null = null;
  let evidence: string | null = null;
  const conflicts: string[] = [];
  const ambiguous: string[] = [];

  for (const value of values) {
    const result = classify(value);
    if (result.kind === 'ambiguous') {
      ambiguous.push(value);
      continue;
    }
    if (result.kind === 'none') continue;

    if (decided === null) {
      decided = result.separator;
      evidence = value;
    } else if (decided !== result.separator) {
      conflicts.push(value);
    }
  }

  if (conflicts.length > 0) {
    throw new AmbiguousNumberError(
      `The file mixes decimal separators: "${evidence}" implies "${decided}" but ` +
        `"${conflicts[0]}" implies the opposite. Refusing to guess.`,
      [evidence ?? '', ...conflicts].filter(Boolean).slice(0, 5),
    );
  }

  if (decided !== null) return { separator: decided, evidence };

  if (ambiguous.length > 0) {
    throw new AmbiguousNumberError(
      `Values such as ${JSON.stringify(ambiguous[0])} could be either a thousands ` +
        'separator or a decimal point, and the file contains nothing that settles it. ' +
        'Re-export with a different locale, or supply the separator explicitly.',
      ambiguous.slice(0, 5),
    );
  }

  // No separators anywhere: integers only. The choice cannot affect any value.
  return { separator: '.', evidence: null };
}

/**
 * Parse one value using an already-decided separator.
 *
 * Returns an exact `Decimal` string; nothing here goes through a JS float,
 * so a price never loses precision on the way in (CLAUDE.md 7.4).
 */
export function parseNumber(raw: string, separator: DecimalSeparator): string {
  const cleaned = stripDecoration(raw);
  if (cleaned === '' || cleaned === '-') throw new InvalidNumberError(raw);

  const group = separator === '.' ? ',' : '.';
  const withoutGroups = cleaned.split(group).join('');
  const normalised = separator === ',' ? withoutGroups.replace(',', '.') : withoutGroups;

  if (!/^-?\d+(\.\d+)?$/.test(normalised)) throw new InvalidNumberError(raw);

  // Decimal rejects nothing that passed the regex, but constructing through it
  // guarantees the stored string is canonical.
  return new Decimal(normalised).toFixed();
}

/** True when a cell is empty or a TradingView placeholder for "no value". */
export function isBlank(raw: string): boolean {
  const t = raw.trim();
  return t === '' || t === '-' || t === '—' || t === 'N/A' || t === 'n/a';
}
