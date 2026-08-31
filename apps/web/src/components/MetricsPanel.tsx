/**
 * Metrics, grouped by where the number came from.
 *
 * CLAUDE.md 18.1 forbids merging an ARF-calculated value with a
 * TradingView-reported one into a single unlabelled number, so they are
 * rendered as separate groups with an explicit provenance label on each.
 *
 * A metric that is undefined shows its reason rather than a zero. The
 * distinction matters: a profit factor of 0 means the strategy made no profit,
 * and an undefined profit factor means it had no losing trades. Rendering both
 * as "0" would tell a validator the opposite of the truth.
 */
import type { JSX } from 'react';
import type { MetricView } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';

const UNIT_SUFFIX: Record<string, string> = {
  PERCENT: '%',
  RATIO: '×',
  COUNT: '',
  CURRENCY: '',
  DAYS: ' d',
  HOURS: ' h',
  BARS: ' bars',
  SECONDS: ' s',
};

/** Metrics worth showing first, in the order a reviewer reads them. */
const HEADLINE_ORDER = [
  'closed_trade_count',
  'net_profit',
  'profit_factor',
  'win_rate',
  'max_drawdown',
  'max_drawdown_percent',
  'payoff_ratio',
  'total_return_percent',
];

function displayName(name: string): string {
  return name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function formatValue(metric: MetricView, currency: string): string {
  if (metric.value === null) return '';
  const numeric = Number(metric.value);
  const suffix = UNIT_SUFFIX[metric.unit] ?? '';
  if (metric.unit === 'CURRENCY') return formatMoney(numeric, currency);
  if (metric.unit === 'COUNT') return String(Math.round(numeric));
  return `${formatNumber(numeric, { maximumFractionDigits: 4 })}${suffix}`;
}

export function MetricsPanel({
  metrics,
  currency,
}: {
  metrics: readonly MetricView[];
  currency: string;
}): JSX.Element {
  const arf = metrics.filter((m) => m.source === 'ARF_CALCULATED');
  const tradingView = metrics.filter((m) => m.source === 'TRADINGVIEW_REPORTED');

  const ordered = [...arf].sort((a, b) => {
    const ai = HEADLINE_ORDER.indexOf(a.name);
    const bi = HEADLINE_ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (metrics.length === 0) {
    return <p className="empty">No metrics yet. They are computed when a report is ingested.</p>;
  }

  return (
    <>
      <MetricGroup
        title="Independently calculated"
        provenance="ARF-CALCULATED"
        description="Computed by ARF-OS from the parsed trade ledger, not read from any report."
        metrics={ordered}
        currency={currency}
      />

      {tradingView.length > 0 ? (
        <MetricGroup
          title="As reported by TradingView"
          provenance="TRADINGVIEW"
          description="Taken from the uploaded export. Kept separate so parity can compare the two."
          metrics={tradingView}
          currency={currency}
        />
      ) : null}
    </>
  );
}

function MetricGroup({
  title,
  provenance,
  description,
  metrics,
  currency,
}: {
  title: string;
  provenance: string;
  description: string;
  metrics: readonly MetricView[];
  currency: string;
}): JSX.Element {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span className="provenance">{provenance}</span>
      </div>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>
        {description}
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">Value</th>
              <th>Unit</th>
              <th>Calc</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={`${m.source}-${m.name}`}>
                <td>{displayName(m.name)}</td>
                <td className="num">
                  {m.value === null ? (
                    // Explicit absence, never a zero.
                    <span className="unavailable" title={m.nullReason ?? undefined}>
                      not available
                    </span>
                  ) : (
                    formatValue(m, currency)
                  )}
                </td>
                <td className="small muted">{m.unit.toLowerCase()}</td>
                <td className="small muted">v{m.calculationVersion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {metrics.some((m) => m.value === null) ? (
        <ul className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
          {metrics
            .filter((m) => m.value === null && m.nullReason)
            .map((m) => (
              <li key={m.name}>
                <strong>{displayName(m.name)}</strong>: {m.nullReason}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
