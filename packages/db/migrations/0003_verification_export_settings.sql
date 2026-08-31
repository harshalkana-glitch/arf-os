-- Capture the export settings on the verification itself.
--
-- A TradingView export carries wall-clock times with no timezone, so reading
-- one requires knowing the chart timezone it was taken in. Holding that as a
-- process-level default on the worker meant the same file could be read
-- differently depending on which worker happened to pick it up, and a wrong
-- zone shifts every trade by hours — enough to move a trade across a segment
-- boundary and quietly contaminate an out-of-sample window.
--
-- Forward-safe in three steps rather than one. `ADD COLUMN ... NOT NULL` with
-- no default fails outright on a table that already has rows, which is not a
-- migration that can be replayed (CLAUDE.md 9.2).

-- 1. Add nullable.
ALTER TABLE tradingview_verifications ADD COLUMN chart_timezone text;--> statement-breakpoint
ALTER TABLE tradingview_verifications ADD COLUMN date_format_day_first boolean;--> statement-breakpoint
ALTER TABLE tradingview_verifications ADD COLUMN initial_capital numeric(28, 10);--> statement-breakpoint

-- 2. Backfill.
--
-- These values are asserted, not known: rows predating this migration were
-- created when the setting did not exist. No production deployment exists, so
-- in practice this covers development and test rows only. If that ever stops
-- being true, the backfill must be replaced by a review of each affected row
-- rather than a blanket default, because claiming a timezone we do not know
-- is exactly the failure this column was added to prevent.
UPDATE tradingview_verifications SET chart_timezone = 'Etc/UTC' WHERE chart_timezone IS NULL;--> statement-breakpoint
UPDATE tradingview_verifications SET initial_capital = 10000 WHERE initial_capital IS NULL;--> statement-breakpoint

-- 3. Enforce.
ALTER TABLE tradingview_verifications ALTER COLUMN chart_timezone SET NOT NULL;--> statement-breakpoint
ALTER TABLE tradingview_verifications ALTER COLUMN initial_capital SET NOT NULL;--> statement-breakpoint

-- Re-stated from migration 0002, which was hand-written and so is not
-- reflected in that migration's schema snapshot. Both are no-ops against a
-- database that has already run 0002; they keep a replay from a clean
-- database consistent with the snapshot.
ALTER TABLE "trades" ALTER COLUMN "gross_pnl" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "fees" DROP NOT NULL;
