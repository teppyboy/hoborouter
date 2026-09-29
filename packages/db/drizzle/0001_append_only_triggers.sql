CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;
--> statement-breakpoint
-- price_snapshots are immutable; a price change publishes a NEW snapshot
-- referenced by reservations (data-model.md §2).
CREATE TRIGGER price_snapshots_no_update
BEFORE UPDATE ON price_snapshots
BEGIN
  SELECT RAISE(ABORT, 'price_snapshots is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER price_snapshots_no_delete
BEFORE DELETE ON price_snapshots
BEGIN
  SELECT RAISE(ABORT, 'price_snapshots is immutable');
END;
