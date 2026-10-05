// Promo code redemption (member+, workspace-scoped). POST
// /api/v1/workspaces/:id/promotions/redeem with { code }: validates the code
// against the admin-side contract (normalize trim().toUpperCase(), then
// /^[A-F0-9]{32}$/, SHA-256 — helpers imported from admin-promotions.ts so
// the hash can never drift), then in ONE transaction: lock the promo row FOR
// UPDATE first, then the wallet (creditWallet locks it) — a fixed lock order
// that serializes last-slot races. All checks (active, unexpired,
// uses<max_uses, no prior redemption by this workspace) run after the promo
// lock; the promo_redemptions UNIQUE(promo_code_id, workspace_id) and the
// uses<=max_uses CHECK are the storage-layer backstop, so a lost race rolls
// back the whole transaction (no credit without a committed redemption row —
// the redemption row's ledger_entry_id FK forces credit-before-gate).
// Replay of a committed redemption answers 409 without a second credit.
// Code format/auth failures write nothing. Authorization additionally
// requires an ACTIVE workspace: the status check runs inside the credit
// transaction with the workspace row locked, so a concurrent suspension
// cannot race between the membership check and the credit.
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { promoCodes, promoRedemptions, wallets, workspaces } from "@hoborouter/db";
import { creditWallet } from "@hoborouter/wallet";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, wsRole, writeAudit, jsonError } from "../authz";
import { hashPromoCode } from "./admin-promotions";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Redeem-side half of the admin worker's code contract.
export const normalizePromoCode = (raw: string): string | null => {
  const code = raw.trim().toUpperCase();
  return /^[A-F0-9]{32}$/.test(code) ? code : null;
};

export const promotionsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "promotions" }).post(
    "/api/v1/workspaces/:id/promotions/redeem",
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ code: t.String() }),
      detail: {
        tags: ["Billing"],
        summary: "Redeem a promo code",
        description:
          "Credits the workspace's topup wallet once per (promo code, workspace). Unknown codes answer 404; invalid format 400; inactive/expired/exhausted/already-redeemed 409.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, params, body }) => {
      const gate = await requireSession(auth, request);
      if (gate.error) return gate.error;
      const userId = gate.session.user.id;
      // Unknown workspace AND non-member both answer 404 so workspace
      // existence is not revealed to outsiders (same masking as bundles).
      const role = await wsRole(db, params.id, userId);
      if (!role) return jsonError(404, "NOT_FOUND", "Workspace not found");

      const code = normalizePromoCode(body.code);
      if (!code) return jsonError(400, "INVALID_CODE", "Code must be 32 hex characters");

      const codeHash = hashPromoCode(code);
      const now = Date.now();

      return db.transaction(async (tx) => {
        // Active-workspace gate, row-locked INSIDE the transaction: membership
        // alone (wsRole) is not authorization for money movement. Locking the
        // workspace row first serializes against a concurrent suspension — the
        // check cannot race past a suspend that commits before the credit.
        // Lock order stays consistent (workspace → promo → wallet); no other
        // path acquires a workspace lock after promo/wallet, so no deadlock.
        const wsRows = await tx
          .select({ status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .for("update");
        if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        if (wsRows[0].status !== "active")
          return jsonError(403, "WORKSPACE_SUSPENDED", "Workspace is suspended");

        // Lock the promo row first: concurrent redemptions (last slot,
        // duplicate workspace) serialize here before any money moves.
        const promoRows = await tx
          .select()
          .from(promoCodes)
          .where(eq(promoCodes.code_hash, codeHash))
          .for("update");
        const promo = promoRows[0];
        if (!promo) return jsonError(404, "NOT_FOUND", "Promo code not found");
        if (!promo.active) return jsonError(409, "PROMO_INACTIVE", "Promo code is inactive");
        if (promo.expires_at !== null && promo.expires_at <= now)
          return jsonError(409, "PROMO_EXPIRED", "Promo code is expired");
        if (promo.uses >= promo.max_uses)
          return jsonError(409, "PROMO_EXHAUSTED", "Promo code has no redemptions left");
        const prior = await tx
          .select({ id: promoRedemptions.id })
          .from(promoRedemptions)
          .where(
            and(
              eq(promoRedemptions.promo_code_id, promo.id),
              eq(promoRedemptions.workspace_id, params.id),
            ),
          )
          .limit(1);
        if (prior.length > 0)
          return jsonError(
            409,
            "ALREADY_REDEEMED",
            "Promo code already redeemed by this workspace",
          );

        // Topup wallet only — promo grants never touch the subscription
        // wallet. creditWallet locks the wallet row (fixed promo→wallet order)
        // and its paymentId=null path skips the payment dedup: the
        // promo_redemptions unique index is the replay gate instead.
        const walletRows = await tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(and(eq(wallets.workspace_id, params.id), eq(wallets.kind, "topup")))
          .limit(1);
        const wallet = walletRows[0];
        if (!wallet) return jsonError(409, "WALLET_MISSING", "No wallet for this workspace");

        const amount = Number(promo.amount_vnd);
        const credit = await creditWallet(tx, {
          walletId: wallet.id,
          amount,
          kind: "adjustment",
          paymentId: null,
          memo: `promo:${promo.id}`,
        });

        // The ledger_entry_id FK makes credit-then-insert atomic: if the
        // unique (promo_code_id, workspace_id) gate rejects a concurrent
        // duplicate, this insert fails and the credit rolls back with it.
        const redemptionId = crypto.randomUUID();
        await tx.insert(promoRedemptions).values({
          id: redemptionId,
          promo_code_id: promo.id,
          workspace_id: params.id,
          ledger_entry_id: credit.ledgerEntryId,
          created_at: now,
        });
        // CHECK uses<=max_uses backs this up; the promo row lock makes the
        // increment safe against last-slot races.
        await tx
          .update(promoCodes)
          .set({ uses: promo.uses + 1 })
          .where(eq(promoCodes.id, promo.id));
        await writeAudit(tx, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "promo.redeem",
          target: redemptionId,
          detail: { promo_id: promo.id, credited_vnd: amount },
        });

        return json({
          balance: credit.balanceAfter,
          credited_vnd: amount,
          promo_id: promo.id,
        });
      });
    },
  );
