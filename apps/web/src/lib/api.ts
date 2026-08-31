/**
 * The typed API client.
 *
 * CLAUDE.md 18.5: one central client, no direct database access from the web
 * app, and no duplicated contract types — response shapes are derived from
 * @arf/contracts rather than re-declared here, so a contract change breaks the
 * build instead of silently producing a wrong screen.
 *
 * Every call goes through `request`, which is the single place that attaches
 * credentials and turns a problem-details body into a typed error.
 */
import type {
  EvidenceKind,
  HardFailure,
  MetricUnit,
  ParityStatus,
  RbacRole,
  WorkflowState,
} from '@arf/contracts';

const API_BASE = process.env['ARF_API_URL'] ?? 'http://127.0.0.1:3001';

/** RFC 9457 problem details, as the API emits them. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  traceId?: string;
  validationErrors?: Array<{ path: string; message: string }>;
  context?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }

  /** Structured detail a policy rejection carries, for rendering what is missing. */
  get context(): Record<string, unknown> | undefined {
    return this.problem.context;
  }
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /**
   * Identity for the development auth stub. In a deployed environment this is
   * replaced by a Clerk session token; the client shape does not change.
   */
  readonly actor?: string;
  /**
   * Read caching. Evidence is immutable once written, so it is safe to cache;
   * anything reflecting live workflow state must not be.
   */
  readonly cache?: RequestCache;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const actor = options.actor ?? process.env['ARF_DEV_USER'];
  if (actor) headers['x-dev-user'] = actor;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: options.cache ?? 'no-store',
  });

  if (!response.ok) {
    // The API always answers with problem details; a non-JSON body here means
    // something upstream of the API failed, and is surfaced as such rather
    // than being swallowed into a generic message.
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: 'Request failed',
        status: response.status,
        code: 'upstream_error',
        detail: `${response.status} ${response.statusText}`,
      },
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Response shapes. These mirror what the API returns; the *domain* vocabulary
// (states, roles, units) is imported so it cannot drift from the contracts.
// ---------------------------------------------------------------------------

export interface AvailableTransition {
  to: WorkflowState;
  requiredEvidence: EvidenceKind[];
  allowedRoles: RbacRole[];
  requiresHumanApproval: boolean;
  requiresIndependentActor: boolean;
  rationale: string;
}

export interface StrategyVersionView {
  id: string;
  strategyId: string;
  versionNumber: number;
  state: WorkflowState;
  parentVersionId: string | null;
  definitionHash: string | null;
  manifestHash: string | null;
  pineSourceHash: string | null;
  contaminatedDatasetIds: string[];
  /** Once true the revision is read-only (CLAUDE.md 18.2). */
  isTested: boolean;
  createdAt: string;
  availableTransitions: AvailableTransition[];
}

export interface TradeView {
  tradeNumber: number;
  direction: 'LONG' | 'SHORT';
  entryTime: string;
  exitTime: string;
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  /** Null where the source does not report it — never rendered as zero. */
  grossPnl: string | null;
  fees: string | null;
  netPnl: string;
}

export interface EquityPointView {
  tradeNumber: number;
  at: string;
  equity: string;
  drawdown: string;
  drawdownPercent: number;
  calculationVersion: string;
}

export interface MetricView {
  name: string;
  value: string | null;
  nullReason?: string | null;
  unit: MetricUnit;
  calculationVersion: string;
  /** Never merged with the other source (CLAUDE.md 18.1). */
  source: 'ARF_CALCULATED' | 'TRADINGVIEW_REPORTED';
}

export interface RunView {
  id: string;
  /** Which engine produced this. Never presented as interchangeable. */
  runnerType: 'LOCAL_RESEARCH_RUNNER' | 'TRADINGVIEW';
  runnerVersion: string;
  symbol: string;
  timeframe: string;
  status: string;
  currency: string;
  initialCapital: string;
  sourceHash: string;
  warnings: string[];
  verificationId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RunEvidenceView {
  trades: TradeView[];
  equity: EquityPointView[];
  metrics: MetricView[];
}

export interface ParityComparisonView {
  field: string;
  arfValue: string | null;
  tradingViewValue: string | null;
  absoluteDifference: string | null;
  withinTolerance: boolean;
  note?: string;
}

export interface ParityReportView {
  id?: string;
  status: ParityStatus | 'NOT_COMPUTED';
  message?: string;
  tolerancePolicyVersion?: string;
  identityMatches?: boolean;
  identityMismatches?: string[];
  comparisons?: ParityComparisonView[];
  firstDivergentTradeNumber?: number | null;
  firstDivergenceDetail?: string | null;
  insufficientDataReason?: string | null;
  createdAt?: string;
}

export interface VerificationView {
  id: string;
  status: string;
  strategyVersionId: string;
  expected: {
    sourceHash: string;
    symbol: string;
    timeframe: string;
    settings: Record<string, unknown>;
    rangeStart: string | null;
    rangeEnd: string | null;
    chartTimezone: string;
    initialCapital: string;
  };
  uploads: Array<{
    id: string;
    reportKind: string;
    status: string;
    filename: string | null;
    parserVersion: string | null;
    parserWarnings: string[];
    rejectionReason: string | null;
  }>;
}

export interface CampaignView {
  id: string;
  title: string;
  objective: string;
  state: WorkflowState;
  budgetUsd: string | null;
  modelSpendUsd: string;
  createdAt: string;
}

export interface AuditEntryView {
  id: string;
  action: string;
  actorType: 'HUMAN' | 'AGENT' | 'SERVICE';
  actorId: string;
  priorState: unknown;
  newState: unknown;
  reason: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TransitionRequestBody {
  to: WorkflowState;
  reason: string;
  evidenceIds?: string[];
  presentEvidence?: EvidenceKind[];
  hardFailures?: HardFailure[];
  humanApprovalRecorded?: boolean;
  humanOverride?: { granted: true; reason: string };
}

export const api = {
  health: () => request<{ status: string; database: string }>('/health/ready'),

  campaigns: (limit = 25) => request<Page<CampaignView>>(`/v1/campaigns?limit=${limit}`),

  strategyVersion: (id: string) => request<StrategyVersionView>(`/v1/strategy-versions/${id}`),

  audit: (versionId: string, limit = 50) =>
    request<Page<AuditEntryView>>(`/v1/strategy-versions/${versionId}/audit?limit=${limit}`),

  runs: (versionId: string) => request<{ items: RunView[] }>(`/v1/strategy-versions/${versionId}/runs`),

  runEvidence: (runId: string) => request<RunEvidenceView>(`/v1/backtest-runs/${runId}/evidence`),

  verification: (id: string) => request<VerificationView>(`/v1/verifications/${id}`),

  parity: (verificationId: string) =>
    request<ParityReportView>(`/v1/verifications/${verificationId}/parity`),

  transition: (versionId: string, body: TransitionRequestBody, actor?: string) =>
    request<{ from: WorkflowState; to: WorkflowState; policyVersion: string }>(
      `/v1/strategy-versions/${versionId}/transition`,
      { method: 'POST', body, ...(actor ? { actor } : {}) },
    ),
};
