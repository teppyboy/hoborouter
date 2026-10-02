// Task 8: reservation core — createReservation, releaseHold.
// No settlement, no refund, no dispatch. Holds only.
import type { Database } from "bun:sqlite";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  apiKeys,
  modelBindings,
  orm,
  priceSnapshots,
  requests,
  reservations,
  runChanges,
  wallets,
} from "@hoborouter/db";
import { WalletError, requirePositiveSafeInteger } from "./wallet";
export { WalletError } from "./wallet";

function beginImmediate<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export type CreateReservationArgs = {
  walletId: string;
  workspaceId: string;
  gatewayRequestId: string;
  apiKeyId: string;
  modelBindingId: string;
  endpoint: "/v1/chat/completions" | "/v1/responses";
  mode: "stream" | "non-stream";
  priceSnapshotId: string;
  capAmount: number;
  estimatedInputTokens: number;
  now: number;
};
export type CreateReservationResult =
  | { reservationId: string; requestId: string }
  | { error: "insufficient" };

export function createReservation(
  db: Database,
  args: CreateReservationArgs,
): CreateReservationResult {
  const capAmount = requirePositiveSafeInteger("capAmount", args.capAmount);
  // releaseHold requires the SAME api key that created the hold; a null-key
  // reservation could never be released (only Phase-2 unknown_resolutions could
  // clear it). Require a real key, validated before any SQL.
  if (typeof args.apiKeyId !== "string" || args.apiKeyId === "") {
    throw new WalletError("invalid", `invalid apiKeyId: must be a non-empty string, got ${String(args.apiKeyId)}`);
  }
  if (
    typeof args.estimatedInputTokens !== "number" ||
    !Number.isSafeInteger(args.estimatedInputTokens) ||
    args.estimatedInputTokens < 0
  ) {
    throw new WalletError("invalid", "estimatedInputTokens must be a non-negative safe integer");
  }

  try {
    return beginImmediate(db, () => {
      const db0 = orm(db);
      // 1. Authenticated key: exists, active, workspace matches.
      const key = db0
        .select({ workspace_id: apiKeys.workspace_id, status: apiKeys.status })
        .from(apiKeys)
        .where(eq(apiKeys.id, args.apiKeyId))
        .get();
      if (!key || key.status !== "active" || key.workspace_id !== args.workspaceId) {
        throw new WalletError(
          "ownership",
          `api key ${args.apiKeyId} not usable for workspace ${args.workspaceId}`,
        );
      }
      // 2. Wallet: exists, belongs to workspace.
      const wallet = db0
        .select({ id: wallets.id, workspace_id: wallets.workspace_id })
        .from(wallets)
        .where(eq(wallets.id, args.walletId))
        .get();
      if (!wallet || wallet.workspace_id !== args.workspaceId) {
        throw new WalletError(
          "ownership",
          `wallet ${args.walletId} not owned by workspace ${args.workspaceId}`,
        );
      }
      // 4. Model binding: exists, published, global or owned by workspace.
      const binding = db0
        .select({ id: modelBindings.id, workspace_id: modelBindings.workspace_id, status: modelBindings.status })
        .from(modelBindings)
        .where(eq(modelBindings.id, args.modelBindingId))
        .get();
      if (!binding || binding.status !== "published") {
        throw new WalletError("ownership", `model binding ${args.modelBindingId} not published`);
      }
      if (binding.workspace_id !== null && binding.workspace_id !== args.workspaceId) {
        throw new WalletError(
          "ownership",
          `model binding ${args.modelBindingId} not owned by workspace ${args.workspaceId}`,
        );
      }
      // 5. Snapshot must be a snapshot OF the named binding.
      const snap = db0
        .select({ id: priceSnapshots.id, binding_id: priceSnapshots.binding_id })
        .from(priceSnapshots)
        .where(eq(priceSnapshots.id, args.priceSnapshotId))
        .get();
      if (!snap || snap.binding_id !== args.modelBindingId) {
        throw new WalletError(
          "ownership",
          `price snapshot ${args.priceSnapshotId} is not of binding ${args.modelBindingId}`,
        );
      }
      // 6. gatewayRequestId uniqueness → conflict.
      if (db0.select({ x: requests.id }).from(requests).where(eq(requests.id, args.gatewayRequestId)).get()) {
        throw new WalletError(
          "conflict",
          `conflict: request id ${args.gatewayRequestId} already exists`,
        );
      }

      // Insert request (pending, pre-dispatch) then reservation, then canonical
      // conditional wallet update — one transaction, all or nothing.
      db0
        .insert(requests)
        .values({
          id: args.gatewayRequestId,
          workspace_id: args.workspaceId,
          api_key_id: args.apiKeyId,
          model_binding_id: args.modelBindingId,
          endpoint: args.endpoint,
          mode: args.mode,
          status: "pending",
          created_at: args.now,
        })
        .run();

      const reservationId = crypto.randomUUID();
      try {
        db0
          .insert(reservations)
          .values({
            id: reservationId,
            wallet_id: wallet.id,
            gateway_request_id: args.gatewayRequestId,
            api_key_id: args.apiKeyId,
            price_snapshot_id: args.priceSnapshotId,
            status: "held",
            cap_amount: capAmount,
            estimated_input_tokens: args.estimatedInputTokens,
            created_at: args.now,
          })
          .run();
      } catch (err) {
        throw new WalletError("conflict", `reservation insert failed: ${String(err)}`);
      }

      // Canonical conditional hold: available balance must cover the cap.
      const updated = runChanges(
        db0
          .update(wallets)
          .set({ reserved: sql`${wallets.reserved} + ${capAmount}`, version: sql`${wallets.version} + 1` })
          .where(
            and(
              eq(wallets.id, wallet.id),
              gte(sql`${wallets.balance} - ${wallets.reserved}`, capAmount),
            ),
          ),
      );
      if (updated.changes !== 1) {
        throw new WalletError("insufficient", "insufficient: available balance below cap");
      }
      return { reservationId, requestId: args.gatewayRequestId };
    });
  } catch (err) {
    if (err instanceof WalletError && err.code === "insufficient") return { error: "insufficient" };
    throw err;
  }
}

export function releaseHold(
  db: Database,
  opts: { reservationId: string; apiKeyId: string; workspaceId: string; now: number },
): void {
  beginImmediate(db, () => {
    // Ownership: reservation joined to its request and wallet, all in caller scope.
    const row = orm(db)
      .select({
        id: reservations.id,
        wallet_id: reservations.wallet_id,
        api_key_id: reservations.api_key_id,
        status: reservations.status,
        cap_amount: reservations.cap_amount,
        wallet_ws: wallets.workspace_id,
        request_ws: requests.workspace_id,
      })
      .from(reservations)
      .innerJoin(wallets, eq(wallets.id, reservations.wallet_id))
      .leftJoin(requests, eq(requests.id, reservations.gateway_request_id))
      .where(eq(reservations.id, opts.reservationId))
      .get();
    if (
      !row ||
      row.wallet_ws !== opts.workspaceId ||
      row.request_ws !== opts.workspaceId ||
      row.api_key_id !== opts.apiKeyId
    ) {
      throw new WalletError(
        "ownership",
        `ownership: reservation ${opts.reservationId} not releasable by key ${opts.apiKeyId} in workspace ${opts.workspaceId}`,
      );
    }
    // Terminal CAS: held|unknown → released.
    const cas = runChanges(
      orm(db)
        .update(reservations)
        .set({ status: "released", resolved_at: opts.now })
        .where(and(eq(reservations.id, row.id), inArray(reservations.status, ["held", "unknown"]))),
    );
    if (cas.changes !== 1) {
      throw new WalletError(
        "terminal",
        `reservation ${row.id} already terminal (status ${row.status})`,
      );
    }
    // Decrease reserved; precondition reserved >= cap and balance stays non-negative.
    const updated = runChanges(
      orm(db)
        .update(wallets)
        .set({ reserved: sql`${wallets.reserved} - ${row.cap_amount}`, version: sql`${wallets.version} + 1` })
        .where(
          and(
            eq(wallets.id, row.wallet_id),
            gte(wallets.reserved, row.cap_amount),
            gte(sql`${wallets.balance} - (${wallets.reserved} - ${row.cap_amount})`, 0),
          ),
        ),
    );
    if (updated.changes !== 1) {
      throw new WalletError(
        "terminal",
        `wallet ${row.wallet_id} reserved invariant violated on release`,
      );
    }
    // NO ledger row: hold release is not a cash movement.
  });
}
