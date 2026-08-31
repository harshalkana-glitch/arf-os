/**
 * The strategy-version transition command.
 *
 * This is where the workflow policy is actually *applied*. CLAUDE.md 9.3
 * requires the state change, the audit event and the domain event to share
 * one transaction: without that, a crash between them leaves a version whose
 * recorded history disagrees with its state, and the audit trail stops being
 * evidence.
 *
 * CLAUDE.md 3.2 also matters here — workers never call this. Only the API
 * applies transition policy; a worker emits a result and lets the
 * orchestrator decide what it means.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@arf/db';
import { newId } from '@arf/db';
import {
  auditEvents,
  committeeDecisions,
  outboxEvents,
  strategyVersions,
} from '@arf/db/schema';
import type { EvidenceKind, HardFailure, WorkflowState } from '@arf/contracts';
import { evaluateTransition, type TransitionContext, type TransitionOutcome } from '@arf/workflow';
import type { AuthContext } from '../auth.js';
import { NotFoundError, PolicyRejectionError } from '../errors.js';

export interface TransitionCommand {
  readonly strategyVersionId: string;
  readonly to: WorkflowState;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly traceId?: string;
  readonly humanOverride?: { readonly granted: boolean; readonly reason: string };
  /**
   * Supplied by the caller for now. Once evidence rows are written by the
   * research lanes these come from the database instead; the shape of this
   * function does not change when that happens.
   */
  readonly presentEvidence: readonly EvidenceKind[];
  readonly hardFailures: readonly HardFailure[];
  readonly humanApprovalRecorded: boolean;
}

export interface TransitionSuccess {
  readonly strategyVersionId: string;
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly policyVersion: string;
  readonly viaHumanOverride: boolean;
  readonly auditEventId: string;
  /** Null when the transition was a no-op. */
  readonly decisionId: string | null;
}

/** Transitions that record a committee decision as well as an audit event. */
const DECISION_STATES: readonly WorkflowState[] = [
  'PAPER_APPROVED',
  'RESEARCH_APPROVED',
  'LIVE_CANDIDATE',
  'REJECTED',
];

/**
 * Apply a transition.
 *
 * Returns a typed success. A policy rejection is thrown as a
 * `PolicyRejectionError` carrying the workflow's structured detail, because
 * at the HTTP boundary a refusal has to become a status code — but the
 * *policy engine itself* still never throws, so it stays exhaustively
 * testable without HTTP.
 */
export async function applyTransition(
  db: Database,
  auth: AuthContext,
  command: TransitionCommand,
): Promise<TransitionSuccess> {
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE: two concurrent transitions on the same version
    // must not both read the same `from` state and both succeed.
    const [version] = await tx
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, command.strategyVersionId),
          eq(strategyVersions.organisationId, auth.organisationId),
        ),
      )
      .for('update')
      .limit(1);

    if (!version) {
      throw new NotFoundError('Strategy version', command.strategyVersionId);
    }

    const context: TransitionContext = {
      currentState: version.state,
      actor: { type: 'HUMAN', id: auth.userId, role: auth.role },
      /**
       * Everyone who contributed to this version, for the independence check
       * (CLAUDE.md 3.4). Currently the creating user; once agent runs are
       * stored this also carries the agent-run identities that authored or
       * optimised it, which is what makes the rule hold for agents and not
       * only for people.
       */
      contributorIds: version.createdByUserId ? [version.createdByUserId] : [],
      presentEvidence: command.presentEvidence,
      hardFailures: command.hardFailures,
      humanApprovalRecorded: command.humanApprovalRecorded,
      ...(command.humanOverride
        ? {
            humanOverride: {
              granted: command.humanOverride.granted,
              reason: command.humanOverride.reason,
              approverRole: auth.role,
            },
          }
        : {}),
    };

    const outcome: TransitionOutcome = evaluateTransition({ to: command.to, context });

    if (outcome.status === 'REJECTED') {
      throw new PolicyRejectionError(outcome.code, outcome.message, {
        from: outcome.from,
        to: outcome.to,
        policyVersion: outcome.policyVersion,
        ...(outcome.missingEvidence ? { missingEvidence: outcome.missingEvidence } : {}),
        ...(outcome.hardFailures ? { hardFailures: outcome.hardFailures } : {}),
        ...(outcome.permittedRoles ? { permittedRoles: outcome.permittedRoles } : {}),
        ...(outcome.availableTargets ? { availableTargets: outcome.availableTargets } : {}),
      });
    }

    if (outcome.status === 'NO_OP') {
      // Idempotent replay. No state change, no decision — but the attempt is
      // still audited, because "who tried to move this and when" is part of
      // the record even when nothing moved.
      const auditId = newId();
      await tx.insert(auditEvents).values({
        id: auditId,
        organisationId: auth.organisationId,
        actorType: 'HUMAN',
        actorId: auth.userId,
        action: 'strategy_version.transition.noop',
        aggregateType: 'strategy_version',
        aggregateId: command.strategyVersionId,
        priorState: { state: version.state },
        newState: { state: version.state },
        reason: command.reason,
        ...(command.traceId ? { traceId: command.traceId } : {}),
      });
      return {
        strategyVersionId: command.strategyVersionId,
        from: version.state,
        to: version.state,
        policyVersion: outcome.policyVersion,
        viaHumanOverride: false,
        auditEventId: auditId,
        decisionId: null,
      };
    }

    // ---- Allowed. State change, audit, decision and outbox all commit together.

    await tx
      .update(strategyVersions)
      .set({ state: outcome.to })
      .where(eq(strategyVersions.id, command.strategyVersionId));

    const auditId = newId();
    await tx.insert(auditEvents).values({
      id: auditId,
      organisationId: auth.organisationId,
      actorType: 'HUMAN',
      actorId: auth.userId,
      action: 'strategy_version.transition',
      aggregateType: 'strategy_version',
      aggregateId: command.strategyVersionId,
      priorState: { state: outcome.from },
      newState: {
        state: outcome.to,
        policyVersion: outcome.policyVersion,
        viaHumanOverride: outcome.viaHumanOverride,
        evidenceIds: command.evidenceIds,
      },
      reason: command.reason,
      ...(command.traceId ? { traceId: command.traceId } : {}),
    });

    let decisionId: string | null = null;
    if (DECISION_STATES.includes(outcome.to)) {
      decisionId = newId();
      await tx.insert(committeeDecisions).values({
        id: decisionId,
        organisationId: auth.organisationId,
        strategyVersionId: command.strategyVersionId,
        decision: outcome.to === 'REJECTED' ? 'REJECT' : mapDecision(outcome.to),
        fromState: outcome.from,
        toState: outcome.to,
        policyVersion: outcome.policyVersion,
        summary: command.reason,
        // These are required columns: a decision that records only its
        // supporting argument is not reviewable (specification 7.9).
        positiveCase: command.reason,
        rejectionCase: command.humanOverride?.reason ?? 'Not stated by the caller.',
        supportingEvidenceIds: [...command.evidenceIds],
        actorType: 'HUMAN',
        actorId: auth.userId,
        decidedByUserId: auth.userId,
        humanOverride: outcome.viaHumanOverride,
        ...(outcome.viaHumanOverride
          ? { overrideReason: command.humanOverride?.reason ?? 'Override reason not recorded.' }
          : {}),
      });
    }

    // Outbox rather than a direct publish: the event must not escape unless
    // this transaction commits, and must not be lost if the process dies
    // immediately after it does.
    await tx.insert(outboxEvents).values({
      id: newId(),
      organisationId: auth.organisationId,
      eventType: 'strategy_version.transitioned',
      aggregateType: 'strategy_version',
      aggregateId: command.strategyVersionId,
      ...(command.traceId ? { traceId: command.traceId, correlationId: command.traceId } : {}),
      causationId: auditId,
      payload: {
        strategyVersionId: command.strategyVersionId,
        from: outcome.from,
        to: outcome.to,
        policyVersion: outcome.policyVersion,
        viaHumanOverride: outcome.viaHumanOverride,
        actorId: auth.userId,
      },
    });

    return {
      strategyVersionId: command.strategyVersionId,
      from: outcome.from,
      to: outcome.to,
      policyVersion: outcome.policyVersion,
      viaHumanOverride: outcome.viaHumanOverride,
      auditEventId: auditId,
      decisionId,
    };
  });
}

function mapDecision(
  to: WorkflowState,
): 'PAPER_APPROVED' | 'RESEARCH_APPROVED' | 'LIVE_CANDIDATE_FOR_HUMAN_REVIEW' {
  switch (to) {
    case 'PAPER_APPROVED':
      return 'PAPER_APPROVED';
    case 'RESEARCH_APPROVED':
      return 'RESEARCH_APPROVED';
    case 'LIVE_CANDIDATE':
      // Never 'LIVE_APPROVED'. That value does not exist in the schema, and
      // this state is a nomination for human review only.
      return 'LIVE_CANDIDATE_FOR_HUMAN_REVIEW';
    default:
      throw new Error(`No decision mapping for state ${to}`);
  }
}
