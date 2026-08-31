-- Per-trade gross P&L and fees become nullable. See docs/adr/0002.
--
-- A TradingView "List of Trades" export reports net profit only and carries
-- no per-trade commission column. The three honest options were to store null,
-- to write zero, or to apportion an account-level total across trades. Writing
-- zero would present a strategy as tested without costs, which specification
-- 16.1 treats as a hard failure — making that failure invisible rather than
-- detected. Apportioning invents per-trade values from an aggregate.
--
-- Widening nullability is forward-safe and needs no backfill.

ALTER TABLE trades ALTER COLUMN gross_pnl DROP NOT NULL;
ALTER TABLE trades ALTER COLUMN fees DROP NOT NULL;

-- The finite-value check rejected NaN by asserting x = x, which is NULL (not
-- false) for a null column and would therefore no longer reject anything for
-- those two columns. Restate it so nulls pass and NaN still does not.
ALTER TABLE trades DROP CONSTRAINT trades_pnl_finite;

ALTER TABLE trades
  ADD CONSTRAINT trades_pnl_finite
  CHECK (
    net_pnl = net_pnl
    AND entry_price = entry_price
    AND exit_price = exit_price
    AND quantity = quantity
    AND (gross_pnl IS NULL OR gross_pnl = gross_pnl)
    AND (fees IS NULL OR fees = fees)
  );
