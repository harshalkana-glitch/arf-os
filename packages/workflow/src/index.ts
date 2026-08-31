/**
 * @arf/workflow
 *
 * The research state machine (CLAUDE.md 10). Transition checks live here and
 * are never scattered across route handlers. Evaluation is a pure function
 * returning a typed outcome; it does not throw for an expected policy
 * rejection, because rejecting a strategy is a normal, desirable result.
 */
export {
  POLICY_VERSION,
  TERMINAL_STATES,
  TRANSITION_RULES,
  ALL_RULES,
  availableTransitions,
  findRule,
  type TransitionRule,
} from './policy.js';

export {
  evaluateTransition,
  type RejectionCode,
  type TransitionActor,
  type TransitionContext,
  type TransitionOutcome,
  type TransitionRequest,
} from './evaluate.js';
