// Task 8: reservation core — createReservation, releaseHold.
// No settlement, no refund, no dispatch. Holds only.
import type { Database } from "bun:sqlite";
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
      // 1. Authenticated key: exists, active, workspace matches.
      const key = db
        .prepare("SELECT workspace_id, status FROM api_keys WHERE id = ?")
        .get(args.apiKeyId) as { workspace_id: string; status: string } | undefined;
      if (!key || key.status !== "active" || key.workspace_id !== args.workspaceId) {
        throw new WalletError(
          "ownership",
          `api key ${args.apiKeyId} not usable for workspace ${args.workspaceId}`,
        );
      }
      // 2. Wallet: exists, belongs to workspace.
      const wallet = db
        .prepare("SELECT id, workspace_id FROM wallets WHERE id = ?")
        .get(args.walletId) as { id: string; workspace_id: string } | undefined;
      if (!wallet || wallet.workspace_id !== args.workspaceId) {
        throw new WalletError(
          "ownership",
          `wallet ${args.walletId} not owned by workspace ${args.workspaceId}`,
        );
      }
      // 4. Model binding: exists, published, global or owned by workspace.
      const binding = db
        .prepare("SELECT id, workspace_id, status FROM model_bindings WHERE id = ?")
        .get(args.modelBindingId) as
        | { id: string; workspace_id: string | null; status: string }
        | undefined;
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
      const snap = db
        .prepare("SELECT id, binding_id FROM price_snapshots WHERE id = ?")
        .get(args.priceSnapshotId) as { id: string; binding_id: string } | undefined;
      if (!snap || snap.binding_id !== args.modelBindingId) {
        throw new WalletError(
          "ownership",
          `price snapshot ${args.priceSnapshotId} is not of binding ${args.modelBindingId}`,
        );
      }
      // 6. gatewayRequestId uniqueness → conflict.
      if (db.prepare("SELECT 1 FROM requests WHERE id = ?").get(args.gatewayRequestId)) {
        throw new WalletError(
          "conflict",
          `conflict: request id ${args.gatewayRequestId} already exists`,
        );
      }

      // Insert request (pending, pre-dispatch) then reservation, then canonical
      // conditional wallet update — one transaction, all or nothing.
      db.prepare(
        "INSERT INTO requests (id, workspace_id, api_key_id, model_binding_id, endpoint, mode, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      ).run(
        args.gatewayRequestId,
        args.workspaceId,
        args.apiKeyId,
        args.modelBindingId,
        args.endpoint,
        args.mode,
        args.now,
      );

      const reservationId = crypto.randomUUID();
      try {
        db.prepare(
          "INSERT INTO reservations (id, wallet_id, gateway_request_id, api_key_id, price_snapshot_id, status, cap_amount, estimated_input_tokens, created_at) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?)",
        ).run(
          reservationId,
          wallet.id,
          args.gatewayRequestId,
          args.apiKeyId,
          args.priceSnapshotId,
          capAmount,
          args.estimatedInputTokens,
          args.now,
        );
      } catch (err) {
        throw new WalletError("conflict", `reservation insert failed: ${String(err)}`);
      }

      const updated = db
        .prepare(
          "UPDATE wallets SET reserved = reserved + ?, version = version + 1 WHERE id = ? AND balance - reserved >= ?",
        )
        .run(capAmount, wallet.id, capAmount);
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
    const row = db
      .prepare(
        `SELECT r.id, r.wallet_id, r.api_key_id, r.status, r.cap_amount, w.workspace_id AS wallet_ws, rq.workspace_id AS request_ws
         FROM reservations r
         JOIN wallets w ON w.id = r.wallet_id
         LEFT JOIN requests rq ON rq.id = r.gateway_request_id
         WHERE r.id = ?`,
      )
      .get(opts.reservationId) as
      | {
          id: string;
          wallet_id: string;
          api_key_id: string | null;
          status: string;
          cap_amount: number;
          wallet_ws: string;
          request_ws: string | null;
        }
      | undefined;
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
    const cas = db
      .prepare(
        "UPDATE reservations SET status = 'released', resolved_at = ? WHERE id = ? AND status IN ('held','unknown')",
      )
      .run(opts.now, row.id);
    if (cas.changes !== 1) {
      throw new WalletError(
        "terminal",
        `reservation ${row.id} already terminal (status ${row.status})`,
      );
    }
    // Decrease reserved; precondition reserved >= cap.
    const updated = db
      .prepare(
        "UPDATE wallets SET reserved = reserved - ?, version = version + 1 WHERE id = ? AND reserved >= ? AND balance - (reserved - ?) >= 0",
      )
      .run(row.cap_amount, row.wallet_id, row.cap_amount, row.cap_amount);
    if (updated.changes !== 1) {
      throw new WalletError(
        "terminal",
        `wallet ${row.wallet_id} reserved invariant violated on release`,
      );
    }
    // NO ledger row: hold release is not a cash movement.
  });
}
