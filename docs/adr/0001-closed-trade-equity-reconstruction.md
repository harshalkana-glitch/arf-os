# ADR-0001: Reconstruct equity from closed trades, and treat the gap from TradingView as evidence

## Status

Accepted — 2026-08-31

## Context

Spec 22 item 6 and the build prompt both require ARF-OS to reconstruct the
equity curve, drawdown curve and core metrics *independently* from the parsed
trade ledger, rather than reading them out of a TradingView report. If we
copied TradingView's numbers, the parity report of section 13.4 would be
comparing those numbers with themselves and could never fail.

The only trade data a TradingView "List of Trades" export reliably provides is
the closed-trade ledger: entry and exit timestamps, prices, quantity, gross
P&L, commission and net P&L. Some exports additionally carry MAE and MFE per
trade; many do not.

TradingView's own Strategy Tester computes equity continuously, including
unrealised profit and loss while a position is open. Its reported maximum
drawdown therefore includes adverse excursion *inside* a trade.

These two definitions do not agree. A strategy that never closes a losing
trade but sits 40% underwater mid-position has a large TradingView drawdown
and a near-zero closed-trade drawdown. The difference is systematic: a
closed-trade drawdown is always less than or equal to the intra-trade figure.

## Decision

`packages/metrics` reconstructs equity as a **closed-trade** curve: one point
per closed trade, marked at the exit timestamp, plus an opening point carrying
the initial capital.

`max_drawdown` and `max_drawdown_percent` are computed from that curve and are
labelled as ARF-calculated, closed-trade figures.

TradingView's reported drawdown is stored separately, as a `MetricSnapshot`
with `source: TRADINGVIEW_REPORTED`. The two are never averaged, reconciled,
or merged into one unlabelled number.

The parity report treats a drawdown difference in the expected direction
(TradingView greater than or equal to ARF) as an explainable difference rather
than a parity failure. A difference in the *opposite* direction is a genuine
defect, because it cannot arise from this definitional gap and therefore
indicates a parsing or reconstruction error.

Where MAE data is present in the export, an intra-trade drawdown estimate is
computed as a separate, separately named metric. It is never substituted for
the closed-trade figure.

## Alternatives considered

**Read drawdown from the TradingView report.** Rejected: it destroys the
independence that makes parity meaningful, and CLAUDE.md 26 forbids making
report data canonical when structured data exists to compute from.

**Reconstruct intra-trade equity from bar data.** This would match
TradingView's definition closely. Rejected for this milestone: it requires
per-bar OHLC for every symbol and timeframe, which the local research runner
does not yet provide, and it would make the metric depend on a dataset version
as well as the trade ledger. Revisit when the research runner lands.

**Interpolate equity between exits.** Rejected: it invents data points that no
source supports, and any drawdown it produced would be an artefact of the
interpolation method.

## Consequences

- ARF's reported maximum drawdown is systematically **less severe** than
  TradingView's for strategies that hold through adverse excursion. Every
  surface that displays it must label it as closed-trade, per CLAUDE.md 18.1.
- Validators comparing an ARF drawdown against a published TradingView figure
  will see a discrepancy that is expected rather than a defect. The parity
  report states this explicitly so the difference is not re-litigated on each
  strategy.
- A strategy whose edge depends on surviving deep unrealised drawdown will
  look better on the closed-trade curve than it is. This is the main risk of
  this decision. It is mitigated by the robustness lane's excursion and
  concentration tests, and it is the reason the intra-trade estimate is
  computed wherever MAE data allows.
- Because drawdown is measured in trades rather than days, `longestDrawdown`
  is reported in trade count. A calendar-time equivalent needs the intra-trade
  curve and is deferred with it.

## Security implications

None. This decision concerns calculation only; it introduces no new data
flows, no new external dependency, and no change to protected-data access.

## Migration / rollback

`EQUITY_CALCULATION_VERSION` and `CORE_CALCULATION_VERSION` are stored on every
`MetricSnapshot`. If this decision is revisited, the new formula ships under a
bumped version and previously stored snapshots keep their original version and
values. Historical evidence is never recomputed in place, because a decision
recorded against one set of numbers must remain auditable against exactly
those numbers.
