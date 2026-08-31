/**
 * Canonical enumerations.
 *
 * Spec 5 (research lifecycle), 1.3 (approval levels), 6.1 (agent roles),
 * 16.3 (evidence grades), 14.9 (job statuses).
 *
 * CLAUDE.md 8: use explicit enum values, never silently coerce.
 */
import { z } from 'zod';

/**
 * Research lifecycle states. Leader prompt section 3 lists the full set;
 * the build prompt scopes this milestone to a subset, but the type carries
 * every state so the workflow package never needs a widening change.
 */
export const WorkflowState = z.enum([
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'INDICATOR_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'COMPILE_CHECK',
  'BASIC_BACKTEST',
  'SEGMENTED_BACKTEST',
  'ROBUSTNESS_VALIDATION',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'FORWARD_TESTING',
  'FINAL_REVIEW',
  'RESEARCH_APPROVED',
  'PAPER_APPROVED',
  'LIVE_CANDIDATE',
  'REJECTED',
  'ARCHIVED',
  'BLOCKED',
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

/**
 * States implemented in the current milestone (build prompt,
 * "Workflow states for this milestone").
 */
export const MILESTONE_STATES = [
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'PAPER_APPROVED',
  'REJECTED',
  'BLOCKED',
] as const satisfies readonly WorkflowState[];

/** Terminal states: no outbound transition exists. */
export const TERMINAL_STATES = ['ARCHIVED'] as const satisfies readonly WorkflowState[];

/** Spec 1.3. `LIVE_APPROVED` is deliberately absent — no agent can grant it. */
export const ApprovalStatus = z.enum([
  'RESEARCH_APPROVED',
  'PAPER_APPROVED',
  'LIVE_CANDIDATE',
  'REJECTED',
  'ARCHIVED',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Spec 6.1. */
export const AgentRole = z.enum([
  'CHIEF_RESEARCH_ORCHESTRATOR',
  'IDEA_SCOUT',
  'INDICATOR_RESEARCHER',
  'STRATEGY_ARCHITECT',
  'PINE_ENGINEER',
  'BACKTEST_ENGINEER',
  'ROBUSTNESS_VALIDATOR',
  'FORWARD_TEST_OPERATOR',
  'STRATEGY_JUDGE',
  'DATA_INTEGRITY_ANALYST',
  'PORTFOLIO_RESEARCHER',
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Spec 17.1. */
export const RbacRole = z.enum([
  'VIEWER',
  'RESEARCHER',
  'DEVELOPER',
  'VALIDATOR',
  'OPERATOR',
  'COMMITTEE_MEMBER',
  'ADMIN',
  'SERVICE_ACCOUNT',
]);
export type RbacRole = z.infer<typeof RbacRole>;

/** Who performed an action. Audit records must distinguish these. */
export const ActorType = z.enum(['HUMAN', 'AGENT', 'SERVICE']);
export type ActorType = z.infer<typeof ActorType>;

/** Spec 7.7. Validator recommendation values. */
export const PromotionRecommendation = z.enum([
  'REJECT',
  'REWORK_WITH_NEW_VERSION',
  'PAPER_TEST',
  'RESEARCH_APPROVE',
  'INSUFFICIENT_EVIDENCE',
]);
export type PromotionRecommendation = z.infer<typeof PromotionRecommendation>;

/** Spec 7.9. Judge decision values. LIVE_APPROVED is not available. */
export const CommitteeDecisionType = z.enum([
  'REJECT',
  'REWORK_WITH_NEW_VERSION',
  'PAPER_APPROVED',
  'RESEARCH_APPROVED',
  'LIVE_CANDIDATE_FOR_HUMAN_REVIEW',
  'INSUFFICIENT_EVIDENCE',
]);
export type CommitteeDecisionType = z.infer<typeof CommitteeDecisionType>;

/** Spec 16.3. */
export const EvidenceGrade = z.enum(['A', 'B', 'C', 'D', 'F']);
export type EvidenceGrade = z.infer<typeof EvidenceGrade>;

/** Spec 13, build prompt "Parity". */
export const ParityStatus = z.enum(['PASS', 'WARN', 'FAIL', 'INSUFFICIENT_DATA']);
export type ParityStatus = z.infer<typeof ParityStatus>;

/** Spec 14.9. */
export const JobStatus = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_EXTERNAL',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);
export type JobStatus = z.infer<typeof JobStatus>;

/** Leader prompt 10. Data-access ledger classification. */
export const DataProtectionClass = z.enum([
  'DEVELOPMENT',
  'VALIDATION',
  'FINAL_HOLDOUT',
  'FORWARD',
  'CONTAMINATED',
  'RETIRED',
]);
export type DataProtectionClass = z.infer<typeof DataProtectionClass>;

/** Leader prompt 7. Orchestrator verdict on a specialist handoff. */
export const HandoffVerdict = z.enum([
  'ACCEPTED',
  'RETRY_WITH_VALIDATION_ERRORS',
  'REJECTED_ROLE_VIOLATION',
  'BLOCKED_MISSING_EVIDENCE',
  'ESCALATE_HUMAN',
]);
export type HandoffVerdict = z.infer<typeof HandoffVerdict>;

/** Spec 7.8. */
export const ForwardTestState = z.enum([
  'PLANNED',
  'CONFIGURING',
  'ACTIVE',
  'PAUSED',
  'DEGRADED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type ForwardTestState = z.infer<typeof ForwardTestState>;

export const TradeDirection = z.enum(['LONG', 'SHORT']);
export type TradeDirection = z.infer<typeof TradeDirection>;

/** Which engine produced a run. Results from different runners never merge. */
export const RunnerType = z.enum(['LOCAL_RESEARCH_RUNNER', 'TRADINGVIEW']);
export type RunnerType = z.infer<typeof RunnerType>;
