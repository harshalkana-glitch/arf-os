/**
 * Evidence kinds.
 *
 * A gate is defined by the evidence it requires (leader prompt 8), so these
 * values are what the workflow policy is written against. They are a closed
 * enum rather than free text: a transition must never pass because someone
 * attached an artefact with a plausible-looking label.
 *
 * Spec 6.2: treat missing evidence as missing, never as favourable.
 */
import { z } from 'zod';
import { EvidenceId, StrategyVersionId } from './ids.js';
import { UtcTimestamp } from './common.js';

export const EvidenceKind = z.enum([
  /** A falsifiable Idea Card (spec 7.2). */
  'IDEA_CARD',
  /** An Indicator Card with repainting analysis (spec 7.3). */
  'INDICATOR_CARD',
  /** A validated Strategy Definition Language document (spec 9). */
  'STRATEGY_DEFINITION',
  /** The frozen parameter manifest for the version. */
  'PARAMETER_MANIFEST',
  /** An immutable Pine revision with its manifest. */
  'PINE_REVISION',
  /** A successful compile plus static-check report (spec 12.1 stage A). */
  'COMPILE_REPORT',
  /** Synthetic tests proving expected signal behaviour. */
  'SYNTHETIC_TEST_REPORT',
  /** Baseline run at default parameters with realistic costs (stage B). */
  'BASELINE_BACKTEST',
  /** Recorded in-sample search with a predeclared selection rule (stage C). */
  'PARAMETER_SELECTION_RECORD',
  /** Segmented results across validation windows (stage D). */
  'SEGMENTED_BACKTEST',
  /** The single final-holdout run (stage E). */
  'FINAL_HOLDOUT_RESULT',
  /** Independent trade ledger and reconstructed equity. */
  'TRADE_LEDGER',
  /** Adversarial validation report with a rejection case (spec 7.7). */
  'VALIDATION_REPORT',
  /** Local-runner versus TradingView parity (spec 13.4). */
  'PARITY_REPORT',
  /** Dataset health for every dataset used (spec 7.10). */
  'DATA_QUALITY_REPORT',
  /** Forward paper-test evidence (spec 7.8). */
  'FORWARD_TEST_REPORT',
  /** An explicit, recorded human approval. */
  'HUMAN_APPROVAL',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * A hard-failure code.
 *
 * Spec 16.1: these override any score. A strategy with confirmed future
 * leakage cannot pass by scoring well elsewhere, so the workflow treats the
 * presence of any of these as blocking regardless of the evidence attached.
 */
export const HardFailure = z.enum([
  'FUTURE_LEAKAGE_CONFIRMED',
  'REPAINTING_INVALIDATES_SIGNALS',
  'SOURCE_MISMATCH',
  'DATA_INTEGRITY_UNRESOLVED',
  'FINAL_HOLDOUT_USED_FOR_TUNING',
  'COSTS_OMITTED',
  'TRADE_LEDGER_NOT_REPRODUCIBLE',
  'PARITY_OUT_OF_TOLERANCE',
  'EVIDENCE_MISSING_OR_ALTERED',
  'IMPOSSIBLE_FILLS',
  'SAMPLE_TOO_SMALL_FOR_CLAIM',
  'FAILED_RUNS_HIDDEN',
]);
export type HardFailure = z.infer<typeof HardFailure>;

/**
 * A stored piece of evidence attached to a strategy version.
 *
 * `supersededAt` exists because evidence is never deleted: a superseded
 * report stays readable so an old decision remains auditable against exactly
 * what was known when it was made.
 */
export const EvidenceItem = z.object({
  id: EvidenceId,
  strategyVersionId: StrategyVersionId,
  kind: EvidenceKind,
  /** Object-store key or table reference for the underlying artefact. */
  reference: z.string().min(1),
  createdAt: UtcTimestamp,
  supersededAt: UtcTimestamp.nullable().default(null),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
