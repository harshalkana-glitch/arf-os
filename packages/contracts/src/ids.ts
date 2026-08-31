/**
 * Branded identifier types.
 *
 * CLAUDE.md 7.2 requires domain IDs to be branded so that an ID for one
 * aggregate cannot be passed where another is expected. All IDs are
 * UUIDv7-compatible strings; ordering by ID therefore approximates
 * ordering by creation time.
 */
import { z } from 'zod';

/** RFC 9562 UUID, any version. Version 7 is used for all new records. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

function idSchema<B extends string>(name: B) {
  return z
    .string()
    .regex(UUID_RE, `Invalid ${name}: expected a UUID`)
    .transform((v) => v.toLowerCase() as Brand<string, B>);
}

export const OrganisationId = idSchema('OrganisationId');
export const UserId = idSchema('UserId');
export const CampaignId = idSchema('CampaignId');
export const ResearchTaskId = idSchema('ResearchTaskId');
export const AgentRunId = idSchema('AgentRunId');
export const HandoffId = idSchema('HandoffId');
export const IdeaCardId = idSchema('IdeaCardId');
export const IndicatorCardId = idSchema('IndicatorCardId');
export const StrategyId = idSchema('StrategyId');
export const StrategyVersionId = idSchema('StrategyVersionId');
export const PineRevisionId = idSchema('PineRevisionId');
export const ArtefactId = idSchema('ArtefactId');
export const EvidenceId = idSchema('EvidenceId');
export const DatasetVersionId = idSchema('DatasetVersionId');
export const SymbolId = idSchema('SymbolId');
export const SegmentId = idSchema('SegmentId');
export const ParameterSetId = idSchema('ParameterSetId');
export const BacktestPlanId = idSchema('BacktestPlanId');
export const BacktestRunId = idSchema('BacktestRunId');
export const VerificationId = idSchema('VerificationId');
export const ReportUploadId = idSchema('ReportUploadId');
export const ParityReportId = idSchema('ParityReportId');
export const ValidationReportId = idSchema('ValidationReportId');
export const DeploymentId = idSchema('DeploymentId');
export const SignalEventId = idSchema('SignalEventId');
export const DecisionId = idSchema('DecisionId');
export const PolicyVersionId = idSchema('PolicyVersionId');
export const AuditEventId = idSchema('AuditEventId');

export type OrganisationId = z.infer<typeof OrganisationId>;
export type UserId = z.infer<typeof UserId>;
export type CampaignId = z.infer<typeof CampaignId>;
export type ResearchTaskId = z.infer<typeof ResearchTaskId>;
export type AgentRunId = z.infer<typeof AgentRunId>;
export type HandoffId = z.infer<typeof HandoffId>;
export type IdeaCardId = z.infer<typeof IdeaCardId>;
export type IndicatorCardId = z.infer<typeof IndicatorCardId>;
export type StrategyId = z.infer<typeof StrategyId>;
export type StrategyVersionId = z.infer<typeof StrategyVersionId>;
export type PineRevisionId = z.infer<typeof PineRevisionId>;
export type ArtefactId = z.infer<typeof ArtefactId>;
export type EvidenceId = z.infer<typeof EvidenceId>;
export type DatasetVersionId = z.infer<typeof DatasetVersionId>;
export type SymbolId = z.infer<typeof SymbolId>;
export type SegmentId = z.infer<typeof SegmentId>;
export type ParameterSetId = z.infer<typeof ParameterSetId>;
export type BacktestPlanId = z.infer<typeof BacktestPlanId>;
export type BacktestRunId = z.infer<typeof BacktestRunId>;
export type VerificationId = z.infer<typeof VerificationId>;
export type ReportUploadId = z.infer<typeof ReportUploadId>;
export type ParityReportId = z.infer<typeof ParityReportId>;
export type ValidationReportId = z.infer<typeof ValidationReportId>;
export type DeploymentId = z.infer<typeof DeploymentId>;
export type SignalEventId = z.infer<typeof SignalEventId>;
export type DecisionId = z.infer<typeof DecisionId>;
export type PolicyVersionId = z.infer<typeof PolicyVersionId>;
export type AuditEventId = z.infer<typeof AuditEventId>;
