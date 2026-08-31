/**
 * Response serialisation helpers.
 *
 * CLAUDE.md 7.3 requires ISO-8601 at API boundaries. PostgreSQL returns a
 * `timestamptz` in its own text form — "2026-01-05 08:00:00+00" — which uses a
 * space instead of "T" and a two-digit offset. That is the same instant, but
 * it is not ISO-8601, and a client parsing it with a strict parser will
 * either reject it or, worse, fall back to a lenient path that guesses.
 *
 * Every timestamp leaving the API goes through `toIso`.
 */

/**
 * Convert a PostgreSQL timestamptz string to a UTC ISO-8601 instant.
 *
 * Throws rather than returning the input unchanged on a value it cannot
 * parse: emitting an unparseable timestamp as though it were valid is the
 * failure mode this function exists to prevent.
 */
export function toIso(value: string): string;
export function toIso(value: string | null): string | null;
export function toIso(value: string | null): string | null {
  if (value === null) return null;

  // Already ISO with a Z or a full offset.
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) throw new Error(`Unparseable timestamp: ${value}`);
    return asDate.toISOString();
  }

  // PostgreSQL form: space separator, and an offset like "+00" that needs
  // widening to "+00:00" before Date will reliably accept it.
  let normalised = value.replace(' ', 'T');
  normalised = normalised.replace(/([+-]\d{2})$/, '$1:00');
  // A bare timestamp with no zone is UTC by our own storage convention.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(normalised)) normalised += 'Z';

  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unparseable timestamp from the database: ${value}`);
  }
  return date.toISOString();
}
