// Task 8: reservation core — createReservation, releaseHold.
// No settlement, no refund, no dispatch. Holds only.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import {
  apiKeys,
  modelBindings,
  priceSnapshots,
  requests,
  reservations,
  wallets,
} from "@hoborouter/db";
import {
  WalletError,
  lockWallet,
  requirePositiveSafeInteger,
  runInImmediate,
} from "./wallet";
export { WalletError } from "./wallet";

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

export async function createReservation(
  db: Db | Tx,
  args: CreateReservationArgs,
): Promise<CreateReservationResult> {
  const capAmount = requirePositiveSafeInteger("capAmount", args.capAmount);
  // releaseHold requires the SAME api key that created the hold; a null-key
  // reservation could never be released (only Phase-2 unknown_resolutions could
  // clear it). Require a real key, validated before any SQL.
  if (typeof args.apiKeyId !== "string" || args.apiKeyId === "") {
    throw new WalletError(
      "invalid",
      `invalid apiKeyId: must be a non-empty string, got ${String(args.apiKeyId)}`,
    );
  }
  if (
    typeof args.estimatedInputTokens !== "number" ||
    !Number.isSafeInteger(args.estimatedInputTokens) ||
    args.estimatedInputTokens < 0
  ) {
    throw new WalletError("invalid", "estimatedInputTokens must be a non-negative safe integer");
  }

  try {
    return await runInImmediate(
      db,
      async (tx) => {
        // Wallet row locked FOR UPDATE by runInImmediate — serializes holds.
        // 1. Authenticated key: exists, active, workspace matches.
        const keys = await tx
          .select({ workspace_id: apiKeys.workspace_id, status: apiKeys.status })
          .from(apiKeys)
          .where(eq(apiKeys.id, args.apiKeyId));
        const key = keys[0];
        if (!key || key.status !== "active" || key.workspace_id !== args.workspaceId) {
          throw new WalletError(
            "ownership",
            `api key ${args.apiKeyId} not usable for workspace ${args.workspaceId}`,
          );
        }
        // 2. Wallet: exists, belongs to workspace.
        const ws = await tx
          .select({ id: wallets.id, workspace_id: wallets.workspace_id })
          .from(wallets)
          .where(eq(wallets.id, args.walletId));
        const wallet = ws[0];
        if (!wallet || wallet.workspace_id !== args.workspaceId) {
          throw new WalletError(
            "ownership",
            `wallet ${args.walletId} not owned by workspace ${args.workspaceId}`,
          );
        }
        // 4. Model binding: exists, published, global or owned by workspace.
        const bindings = await tx
          .select({
            id: modelBindings.id,
            workspace_id: modelBindings.workspace_id,
            status: modelBindings.status,
          })
          .from(modelBindings)
          .where(eq(modelBindings.id, args.modelBindingId));
        const binding = bindings[0];
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
        const snaps = await tx
          .select({ id: priceSnapshots.id, binding_id: priceSnapshots.binding_id })
          .from(priceSnapshots)
          .where(eq(priceSnapshots.id, args.priceSnapshotId));
        const snap = snaps[0];
        if (!snap || snap.binding_id !== args.modelBindingId) {
          throw new WalletError(
            "ownership",
            `price snapshot ${args.priceSnapshotId} is not of binding ${args.modelBindingId}`,
          );
        }
        // 6. gatewayRequestId uniqueness → conflict.
        const dup = await tx
          .select({ x: requests.id })
          .from(requests)
          .where(eq(requests.id, args.gatewayRequestId));
        if (dup.length > 0) {
          throw new WalletError(
            "conflict",
            `conflict: request id ${args.gatewayRequestId} already exists`,
          );
        }

        // Insert request (pending, pre-dispatch) then reservation, then canonical
        // conditional wallet update — one transaction, all or nothing.
        await tx.insert(requests).values({
          id: args.gatewayRequestId,
          workspace_id: args.workspaceId,
          api_key_id: args.apiKeyId,
          model_binding_id: args.modelBindingId,
          endpoint: args.endpoint,
          mode: args.mode,
          status: "pending",
          created_at: args.now,
        });

        const reservationId = crypto.randomUUID();
        await tx.insert(reservations).values({
          id: reservationId,
          wallet_id: wallet.id,
          gateway_request_id: args.gatewayRequestId,
          api_key_id: args.apiKeyId,
          price_snapshot_id: args.priceSnapshotId,
          status: "held",
          cap_amount: capAmount,
          estimated_input_tokens: args.estimatedInputTokens,
          created_at: args.now,
        });

        // Canonical conditional hold: available balance must cover the cap.
        // CAS: 0 returning rows = insufficient available balance.
        const updated = await tx
          .update(wallets)
          .set({
            reserved: sql`${wallets.reserved} + ${capAmount}`,
            version: sql`${wallets.version} + 1`,
          })
          .where(
            and(
              eq(wallets.id, wallet.id),
              gte(sql`${wallets.balance} - ${wallets.reserved}`, capAmount),
            ),
          )
          .returning({ id: wallets.id });
        if (updated.length !== 1) {
          throw new WalletError("insufficient", "insufficient: available balance below cap");
        }
        return { reservationId, requestId: args.gatewayRequestId };
      },
      { walletId: args.walletId },
    );
  } catch (err) {
    if (err instanceof WalletError && err.code === "insufficient") return { error: "insufficient" };
    throw err;
  }
}

export async function releaseHold(
  db: Db | Tx,
  opts: { reservationId: string; apiKeyId: string; workspaceId: string; now: number },
): Promise<void> {
  await runInImmediate(
    db,
    async (tx) => {
      // Ownership: reservation joined to its request and wallet, all in caller scope.
      const rows = await tx
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
        .where(eq(reservations.id, opts.reservationId));
      const row = rows[0];
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
      await lockWallet(tx, row.wallet_id);
      // Terminal CAS: held|unknown → released.
      const cas = await tx
        .update(reservations)
        .set({ status: "released", resolved_at: opts.now })
        .where(and(eq(reservations.id, row.id), inArray(reservations.status, ["held", "unknown"])))
        .returning({ id: reservations.id });
      if (cas.length !== 1) {
        throw new WalletError(
          "terminal",
          `reservation ${row.id} already terminal (status ${row.status})`,
        );
      }
      // Decrease reserved; precondition reserved >= cap and balance stays non-negative.
      const updated = await tx
        .update(wallets)
        .set({
          reserved: sql`${wallets.reserved} - ${row.cap_amount}`,
          version: sql`${wallets.version} + 1`,
        })
        .where(
          and(
            eq(wallets.id, row.wallet_id),
            gte(wallets.reserved, row.cap_amount),
            gte(sql`${wallets.balance} - (${wallets.reserved} - ${row.cap_amount})`, 0),
          ),
        )
        .returning({ id: wallets.id });
      if (updated.length !== 1) {
        throw new WalletError(
          "terminal",
          `wallet ${row.wallet_id} reserved invariant violated on release`,
        );
      }
      // NO ledger row: hold release is not a cash movement.
    },
    { walletId: undefined },
  );
}
