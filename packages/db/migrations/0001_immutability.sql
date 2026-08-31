-- Immutability and append-only enforcement.
--
-- CLAUDE.md 3.1 forbids mutating a tested strategy version, and 9.4 requires
-- the audit log to be append-only "through the application". Enforcing both
-- only in application code means one careless repository method, one migration
-- script, or one hotfix psql session silently destroys the property the whole
-- platform rests on. These triggers make that a database error instead.
--
-- The application layer still enforces the same rules, and should still
-- produce a typed domain error rather than relying on these. This is the
-- backstop, not the primary check.

-- ---------------------------------------------------------------------------
-- Audit log: insert only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION arf_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted (ARF audit invariant)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

-- ---------------------------------------------------------------------------
-- Strategy versions: content frozen once tested.
--
-- The lifecycle state must keep moving (PINE_DEVELOPMENT ->
-- TRADINGVIEW_VERIFICATION -> ...), so this does not freeze the whole row.
-- It freezes the columns that determine *what was tested*: identity, lineage
-- and the three content hashes. Once a run exists against this version, those
-- bytes are what the evidence refers to and they can never change.
--
-- contaminated_dataset_ids is deliberately still mutable: marking data as
-- contaminated after the fact is a protective annotation, and spec 26's
-- "never mark reused data as unseen" is served by allowing contamination to
-- be added, never removed. The trigger enforces that direction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION arf_strategy_version_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD.first_tested_at IS NOT NULL THEN
    IF NEW.strategy_id       IS DISTINCT FROM OLD.strategy_id
    OR NEW.version_number    IS DISTINCT FROM OLD.version_number
    OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
    OR NEW.definition_hash   IS DISTINCT FROM OLD.definition_hash
    OR NEW.manifest_hash     IS DISTINCT FROM OLD.manifest_hash
    OR NEW.pine_source_hash  IS DISTINCT FROM OLD.pine_source_hash
    THEN
      RAISE EXCEPTION
        'Strategy version % has been tested; its identity and content hashes are immutable. Create a child version instead.',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- first_tested_at records when evidence first attached. Clearing or
    -- moving it would let the freeze above be lifted.
    IF NEW.first_tested_at IS DISTINCT FROM OLD.first_tested_at THEN
      RAISE EXCEPTION
        'first_tested_at is write-once (strategy version %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Contamination is append-only in both directions of the lifecycle: a
  -- dataset that has been seen can never be un-seen.
  IF NOT (OLD.contaminated_dataset_ids <@ NEW.contaminated_dataset_ids) THEN
    RAISE EXCEPTION
      'contaminated_dataset_ids may only be added to (strategy version %); reused data can never be marked unseen',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_versions_immutability
  BEFORE UPDATE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION arf_strategy_version_immutability();

-- A tested version is evidence. Deleting it would orphan every run, report
-- and decision that refers to it.
CREATE TRIGGER strategy_versions_no_delete
  BEFORE DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

-- ---------------------------------------------------------------------------
-- Definitions and Pine revisions: write-once.
--
-- Both are uniquely keyed to a strategy version, so "edit the SDL" must mean
-- "create a new version", which is exactly CLAUDE.md 3.1.
-- ---------------------------------------------------------------------------

CREATE TRIGGER strategy_definitions_no_update
  BEFORE UPDATE ON strategy_definitions
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

CREATE TRIGGER pine_revisions_no_update
  BEFORE UPDATE ON pine_revisions
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

-- ---------------------------------------------------------------------------
-- Committee decisions: append-only.
--
-- Spec 7.9: a judge cannot change thresholds retrospectively, and a decision
-- is a record of what was believed at a point in time. Revisiting a decision
-- creates a new decision row; it never edits the old one.
-- ---------------------------------------------------------------------------

CREATE TRIGGER committee_decisions_no_update
  BEFORE UPDATE ON committee_decisions
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

CREATE TRIGGER committee_decisions_no_delete
  BEFORE DELETE ON committee_decisions
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

-- ---------------------------------------------------------------------------
-- Trades: a run's ledger is fixed once written.
--
-- Re-parsing a report produces a new run, never an edit of an existing one,
-- so that a metric snapshot always refers to a ledger that still exists in
-- the form it was computed from.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trades_no_update
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION arf_reject_mutation();

-- ---------------------------------------------------------------------------
-- Money columns must be finite.
--
-- numeric accepts 'NaN', which would propagate silently through decimal
-- arithmetic and poison an equity curve. CLAUDE.md 14 forbids silently
-- dropping NaN; this stops it entering at all.
-- ---------------------------------------------------------------------------

ALTER TABLE trades
  ADD CONSTRAINT trades_pnl_finite
  CHECK (
    gross_pnl = gross_pnl AND fees = fees AND net_pnl = net_pnl
    AND entry_price = entry_price AND exit_price = exit_price
    AND quantity = quantity
  );

ALTER TABLE equity_points
  ADD CONSTRAINT equity_points_finite
  CHECK (equity = equity AND peak = peak AND drawdown = drawdown);

-- Drawdown is defined as equity - peak, so it is never positive.
ALTER TABLE equity_points
  ADD CONSTRAINT equity_points_drawdown_not_positive
  CHECK (drawdown <= 0);

-- A metric is either a value or an explained absence, never both and never
-- neither (CLAUDE.md 14: no silent nulls).
ALTER TABLE metric_snapshots
  ADD CONSTRAINT metric_snapshots_value_xor_reason
  CHECK ((value IS NULL) = (null_reason IS NOT NULL));

-- A human override must carry a reason (CLAUDE.md 3.4, spec 7.9).
ALTER TABLE committee_decisions
  ADD CONSTRAINT committee_decisions_override_reason
  CHECK (human_override::boolean = false OR override_reason IS NOT NULL);
