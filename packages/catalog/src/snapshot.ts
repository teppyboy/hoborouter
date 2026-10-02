// Task 7: publish an immutable price snapshot for a model binding.
// price_snapshots rows are immutable (DB triggers RAISE(ABORT) on UPDATE/DELETE);
// a price change publishes a NEW snapshot, never an edit.
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { modelBindings, orm, priceSnapshots } from "@hoborouter/db";

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
  if (!orm(db).select({ x: modelBindings.id }).from(modelBindings).where(eq(modelBindings.id, bindingId)).get()) {
    throw new Error(`model binding not found: ${bindingId}`);
  }
  const snapshotId = crypto.randomUUID();
  orm(db)
    .insert(priceSnapshots)
    .values({ id: snapshotId, binding_id: bindingId, price_input: priceInput, price_output: priceOutput, created_at: now })
    .run();
  return { snapshotId };
}
