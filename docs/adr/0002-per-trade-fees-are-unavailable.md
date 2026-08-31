# ADR-0002: Per-trade gross P&L and fees are unavailable from TradingView exports

## Status

Accepted — 2026-09-01

## Context

The `Trade` contract and the `trades` table were written from
`AI_RESEARCH_HEDGE_FUND_SPEC.md` section 15.7, whose trade-table specification
lists `Gross P&L`, `Fees` and `Net P&L` as separate columns, and from the
build prompt, which asks for `gross profit` and `gross loss` metrics. All three
money columns were therefore made `NOT NULL`.

Building the TradingView "List of Trades" parser showed that the source data
cannot satisfy that. The export contains a single realised profit column —
labelled `Net P&L` in current exports and `Profit` in older ones — which is
already **net of commission**. There is no per-trade commission column in any
export vintage examined. Commission appears only as an account-level total on
the Performance Summary tab.

So for a TradingView-sourced run there are exactly three options:

1. Store `netPnl` and leave gross and fees null.
2. Set `fees = 0` and `gross = net`.
3. Apportion the Performance Summary's total commission across trades.

Option 2 is a lie that reads as a fact: a validator would see zero fees and
conclude the strategy was tested without costs, which is one of the hard
failures in specification 16.1. Option 3 invents per-trade values from an
aggregate; the apportionment would be wrong for any strategy whose position
sizes vary, and CLAUDE.md 26 forbids inferring required fields.

The local research runner, when it exists, *will* know gross and fees per
trade, because it computes the fills itself. So the two runners genuinely
differ in what they can report, and the schema has to accommodate both.

## Decision

`gross_pnl` and `fees` become nullable on `trades`, and optional on the `Trade`
contract. `net_pnl` stays required — it is the one value every source
provides.

The parser stores `netPnl` only and emits a warning recording that per-trade
commission is absent from the export. The warning is attached to the run and
is never cleared on success.

`@arf/metrics` reports `total_fees` as undefined-with-reason when no trade
carries a fee value, using the same null-plus-reason mechanism it already uses
for an unbounded profit factor. A *partial* sum is also refused: summing only
the subset of trades that report fees would understate the total while looking
like a real figure.

A note on the word "gross", which means two different things and must not be
conflated:

- **Per-trade `grossPnl`** — the profit of one trade *before* its commission.
  This is what a TradingView export cannot supply, and it stays null.
- **`gross_profit` / `gross_loss` metrics** — the sum of all winning trades
  and the sum of all losing trades, the standard backtest definitions that
  feed profit factor. These are computed from net P&L and remain fully
  available. They are not "before fees" figures and were never intended to be.

Only the first is affected by this decision. `gross_profit`, `gross_loss` and
`profit_factor` are unchanged for TradingView-sourced runs.

Equity reconstruction is unaffected: it was always built from `netPnl`, which
is the correct basis for a realised equity curve.

## Alternatives considered

**Keep the columns NOT NULL and write `0` for fees.** Rejected: it presents a
strategy as having been tested without costs. Specification 16.1 makes omitted
costs a hard failure, and this would make that failure invisible rather than
detected.

**Derive per-trade fees from the Performance Summary total.** Rejected as
fabrication. The apportionment is only correct when every trade has identical
notional size, which is precisely the assumption the platform exists to
question.

**Parse the Performance Summary and store commission at run scope.** Accepted
in principle and deferred: it is genuinely useful, it is a *run*-scoped fact
rather than a trade-scoped one, and it needs its own adapter. It does not
change this decision, because a run-level total still cannot populate a
per-trade column.

## Consequences

- A TradingView-sourced run has no fee metric and no per-trade gross P&L. The
  UI must render these as "not available from this source" rather than as
  zero, per CLAUDE.md 18.1.
- Commission share of gross profit — a metric specification 12.5 lists under
  trade quality — cannot be computed for TradingView runs, because it needs
  the fee total. It remains computable for local-runner runs.
- Parity comparison between a local run and a TradingView run must compare
  `netPnl` only. Comparing gross would fail on missing data rather than on a
  genuine divergence, which would train operators to ignore parity failures.
- When the local runner lands, the same table holds trades with and without
  fee data. Any query that aggregates fees must therefore filter on non-null
  rather than assume presence.

## Security implications

None. No new data flow, no change to protected-data access.

## Migration / rollback

Migration `0002_nullable_trade_costs.sql` drops the `NOT NULL` constraints on
`trades.gross_pnl` and `trades.fees` and widens the finite-value check to
tolerate nulls. Widening a nullability constraint is forward-safe and requires
no backfill; no rows exist that violate the new shape.

Rolling back requires deciding what to write into the newly-required columns
for TradingView-sourced rows, which is the problem this ADR exists to avoid.
Treat the rollback as unavailable in practice.
