import type { JSX } from 'react';
import { ApiError, api, type RunView } from '@/lib/api';
import { EquityChart } from '@/components/EquityChart';
import { MetricsPanel } from '@/components/MetricsPanel';
import { DecisionPanel } from '@/components/DecisionPanel';
import { formatNumber } from '@/lib/format';

/**
 * Strategy Detail — the canonical evidence page for one immutable version.
 *
 * A server component: stable reads render on the server and go through the API
 * client, never near a database (CLAUDE.md 18.5). The decision surface is the
 * only client island, because it is a live operation.
 *
 * Every number on this page states which runner produced it and whether ARF
 * calculated it or TradingView reported it. That labelling is not decoration —
 * CLAUDE.md 18.1 forbids presenting them as interchangeable, and a reviewer
 * who cannot tell them apart cannot evaluate parity.
 */
export const dynamic = 'force-dynamic';

const API_BASE = process.env['NEXT_PUBLIC_ARF_API_URL'] ?? 'http://127.0.0.1:3001';
const DEV_ACTOR = process.env['ARF_DEV_USER'] ?? '';

export default async function StrategyDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;

  let version: Awaited<ReturnType<typeof api.strategyVersion>>;
  try {
    version = await api.strategyVersion(id);
  } catch (caught: unknown) {
    return (
      <>
        <h1>Strategy version</h1>
        <p className="notice notice-critical">
          ⚠{' '}
          {caught instanceof ApiError
            ? `${caught.problem.title}: ${caught.problem.detail ?? caught.problem.code}`
            : 'The API is unreachable.'}
        </p>
      </>
    );
  }

  const [runs, audit] = await Promise.all([
    api.runs(id).catch(() => ({ items: [] as RunView[] })),
    api.audit(id).catch(() => ({ items: [], nextCursor: null })),
  ]);

  // Newest completed run carries the evidence shown below.
  const run = runs.items.find((r) => r.status === 'SUCCEEDED') ?? runs.items[0] ?? null;
  const evidence = run ? await api.runEvidence(run.id).catch(() => null) : null;
  const parity =
    run?.verificationId ? await api.parity(run.verificationId).catch(() => null) : null;

  return (
    <>
      <h1>
        Strategy version {version.versionNumber}{' '}
        <span className="badge">{version.state.replace(/_/g, ' ')}</span>
        {version.isTested ? (
          // CLAUDE.md 18.2: a tested revision is read-only; editing creates a child.
          <span className="badge" title="Tested revisions are immutable; editing creates a child version.">
            🔒 read-only
          </span>
        ) : null}
      </h1>
      <p className="subtitle">
        <span className="hash">{version.id}</span>
      </p>

      {version.contaminatedDatasetIds.length > 0 ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          ⚠ {version.contaminatedDatasetIds.length} dataset(s) are marked contaminated for this
          version. Results on that data are no longer unseen evidence.
        </p>
      ) : null}

      <div className="detail-grid">
        <div style={{ minWidth: 0 }}>
          <h2>Identity</h2>
          <div className="card">
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0 }}>
              <Term label="Pine source" value={version.pineSourceHash} mono />
              <Term label="Definition" value={version.definitionHash} mono />
              <Term label="Manifest" value={version.manifestHash} mono />
              <Term label="Parent version" value={version.parentVersionId} mono />
            </dl>
          </div>

          <h2>Evidence</h2>
          {run ? (
            <>
              <p className="small muted" style={{ margin: '0 0 10px' }}>
                {/* Which engine produced this, stated up front. */}
                <span className="provenance">
                  {run.runnerType === 'TRADINGVIEW' ? 'TRADINGVIEW' : 'LOCAL RUNNER'}
                </span>{' '}
                {run.symbol} · {run.timeframe} · {run.runnerVersion} · initial capital{' '}
                {formatNumber(Number(run.initialCapital))} {run.currency}
              </p>

              {run.warnings.length > 0 ? (
                <details className="notice" style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: 'pointer' }}>
                    ⚠ {run.warnings.length} warning(s) from ingestion — kept after a successful
                    parse
                  </summary>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                    {run.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {evidence ? (
                <>
                  <EquityChart
                    points={evidence.equity}
                    currency={run.currency}
                    source={run.runnerType === 'TRADINGVIEW' ? 'TRADINGVIEW EXPORT' : 'LOCAL RUNNER'}
                    calculationVersion={evidence.equity[0]?.calculationVersion ?? '1.0.0'}
                    segments={[
                      {
                        fromIndex: 0,
                        label: 'Historical',
                        scope: 'Historical · closed trades · simulated',
                      },
                    ]}
                  />

                  <h2>Metrics</h2>
                  <MetricsPanel metrics={evidence.metrics} currency={run.currency} />

                  <h2>Trades</h2>
                  <TradesTable trades={evidence.trades} currency={run.currency} />
                </>
              ) : (
                <p className="empty">Evidence could not be loaded for this run.</p>
              )}

              <h2>TradingView parity</h2>
              <ParityCard parity={parity} />
            </>
          ) : (
            <p className="empty">
              No runs yet. Create a TradingView verification, upload the exports, and the evidence
              chain is built from them.
            </p>
          )}

          <h2>Audit</h2>
          <div className="card scroll-x">
            {audit.items.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No audit entries yet.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When (UTC)</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.items.map((entry) => (
                    <tr key={entry.id}>
                      <td className="small">{entry.createdAt.slice(0, 19).replace('T', ' ')}</td>
                      <td>{entry.action}</td>
                      <td className="small">
                        <span className="badge">{entry.actorType}</span> {entry.actorId}
                      </td>
                      <td className="muted small">{entry.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside style={{ minWidth: 0 }}>
          <h2 style={{ marginTop: 0 }}>Review</h2>
          <DecisionPanel
            version={version}
            // These come from the caller today. Once evidence rows are written
            // by the research lanes they are read from the version itself.
            presentEvidence={[]}
            hardFailures={[]}
            validatorRecommendation={null}
            rejectionCase={null}
            apiBase={API_BASE}
            actor={DEV_ACTOR}
          />
        </aside>
      </div>
    </>
  );
}

function Term({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): JSX.Element {
  return (
    <>
      <dt className="small muted">{label}</dt>
      <dd style={{ margin: 0 }} className={mono ? 'hash' : undefined}>
        {value ?? <span className="unavailable">not set</span>}
      </dd>
    </>
  );
}

function TradesTable({
  trades,
  currency,
}: {
  trades: Awaited<ReturnType<typeof api.runEvidence>>['trades'];
  currency: string;
}): JSX.Element {
  if (trades.length === 0) return <p className="empty">No closed trades in this run.</p>;

  return (
    <div className="card scroll-x">
      <table>
        <caption className="small muted" style={{ textAlign: 'left', paddingBottom: 8 }}>
          Closed trades only. An open position at the end of the test is excluded from the ledger
          and from the equity curve.
        </caption>
        <thead>
          <tr>
            <th>#</th>
            <th>Side</th>
            <th>Entry (UTC)</th>
            <th>Exit (UTC)</th>
            <th className="num">Entry</th>
            <th className="num">Exit</th>
            <th className="num">Qty</th>
            <th className="num">Gross</th>
            <th className="num">Fees</th>
            <th className="num">Net ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.tradeNumber}>
              <td className="num">{t.tradeNumber}</td>
              <td>
                <span className="badge">{t.direction}</span>
              </td>
              <td className="small">{t.entryTime.slice(0, 16).replace('T', ' ')}</td>
              <td className="small">{t.exitTime.slice(0, 16).replace('T', ' ')}</td>
              <td className="num">{Number(t.entryPrice).toFixed(2)}</td>
              <td className="num">{Number(t.exitPrice).toFixed(2)}</td>
              <td className="num">{Number(t.quantity)}</td>
              {/* Null is rendered as an absence, never as zero (ADR-0002). */}
              <td className="num">
                {t.grossPnl === null ? (
                  <span className="unavailable" title="Not reported by this source">
                    n/a
                  </span>
                ) : (
                  Number(t.grossPnl).toFixed(2)
                )}
              </td>
              <td className="num">
                {t.fees === null ? (
                  <span className="unavailable" title="This export has no per-trade commission column">
                    n/a
                  </span>
                ) : (
                  Number(t.fees).toFixed(2)
                )}
              </td>
              <td className="num">{Number(t.netPnl).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        Gross P&amp;L and fees are unavailable from a TradingView List of Trades export, which
        reports net profit only (ADR-0002). They are shown as unavailable rather than as zero.
      </p>
    </div>
  );
}

function ParityCard({
  parity,
}: {
  parity: Awaited<ReturnType<typeof api.parity>> | null;
}): JSX.Element {
  if (!parity || parity.status === 'NOT_COMPUTED') {
    return <p className="empty">Parity has not been computed for this version yet.</p>;
  }

  const badge =
    parity.status === 'PASS'
      ? 'badge badge-good'
      : parity.status === 'FAIL'
        ? 'badge badge-critical'
        : 'badge badge-warning';
  const glyph = parity.status === 'PASS' ? '✓' : parity.status === 'FAIL' ? '✕' : '⚠';

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={badge}>
          {glyph} {parity.status.replace(/_/g, ' ')}
        </span>
        <span className="small muted">policy {parity.tolerancePolicyVersion}</span>
      </div>

      {/* The first divergence is the headline, not an aggregate delta. */}
      {parity.firstDivergentTradeNumber != null ? (
        <p className="notice notice-critical" style={{ marginTop: 10 }}>
          First divergence at trade #{parity.firstDivergentTradeNumber}.{' '}
          {parity.firstDivergenceDetail}
        </p>
      ) : null}

      {parity.insufficientDataReason ? (
        <p className="notice" style={{ marginTop: 10 }}>
          ⚠ {parity.insufficientDataReason}
        </p>
      ) : null}

      {parity.identityMismatches && parity.identityMismatches.length > 0 ? (
        <ul className="small" style={{ marginTop: 10, paddingLeft: 18 }}>
          {parity.identityMismatches.map((m) => (
            <li key={m} style={{ color: 'var(--status-critical)' }}>
              {m}
            </li>
          ))}
        </ul>
      ) : null}

      {parity.comparisons && parity.comparisons.length > 0 ? (
        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th className="num">ARF calculated</th>
                <th className="num">TradingView reported</th>
                <th className="num">Difference</th>
                <th>Within tolerance</th>
              </tr>
            </thead>
            <tbody>
              {parity.comparisons.map((c) => (
                <tr key={c.field}>
                  <td>{c.field.replace(/_/g, ' ')}</td>
                  <td className="num">
                    {c.arfValue ?? <span className="unavailable">n/a</span>}
                  </td>
                  <td className="num">
                    {c.tradingViewValue ?? <span className="unavailable">n/a</span>}
                  </td>
                  <td className="num">
                    {c.absoluteDifference ?? <span className="unavailable">—</span>}
                  </td>
                  <td>
                    {c.withinTolerance ? '✓ yes' : '✕ no'}
                    {c.note ? (
                      <div className="small muted" style={{ maxWidth: 340 }}>
                        {c.note}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
