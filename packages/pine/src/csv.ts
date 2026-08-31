/**
 * RFC 4180 CSV tokenizer with delimiter detection.
 *
 * A hand-rolled parser rather than a split on the delimiter, because
 * TradingView quotes any field containing its delimiter — and a European
 * export uses ';' as the delimiter while ',' appears *inside* numbers. A
 * naive split silently shifts every column after the first quoted field.
 */

export type Delimiter = ',' | ';' | '\t' | '|';

const CANDIDATES: readonly Delimiter[] = [',', ';', '\t', '|'];

export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'CsvParseError';
  }
}

/**
 * Count occurrences of `delimiter` in `line`, ignoring quoted regions.
 *
 * Counting inside quotes is what makes naive detection pick ',' for a
 * semicolon-delimited European file full of "1.234,56" values.
 */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1; // escaped quote
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) count += 1;
  }
  return count;
}

/**
 * Detect the delimiter from the header line.
 *
 * The header is used rather than the whole file because it is the one line
 * guaranteed to contain no numeric values, so a decimal comma cannot be
 * mistaken for a delimiter.
 */
export function detectDelimiter(headerLine: string): Delimiter {
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = countOutsideQuotes(headerLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  if (bestCount === 0) {
    throw new CsvParseError('No delimiter found in the header row', 1);
  }
  return best;
}

/** Strip a UTF-8 BOM, which Excel-saved exports frequently carry. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Tokenize CSV text into rows of raw string cells.
 *
 * Handles quoted fields, escaped quotes, and embedded newlines. Values are
 * returned exactly as written apart from quote unwrapping: normalisation is
 * the adapter's job, and the raw text is preserved for the audit trail.
 */
export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let fieldWasQuoted = false;

  const endField = (): void => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const endRow = (): void => {
    endField();
    // Skip rows that are entirely empty, which trail most exports.
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (field.trim() !== '') {
        throw new CsvParseError('Unexpected quote in the middle of an unquoted field', line);
      }
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
      continue;
    }

    if (ch === delimiter) {
      endField();
      continue;
    }

    if (ch === '\r') continue; // CRLF: handled at the \n

    if (ch === '\n') {
      endRow();
      line += 1;
      continue;
    }

    field += ch;
  }

  if (inQuotes) {
    throw new CsvParseError('File ended inside a quoted field', line);
  }
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** Tokenize, detecting the delimiter from the first non-empty line. */
export function parseCsvAuto(text: string): { rows: string[][]; delimiter: Delimiter } {
  const clean = stripBom(text);
  const firstLine = clean.split(/\r?\n/).find((l) => l.trim() !== '');
  if (firstLine === undefined) {
    throw new CsvParseError('File is empty', 1);
  }
  const delimiter = detectDelimiter(firstLine);
  return { rows: parseCsv(clean, delimiter), delimiter };
}
