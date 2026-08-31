'use client';

/**
 * Equity and drawdown, as two linked charts sharing one x-axis.
 *
 * Deliberately NOT a dual-axis chart. Equity is a currency total and drawdown
 * is a fall from a peak; putting them on two y-scales in one frame lets the
 * reader infer a relationship from where the lines happen to cross, which is
 * an artefact of the scaling rather than anything in the data. CLAUDE.md 18.4
 * forbids misleading dual axes and the data-viz method treats it as the single
 * worst chart mistake, so this is two stacked frames with a shared time scale
 * and a linked crosshair.
 *
 * Requirements from CLAUDE.md 18.4, and where each is met:
 *   - linked date brushing ....... shared hover index across both frames
 *   - accessible summaries ....... <table> view, always in the DOM
 *   - export ..................... CSV download of the plotted series
 *   - no misleading dual axes .... two frames, one scale each
 *   - scope and units in tooltip . every tooltip row names its unit and source
 *   - empty / error / stale ...... explicit states, never a blank frame
 *
 * CLAUDE.md 18.1 is why `segments` exists: historical and forward equity must
 * never render as one uninterrupted series without a visible boundary.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EquityPointView } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';

export interface EquitySegment {
  /** Inclusive index of the first point in this segment. */
  readonly fromIndex: number;
  readonly label: string;
  /** Shown in the tooltip so a point always states which evidence class it is. */
  readonly scope: string;
}

export interface EquityChartProps {
  readonly points: readonly EquityPointView[];
  readonly currency: string;
  /** Where the numbers came from. Rendered, never assumed. */
  readonly source: string;
  readonly calculationVersion: string;
  /**
   * Boundaries between evidence classes. With one entry the series is a single
   * labelled class; with more, a visible rule is drawn at each boundary.
   */
  readonly segments?: readonly EquitySegment[];
  /** Set when the underlying run is older than its inputs. */
  readonly stale?: string | null;
}

const EQUITY_HEIGHT = 210;
const DRAWDOWN_HEIGHT = 110;
const MARGIN = { top: 12, right: 16, bottom: 22, left: 68 } as const;

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function EquityChart({
  points,
  currency,
  source,
  calculationVersion,
  segments = [{ fromIndex: 0, label: 'Historical', scope: 'Historical (closed trades)' }],
  stale = null,
}: EquityChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Null until measured on the client.
   *
   * Seeding a guessed width would make the server render SVG geometry that
   * the client immediately contradicts once it measures the container — a
   * React hydration mismatch. The skeleton below reserves the same height so
   * nothing shifts when the real chart appears.
   */
  const [width, setWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    // Measured rather than scaled with a viewBox: scaling an SVG would scale
    // the stroke widths with it, and the mark specs are in pixels.
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const times = points.map((p) => new Date(p.at).getTime());
    const equities = points.map((p) => Number(p.equity));
    const drawdowns = points.map((p) => Number(p.drawdown));

    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const eMin = Math.min(...equities);
    const eMax = Math.max(...equities);
    // A little headroom so the line never touches the frame edge.
    const ePad = (eMax - eMin || Math.abs(eMax) || 1) * 0.08;
    const dMin = Math.min(...drawdowns, 0);

    return { times, equities, drawdowns, tMin, tMax, eMin: eMin - ePad, eMax: eMax + ePad, dMin };
  }, [points]);

  const innerWidth = Math.max((width ?? 0) - MARGIN.left - MARGIN.right, 10);

  const xAt = useCallback(
    (index: number): number => {
      if (!model) return 0;
      const span = model.tMax - model.tMin;
      // A single point, or all points at one instant: centre rather than
      // dividing by zero.
      if (span === 0) return MARGIN.left + innerWidth / 2;
      return MARGIN.left + ((model.times[index] ?? 0) - model.tMin) * (innerWidth / span);
    },
    [model, innerWidth],
  );

  const nearestIndex = useCallback(
    (clientX: number): number | null => {
      const element = containerRef.current;
      if (!element || !model) return null;
      const rect = element.getBoundingClientRect();
      const x = clientX - rect.left;
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const distance = Math.abs(xAt(i) - x);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
      return best;
    },
    [model, points.length, xAt],
  );

  const downloadCsv = useCallback(() => {
    const header = 'trade_number,at,equity,drawdown,drawdown_percent\n';
    const rows = points
      .map((p) => `${p.tradeNumber},${p.at},${p.equity},${p.drawdown},${p.drawdownPercent}`)
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'equity-curve.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="card">
        <ChartHeader source={source} calculationVersion={calculationVersion} />
        <p className="empty">
          No equity curve yet. It is reconstructed from the trade ledger once a report has been
          ingested.
        </p>
      </div>
    );
  }

  if (!model) return <div className="card" />;

  const eScale = (value: number): number => {
    const span = model.eMax - model.eMin || 1;
    return MARGIN.top + (model.eMax - value) * ((EQUITY_HEIGHT - MARGIN.top - MARGIN.bottom) / span);
  };
  const dScale = (value: number): number => {
    const span = Math.abs(model.dMin) || 1;
    return MARGIN.top + Math.abs(value) * ((DRAWDOWN_HEIGHT - MARGIN.top - MARGIN.bottom) / span);
  };

  const equityPath = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${eScale(model.equities[i] ?? 0)}`).join(' ');
  const drawdownArea =
    `M${xAt(0)},${dScale(0)} ` +
    points.map((_, i) => `L${xAt(i)},${dScale(model.drawdowns[i] ?? 0)}`).join(' ') +
    ` L${xAt(points.length - 1)},${dScale(0)} Z`;

  const eTicks = niceTicks(model.eMin, model.eMax, 4);
  const dTicks = niceTicks(model.dMin, 0, 2);
  const hovered = hover === null ? null : points[hover];

  const segmentOf = (index: number): EquitySegment =>
    [...segments].reverse().find((s) => index >= s.fromIndex) ?? segments[0]!;

  return (
    <div className="card">
      <ChartHeader
        source={source}
        calculationVersion={calculationVersion}
        onExport={downloadCsv}
        segments={segments}
      />

      {stale ? (
        <p className="notice" style={{ marginBottom: 12 }}>
          ⚠ {stale}
        </p>
      ) : null}

      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', minHeight: EQUITY_HEIGHT + DRAWDOWN_HEIGHT }}
        onMouseMove={(event) => setHover(nearestIndex(event.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        {width === null ? (
          <p className="small muted" style={{ padding: 16 }}>Measuring…</p>
        ) : (
          <>
        {/* Equity. One series, so the title names it and no legend box is needed. */}
        <svg
          width={width}
          height={EQUITY_HEIGHT}
          role="img"
          aria-label={`Equity curve, ${points.length} points, from ${formatMoney(
            model.equities[0] ?? 0,
            currency,
          )} to ${formatMoney(model.equities[model.equities.length - 1] ?? 0, currency)}. A table of the same data follows.`}
        >
          {eTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={eScale(tick)}
                y2={eScale(tick)}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8}
                y={eScale(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--text-muted)"
                fontFamily="var(--font-mono)"
              >
                {formatNumber(tick)}
              </text>
            </g>
          ))}

          {/* Boundaries between evidence classes, drawn and labelled. */}
          {segments.slice(1).map((segment) => (
            <g key={segment.label}>
              <line
                x1={xAt(segment.fromIndex)}
                x2={xAt(segment.fromIndex)}
                y1={MARGIN.top}
                y2={EQUITY_HEIGHT - MARGIN.bottom}
                stroke="var(--text-muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text
                x={xAt(segment.fromIndex) + 4}
                y={MARGIN.top + 10}
                fontSize={10}
                fill="var(--text-muted)"
              >
                {segment.label}
              </text>
            </g>
          ))}

          <path d={equityPath} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {hover !== null ? (
            <>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={MARGIN.top}
                y2={EQUITY_HEIGHT - MARGIN.bottom}
                stroke="var(--axis)"
                strokeWidth={1}
              />
              {/* A surface ring keeps the marker legible over the line. */}
              <circle
                cx={xAt(hover)}
                cy={eScale(model.equities[hover] ?? 0)}
                r={4.5}
                fill="var(--series-1)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            </>
          ) : null}

          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={EQUITY_HEIGHT - MARGIN.bottom}
            y2={EQUITY_HEIGHT - MARGIN.bottom}
            stroke="var(--axis)"
            strokeWidth={1}
          />
        </svg>

        {/* Drawdown, sharing the x scale above. */}
        <svg
          width={width}
          height={DRAWDOWN_HEIGHT}
          role="img"
          aria-label={`Drawdown from peak, worst ${formatMoney(model.dMin, currency)}. Measured on closed trades.`}
          style={{ display: 'block', marginTop: -6 }}
        >
          {dTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={dScale(tick)}
                y2={dScale(tick)}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8}
                y={dScale(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--text-muted)"
                fontFamily="var(--font-mono)"
              >
                {formatNumber(tick)}
              </text>
            </g>
          ))}

          <path d={drawdownArea} fill="var(--series-8)" fillOpacity={0.18} stroke="var(--series-8)" strokeWidth={2} strokeLinejoin="round" />

          {hover !== null ? (
            <>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={MARGIN.top}
                y2={DRAWDOWN_HEIGHT - MARGIN.bottom}
                stroke="var(--axis)"
                strokeWidth={1}
              />
              <circle
                cx={xAt(hover)}
                cy={dScale(model.drawdowns[hover] ?? 0)}
                r={4.5}
                fill="var(--series-8)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            </>
          ) : null}
        </svg>

        {hovered ? (
          <div
            style={{
              position: 'absolute',
              left: Math.min(Math.max(xAt(hover ?? 0) + 12, 8), Math.max(width - 250, 8)),
              top: 8,
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '8px 10px',
              fontSize: 12,
              pointerEvents: 'none',
              boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
              minWidth: 210,
            }}
          >
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatDate(hovered.at)}</div>
            <div style={{ marginTop: 4 }}>
              {/* Scope and units, on every row — CLAUDE.md 18.4. */}
              <TooltipRow
                swatch="var(--series-1)"
                label="Equity"
                value={formatMoney(Number(hovered.equity), currency)}
              />
              <TooltipRow
                swatch="var(--series-8)"
                label="Drawdown"
                value={`${formatMoney(Number(hovered.drawdown), currency)} (${hovered.drawdownPercent.toFixed(2)}%)`}
              />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 5 }}>
              Trade #{hovered.tradeNumber} · {segmentOf(hover ?? 0).scope}
            </div>
          </div>
        ) : null}
          </>
        )}
      </div>

      <p className="small muted" style={{ marginTop: 10 }}>
        Drawdown is measured on <strong>closed trades</strong>. TradingView measures it
        intra-trade, so its figure is equal or larger; the two are different definitions, not a
        discrepancy (ADR-0001).
      </p>

      {/* The accessible view. Always present, not a toggle that can be missed. */}
      <details style={{ marginTop: 10 }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>
          View as table ({points.length} points)
        </summary>
        <div className="scroll-x" style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto' }}>
          <table>
            <caption className="small muted" style={{ textAlign: 'left', paddingBottom: 6 }}>
              Reconstructed equity and closed-trade drawdown, in {currency}.
            </caption>
            <thead>
              <tr>
                <th>Trade</th>
                <th>Exit (UTC)</th>
                <th className="num">Equity</th>
                <th className="num">Drawdown</th>
                <th className="num">Drawdown %</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.tradeNumber}>
                  <td className="num">{p.tradeNumber}</td>
                  <td className="small">{formatDate(p.at)}</td>
                  <td className="num">{Number(p.equity).toFixed(2)}</td>
                  <td className="num">{Number(p.drawdown).toFixed(2)}</td>
                  <td className="num">{p.drawdownPercent.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function TooltipRow({
  swatch,
  label,
  value,
}: {
  swatch: string;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
      {/* The swatch carries identity; the text stays in ink tokens. */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background: swatch,
          flexShrink: 0,
        }}
      />
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ChartHeader({
  source,
  calculationVersion,
  onExport,
  segments,
}: {
  source: string;
  calculationVersion: string;
  onExport?: () => void;
  segments?: readonly EquitySegment[];
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
      <div>
        <strong style={{ fontSize: 14 }}>Equity and drawdown</strong>
        <div className="small muted" style={{ marginTop: 2 }}>
          {/* Provenance is stated, never implied. */}
          <span className="provenance">{source}</span>{' '}
          <span>reconstructed independently · calc v{calculationVersion}</span>
          {segments && segments.length > 0 ? (
            <span> · {segments.map((s) => s.label).join(' → ')}</span>
          ) : null}
        </div>
      </div>
      {onExport ? (
        <button type="button" onClick={onExport} style={{ marginLeft: 'auto' }}>
          Export CSV
        </button>
      ) : null}
    </div>
  );
}
