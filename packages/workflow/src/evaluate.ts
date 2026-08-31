/**
 * Transition evaluation.
 *
 * A pure function: given a requested transition and the facts about a
 * strategy version, decide whether policy permits it. No database, no clock,
 * no I/O — which is what makes the whole gate policy exhaustively testable
 * without infrastructure.
 *
 * CLAUDE.md 10: this returns a typed success or failure. It does NOT throw
 * for an expected policy rejection. A blocked promotion is a normal outcome
 * of a research system that is supposed to reject things, not an exception.
 */
import type { EvidenceKind, HardFailure, RbacRole, WorkflowState } from '@arf/contracts';
import { POLICY_VERSION, TERMINAL_STATES, availableTransitions, findRule } from './policy.js';

/** Who is requesting the transition. */
export interface TransitionActor {
  readonly type: 'HUMAN' | 'AGENT' | 'SERVICE';
  /** Stable identity: a user id, or an agent run identity. */
  readonly id: string;
  readonly role: RbacRole;
}

/** The facts the policy is evaluated against. */
export interface TransitionContext {
  readonly currentState: WorkflowState;
  readonly actor: TransitionActor;
  /**
   * Identities that authored or optimised this version. The actor must not
   * be one of them where independence is required (CLAUDE.md 3.4).
   * Includes every contributing agent run, not just the last one.
   */
  readonly contributorIds: readonly string[];
  /** Evidence kinds currently attached and not superseded. */
  readonly presentEvidence: readonly EvidenceKind[];
  /** Unresolved hard failures. Any of these blocks forward movement. */
  readonly hardFailures: readonly HardFailure[];
  /** A recorded human approval exists for this specific transition. */
  readonly humanApprovalRecorded: boolean;
  /**
   * A human override. Overrides can lift evidence and independence
   * requirements but never hard failures — specification 16.1 makes those
   * absolute, and CLAUDE.md 26 forbids approving on invalid evidence.
   */
  readonly humanOverride?: {
    readonly granted: boolean;
    readonly reason: string;
    readonly approverRole: RbacRole;
  };
}

export interface TransitionRequest {
  readonly to: WorkflowState;
  readonly context: TransitionContext;
}

export type RejectionCode =
  | 'ALREADY_IN_STATE'
  | 'TERMINAL_STATE'
  | 'TRANSITION_NOT_ALLOWED'
  | 'ROLE_NOT_PERMITTED'
  | 'MISSING_EVIDENCE'
  | 'HARD_FAILURE_PRESENT'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'OVERRIDE_REASON_REQUIRED';

export type TransitionOutcome =
  | {
      readonly status: 'ALLOWED';
      readonly from: WorkflowState;
      readonly to: WorkflowState;
      readonly policyVersion: string;
      /** True when policy was satisfied only because a human overrode it. */
      readonly viaHumanOverride: boolean;
      readonly rationale: string;
    }
  | {
      readonly status: 'NO_OP';
      readonly state: WorkflowState;
      readonly policyVersion: string;
      readonly message: string;
    }
  | {
      readonly status: 'REJECTED';
      readonly from: WorkflowState;
      readonly to: WorkflowState;
      readonly policyVersion: string;
      readonly code: RejectionCode;
      readonly message: string;
      /** Exactly what is missing, so the UI can list it rather than say "denied". */
      readonly missingEvidence?: readonly EvidenceKind[];
      readonly hardFailures?: readonly HardFailure[];
      readonly permittedRoles?: readonly RbacRole[];
      readonly availableTargets?: readonly WorkflowState[];
    };

/** Targets that represent giving up on, or pausing, a candidate. */
const NON_PROMOTING_TARGETS: readonly WorkflowState[] = ['REJECTED', 'BLOCKED', 'ARCHIVED'];

/**
 * Evaluate a requested transition against policy.
 *
 * Checks run cheapest-first and in an order chosen so the message a user sees
 * names the most fundamental problem: there is no point reporting missing
 * evidence to someone whose role could never make the transition anyway.
 */
export function evaluateTransition(request: TransitionRequest): TransitionOutcome {
  const { to, context } = request;
  const { currentState: from, actor } = context;

  // Idempotency (CLAUDE.md 3.6): re-requesting the current state is a
  // success, not an error. A retried command must not fail.
  if (from === to) {
    return {
      status: 'NO_OP',
      state: from,
      policyVersion: POLICY_VERSION,
      message: `Already in ${from}; nothing to do.`,
    };
  }

  if (TERMINAL_STATES.includes(from)) {
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'TERMINAL_STATE',
      message: `${from} is terminal; no further transition is possible.`,
    };
  }

  const rule = findRule(from, to);
  if (!rule) {
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'TRANSITION_NOT_ALLOWED',
      message: `No policy rule permits ${from} to ${to}.`,
      availableTargets: availableTransitions(from).map((r) => r.to),
    };
  }

  if (!rule.allowedRoles.includes(actor.role)) {
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'ROLE_NOT_PERMITTED',
      message: `Role ${actor.role} may not move a version from ${from} to ${to}.`,
      permittedRoles: rule.allowedRoles,
    };
  }

  const override = context.humanOverride;
  if (override?.granted === true && override.reason.trim() === '') {
    // CLAUDE.md 18.3 and 3.4: an override is always visible and reasoned.
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'OVERRIDE_REASON_REQUIRED',
      message: 'A human override must state its reason.',
    };
  }
  const overrideActive = override?.granted === true;

  const isPromotion = !NON_PROMOTING_TARGETS.includes(to);

  /**
   * Hard failures block every promotion, and no override lifts them.
   *
   * Specification 16.1: a hard failure overrides the score. A strategy with
   * confirmed future leakage cannot be promoted by any authority inside this
   * system — the defect must be fixed in a new version instead. Rejecting and
   * blocking stay available so a failing candidate can always be killed.
   */
  if (isPromotion && context.hardFailures.length > 0) {
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'HARD_FAILURE_PRESENT',
      message:
        'Unresolved hard failures block promotion. These cannot be overridden; ' +
        'correct them in a new strategy version.',
      hardFailures: context.hardFailures,
    };
  }

  const present = new Set(context.presentEvidence);
  const missing = rule.requiredEvidence.filter((kind) => !present.has(kind));
  if (missing.length > 0 && !overrideActive) {
    // Specification 6.2: missing evidence is missing, never favourable.
    return {
      status: 'REJECTED',
      from,
      to,
      policyVersion: POLICY_VERSION,
      code: 'MISSING_EVIDENCE',
      message: `Missing required evidence for ${from} to ${to}.`,
      missingEvidence: missing,
    };
  }

  if (rule.requiresIndependentActor && !overrideActive) {
    if (context.contributorIds.includes(actor.id)) {
      // CLAUDE.md 3.4 and specification 7.7: the agent or person who created
      // or optimised a strategy cannot be the one who validates or approves
      // it. This is the single rule that stops the system endorsing itself.
      return {
        status: 'REJECTED',
        from,
        to,
        policyVersion: POLICY_VERSION,
        code: 'SELF_APPROVAL_FORBIDDEN',
        message:
          `Actor ${actor.id} contributed to this strategy version and cannot also ` +
          'validate or approve it. An independent actor is required.',
      };
    }
  }

  if (rule.requiresHumanApproval && !context.humanApprovalRecorded) {
    // Deliberately not lifted by an override: an override IS a human
    // decision, so requiring one here would be circular. The override path
    // still records who granted it and why.
    if (!overrideActive) {
      return {
        status: 'REJECTED',
        from,
        to,
        policyVersion: POLICY_VERSION,
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: `Transition ${from} to ${to} requires a recorded human approval.`,
      };
    }
    if (override !== undefined && override.approverRole !== 'ADMIN' && override.approverRole !== 'COMMITTEE_MEMBER') {
      return {
        status: 'REJECTED',
        from,
        to,
        policyVersion: POLICY_VERSION,
        code: 'HUMAN_APPROVAL_REQUIRED',
        message:
          'Only a committee member or administrator may override a human-approval gate.',
      };
    }
  }

  return {
    status: 'ALLOWED',
    from,
    to,
    policyVersion: POLICY_VERSION,
    viaHumanOverride: overrideActive && (missing.length > 0 || rule.requiresIndependentActor),
    rationale: rule.rationale,
  };
}
