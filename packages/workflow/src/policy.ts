/**
 * The research lifecycle transition policy.
 *
 * CLAUDE.md 10: allowed transitions, required evidence, required role, human
 * approval and hard-fail checks live here and nowhere else. Route handlers
 * never re-implement any part of this.
 *
 * The table below is the machine-readable form of the gates in leader prompt
 * section 8 and the lifecycle in specification section 5. It is data, not
 * code, so the whole policy can be read in one place and diffed when it
 * changes — and `POLICY_VERSION` is stamped on every decision, so a later
 * change can never retroactively alter what a past decision was made under
 * (specification 7.9: the judge cannot change thresholds retrospectively).
 */
import type { EvidenceKind, RbacRole, WorkflowState } from '@arf/contracts';

/**
 * Bump on ANY change to the rules below.
 *
 * Stored on every decision record. Two decisions made under different policy
 * versions are not comparable, and an approval granted under an older, weaker
 * policy must remain visibly so.
 */
export const POLICY_VERSION = '2026-09-01.1';

export interface TransitionRule {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  /**
   * Roles permitted to request this transition. Empty means no role may
   * request it directly — the transition is system-driven only.
   */
  readonly allowedRoles: readonly RbacRole[];
  /** Evidence that must be present and not superseded. */
  readonly requiredEvidence: readonly EvidenceKind[];
  /**
   * A recorded human approval is required in addition to role and evidence.
   * Specification 25: human approval is required before forward deployment.
   */
  readonly requiresHumanApproval: boolean;
  /**
   * The actor must not be whoever created or last edited the version.
   * CLAUDE.md 3.4: the creator cannot be the sole validator, and no agent
   * may approve its own work.
   */
  readonly requiresIndependentActor: boolean;
  /** Why this gate exists, shown in the UI beside a blocked transition. */
  readonly rationale: string;
}

/** Transitions available from almost anywhere: rejection and blocking. */
const ALWAYS_AVAILABLE_TARGETS = ['REJECTED', 'BLOCKED'] as const;

/**
 * States from which no further transition is possible.
 * ARCHIVED is terminal; REJECTED is not, because a rejected version can be
 * archived once its lesson has been recorded.
 */
export const TERMINAL_STATES: readonly WorkflowState[] = ['ARCHIVED'];

/**
 * The forward path. Each entry is one gate.
 *
 * Reading top to bottom gives the full research funnel: cheap gates first,
 * so weak candidates die before expensive robustness and forward work
 * (specification 3.7).
 */
export const TRANSITION_RULES: readonly TransitionRule[] = [
  {
    from: 'CAMPAIGN_BACKLOG',
    to: 'IDEA_RESEARCH',
    allowedRoles: ['RESEARCHER', 'ADMIN'],
    requiredEvidence: [],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'Starting research on a backlog item requires no prior evidence.',
  },
  {
    // Gate 0 — idea eligibility.
    from: 'IDEA_RESEARCH',
    to: 'INDICATOR_RESEARCH',
    allowedRoles: ['RESEARCHER', 'ADMIN'],
    requiredEvidence: ['IDEA_CARD'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'An idea proceeds only once it is falsifiable, has available data, and is not a duplicate.',
  },
  {
    from: 'INDICATOR_RESEARCH',
    to: 'HYPOTHESIS_DRAFT',
    allowedRoles: ['RESEARCHER', 'ADMIN'],
    requiredEvidence: ['IDEA_CARD', 'INDICATOR_CARD'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'Indicators must be qualified for repainting and bounded parameters before a design is drafted.',
  },
  {
    // Gate 1 — architecture completeness.
    from: 'HYPOTHESIS_DRAFT',
    to: 'PINE_DEVELOPMENT',
    allowedRoles: ['RESEARCHER', 'DEVELOPER', 'ADMIN'],
    requiredEvidence: ['STRATEGY_DEFINITION', 'PARAMETER_MANIFEST'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'Code is written only from a deterministic definition another agent could implement without asking what the rules mean.',
  },
  {
    // Gate 2 — code integrity.
    from: 'PINE_DEVELOPMENT',
    to: 'COMPILE_CHECK',
    allowedRoles: ['DEVELOPER', 'ADMIN'],
    requiredEvidence: ['PINE_REVISION'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'A revision must exist before it can be compiled and statically checked.',
  },
  {
    from: 'COMPILE_CHECK',
    to: 'BASIC_BACKTEST',
    allowedRoles: ['DEVELOPER', 'ADMIN'],
    requiredEvidence: ['COMPILE_REPORT', 'SYNTHETIC_TEST_REPORT'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'Source must compile, pass anti-leak checks, and produce the expected synthetic signals.',
  },
  {
    // Gate 3 — baseline plausibility.
    from: 'BASIC_BACKTEST',
    to: 'SEGMENTED_BACKTEST',
    allowedRoles: ['DEVELOPER', 'VALIDATOR', 'ADMIN'],
    requiredEvidence: ['BASELINE_BACKTEST', 'TRADE_LEDGER', 'DATA_QUALITY_REPORT'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'Trades must be plausible and reproducible, on healthy data, before expensive segmentation.',
  },
  {
    // Gate 4 — segmented evidence.
    from: 'SEGMENTED_BACKTEST',
    to: 'ROBUSTNESS_VALIDATION',
    allowedRoles: ['DEVELOPER', 'VALIDATOR', 'ADMIN'],
    requiredEvidence: ['SEGMENTED_BACKTEST', 'PARAMETER_SELECTION_RECORD'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'In-sample selection must be documented and parameters frozen before protected data is touched.',
  },
  {
    // Gate 5 — robustness. The validator must be independent of the creator.
    from: 'ROBUSTNESS_VALIDATION',
    to: 'TRADINGVIEW_VERIFICATION',
    allowedRoles: ['VALIDATOR', 'ADMIN'],
    requiredEvidence: ['VALIDATION_REPORT'],
    requiresHumanApproval: false,
    requiresIndependentActor: true,
    rationale:
      'A hostile review must have been performed by someone other than the strategy author.',
  },
  {
    // Gate 6 — TradingView parity.
    from: 'TRADINGVIEW_VERIFICATION',
    to: 'PAPER_APPROVAL_REVIEW',
    allowedRoles: ['VALIDATOR', 'OPERATOR', 'ADMIN'],
    requiredEvidence: ['PARITY_REPORT'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'The exact source must reproduce in TradingView within tolerance before any forward work.',
  },
  {
    // Gate 7 — paper approval. Requires a human and an independent judge.
    from: 'PAPER_APPROVAL_REVIEW',
    to: 'PAPER_APPROVED',
    allowedRoles: ['COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: ['VALIDATION_REPORT', 'PARITY_REPORT', 'HUMAN_APPROVAL'],
    requiresHumanApproval: true,
    requiresIndependentActor: true,
    rationale:
      'Forward deployment consumes real time and attention; specification 25 requires explicit human approval.',
  },
  {
    from: 'PAPER_APPROVED',
    to: 'FORWARD_TESTING',
    allowedRoles: ['OPERATOR', 'ADMIN'],
    requiredEvidence: ['PINE_REVISION'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'A deployment runs one frozen, immutable version.',
  },
  {
    // Gate 8 — forward evidence.
    from: 'FORWARD_TESTING',
    to: 'FINAL_REVIEW',
    allowedRoles: ['OPERATOR', 'VALIDATOR', 'ADMIN'],
    requiredEvidence: ['FORWARD_TEST_REPORT'],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale:
      'Forward evidence must reach its target with healthy infrastructure before final review.',
  },
  {
    from: 'FINAL_REVIEW',
    to: 'RESEARCH_APPROVED',
    allowedRoles: ['COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: ['VALIDATION_REPORT', 'FORWARD_TEST_REPORT'],
    requiresHumanApproval: true,
    requiresIndependentActor: true,
    rationale: 'Research approval is a judgement on the complete evidence bundle.',
  },
  {
    /**
     * LIVE_CANDIDATE is a recommendation for human review, never a grant of
     * live-trading permission. Specification 1.3 and leader prompt 2.4: no
     * agent can produce LIVE_APPROVED, and that state does not exist in the
     * schema at all.
     */
    from: 'FINAL_REVIEW',
    to: 'LIVE_CANDIDATE',
    allowedRoles: ['COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: [
      'VALIDATION_REPORT',
      'PARITY_REPORT',
      'FORWARD_TEST_REPORT',
      'FINAL_HOLDOUT_RESULT',
      'HUMAN_APPROVAL',
    ],
    requiresHumanApproval: true,
    requiresIndependentActor: true,
    rationale:
      'Nominating a strategy for human live-deployment review demands the complete evidence pack. This grants no trading permission.',
  },
  {
    from: 'RESEARCH_APPROVED',
    to: 'ARCHIVED',
    allowedRoles: ['RESEARCHER', 'COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: [],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'Approved work is archived once it is no longer active research.',
  },
  {
    from: 'LIVE_CANDIDATE',
    to: 'ARCHIVED',
    allowedRoles: ['COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: [],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'A live candidate is archived once the human review concludes.',
  },
  {
    /**
     * A rejected version keeps its lesson (specification 2.1 item 7: failed
     * research must stay searchable), so archiving is explicit rather than
     * automatic.
     */
    from: 'REJECTED',
    to: 'ARCHIVED',
    allowedRoles: ['RESEARCHER', 'VALIDATOR', 'COMMITTEE_MEMBER', 'ADMIN'],
    requiredEvidence: [],
    requiresHumanApproval: false,
    requiresIndependentActor: false,
    rationale: 'Rejected research is archived once its failure lesson is recorded.',
  },
];

/**
 * Rules for rejecting or blocking, generated for every non-terminal state.
 *
 * Rejection is always available and never gated: specification 3.7 and the
 * leader prompt both make killing a weak idea cheap and easy on purpose. It
 * must never be harder to reject a strategy than to promote it.
 */
function buildAlwaysAvailableRules(): TransitionRule[] {
  const states = new Set<WorkflowState>();
  for (const rule of TRANSITION_RULES) {
    states.add(rule.from);
    states.add(rule.to);
  }

  const rules: TransitionRule[] = [];
  for (const from of states) {
    if (TERMINAL_STATES.includes(from)) continue;
    for (const to of ALWAYS_AVAILABLE_TARGETS) {
      if (from === to) continue;
      rules.push({
        from,
        to,
        allowedRoles: ['RESEARCHER', 'DEVELOPER', 'VALIDATOR', 'OPERATOR', 'COMMITTEE_MEMBER', 'ADMIN'],
        requiredEvidence: [],
        requiresHumanApproval: false,
        requiresIndependentActor: false,
        rationale:
          to === 'REJECTED'
            ? 'Rejecting a weak candidate is always permitted and never gated.'
            : 'Any actor may block work when a prerequisite is missing or unsafe.',
      });
    }
  }

  // A blocked item returns to the state it was blocked from; the service
  // layer supplies the prior state, so BLOCKED is an origin for every state.
  for (const to of states) {
    if (to === 'BLOCKED' || TERMINAL_STATES.includes(to)) continue;
    rules.push({
      from: 'BLOCKED',
      to,
      allowedRoles: ['RESEARCHER', 'DEVELOPER', 'VALIDATOR', 'OPERATOR', 'COMMITTEE_MEMBER', 'ADMIN'],
      requiredEvidence: [],
      requiresHumanApproval: false,
      requiresIndependentActor: false,
      rationale: 'Unblocking returns the item to the state it was blocked from.',
    });
  }

  return rules;
}

/** Every rule, forward path plus rejection, blocking and unblocking. */
export const ALL_RULES: readonly TransitionRule[] = [
  ...TRANSITION_RULES,
  ...buildAlwaysAvailableRules(),
];

/** Look up the rule for a transition, or undefined if it is not permitted. */
export function findRule(from: WorkflowState, to: WorkflowState): TransitionRule | undefined {
  return ALL_RULES.find((r) => r.from === from && r.to === to);
}

/** Every state reachable from `from`, for rendering available actions. */
export function availableTransitions(from: WorkflowState): readonly TransitionRule[] {
  return ALL_RULES.filter((r) => r.from === from);
}
