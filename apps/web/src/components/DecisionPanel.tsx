'use client';

/**
 * The decision surface.
 *
 * CLAUDE.md 18.3 requires a decision dialog to show the exact strategy version,
 * mandatory evidence status, the validator recommendation, hard failures, the
 * strongest rejection case, and override status — and forbids a one-click
 * approval that hides the evidence.
 *
 * So this is deliberately not a button. Promotion requires the reviewer to
 * state a reason, acknowledge the rejection case, and — where policy demands
 * it — record a human approval explicitly. Rejection, by contrast, is
 * ungated: CLAUDE.md 28 says it must be easier to reject a weak strategy than
 * to make it look strong, and a UI that makes approval the path of least
 * resistance would undo that in the last mile.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { AvailableTransition, StrategyVersionView } from '@/lib/api';
import type { EvidenceKind, HardFailure } from '@arf/contracts';

export interface DecisionPanelProps {
  readonly version: StrategyVersionView;
  /** Evidence kinds actually attached to this version. */
  readonly presentEvidence: readonly EvidenceKind[];
  readonly hardFailures: readonly HardFailure[];
  readonly validatorRecommendation: string | null;
  /** The validator's strongest case against, shown even when approving. */
  readonly rejectionCase: string | null;
  readonly apiBase: string;
  readonly actor: string;
}

type Submission =
  | { readonly state: 'idle' }
  | { readonly state: 'submitting' }
  | { readonly state: 'ok'; readonly message: string }
  | { readonly state: 'error'; readonly message: string; readonly missing?: string[] };

const PROMOTING = (to: string): boolean => !['REJECTED', 'BLOCKED', 'ARCHIVED'].includes(to);

export function DecisionPanel({
  version,
  presentEvidence,
  hardFailures,
  validatorRecommendation,
  rejectionCase,
  apiBase,
  actor,
}: DecisionPanelProps): JSX.Element {
  const [selected, setSelected] = useState<AvailableTransition | null>(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [humanApproval, setHumanApproval] = useState(false);
  const [submission, setSubmission] = useState<Submission>({ state: 'idle' });

  const present = new Set(presentEvidence);
  const missing = selected ? selected.requiredEvidence.filter((k) => !present.has(k)) : [];
  const promoting = selected ? PROMOTING(selected.to) : false;

  // A hard failure blocks promotion absolutely and cannot be overridden here
  // or anywhere else (specification 16.1). The control is disabled *and* the
  // reason is stated, so it never looks like a UI glitch.
  const blockedByHardFailure = promoting && hardFailures.length > 0;

  const canSubmit =
    selected !== null &&
    reason.trim().length > 0 &&
    !blockedByHardFailure &&
    (!promoting || acknowledged) &&
    (!selected.requiresHumanApproval || humanApproval) &&
    submission.state !== 'submitting';

  async function submit(): Promise<void> {
    if (!selected) return;
    setSubmission({ state: 'submitting' });
    try {
      const response = await fetch(
        `${apiBase}/v1/strategy-versions/${version.id}/transition`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dev-user': actor },
          body: JSON.stringify({
            to: selected.to,
            reason: reason.trim(),
            presentEvidence,
            hardFailures,
            humanApprovalRecorded: humanApproval,
          }),
        },
      );
      // The response is untyped JSON at this boundary, so it is narrowed
      // rather than trusted (CLAUDE.md 7.1: unknown plus validation).
      const body = (await response.json()) as {
        detail?: string;
        title?: string;
        to?: string;
        context?: { missingEvidence?: string[] };
      };

      if (!response.ok) {
        // The API returns exactly what is missing, so the UI lists it rather
        // than showing an opaque refusal.
        const missing = body.context?.missingEvidence;
        setSubmission({
          state: 'error',
          message: body.detail ?? body.title ?? 'The transition was refused.',
          ...(missing ? { missing } : {}),
        });
        return;
      }
      setSubmission({
        state: 'ok',
        message: `Moved to ${(body.to ?? '').replace(/_/g, ' ')}.`,
      });
    } catch {
      setSubmission({ state: 'error', message: 'The API could not be reached.' });
    }
  }

  return (
    <div className="card">
      <strong style={{ fontSize: 14 }}>Decision</strong>

      {/* The exact version under review, never implied by page context. */}
      <p className="small muted" style={{ margin: '4px 0 14px' }}>
        Version {version.versionNumber} · <span className="hash">{version.id}</span>
        <br />
        Source hash <span className="hash">{version.pineSourceHash ?? 'none'}</span>
      </p>

      {hardFailures.length > 0 ? (
        <div className="notice notice-critical" style={{ marginBottom: 12 }}>
          <strong>✕ {hardFailures.length} unresolved hard failure(s).</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {hardFailures.map((f) => (
              <li key={f}>{f.replace(/_/g, ' ').toLowerCase()}</li>
            ))}
          </ul>
          <p style={{ margin: '6px 0 0' }}>
            These cannot be overridden. Correct them in a new strategy version.
          </p>
        </div>
      ) : null}

      <dl style={{ margin: '0 0 14px', display: 'grid', gap: 6 }}>
        <Row
          term="Validator recommendation"
          value={validatorRecommendation ?? 'No validation report yet'}
          muted={validatorRecommendation === null}
        />
        <Row
          term="Strongest case against"
          value={rejectionCase ?? 'Not recorded'}
          muted={rejectionCase === null}
        />
      </dl>

      <label className="small" style={{ display: 'block', marginBottom: 4 }}>
        Action
      </label>
      <select
        value={selected?.to ?? ''}
        onChange={(event) => {
          const next = version.availableTransitions.find((t) => t.to === event.target.value);
          setSelected(next ?? null);
          setAcknowledged(false);
          setHumanApproval(false);
          setSubmission({ state: 'idle' });
        }}
        style={{
          width: '100%',
          padding: '7px 8px',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--text-primary)',
          font: 'inherit',
        }}
      >
        <option value="">Select an action…</option>
        {version.availableTransitions.map((t) => (
          <option key={t.to} value={t.to}>
            {t.to.replace(/_/g, ' ')}
          </option>
        ))}
      </select>

      {selected ? (
        <>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            {selected.rationale}
          </p>

          {/* Mandatory evidence status, itemised — not a single pass/fail light. */}
          <div style={{ marginTop: 12 }}>
            <div className="small" style={{ marginBottom: 4 }}>
              Required evidence
            </div>
            {selected.requiredEvidence.length === 0 ? (
              <p className="small muted">None for this action.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
                {selected.requiredEvidence.map((kind) => {
                  const have = present.has(kind);
                  return (
                    <li key={kind} style={{ color: have ? 'var(--text-primary)' : 'var(--status-critical)' }}>
                      {/* Glyph plus word: never colour alone. */}
                      {have ? '✓' : '✕'} {kind.replace(/_/g, ' ').toLowerCase()}
                      {have ? '' : ' — missing'}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected.requiresIndependentActor ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              Requires an actor independent of this version&apos;s contributors.
            </p>
          ) : null}

          <label className="small" style={{ display: 'block', margin: '14px 0 4px' }}>
            Reason (recorded on the decision)
          </label>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder="State the evidence this decision rests on."
            style={{
              width: '100%',
              padding: 8,
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text-primary)',
              font: 'inherit',
              resize: 'vertical',
            }}
          />

          {promoting ? (
            <label
              className="small"
              style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I have read the strongest case against this strategy and the evidence above.
              </span>
            </label>
          ) : null}

          {selected.requiresHumanApproval ? (
            <label
              className="small"
              style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={humanApproval}
                onChange={(event) => setHumanApproval(event.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I record an explicit human approval for this promotion. This is not a research
                approval to deploy capital.
              </span>
            </label>
          ) : null}

          {missing.length > 0 ? (
            <p className="notice" style={{ marginTop: 10 }}>
              ⚠ {missing.length} required item(s) are missing. The API will refuse this transition.
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{ marginTop: 12 }}
          >
            {submission.state === 'submitting' ? 'Recording…' : 'Record decision'}
          </button>

          {blockedByHardFailure ? (
            <p className="small" style={{ color: 'var(--status-critical)', marginTop: 8 }}>
              Promotion is blocked while a hard failure is unresolved.
            </p>
          ) : null}
        </>
      ) : null}

      {submission.state === 'error' ? (
        <div className="notice notice-critical" style={{ marginTop: 12 }}>
          <strong>Refused.</strong> {submission.message}
          {submission.missing ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {submission.missing.map((m) => (
                <li key={m}>{m.replace(/_/g, ' ').toLowerCase()}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {submission.state === 'ok' ? (
        <p className="notice" style={{ marginTop: 12, borderLeftColor: 'var(--status-good)' }}>
          ✓ {submission.message} Reload to see the updated state.
        </p>
      ) : null}
    </div>
  );
}

function Row({
  term,
  value,
  muted,
}: {
  term: string;
  value: string;
  muted?: boolean;
}): JSX.Element {
  return (
    <div>
      <dt className="small muted">{term}</dt>
      <dd style={{ margin: 0 }} className={muted ? 'unavailable' : undefined}>
        {value}
      </dd>
    </div>
  );
}
