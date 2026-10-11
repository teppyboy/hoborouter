// Promo code redemption + side-effect-free preview (member+, workspace-
// scoped). Code normalization/hash come from the canonical promo-code helper
// (unified-promos spec §3): outer trim, whole-string uppercase, interior
// verbatim, SHA-256 of the normalized value exactly once — case/whitespace
// variants resolve to the same hash and therefore the same promo, and legacy
// 32-hex hashes are byte-identical.
//
// Redeem: in ONE transaction, lock the promo row FOR UPDATE first, then the
// wallet (creditWallet locks it) — a fixed lock order that serializes
// last-slot races. All checks (kind, active, unexpired, uses<max_uses, no
// prior redemption by this workspace) run after the promo lock; the
// promo_redemptions UNIQUE(promo_code_id, workspace_id) and the
// uses<=max_uses CHECK are the storage-layer backstop, so a lost race rolls
// back the whole transaction (no credit without a committed redemption row —
// the redemption row's ledger_entry_id FK forces credit-before-gate). Replay
// of a committed redemption answers 409 without a second credit. The kind
// guard runs immediately after the promo row lock and before any other state
// access: a percent code has amount_vnd = NULL, which previously reached
// creditWallet and surfaced as an unhandled 500 (atomic rollback, but the
// status was wrong). Code format/auth failures write nothing.
// Authorization additionally requires an ACTIVE workspace: the status check
// runs inside the credit transaction with the workspace row locked, so a
// concurrent suspension cannot race between the membership check and the
// credit.
//
// Preview (POST .../promotions/preview): strictly READ-ONLY — no
// transaction, no row lock, no uses increment, no redemption/ledger rows,
// even on error paths. Uniform 404 masking for unknown/non-member; money
// routes revalidate every gate under FOR UPDATE, so a stale preview is
// advisory only.
import { Elysia, t } from "elysia";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { promoCodes, promoRedemptions, wallets, workspaces } from "@hoborouter/db";
import { creditWallet } from "@hoborouter/wallet";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, wsRole, writeAudit, jsonError } from "../authz";
import { hashPromoCode, normalizePromoCode } from "../promo-code";
import { computePercentDiscountVnd } from "../payment-creation";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const redeemGates = (promo: typeof promoCodes.$inferSelect, now: number): Response | null => {
  if (!promo.active) return jsonError(409, "PROMO_INACTIVE", "Promo code is inactive");
  if (promo.expires_at !== null && promo.expires_at <= now)
    return jsonError(409, "PROMO_EXPIRED", "Promo code is expired");
  if (promo.uses >= promo.max_uses)
    return jsonError(409, "PROMO_EXHAUSTED", "Promo code has no redemptions left");
  return null;
};

export const promotionsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "promotions" })
    .post(
      "/api/v1/workspaces/:id/promotions/redeem",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ code: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Redeem a promo code",
          description:
            "Credits the workspace's topup wallet once per (promo code, workspace). Unknown codes answer 404; invalid format 400; wrong kind (percent at redeem) 409 PROMO_WRONG_KIND; inactive/expired/exhausted/already-redeemed 409.",
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
        if (!code) return jsonError(400, "INVALID_CODE", "Invalid promo code");

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
            // Soft-removed codes are invisible to redemption: they answer
            // 404 NOT_FOUND like unknown codes instead of 409 gate errors.
            .where(and(eq(promoCodes.code_hash, codeHash), isNull(promoCodes.deleted_at)))
            .for("update");
          const promo = promoRows[0];
          if (!promo) return jsonError(404, "NOT_FOUND", "Promo code not found");
          // Kind guard BEFORE any other state access (spec §2): percent rows
          // carry no fixed amount; crediting one would throw in creditWallet
          // and roll back as a 500.
          if (promo.kind !== "fixed")
            return jsonError(
              409,
              "PROMO_WRONG_KIND",
              "This code is a topup discount; apply it at checkout",
            );
          const gateErr = redeemGates(promo, now);
          if (gateErr) return gateErr;
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
    )
    .post(
      "/api/v1/workspaces/:id/promotions/preview",
      {
        params: t.Object({ id: t.String() }),
        // Permissive body + manual checks: exact 400 INVALID_CODE /
        // INVALID_AMOUNT contract instead of Elysia's schema-level 422.
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Billing"],
          summary: "Preview a promo code (read-only)",
          description:
            "Resolves a code to its promo without any side effect. Fixed codes return the credit amount; percent codes return basis points + cap, with discount math only when original_amount_vnd is supplied. Redemption/topup revalidates every gate under lock.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const userId = gate.session.user.id;
        const role = await wsRole(db, params.id, userId);
        if (!role) return jsonError(404, "NOT_FOUND", "Workspace not found");

        const b = (body ?? {}) as Record<string, unknown>;
        const rawCode = b.code;
        if (typeof rawCode !== "string")
          return jsonError(400, "INVALID_CODE", "Invalid promo code");
        const code = normalizePromoCode(rawCode);
        if (!code) return jsonError(400, "INVALID_CODE", "Invalid promo code");

        const rawAmount = b.original_amount_vnd;
        let originalAmount: number | undefined;
        if (rawAmount !== undefined) {
          if (typeof rawAmount !== "number" || !Number.isSafeInteger(rawAmount) || rawAmount <= 0)
            return jsonError(
              400,
              "INVALID_AMOUNT",
              "original_amount_vnd must be a positive integer VND amount",
            );
          originalAmount = rawAmount;
        }

        // Active-workspace gate, READ-ONLY: no row lock (preview writes
        // nothing and must not take one); the money routes revalidate the
        // workspace status under FOR UPDATE before any movement.
        const wsRows = await db
          .select({ status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        if (wsRows[0].status !== "active")
          return jsonError(403, "WORKSPACE_SUSPENDED", "Workspace is suspended");

        const codeHash = hashPromoCode(code);
        const now = Date.now();
        const promoRows = await db
          .select()
          .from(promoCodes)
          // Same soft-delete invisibility as redeem: deleted = unknown (404).
          .where(and(eq(promoCodes.code_hash, codeHash), isNull(promoCodes.deleted_at)))
          .limit(1);
        const promo = promoRows[0];
        if (!promo) return jsonError(404, "NOT_FOUND", "Promo code not found");
        const gateErr = redeemGates(promo, now);
        if (gateErr) return gateErr;
        // Same once-per-(code, workspace) gate as redeem — but as a plain
        // SELECT: no insert, no lock, no increment.
        const prior = await db
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

        if (promo.kind === "percent") {
          // CHECK pc_kind guarantees percent_bp > 0 and max_discount_vnd > 0.
          const percentBp = promo.percent_bp!;
          const cap = Number(promo.max_discount_vnd!);
          const base = {
            kind: "percent",
            promo_id: promo.id,
            name: promo.name,
            percent_bp: percentBp,
            max_discount_vnd: cap,
          };
          if (originalAmount === undefined) return json(base);
          // Server-only money math (integer VND floor + cap); the client
          // never computes money.
          const { discountVnd, finalDueVnd } = computePercentDiscountVnd(
            originalAmount,
            percentBp,
            cap,
          );
          return json({ ...base, discount_vnd: discountVnd, final_due_vnd: finalDueVnd });
        }
        return json({
          kind: "fixed",
          promo_id: promo.id,
          name: promo.name,
          amount_vnd: Number(promo.amount_vnd),
        });
      },
    );
