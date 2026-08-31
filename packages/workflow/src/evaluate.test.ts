import { describe, expect, it } from 'vitest';
import type { EvidenceKind, HardFailure, RbacRole, WorkflowState } from '@arf/contracts';
import { evaluateTransition, type TransitionContext } from './evaluate.js';
import { ALL_RULES, POLICY_VERSION, TERMINAL_STATES, availableTransitions } from './policy.js';

const AUTHOR = 'agent-run-author';
const REVIEWER = 'agent-run-reviewer';

function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    currentState: 'ROBUSTNESS_VALIDATION',
    actor: { type: 'AGENT', id: REVIEWER, role: 'VALIDATOR' },
    contributorIds: [AUTHOR],
    presentEvidence: [],
    hardFailures: [],
    humanApprovalRecorded: false,
    ...overrides,
  };
}

describe('idempotency and terminal states', () => {
  it('treats a transition to the current state as a no-op, not an error', () => {
    // CLAUDE.md 3.6: a retried command must not fail.
    const outcome = evaluateTransition({
      to: 'ROBUSTNESS_VALIDATION',
      context: context({ currentState: 'ROBUSTNESS_VALIDATION' }),
    });
    expect(outcome.status).toBe('NO_OP');
  });

  it('refuses any transition out of a terminal state', () => {
    const outcome = evaluateTransition({
      to: 'REJECTED',
      context: context({ currentState: 'ARCHIVED', actor: { type: 'HUMAN', id: 'u', role: 'ADMIN' } }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('TERMINAL_STATE');
  });

  it('stamps the policy version on every outcome', () => {
    // Specification 7.9: a decision must remain auditable against the policy
    // it was made under, so this can never be omitted.
    const outcomes = [
      evaluateTransition({ to: 'ROBUSTNESS_VALIDATION', context: context() }),
      evaluateTransition({ to: 'RESEARCH_APPROVED', context: context() }),
      evaluateTransition({ to: 'REJECTED', context: context() }),
    ];
    for (const o of outcomes) expect(o.policyVersion).toBe(POLICY_VERSION);
  });
});

describe('evidence gates', () => {
  it('permits a gated transition when its evidence is present', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({ presentEvidence: ['VALIDATION_REPORT'] }),
    });
    expect(outcome.status).toBe('ALLOWED');
  });

  it('names exactly what is missing rather than saying "denied"', () => {
    const outcome = evaluateTransition({
      to: 'PAPER_APPROVED',
      context: context({
        currentState: 'PAPER_APPROVAL_REVIEW',
        actor: { type: 'HUMAN', id: 'u1', role: 'COMMITTEE_MEMBER' },
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') {
      expect(outcome.code).toBe('MISSING_EVIDENCE');
      expect(outcome.missingEvidence).toEqual(['PARITY_REPORT', 'HUMAN_APPROVAL']);
    }
  });

  it('treats missing evidence as missing, never as favourable', () => {
    // Specification 6.2. An empty evidence set must never pass a gate.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({ presentEvidence: [] }),
    });
    expect(outcome.status).toBe('REJECTED');
  });
});

describe('role permissions', () => {
  it('refuses a role that may never make the transition', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        actor: { type: 'HUMAN', id: 'v1', role: 'VIEWER' },
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') {
      expect(outcome.code).toBe('ROLE_NOT_PERMITTED');
      expect(outcome.permittedRoles).toContain('VALIDATOR');
    }
  });

  it('reports the role problem before the evidence problem', () => {
    // Listing missing evidence to someone who could never make the
    // transition anyway sends them to gather artefacts pointlessly.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({ actor: { type: 'HUMAN', id: 'v1', role: 'VIEWER' }, presentEvidence: [] }),
    });
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('ROLE_NOT_PERMITTED');
  });

  it('does not let a developer perform the independent validation gate', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        actor: { type: 'AGENT', id: 'dev', role: 'DEVELOPER' },
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('REJECTED');
  });
});

describe('separation of duties', () => {
  it('refuses to let a contributor validate their own strategy version', () => {
    // CLAUDE.md 3.4 and specification 7.7. This is the single rule that stops
    // the system endorsing its own work.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        actor: { type: 'AGENT', id: AUTHOR, role: 'VALIDATOR' },
        contributorIds: [AUTHOR],
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('permits an independent actor at the same gate', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        actor: { type: 'AGENT', id: REVIEWER, role: 'VALIDATOR' },
        contributorIds: [AUTHOR],
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('ALLOWED');
  });

  it('checks every contributor, not just the most recent one', () => {
    // An agent that optimised the strategy three steps ago is still not
    // independent of it.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        actor: { type: 'AGENT', id: 'agent-early', role: 'VALIDATOR' },
        contributorIds: ['agent-early', AUTHOR],
        presentEvidence: ['VALIDATION_REPORT'],
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });
});

describe('human approval', () => {
  const paperReview = (overrides: Partial<TransitionContext> = {}) =>
    context({
      currentState: 'PAPER_APPROVAL_REVIEW',
      actor: { type: 'HUMAN', id: 'committee-1', role: 'COMMITTEE_MEMBER' },
      presentEvidence: ['VALIDATION_REPORT', 'PARITY_REPORT', 'HUMAN_APPROVAL'],
      ...overrides,
    });

  it('requires a recorded human approval before paper deployment', () => {
    // Specification 25: human approval required before forward deployment.
    const outcome = evaluateTransition({
      to: 'PAPER_APPROVED',
      context: paperReview({ humanApprovalRecorded: false }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('HUMAN_APPROVAL_REQUIRED');
  });

  it('permits it once the approval is recorded', () => {
    const outcome = evaluateTransition({
      to: 'PAPER_APPROVED',
      context: paperReview({ humanApprovalRecorded: true }),
    });
    expect(outcome.status).toBe('ALLOWED');
  });
});

describe('hard failures are absolute', () => {
  const withFailure = (failures: HardFailure[], overrides: Partial<TransitionContext> = {}) =>
    context({ hardFailures: failures, presentEvidence: ['VALIDATION_REPORT'], ...overrides });

  it('blocks promotion when a hard failure is unresolved', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: withFailure(['FUTURE_LEAKAGE_CONFIRMED']),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') {
      expect(outcome.code).toBe('HARD_FAILURE_PRESENT');
      expect(outcome.hardFailures).toEqual(['FUTURE_LEAKAGE_CONFIRMED']);
    }
  });

  it('cannot be lifted by a human override', () => {
    // Specification 16.1: a hard failure overrides the score, and CLAUDE.md 26
    // forbids approving on invalid evidence. No authority inside this system
    // can promote a strategy with confirmed leakage — it must be fixed in a
    // new version. This is the most important assertion in the suite.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: withFailure(['FUTURE_LEAKAGE_CONFIRMED'], {
        actor: { type: 'HUMAN', id: 'admin-1', role: 'ADMIN' },
        humanOverride: {
          granted: true,
          reason: 'Research director wants this promoted regardless.',
          approverRole: 'ADMIN',
        },
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('HARD_FAILURE_PRESENT');
  });

  it('still allows rejecting a strategy that has hard failures', () => {
    // A failing candidate must always be killable; otherwise a hard failure
    // would strand a version in place forever.
    const outcome = evaluateTransition({
      to: 'REJECTED',
      context: withFailure(['REPAINTING_INVALIDATES_SIGNALS']),
    });
    expect(outcome.status).toBe('ALLOWED');
  });

  it('still allows blocking a strategy that has hard failures', () => {
    const outcome = evaluateTransition({
      to: 'BLOCKED',
      context: withFailure(['DATA_INTEGRITY_UNRESOLVED']),
    });
    expect(outcome.status).toBe('ALLOWED');
  });
});

describe('human override', () => {
  it('can lift a missing-evidence gate, and is flagged as having done so', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        presentEvidence: [],
        humanOverride: {
          granted: true,
          reason: 'Validation report delivered out of band and attached manually.',
          approverRole: 'ADMIN',
        },
      }),
    });
    expect(outcome.status).toBe('ALLOWED');
    if (outcome.status === 'ALLOWED') expect(outcome.viaHumanOverride).toBe(true);
  });

  it('refuses an override with no stated reason', () => {
    // CLAUDE.md 18.3: an override is always visible and reasoned.
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({
        presentEvidence: [],
        humanOverride: { granted: true, reason: '   ', approverRole: 'ADMIN' },
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('does not mark an unassisted pass as an override', () => {
    const outcome = evaluateTransition({
      to: 'TRADINGVIEW_VERIFICATION',
      context: context({ presentEvidence: ['VALIDATION_REPORT'] }),
    });
    expect(outcome.status).toBe('ALLOWED');
    if (outcome.status === 'ALLOWED') expect(outcome.viaHumanOverride).toBe(false);
  });

  it('does not let a non-committee role override a human-approval gate', () => {
    const outcome = evaluateTransition({
      to: 'PAPER_APPROVED',
      context: context({
        currentState: 'PAPER_APPROVAL_REVIEW',
        actor: { type: 'HUMAN', id: 'ops', role: 'ADMIN' },
        presentEvidence: ['VALIDATION_REPORT', 'PARITY_REPORT', 'HUMAN_APPROVAL'],
        humanApprovalRecorded: false,
        humanOverride: { granted: true, reason: 'Operator judgement.', approverRole: 'OPERATOR' },
      }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.code).toBe('HUMAN_APPROVAL_REQUIRED');
  });
});

describe('policy shape', () => {
  it('never permits a transition into a live-approved state', () => {
    // Specification 1.3 and leader prompt 2.4: no agent can grant live
    // approval, and the state does not exist. This guards against a future
    // edit reintroducing it.
    const targets = ALL_RULES.map((r) => String(r.to));
    expect(targets).not.toContain('LIVE_APPROVED');
    expect(targets.filter((t) => t === 'LIVE_CANDIDATE').length).toBeGreaterThan(0);
  });

  it('requires the full evidence pack before nominating a live candidate', () => {
    const rule = ALL_RULES.find((r) => r.from === 'FINAL_REVIEW' && r.to === 'LIVE_CANDIDATE');
    expect(rule?.requiredEvidence).toContain('FINAL_HOLDOUT_RESULT');
    expect(rule?.requiredEvidence).toContain('FORWARD_TEST_REPORT');
    expect(rule?.requiresHumanApproval).toBe(true);
    expect(rule?.requiresIndependentActor).toBe(true);
  });

  it('makes rejection reachable from every non-terminal state with no evidence', () => {
    // CLAUDE.md 28: it must be easier to reject a weak strategy than to make
    // it look strong. If any state could not be rejected cheaply, a bad
    // candidate could get stuck alive.
    const states = new Set<WorkflowState>();
    for (const r of ALL_RULES) {
      states.add(r.from);
      states.add(r.to);
    }
    for (const state of states) {
      if (TERMINAL_STATES.includes(state) || state === 'REJECTED') continue;
      const outcome = evaluateTransition({
        to: 'REJECTED',
        context: context({
          currentState: state,
          actor: { type: 'HUMAN', id: 'u', role: 'RESEARCHER' },
          presentEvidence: [],
          contributorIds: [],
        }),
      });
      expect(outcome.status, `${state} should be rejectable with no evidence`).toBe('ALLOWED');
    }
  });

  it('gates every promotion on at least one piece of evidence', () => {
    // Archiving and rejection are exempt; every forward step must demand
    // something. A promotion requiring nothing would be a hole in the funnel.
    const exempt: readonly WorkflowState[] = ['REJECTED', 'BLOCKED', 'ARCHIVED'];
    const promotions = ALL_RULES.filter(
      (r) => !exempt.includes(r.to) && r.from !== 'BLOCKED' && r.from !== 'CAMPAIGN_BACKLOG',
    );
    expect(promotions.length).toBeGreaterThan(0);
    for (const rule of promotions) {
      expect(rule.requiredEvidence.length, `${rule.from} -> ${rule.to} has no evidence gate`)
        .toBeGreaterThan(0);
    }
  });

  it('has no duplicate rules for the same transition', () => {
    const seen = new Set<string>();
    for (const r of ALL_RULES) {
      const key = `${r.from}->${r.to}`;
      expect(seen.has(key), `duplicate rule ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('gives every rule a rationale a user can read', () => {
    for (const r of ALL_RULES) {
      expect(r.rationale.length, `${r.from} -> ${r.to} has no rationale`).toBeGreaterThan(10);
    }
  });

  it('lists available targets when a transition is not allowed', () => {
    const outcome = evaluateTransition({
      to: 'PAPER_APPROVED',
      context: context({ currentState: 'IDEA_RESEARCH', actor: { type: 'HUMAN', id: 'u', role: 'ADMIN' } }),
    });
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') {
      expect(outcome.code).toBe('TRANSITION_NOT_ALLOWED');
      expect(outcome.availableTargets).toContain('INDICATOR_RESEARCH');
    }
  });

  it('exposes available transitions for a state', () => {
    const targets = availableTransitions('ROBUSTNESS_VALIDATION').map((r) => r.to);
    expect(targets).toContain('TRADINGVIEW_VERIFICATION');
    expect(targets).toContain('REJECTED');
  });
});

describe('the full happy path', () => {
  it('walks a strategy from backlog to research approval', () => {
    // Each step uses the minimum role and evidence the policy demands, which
    // doubles as executable documentation of the funnel.
    const steps: ReadonlyArray<{
      from: WorkflowState;
      to: WorkflowState;
      role: RbacRole;
      evidence: EvidenceKind[];
      humanApproval?: boolean;
    }> = [
      { from: 'CAMPAIGN_BACKLOG', to: 'IDEA_RESEARCH', role: 'RESEARCHER', evidence: [] },
      { from: 'IDEA_RESEARCH', to: 'INDICATOR_RESEARCH', role: 'RESEARCHER', evidence: ['IDEA_CARD'] },
      {
        from: 'INDICATOR_RESEARCH',
        to: 'HYPOTHESIS_DRAFT',
        role: 'RESEARCHER',
        evidence: ['IDEA_CARD', 'INDICATOR_CARD'],
      },
      {
        from: 'HYPOTHESIS_DRAFT',
        to: 'PINE_DEVELOPMENT',
        role: 'DEVELOPER',
        evidence: ['STRATEGY_DEFINITION', 'PARAMETER_MANIFEST'],
      },
      { from: 'PINE_DEVELOPMENT', to: 'COMPILE_CHECK', role: 'DEVELOPER', evidence: ['PINE_REVISION'] },
      {
        from: 'COMPILE_CHECK',
        to: 'BASIC_BACKTEST',
        role: 'DEVELOPER',
        evidence: ['COMPILE_REPORT', 'SYNTHETIC_TEST_REPORT'],
      },
      {
        from: 'BASIC_BACKTEST',
        to: 'SEGMENTED_BACKTEST',
        role: 'DEVELOPER',
        evidence: ['BASELINE_BACKTEST', 'TRADE_LEDGER', 'DATA_QUALITY_REPORT'],
      },
      {
        from: 'SEGMENTED_BACKTEST',
        to: 'ROBUSTNESS_VALIDATION',
        role: 'DEVELOPER',
        evidence: ['SEGMENTED_BACKTEST', 'PARAMETER_SELECTION_RECORD'],
      },
      {
        from: 'ROBUSTNESS_VALIDATION',
        to: 'TRADINGVIEW_VERIFICATION',
        role: 'VALIDATOR',
        evidence: ['VALIDATION_REPORT'],
      },
      {
        from: 'TRADINGVIEW_VERIFICATION',
        to: 'PAPER_APPROVAL_REVIEW',
        role: 'VALIDATOR',
        evidence: ['PARITY_REPORT'],
      },
      {
        from: 'PAPER_APPROVAL_REVIEW',
        to: 'PAPER_APPROVED',
        role: 'COMMITTEE_MEMBER',
        evidence: ['VALIDATION_REPORT', 'PARITY_REPORT', 'HUMAN_APPROVAL'],
        humanApproval: true,
      },
      { from: 'PAPER_APPROVED', to: 'FORWARD_TESTING', role: 'OPERATOR', evidence: ['PINE_REVISION'] },
      {
        from: 'FORWARD_TESTING',
        to: 'FINAL_REVIEW',
        role: 'OPERATOR',
        evidence: ['FORWARD_TEST_REPORT'],
      },
      {
        from: 'FINAL_REVIEW',
        to: 'RESEARCH_APPROVED',
        role: 'COMMITTEE_MEMBER',
        evidence: ['VALIDATION_REPORT', 'FORWARD_TEST_REPORT'],
        humanApproval: true,
      },
    ];

    for (const step of steps) {
      const outcome = evaluateTransition({
        to: step.to,
        context: context({
          currentState: step.from,
          actor: { type: 'HUMAN', id: REVIEWER, role: step.role },
          contributorIds: [AUTHOR],
          presentEvidence: step.evidence,
          humanApprovalRecorded: step.humanApproval ?? false,
        }),
      });
      expect(outcome.status, `${step.from} -> ${step.to}: ${JSON.stringify(outcome)}`).toBe(
        'ALLOWED',
      );
    }
  });
});
