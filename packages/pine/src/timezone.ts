/**
 * Wall-clock to UTC conversion for TradingView exports.
 *
 * A TradingView "List of Trades" export gives a Date/Time like
 * "2026-03-08 02:30" with NO timezone. It is wall-clock time in the chart's
 * timezone. Treating it as UTC, or letting `new Date(string)` interpret it in
 * the server's local zone, silently shifts every trade by hours — which then
 * lands them in the wrong backtest segment and quietly corrupts an
 * out-of-sample boundary.
 *
 * CLAUDE.md 7.3 forbids `Date` arithmetic for market windows without a
 * timezone-aware library or a *tested helper*. This is that helper, with the
 * daylight-saving boundary tests the same section requires.
 *
 * Two edge cases exist at every DST transition and both are reported rather
 * than silently resolved:
 *
 *   - Spring forward: 02:30 does not exist on the transition day. A file
 *     containing it is either mislabelled or came from a different zone.
 *   - Fall back: 01:30 occurs twice. The earlier (daylight) instant is
 *     chosen by convention, and a warning records that the file could not
 *     say which was meant.
 */

export interface WallClock {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface ZonedConversion {
  /** ISO-8601 instant in UTC. */
  readonly iso: string;
  readonly warnings: readonly string[];
}

export class InvalidTimezoneError extends Error {
  constructor(timeZone: string) {
    super(`Unknown IANA timezone: ${timeZone}`);
    this.name = 'InvalidTimezoneError';
  }
}

export class NonexistentLocalTimeError extends Error {
  constructor(readonly wall: string, readonly timeZone: string) {
    super(
      `Local time ${wall} does not exist in ${timeZone}; it falls in a ` +
        'daylight-saving gap. The export may be labelled with the wrong timezone.',
    );
    this.name = 'NonexistentLocalTimeError';
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new InvalidTimezoneError(timeZone);
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** The wall-clock time `timeZone` shows at a given UTC instant. */
function wallClockAt(utcMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // Intl renders midnight as hour 24 in some engines; normalise to 0.
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function asUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The offset, in milliseconds, that `timeZone` is ahead of UTC at `utcMs`.
 */
function offsetAt(utcMs: number, timeZone: string): number {
  return asUtcMs(wallClockAt(utcMs, timeZone)) - utcMs;
}

function formatWall(w: WallClock): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}:${p(w.second)}`;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant.
 *
 * Uses two offset probes rather than one: near a transition the offset at the
 * naive guess differs from the offset at the true instant, and a single probe
 * lands an hour out.
 */
export function zonedWallTimeToUtc(wall: WallClock, timeZone: string): ZonedConversion {
  const warnings: string[] = [];
  const naive = asUtcMs(wall);

  // First probe: offset as it stands at the naive instant.
  const firstOffset = offsetAt(naive, timeZone);
  let candidate = naive - firstOffset;

  // Second probe: re-evaluate at the corrected instant. If the offset changed
  // we crossed a transition, and the second value is the correct one.
  const secondOffset = offsetAt(candidate, timeZone);
  if (secondOffset !== firstOffset) {
    candidate = naive - secondOffset;
  }

  // Verify by round-tripping. If the zone does not show the wall time we asked
  // for, that local time does not exist.
  if (!sameWallClock(wallClockAt(candidate, timeZone), wall)) {
    throw new NonexistentLocalTimeError(formatWall(wall), timeZone);
  }

  /**
   * Ambiguity check: during a fall-back the same wall clock occurs at two
   * instants an hour apart. Which side of the pair the offset probes landed
   * on depends on the zone, so both directions are checked, and the earlier
   * instant — still on daylight time — is chosen by convention.
   */
  const ambiguous = (candidateMs: number): boolean =>
    sameWallClock(wallClockAt(candidateMs, timeZone), wall);

  const anHourEarlier = candidate - 3_600_000;
  const anHourLater = candidate + 3_600_000;
  let isAmbiguous = false;

  if (ambiguous(anHourEarlier)) {
    candidate = anHourEarlier;
    isAmbiguous = true;
  } else if (ambiguous(anHourLater)) {
    // `candidate` is already the earlier of the two; keep it.
    isAmbiguous = true;
  }

  if (isAmbiguous) {
    warnings.push(
      `Local time ${formatWall(wall)} occurs twice in ${timeZone} because of a ` +
        'daylight-saving transition. The earlier of the two instants was used; ' +
        'the export does not say which was meant.',
    );
  }

  return { iso: new Date(candidate).toISOString(), warnings };
}

/**
 * Parse a TradingView Date/Time cell.
 *
 * Accepts the formats TradingView emits across locales:
 *   2026-03-08 14:30:00
 *   2026-03-08 14:30
 *   2026-03-08T14:30:00
 *   08/03/2026 14:30      (day-first; requires dayFirst: true)
 *
 * A bare date with no time is rejected rather than assumed to be midnight:
 * assuming would place the trade at a segment boundary it may not belong to.
 */
export function parseTradingViewDateTime(
  raw: string,
  timeZone: string,
  options: { readonly dayFirst?: boolean } = {},
): ZonedConversion {
  const text = raw.trim().replace('T', ' ');

  const iso = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);

  let wall: WallClock;
  if (iso) {
    wall = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4]),
      minute: Number(iso[5]),
      second: Number(iso[6] ?? 0),
    };
  } else if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    // With dayFirst unset, a value above 12 in the first position is the only
    // safe signal that this is day-first; otherwise the caller must say.
    const dayFirst = options.dayFirst ?? a > 12;
    wall = {
      year: Number(slashed[3]),
      month: dayFirst ? b : a,
      day: dayFirst ? a : b,
      hour: Number(slashed[4]),
      minute: Number(slashed[5]),
      second: Number(slashed[6] ?? 0),
    };
    if (options.dayFirst === undefined && a <= 12 && b <= 12) {
      // Genuinely ambiguous: 03/08 is 3 August or 8 March depending on locale.
      throw new Error(
        `Date "${raw}" is ambiguous: both components are 12 or below, so day-first ` +
          'and month-first cannot be distinguished. Supply the export locale.',
      );
    }
  } else {
    throw new Error(`Unrecognised Date/Time format: ${JSON.stringify(raw)}`);
  }

  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) {
    throw new Error(`Date "${raw}" has an out-of-range component.`);
  }

  return zonedWallTimeToUtc(wall, timeZone);
}
