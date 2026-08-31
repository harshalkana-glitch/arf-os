/**
 * Deterministic number formatting.
 *
 * `toLocaleString()` with no locale uses the *environment's* locale, which
 * differs between the Node server and the browser — that mismatch is a React
 * hydration error, and more importantly it means two reviewers can see the
 * same figure written differently.
 *
 * Research output has to read identically everywhere, so the locale is pinned
 * rather than inherited.
 */
const LOCALE = 'en-US';

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return value.toLocaleString(LOCALE, options);
}

export function formatMoney(value: number, currency: string): string {
  return `${value.toLocaleString(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}
