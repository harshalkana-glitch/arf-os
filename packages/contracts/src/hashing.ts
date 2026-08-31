/**
 * Canonical hashing for research artefacts.
 *
 * Spec 3.5 requires every result to be reproducible from, among other things,
 * a definition hash, a source hash and a manifest hash. Those hashes are only
 * meaningful if the same logical document always serialises to the same bytes,
 * so this module defines one canonical form and uses it everywhere.
 *
 * Canonical form (a narrowed JCS, RFC 8785):
 *   - object keys sorted by UTF-16 code unit,
 *   - no insignificant whitespace,
 *   - `undefined`-valued properties omitted,
 *   - arrays keep their order, since order is meaningful in an SDL,
 *   - non-finite numbers rejected rather than coerced to null.
 *
 * A document that round-trips through the database must hash identically, so
 * nothing here may depend on key insertion order or on `JSON.stringify`
 * defaults.
 */
import { createHash } from 'node:crypto';

export class CanonicalisationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || '<root>'})`);
    this.name = 'CanonicalisationError';
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonicalise(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number': {
      if (!Number.isFinite(value)) {
        // JSON.stringify silently turns these into null, which would make two
        // materially different documents hash the same.
        throw new CanonicalisationError(`Non-finite number cannot be canonicalised`, path);
      }
      // Negative zero and positive zero are the same value; normalise so they
      // cannot produce different hashes.
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }

    case 'string':
      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => canonicalise(item, `${path}[${i}]`));
        return `[${items.join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        // An omitted key and a key set to undefined are the same document.
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = entries.map(
        ([k, v]) => `${JSON.stringify(k)}:${canonicalise(v, path ? `${path}.${k}` : k)}`,
      );
      return `{${parts.join(',')}}`;
    }

    default:
      // functions, symbols, bigint, undefined at a non-object position
      throw new CanonicalisationError(`Value of type ${typeof value} is not JSON`, path);
  }
}

/** Serialise a value to its canonical JSON string. */
export function canonicalJson(value: unknown): string {
  return canonicalise(value, '');
}

/** Lowercase hex SHA-256 of the canonical JSON form of `value`. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * SHA-256 of raw text, used for Pine source and uploaded report files.
 *
 * Line endings are normalised to LF first: a Windows checkout and a Linux CI
 * runner must agree on the source hash of the same revision, and TradingView
 * returns CRLF in exported files.
 */
export function sourceHash(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/** SHA-256 of arbitrary bytes, used for raw upload checksums. */
export function bytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
