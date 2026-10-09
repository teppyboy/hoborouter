// Task 9: payments routes (member+, workspace-scoped) + manual top-up creation.
// Manual payments are admin-approved: creation is always available (no env
// gate); completion happens via the instance-admin complete endpoint. The
// legacy signed mock webhook stays for pre-existing 'mock' provider rows and
// is never routed for new 'manual' rows.
// payOS: provider=payos creates a pending row + audit atomically, then calls
// payOS for the checkout URL. Return/cancel redirect URLs are display-only —
// /webhooks/payments/payos is the sole credit path.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { requirePositiveSafeInteger } from "@hoborouter/wallet";
import { eq } from "drizzle-orm";
import { workspaces, payments } from "@hoborouter/db";
import {
  PayOSProvider,
  payosConfigFromEnv,
  payosNextOrderCode,
  type PayosConfig,
} from "@hoborouter/payments";
import {
  readPaymentLimits,
  paymentDeadlineMs,
  resolveTopupAmount,
  applyPromoToTopup,
  recordPercentRedemption,
  type PaymentSnapshot,
  type PromoApplyResult,
} from "../payment-creation";

// Human-readable mapping of the promo-apply failure reasons; each maps to a
// specific status so clients can distinguish fixable input (400) from state
// conflicts (409) and authorization (403).
const PROMO_APPLY_STATUS: Record<string, { status: number; code: string; message: string }> = {
  invalid_code: { status: 400, code: "INVALID", message: "promo_code is invalid" },
  not_found: { status: 404, code: "NOT_FOUND", message: "Promo code not found" },
  workspace_suspended: {
    status: 403,
    code: "WORKSPACE_SUSPENDED",
    message: "Workspace is suspended",
  },
  promo_inactive: { status: 409, code: "PROMO_INACTIVE", message: "Promo code is inactive" },
  promo_expired: { status: 409, code: "PROMO_EXPIRED", message: "Promo code is expired" },
  promo_exhausted: { status: 409, code: "PROMO_EXHAUSTED", message: "Promo code has no uses left" },
  already_redeemed: {
    status: 409,
    code: "ALREADY_REDEEMED",
    message: "Promo code already used by this workspace",
  },
  not_percent: {
    status: 409,
    code: "PROMO_NOT_PERCENT",
    message: "Fixed-credit promo codes are redeemed via the redeem endpoint, not checkout",
  },
};

/** Purchase FK columns carried on a bundle/plan/throughput purchase; all absent = plain top-up. */
export interface PayosPurchase {
  bundleId?: string;
  subscriptionPlanId?: string;
  throughputProductId?: string;
  /** Server-catalog USD price text; never client-supplied. Omitted = VND amount. */
  priceUsd?: string;
}

// payOS branch of payment creation: persist pending + audit atomically, then
// create the checkout link. Remote failure marks the row failed and returns a
// safe 502 — no upstream body or credentials ever reach the response.
// Exported so bundle/plan purchase routes reuse the identical pipeline; the
// purchase argument only adds the FK columns and audit fields (both omitted
// for plain top-ups, whose behavior is unchanged).
export const makePayosPaymentCreator =
  (
    db: Db,
    payos: PayosConfig,
    payosFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) =>
  async (
    workspaceId: string,
    userId: string,
    amount: number,
    purchase?: PayosPurchase,
    /** USD top-up input (plain top-ups only): the exact text typed by the payer. */
    usdAmountText?: string,
    /** Optional percent-voucher code (plain top-ups only): consumed atomically with the insert. */
    promoCodeText?: string,
  ) => {
    const id = crypto.randomUUID();
    const orderCode = payosNextOrderCode();
    const now = Date.now();
    // Deadline + cap come from one settings read inside the insert
    // transaction; cap violations and invalid USD input abort the insert
    // before any row exists.
    let snapshot: PaymentSnapshot | null = null;
    let deadlineMs = 0;
    let overCap = false;
    let invalidInput = false;
    // Holder objects: TS narrows bare `let` flags assigned inside the
    // transaction closure back to their initializer at post-transaction
    // reads, so results are read through a stable property instead.
    const promoResult: {
      failure: Extract<PromoApplyResult, { ok: false }> | null;
      voucher: Extract<PromoApplyResult, { ok: true }> | null;
    } = { failure: null, voucher: null };
    let resolvedAmount = 0;
    await db.transaction(async (tx) => {
      const limits = await readPaymentLimits(tx);
      // USD input sources: a plain top-up's payer-typed text, or the server
      // catalog row's price_usd for USD-priced purchases. Purchases without
      // it keep their VND amount; the amount argument is ignored whenever a
      // USD text resolves the charge.
      const usdText = purchase?.priceUsd ?? (purchase ? null : (usdAmountText ?? null));
      const resolved = resolveTopupAmount(usdText === null ? amount : null, usdText, limits);
      if (!resolved.ok) {
        if (resolved.reason === "over_cap") overCap = true;
        else invalidInput = true;
        return;
      }
      deadlineMs = paymentDeadlineMs(now, limits.timeoutMinutes);
      // Percent-voucher apply: explicit promo_code body field, authorized by
      // the same session/workspace gates as the payment itself, checked and
      // locked INSIDE this transaction (workspace → promo lock order). On any
      // failure nothing is inserted — the payment and the redemption commit
      // atomically or not at all.
      if (promoCodeText !== undefined) {
        const applied = await applyPromoToTopup(
          tx,
          workspaceId,
          promoCodeText,
          resolved.amountVnd,
          now,
        );
        if (applied.ok) promoResult.voucher = applied;
        else {
          promoResult.failure = applied;
          return;
        }
      }
      const voucher = promoResult.voucher;
      resolvedAmount = voucher ? voucher.finalDueVnd : resolved.amountVnd;
      snapshot = {
        input_currency: resolved.inputCurrency,
        input_amount_text: resolved.inputAmountText,
        fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd,
      };
      await tx.insert(payments).values({
        id,
        workspace_id: workspaceId,
        // Final due for voucher payments — the payer/provider is charged the
        // discounted amount; settlement credits original_amount_vnd instead.
        amount: resolvedAmount,
        status: "pending",
        provider: "payos",
        provider_order_code: String(orderCode),
        created_at: now,
        expires_at: deadlineMs,
        bundle_id: purchase?.bundleId,
        subscription_plan_id: purchase?.subscriptionPlanId,
        throughput_product_id: purchase?.throughputProductId,
        input_currency: resolved.inputCurrency,
        input_amount_text: resolved.inputAmountText,
        fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd,
        promo_code_id: voucher ? voucher.promoId : null,
        promo_kind: voucher ? "percent" : null,
        original_amount_vnd: voucher ? resolved.amountVnd : null,
        discount_vnd: voucher ? voucher.discountVnd : null,
      });
      if (voucher) {
        await recordPercentRedemption(tx, {
          promoId: voucher.promoId,
          workspaceId,
          paymentId: id,
          uses: 0,
          now,
        });
      }
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId,
        action: "payment.create",
        target: id,
        detail: {
          amount: resolved.amountVnd,
          provider: "payos",
          expires_at: deadlineMs,
          input_currency: resolved.inputCurrency,
          input_amount_text: resolved.inputAmountText,
          ...(resolved.fxRateVndPerUsd !== null
            ? { fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd }
            : {}),
          ...(purchase?.bundleId ? { bundle_id: purchase.bundleId } : {}),
          ...(purchase?.subscriptionPlanId
            ? { subscription_plan_id: purchase.subscriptionPlanId }
            : {}),
          ...(purchase?.throughputProductId
            ? { throughput_product_id: purchase.throughputProductId }
            : {}),
          ...(voucher
            ? {
                promo_code_id: voucher.promoId,
                promo_kind: "percent",
                percent_bp: voucher.percentBp,
                original_amount_vnd: resolved.amountVnd,
                discount_vnd: voucher.discountVnd,
                final_due_vnd: voucher.finalDueVnd,
              }
            : {}),
        },
      });
    });
    if (overCap) {
      return jsonError(400, "INVALID", "payment amount exceeds the configured maximum");
    }
    if (promoResult.failure) {
      const m = PROMO_APPLY_STATUS[promoResult.failure.reason]!;
      return jsonError(m.status, m.code, m.message);
    }
    if (invalidInput || !snapshot) {
      // Server-catalog USD text is DB-validated, so this only rejects an
      // invalid plain top-up usd_amount.
      return jsonError(
        400,
        "INVALID",
        "usd_amount must be a decimal amount with at most 2 decimals",
      );
    }
    // Same canonical base as auth.ts; redirect pages are display-only (the
    // webhook is the sole credit path).
    const base = process.env.BETTER_AUTH_URL || process.env.HBR_BASE_URL || "http://localhost:3000";
    const redirectUrl = `${base}/billing/payments?payment=${id}`;
    const client = new PayOSProvider(
      { clientId: payos.clientId, apiKey: payos.apiKey, checksumKey: payos.checksumKey },
      payosFetch,
    );
    try {
      const created = await client.createPayment({
        paymentId: id,
        amountVnd: resolvedAmount,
        description: "topup",
        orderCode,
        returnUrl: redirectUrl,
        cancelUrl: redirectUrl,
        // Provider-side expiry mirrors the local deadline snapshot.
        expiredAtSec: Math.ceil(deadlineMs / 1000),
      });
      const pv = promoResult.voucher;
      return new Response(
        JSON.stringify({
          id,
          amount: resolvedAmount,
          status: "pending",
          provider: "payos",
          provider_order_code: String(orderCode),
          checkout_url: created.checkoutUrl,
          // Voucher snapshot echo (absent when no promo was applied).
          ...(pv
            ? {
                original_amount_vnd: pv.finalDueVnd + pv.discountVnd,
                discount_vnd: pv.discountVnd,
                promo_code_id: pv.promoId,
              }
            : {}),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch {
      await db.update(payments).set({ status: "failed" }).where(eq(payments.id, id));
      return jsonError(502, "PROVIDER_UNAVAILABLE", "payment provider failed to create checkout");
    }
  };

export const paymentsRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  payos: PayosConfig = payosConfigFromEnv(),
  payosFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>,
) => {
  const createPayosPayment = makePayosPaymentCreator(db, payos, payosFetch);

  return (
    new Elysia({ name: "payments" })
      .post(
        "/api/v1/workspaces/:id/payments",
        {
          params: t.Object({ id: t.String() }),
          body: t.Optional(
            t.Object({
              amount: t.Optional(t.Number()),
              // Optional USD input (plain top-ups only): digits, max 2
              // decimals. Mutually exclusive with `amount`.
              usd_amount: t.Optional(t.String()),
              provider: t.Optional(t.Union([t.Literal("manual"), t.Literal("payos")])),
              // Explicit percent-voucher apply (plain top-ups only). Applied
              // and consumed inside the creation transaction; fixed-credit
              // promo codes are redeem-only and rejected here.
              promo_code: t.Optional(t.String()),
            }),
          ),
          response: t.Object({
            id: t.String(),
            amount: t.Number(),
            status: t.String(),
            provider: t.String(),
            provider_order_code: t.String(),
            checkout_url: t.String(),
            original_amount_vnd: t.Optional(t.Number()),
            discount_vnd: t.Optional(t.Number()),
            promo_code_id: t.Optional(t.String()),
          }),
          detail: {
            tags: ["Payments"],
            summary: "Create payment",
            description:
              "Create a pending top-up. provider=manual (default) is completed only by an instance admin; provider=payos returns a payOS checkout_url when payOS is configured.",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request, params, body }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const userId = gate.session.user.id;
          const denied = await requireWsRole(db, params.id, userId, "member");
          if (denied) return denied;
          const wsRows = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .limit(1);
          if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
          const raw = (body as { amount?: unknown } | null)?.amount;
          const usdRaw = (body as { usd_amount?: unknown } | null)?.usd_amount;
          if (raw !== undefined && usdRaw !== undefined) {
            return jsonError(400, "INVALID", "amount and usd_amount are mutually exclusive");
          }
          const promoRaw = (body as { promo_code?: unknown } | null)?.promo_code;
          if (promoRaw !== undefined && typeof promoRaw !== "string") {
            return jsonError(400, "INVALID", "promo_code must be a string");
          }
          const promoCodeText = promoRaw as string | undefined;
          const usdAmountText = typeof usdRaw === "string" ? usdRaw : null;
          let amount = 0;
          if (usdAmountText === null) {
            try {
              amount = requirePositiveSafeInteger("amount", raw);
            } catch {
              return jsonError(400, "INVALID", "amount must be a positive integer VND amount");
            }
          }
          const providerChoice = (body as { provider?: string } | null)?.provider;
          if (providerChoice === "payos") {
            if (!payos.available) {
              return jsonError(503, "PROVIDER_UNAVAILABLE", "payOS is not configured");
            }
            return createPayosPayment(
              params.id,
              userId,
              amount,
              undefined,
              usdAmountText ?? undefined,
              promoCodeText,
            );
          }
          const id = crypto.randomUUID();
          const orderCode = `MANUAL-${id}`;
          const now = Date.now();
          // Settings (deadline/cap/FX) are read inside the insert transaction:
          // expires_at is a creation-time snapshot and the cap always binds.
          // The percent-voucher (if any) is checked, the payment row and the
          // redemption are written, and uses is incremented in ONE transaction:
          // a lost race rolls back the payment too, so a voucher can never be
          // double-spent and a payment can never exist without its redemption.
          const promoResult: {
            failure: Extract<PromoApplyResult, { ok: false }> | null;
            voucher: Extract<PromoApplyResult, { ok: true }> | null;
            originalAmount: number;
          } = { failure: null, voucher: null, originalAmount: 0 };
          let resolvedAmount = 0;
          let checkoutPath = "";
          let createError: Response | null = null;
          await db.transaction(async (tx) => {
            const limits = await readPaymentLimits(tx);
            const resolved = resolveTopupAmount(amount, usdAmountText, limits);
            if (!resolved.ok) {
              createError = jsonError(400, "INVALID", resolved.message);
              return;
            }
            const deadline = paymentDeadlineMs(now, limits.timeoutMinutes);
            if (promoCodeText !== undefined) {
              const applied = await applyPromoToTopup(
                tx,
                params.id,
                promoCodeText,
                resolved.amountVnd,
                now,
              );
              if (applied.ok) {
                promoResult.voucher = applied;
                promoResult.originalAmount = resolved.amountVnd;
              } else {
                promoResult.failure = applied;
                return;
              }
            }
            const voucher = promoResult.voucher;
            resolvedAmount = voucher ? voucher.finalDueVnd : resolved.amountVnd;
            await tx.insert(payments).values({
              id,
              workspace_id: params.id,
              // Final due for voucher payments: the payer is charged the
              // discounted amount; settlement credits original_amount_vnd.
              amount: resolvedAmount,
              status: "pending",
              provider: "manual",
              provider_order_code: orderCode,
              created_at: now,
              expires_at: deadline,
              input_currency: resolved.inputCurrency,
              input_amount_text: resolved.inputAmountText,
              fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd,
              promo_code_id: voucher ? voucher.promoId : null,
              promo_kind: voucher ? "percent" : null,
              original_amount_vnd: voucher ? resolved.amountVnd : null,
              discount_vnd: voucher ? voucher.discountVnd : null,
            });
            if (voucher) {
              await recordPercentRedemption(tx, {
                promoId: voucher.promoId,
                workspaceId: params.id,
                paymentId: id,
                uses: 0,
                now,
              });
            }
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: params.id,
              action: "payment.create",
              target: id,
              detail: {
                amount: resolvedAmount,
                provider: "manual",
                expires_at: deadline,
                input_currency: resolved.inputCurrency,
                input_amount_text: resolved.inputAmountText,
                ...(resolved.fxRateVndPerUsd !== null
                  ? { fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd }
                  : {}),
                ...(voucher
                  ? {
                      promo_code_id: voucher.promoId,
                      promo_kind: "percent",
                      percent_bp: voucher.percentBp,
                      original_amount_vnd: voucher.finalDueVnd + voucher.discountVnd,
                      discount_vnd: voucher.discountVnd,
                      final_due_vnd: voucher.finalDueVnd,
                    }
                  : {}),
              },
            });
            checkoutPath = `/billing/payments?payment=${id}`;
          });
          if (createError) return createError;
          if (promoResult.failure) {
            const m = PROMO_APPLY_STATUS[promoResult.failure.reason]!;
            return jsonError(m.status, m.code, m.message);
          }
          // No provider checkout: admin approval happens out-of-band; the
          // member tracks status in the billing UI.
          const mv = promoResult.voucher;
          return new Response(
            JSON.stringify({
              id,
              amount: resolvedAmount,
              status: "pending",
              provider: "manual",
              provider_order_code: orderCode,
              checkout_url: checkoutPath,
              // Voucher snapshot echo (absent when no promo was applied).
              ...(mv
                ? {
                    original_amount_vnd: promoResult.originalAmount,
                    discount_vnd: mv.discountVnd,
                    promo_code_id: mv.promoId,
                  }
                : {}),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      )
      .get(
        "/api/v1/workspaces/:id/payments/:paymentId",
        {
          params: t.Object({ id: t.String(), paymentId: t.String() }),
          detail: {
            tags: ["Payments"],
            summary: "Get payment",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request, params }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const userId = gate.session.user.id;
          const denied = await requireWsRole(db, params.id, userId, "member");
          if (denied) return denied;
          const rows = await db
            .select({ workspace_id: payments.workspace_id })
            .from(payments)
            .where(eq(payments.id, params.paymentId))
            .limit(1);
          const row = rows[0];
          if (!row) return jsonError(404, "NOT_FOUND", "Payment not found");
          if (row.workspace_id !== params.id)
            return jsonError(403, "FORBIDDEN", "Payment belongs to another workspace");
          const paymentRows = await db
            .select({
              id: payments.id,
              workspace_id: payments.workspace_id,
              amount: payments.amount,
              status: payments.status,
              provider: payments.provider,
              provider_order_code: payments.provider_order_code,
              created_at: payments.created_at,
              expires_at: payments.expires_at,
              input_currency: payments.input_currency,
              input_amount_text: payments.input_amount_text,
              fx_rate_vnd_per_usd: payments.fx_rate_vnd_per_usd,
              promo_code_id: payments.promo_code_id,
              promo_kind: payments.promo_kind,
              original_amount_vnd: payments.original_amount_vnd,
              discount_vnd: payments.discount_vnd,
            })
            .from(payments)
            .where(eq(payments.id, params.paymentId))
            .limit(1);
          return new Response(JSON.stringify(paymentRows[0]), {
            headers: { "content-type": "application/json" },
          });
        },
      )
      // Safe capability endpoint: which payment providers are enabled plus
      // the display-safe control values (timeout, cap, FX rate). No secrets,
      // no provider configuration detail.
      .get(
        "/api/v1/payment-methods",
        {
          response: t.Object({ manual: t.Boolean(), payos: t.Boolean() }),
          detail: {
            tags: ["Payments"],
            summary: "List available payment methods",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          return new Response(JSON.stringify({ manual: true, payos: payos.available }), {
            headers: { "content-type": "application/json" },
          });
        },
      )
      .get(
        "/api/v1/payment-config",
        {
          response: t.Object({
            timeout_minutes: t.Number(),
            max_amount_vnd: t.Number(),
            usd_vnd_rate: t.Number(),
          }),
          detail: {
            tags: ["Payments"],
            summary: "Get display-safe payment configuration",
            security: [{ cookieAuth: [] }],
          },
        },
        async ({ request }) => {
          const gate = await requireSession(auth, request);
          if (gate.error) return gate.error;
          const limits = await readPaymentLimits(db);
          return new Response(
            JSON.stringify({
              timeout_minutes: limits.timeoutMinutes,
              max_amount_vnd: limits.maxAmountVnd,
              usd_vnd_rate: limits.usdVndRate,
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      )
  );
};
