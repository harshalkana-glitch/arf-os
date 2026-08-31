/**
 * Primitive value contracts shared by every schema.
 *
 * CLAUDE.md 7.4: money never uses binary floating point. Authoritative
 * monetary values cross boundaries as decimal *strings* and are stored in
 * numeric database columns. Only display code converts to `number`.
 *
 * CLAUDE.md 7.4 also requires percentage semantics to be unambiguous, so
 * ratios (0.05) and percents (5) are distinct types with distinct names.
 */
import { z } from 'zod';

/** Semantic version of a contract, e.g. "1.0.0". */
export const SchemaVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Expected a semantic version such as 1.0.0');
export type SchemaVersion = z.infer<typeof SchemaVersion>;

/** Lowercase hex SHA-256 digest. */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex sha256 digest');
export type Sha256 = z.infer<typeof Sha256>;

/**
 * An ISO-8601 instant in UTC.
 *
 * CLAUDE.md 7.3: timestamps are stored in UTC and cross API boundaries as
 * ISO-8601. A market-session timezone is carried separately and never
 * inferred from a timestamp.
 */
export const UtcTimestamp = z
  .string()
  .datetime({ offset: true })
  .refine((v) => v.endsWith('Z') || /[+-]00:00$/.test(v), {
    message: 'Timestamp must be expressed in UTC',
  });
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/** Calendar date with no time component, e.g. "2026-08-04". */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

/** IANA timezone identifier, e.g. "Etc/UTC" or "America/New_York". */
export const Timezone = z
  .string()
  .min(1)
  .refine(
    (v) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown IANA timezone identifier' },
  );
export type Timezone = z.infer<typeof Timezone>;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * An exact decimal carried as a string.
 *
 * Accepts a JS number only when it is finite and safely integral, so that a
 * caller cannot silently introduce binary rounding error by passing 0.1 + 0.2.
 */
export const Decimal = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Decimal must be finite' });
        return z.NEVER;
      }
      if (!Number.isSafeInteger(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Pass non-integer decimals as strings; a JS number cannot represent them exactly',
        });
        return z.NEVER;
      }
      return String(v);
    }
    const trimmed = v.trim();
    if (!DECIMAL_RE.test(trimmed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a decimal value: ${v}` });
      return z.NEVER;
    }
    return trimmed;
  });
export type Decimal = z.infer<typeof Decimal>;

/** A monetary amount. Always paired with a currency at the record level. */
export const Money = Decimal;
export type Money = z.infer<typeof Money>;

/** ISO 4217 currency code, or a crypto ticker such as USDT. */
export const Currency = z.string().regex(/^[A-Z]{3,10}$/, 'Expected a currency code');
export type Currency = z.infer<typeof Currency>;

/**
 * A proportion expressed as a fraction of one: 0.05 means five percent.
 * Named `Ratio` so it can never be confused with `Percent`.
 */
export const Ratio = z.number().finite();
export type Ratio = z.infer<typeof Ratio>;

/** A percentage expressed out of one hundred: 5 means five percent. */
export const Percent = z.number().finite();
export type Percent = z.infer<typeof Percent>;

/** Units a metric value can carry. Spec 14.5 requires an explicit unit. */
export const MetricUnit = z.enum([
  'CURRENCY',
  'PERCENT',
  'RATIO',
  'COUNT',
  'DAYS',
  'HOURS',
  'BARS',
  'SECONDS',
]);
export type MetricUnit = z.infer<typeof MetricUnit>;

/** Timeframe as TradingView expresses it: "60" = 60 minutes, "1D" = daily. */
export const Timeframe = z
  .string()
  .regex(/^(\d+|\d+[SDWM])$/, 'Expected a TradingView timeframe such as 60, 240, 1D');
export type Timeframe = z.infer<typeof Timeframe>;

/** Fully qualified symbol including venue, e.g. "BYBIT:BTCUSDT.P". */
export const SymbolCode = z
  .string()
  .regex(/^[A-Z0-9_]+:[A-Z0-9._-]+$/i, 'Expected VENUE:TICKER');
export type SymbolCode = z.infer<typeof SymbolCode>;

/** RFC 9457 problem details. CLAUDE.md 7.5. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  traceId: z.string().optional(),
  validationErrors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Who took an action, for audit and handoff records. */
export const Actor = z.object({
  type: z.enum(['HUMAN', 'AGENT', 'SERVICE']),
  id: z.string().min(1),
  displayName: z.string().optional(),
  /** Prompt content hash, when the actor is an agent. */
  promptVersion: Sha256.optional(),
});
export type Actor = z.infer<typeof Actor>;
