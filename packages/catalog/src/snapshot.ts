// Task 7: publish an immutable price snapshot for a model binding.
// price_snapshots rows are immutable (DB triggers RAISE(ABORT) on UPDATE/DELETE);
// a price change publishes a NEW snapshot, never an edit.
import type { Database } from "bun:sqlite";

export function publishSnapshot(
  db: Database,
  opts: { bindingId: string; priceInput: number; priceOutput: number; now: number },
): { snapshotId: string } {
  const { bindingId, priceInput, priceOutput, now } = opts;
  for (const [name, v] of [
    ["priceInput", priceInput],
    ["priceOutput", priceOutput],
  ] as const) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (!db.prepare("SELECT 1 FROM model_bindings WHERE id = ?").get(bindingId)) {
    throw new Error(`model binding not found: ${bindingId}`);
  }
  const snapshotId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO price_snapshots (id, binding_id, price_input, price_output, created_at) VALUES (?,?,?,?,?)",
  ).run(snapshotId, bindingId, priceInput, priceOutput, now);
  return { snapshotId };
}
