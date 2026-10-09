// Instance-admin CRUD for credit bundles and subscription plans. No delete:
// catalog items are deactivated (active=false); past payments keep their FK.
// Amounts are immutable after create — settlement reads them at payment
// success time, so editing a price would silently change what pending
// payments credit; a price change means deactivate + create a new item.
import { Elysia, t } from "elysia";
import type { Db, Tx } from "@hoborouter/db";
import { creditBundles, MAX_SAFE_INTEGER_MONEY, subscriptionPlans } from "@hoborouter/db";
import { desc, eq } from "drizzle-orm";
import { parseUsdCents, usdCentsToVndCeiling } from "@hoborouter/payments";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";
import { readPaymentLimits } from "../payment-creation";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Replay key for a financial revision: sha256 over resource kind + acting
// admin + target row + the canonical resolved request. Deterministic, so an
// identical resubmission maps to the SAME successor row (the partial unique
// index on revision_key arbitrates); any different payload or actor yields a
// different key and is rejected as a conflict on an already-superseded row.
const revisionKeyFor = (
  resource: "bundle" | "plan",
  actorUserId: string,
  targetId: string,
  canonical: unknown,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${resource}\u0000${actorUserId}\u0000${targetId}\u0000${JSON.stringify(canonical)}`)
    .digest("hex");

// No-op equivalence for one money field: a USD-authored field matches when
// the canonical USD text is identical (same authored terms — the stored VND
// stays the frozen conversion, so FX drift must not turn a resubmission into
// a revision); a VND-authored field matches only a legacy VND-authored old
// field with the same integer. Mixed authoring-form changes always revise.
const moneyEquivalent = (field: FieldAmount, oldVnd: number, oldUsd: string | null): boolean =>
  field.usd !== null ? oldUsd === field.usd : oldUsd === null && oldVnd === field.vnd;

const posInt = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const nonNegInt = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// Mirrors the subscription_plans rate_limit CHECK; not a money amount, so it
// stays PATCH-editable on existing plans.
const validRateLimit = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 600;

// Per-field mixed currency authoring: each money field is independently USD
// text or VND integer — never both variants of one field. USD texts convert
// ONCE to integer VND at the shared creation FX read inside the insert
// transaction and are frozen forever after (a later FX change only affects
// checkout price, never already-promised grants). Stored *_usd records only
// fields authored in USD — it is never fabricated for a VND-authored field.
// The payment cap is deliberately NOT applied here: it bounds a single
// checkout, not catalog item size.

// Strip redundant integer-part leading zeros ("0009.99" -> "9.99") so stored
// texts are canonical for display; the DB regex tolerates them, the API does
// not store them.
const canonicalUsd = (text: string): string => {
  const trimmed = text.trim();
  const dot = trimmed.indexOf(".");
  const intPart = (dot === -1 ? trimmed : trimmed.slice(0, dot)).replace(/^0+(?=\d)/, "");
  return dot === -1 ? intPart : `${intPart}.${trimmed.slice(dot + 1)}`;
};

type FieldParse = { ok: true; vnd: number; usd: string | null } | { ok: false; message: string };

interface FieldAmount {
  vnd: number;
  // Exact authored USD text, or null when the field was authored in VND.
  usd: string | null;
}

// Parse+validate one authored USD text and convert it once at the shared
// creation FX. price must be positive; grants may be zero (usdCentsToVndCeiling
// rejects non-positive cents, so zero grants are short-circuited to 0
// explicitly). Oversized text/conversion parse to null and fail closed. The
// caller must convert, insert, and audit inside ONE transaction so the stored
// row and its audit share one FX snapshot (never a second transaction).
const convertUsdField = (
  text: string,
  label: string,
  positive: boolean,
  fxRateVndPerUsd: number,
): FieldParse => {
  const cents = parseUsdCents(text);
  if (cents === null)
    return {
      ok: false,
      message: `${label} must be a decimal amount with at most 2 decimals`,
    };
  if (positive && cents <= 0n)
    return {
      ok: false,
      message: `${label} must be a positive decimal amount with at most 2 decimals`,
    };
  const vnd = cents === 0n ? 0 : usdCentsToVndCeiling(cents, fxRateVndPerUsd);
  if (vnd === null)
    return {
      ok: false,
      message: "USD amounts exceed the maximum supported money value",
    };
  return { ok: true, vnd, usd: canonicalUsd(text) };
};

const vndField = (vnd: number): FieldParse => ({ ok: true, vnd, usd: null });

const resolveMixedBundleAmounts = async (
  tx: Tx,
  body: {
    price_vnd?: number;
    credit_vnd?: number;
    bonus_vnd?: number;
    price_usd?: string;
    credit_usd?: string;
    bonus_usd?: string;
  },
): Promise<
  | {
      ok: true;
      price: FieldAmount;
      credit: FieldAmount;
      bonus: FieldAmount;
      fxRateVndPerUsd: number;
    }
  | { ok: false; message: string }
> => {
  const { usdVndRate } = await readPaymentLimits(tx);
  const conv = (text: string, label: string, positive: boolean): FieldParse =>
    convertUsdField(text, label, positive, usdVndRate);
  const price: FieldParse =
    body.price_usd !== undefined
      ? conv(body.price_usd, "price_usd", true)
      : vndField(body.price_vnd!);
  if (!price.ok) return price;
  const credit: FieldParse =
    body.credit_usd !== undefined
      ? conv(body.credit_usd, "credit_usd", false)
      : vndField(body.credit_vnd!);
  if (!credit.ok) return credit;
  const bonus: FieldParse =
    body.bonus_usd !== undefined
      ? conv(body.bonus_usd, "bonus_usd", false)
      : vndField(body.bonus_vnd ?? 0);
  if (!bonus.ok) return bonus;
  // Individually bounded grants can still overflow TOGETHER (settlement would
  // credit an impossible amount). BigInt sum, never Number addition.
  if (BigInt(credit.vnd) + BigInt(bonus.vnd) > BigInt(MAX_SAFE_INTEGER_MONEY))
    return {
      ok: false,
      message: "bundle credit and bonus grants together exceed the maximum supported money value",
    };
  return {
    ok: true,
    price: { vnd: price.vnd, usd: price.usd },
    credit: { vnd: credit.vnd, usd: credit.usd },
    bonus: { vnd: bonus.vnd, usd: bonus.usd },
    fxRateVndPerUsd: usdVndRate,
  };
};

const resolveMixedPlanAmounts = async (
  tx: Tx,
  body: {
    price_vnd?: number;
    credit_per_period_vnd?: number;
    price_usd?: string;
    credit_per_period_usd?: string;
  },
): Promise<
  | { ok: true; price: FieldAmount; credit: FieldAmount; fxRateVndPerUsd: number }
  | { ok: false; message: string }
> => {
  const { usdVndRate } = await readPaymentLimits(tx);
  const conv = (text: string, label: string, positive: boolean): FieldParse =>
    convertUsdField(text, label, positive, usdVndRate);
  const price: FieldParse =
    body.price_usd !== undefined
      ? conv(body.price_usd, "price_usd", true)
      : vndField(body.price_vnd!);
  if (!price.ok) return price;
  const credit: FieldParse =
    body.credit_per_period_usd !== undefined
      ? conv(body.credit_per_period_usd, "credit_per_period_usd", false)
      : vndField(body.credit_per_period_vnd!);
  if (!credit.ok) return credit;
  return {
    ok: true,
    price: { vnd: price.vnd, usd: price.usd },
    credit: { vnd: credit.vnd, usd: credit.usd },
    fxRateVndPerUsd: usdVndRate,
  };
};

// Per-field mixed currency: reject a field that names both currency variants,
// and require price/credit in exactly one variant each (bundle bonus may be
// omitted and defaults to zero).
const bundleFieldError = (body: Record<string, unknown>): string | null => {
  for (const field of ["price", "credit", "bonus"] as const) {
    const vndKey = `${field}_vnd`;
    const usdKey = `${field}_usd`;
    if (body[vndKey] !== undefined && body[usdKey] !== undefined)
      return `cannot set both ${vndKey} and ${usdKey} for one field`;
  }
  if (body.price_vnd === undefined && body.price_usd === undefined)
    return "bundle requires price_vnd or price_usd";
  if (body.credit_vnd === undefined && body.credit_usd === undefined)
    return "bundle requires credit_vnd or credit_usd";
  return null;
};

export const adminBundlesRoutes = (db: Db, auth: BetterAuthInstance) => {
  const guard = async (request: Request) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return { error: gate.error } as const;
    const denied = await requireInstanceAdmin(db, gate.session.user.id);
    if (denied) return { error: denied } as const;
    return { userId: gate.session.user.id } as const;
  };

  const bundleRoutes = new Elysia({ name: "admin-bundles" })
    .get(
      "/api/v1/admin/bundles",
      {
        detail: { tags: ["Admin"], summary: "List credit bundles", security: [{ cookieAuth: [] }] },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db.select().from(creditBundles).orderBy(desc(creditBundles.created_at));
        return json({ data: rows });
      },
    )
    .post(
      "/api/v1/admin/bundles",
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          price_vnd: t.Optional(t.Integer()),
          credit_vnd: t.Optional(t.Integer()),
          bonus_vnd: t.Optional(t.Integer()),
          price_usd: t.Optional(t.String()),
          credit_usd: t.Optional(t.String()),
          bonus_usd: t.Optional(t.String()),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create credit bundle",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const usdError = bundleFieldError(body);
        if (usdError) return jsonError(400, "INVALID", usdError);
        const hasAnyUsd =
          body.price_usd !== undefined ||
          body.credit_usd !== undefined ||
          body.bonus_usd !== undefined;
        // A fully USD-authored body keeps the committed all-USD default
        // (bonus_usd "0"); mixed bodies default the bonus to zero VND and
        // leave bonus_usd NULL — never fabricate USD text for a VND grant.
        const allUsd =
          body.price_usd !== undefined &&
          body.credit_usd !== undefined &&
          body.price_vnd === undefined &&
          body.credit_vnd === undefined &&
          body.bonus_vnd === undefined;
        const normalized = { ...body, bonus_usd: body.bonus_usd ?? (allUsd ? "0" : undefined) };
        const id = crypto.randomUUID();
        if (hasAnyUsd) {
          // VND-side values validate before the transaction so rejections
          // never open one; USD-side values validate inside (they need the FX
          // read). ONE transaction owns FX read, amount derivation, insert,
          // and audit: the stored row and its audit always share one FX
          // snapshot. Validation failures return before any write, so no
          // rollback is needed and nothing (row/audit) is persisted.
          if (body.price_vnd !== undefined && !posInt(body.price_vnd))
            return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
          if (body.credit_vnd !== undefined && !nonNegInt(body.credit_vnd))
            return jsonError(400, "INVALID", "credit_vnd must be a non-negative integer");
          if (body.bonus_vnd !== undefined && !nonNegInt(body.bonus_vnd))
            return jsonError(400, "INVALID", "bonus_vnd must be a non-negative integer");
          const result = await db.transaction(async (tx) => {
            const resolved = await resolveMixedBundleAmounts(tx, normalized);
            if (!resolved.ok) return { ok: false, message: resolved.message } as const;
            const row: Record<string, unknown> = {
              id,
              name: body.name,
              price_vnd: resolved.price.vnd,
              credit_vnd: resolved.credit.vnd,
              bonus_vnd: resolved.bonus.vnd,
              active: true,
              created_at: Date.now(),
              price_usd: resolved.price.usd,
              credit_usd: resolved.credit.usd,
              bonus_usd: resolved.bonus.usd,
              creation_fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd,
            };
            await tx.insert(creditBundles).values(row as typeof creditBundles.$inferInsert);
            await writeAudit(tx, {
              actorUserId: g.userId,
              workspaceId: null,
              action: "bundle.create",
              target: id,
              detail: row,
            });
            return { ok: true, row } as const;
          });
          if (!result.ok) return jsonError(400, "INVALID", result.message);
          return json(result.row, 201);
        }
        {
          if (!posInt(body.price_vnd))
            return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
          if (!nonNegInt(body.credit_vnd) || !nonNegInt(body.bonus_vnd ?? 0))
            return jsonError(
              400,
              "INVALID",
              "credit_vnd and bonus_vnd must be non-negative integers",
            );
          // Same aggregate bound as the USD path: individually valid grants
          // must not overflow in sum (BigInt, never Number addition).
          if (
            BigInt(body.credit_vnd) + BigInt(body.bonus_vnd ?? 0) >
            BigInt(MAX_SAFE_INTEGER_MONEY)
          )
            return jsonError(
              400,
              "INVALID",
              "credit_vnd and bonus_vnd together exceed the maximum supported money value",
            );
          const row: Record<string, unknown> = {
            id,
            name: body.name,
            price_vnd: body.price_vnd,
            credit_vnd: body.credit_vnd,
            bonus_vnd: body.bonus_vnd ?? 0,
            active: true,
            created_at: Date.now(),
            // Legacy VND row: explicit NULL USD group in the response (DB
            // columns are already NULL), symmetric with USD-authored rows.
            price_usd: null,
            credit_usd: null,
            bonus_usd: null,
            creation_fx_rate_vnd_per_usd: null,
          };
          await db.transaction(async (tx) => {
            await tx.insert(creditBundles).values(row as typeof creditBundles.$inferInsert);
            await writeAudit(tx, {
              actorUserId: g.userId,
              workspaceId: null,
              action: "bundle.create",
              target: id,
              detail: row,
            });
          });
          return json(row, 201);
        }
      },
    )
    .post(
      "/api/v1/admin/bundles/:id/revise",
      {
        params: t.Object({ id: t.String() }),
        // Full create-validated financial body: the successor is a brand-new
        // catalog row, not a mutation of the old one.
        body: t.Object({
          name: t.String({ minLength: 1 }),
          price_vnd: t.Optional(t.Integer()),
          credit_vnd: t.Optional(t.Integer()),
          bonus_vnd: t.Optional(t.Integer()),
          price_usd: t.Optional(t.String()),
          credit_usd: t.Optional(t.String()),
          bonus_usd: t.Optional(t.String()),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Revise bundle financial terms (supersedes with a successor)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const usdError = bundleFieldError(body);
        if (usdError) return jsonError(400, "INVALID", usdError);
        if (body.price_vnd !== undefined && !posInt(body.price_vnd))
          return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
        if (body.credit_vnd !== undefined && !nonNegInt(body.credit_vnd))
          return jsonError(400, "INVALID", "credit_vnd must be a non-negative integer");
        if (body.bonus_vnd !== undefined && !nonNegInt(body.bonus_vnd))
          return jsonError(400, "INVALID", "bonus_vnd must be a non-negative integer");
        const id = crypto.randomUUID();
        // ONE transaction owns the old-row lock, FX read, successor insert,
        // old-row link, and audit. The FOR UPDATE lock serializes concurrent
        // revises of the same row, so the replay/conflict check and the
        // revision_key unique index cannot race; any failure rolls back
        // everything (no partial successor/link/audit).
        const result = await db.transaction(async (tx) => {
          const oldRows = await tx
            .select()
            .from(creditBundles)
            .where(eq(creditBundles.id, params.id))
            .limit(1)
            .for("update");
          const old = oldRows[0];
          if (!old) return { kind: "missing" } as const;
          const resolved = await resolveMixedBundleAmounts(tx, body);
          if (!resolved.ok) return { kind: "invalid", message: resolved.message } as const;
          // Replay key over the AUTHORED body (canonical USD text / authored
          // VND integers), never the FX-resolved VND: an identical USD
          // resubmission after an FX change must still find the original
          // successor instead of surfacing as a conflict.
          const revisionKey = revisionKeyFor("bundle", g.userId, params.id, {
            name: body.name,
            price:
              body.price_usd !== undefined
                ? { usd: canonicalUsd(body.price_usd) }
                : { vnd: body.price_vnd },
            credit:
              body.credit_usd !== undefined
                ? { usd: canonicalUsd(body.credit_usd) }
                : { vnd: body.credit_vnd },
            bonus:
              body.bonus_usd !== undefined
                ? { usd: canonicalUsd(body.bonus_usd) }
                : { vnd: body.bonus_vnd ?? 0 },
          });
          // Superseded check BEFORE the no-op branch: once a successor exists,
          // the old row is closed for business — a same-terms body is still a
          // replay hit (same key) or a 409, never a 200 of the inactive row.
          if (old.successor_id !== null) {
            const succ = await tx
              .select()
              .from(creditBundles)
              .where(eq(creditBundles.revision_key, revisionKey))
              .limit(1);
            if (succ[0]) return { kind: "replay", row: succ[0] } as const;
            return { kind: "conflict" } as const;
          }
          if (
            moneyEquivalent(resolved.price, old.price_vnd, old.price_usd) &&
            moneyEquivalent(resolved.credit, old.credit_vnd, old.credit_usd) &&
            moneyEquivalent(resolved.bonus, old.bonus_vnd, old.bonus_usd)
          ) {
            // No-op: equivalent terms, old row returned unchanged, no
            // successor, no audit revision.
            return { kind: "noop", row: old } as const;
          }
          const row: Record<string, unknown> = {
            id,
            name: body.name,
            price_vnd: resolved.price.vnd,
            credit_vnd: resolved.credit.vnd,
            bonus_vnd: resolved.bonus.vnd,
            active: true,
            created_at: Date.now(),
            price_usd: resolved.price.usd,
            credit_usd: resolved.credit.usd,
            bonus_usd: resolved.bonus.usd,
            creation_fx_rate_vnd_per_usd:
              resolved.price.usd !== null ||
              resolved.credit.usd !== null ||
              resolved.bonus.usd !== null
                ? resolved.fxRateVndPerUsd
                : null,
            revision_key: revisionKey,
            // Never superseded at creation: the link lives on the OLD row.
            successor_id: null,
          };
          await tx.insert(creditBundles).values(row as typeof creditBundles.$inferInsert);
          // Same-transaction link makes the old row the single superseded
          // predecessor; its money values are never touched.
          await tx
            .update(creditBundles)
            .set({ active: false, successor_id: id })
            .where(eq(creditBundles.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "bundle.revise",
            target: params.id,
            detail: { before: old, successor: row },
          });
          return { kind: "created", row } as const;
        });
        if (result.kind === "missing") return jsonError(404, "NOT_FOUND", "Bundle not found");
        if (result.kind === "invalid") return jsonError(400, "INVALID", result.message);
        if (result.kind === "conflict")
          return jsonError(
            409,
            "RESOURCE_SUPERSEDED",
            "Bundle already superseded by a different revision",
          );
        if (result.kind === "created") return json({ data: result.row }, 201);
        return json({ data: result.row });
      },
    )
    .patch(
      "/api/v1/admin/bundles/:id",
      {
        params: t.Object({ id: t.String() }),
        // additionalProperties:false enforces the immutable-amounts rule at the
        // boundary: price/credit edits are rejected, not silently ignored.
        body: t.Object(
          { name: t.Optional(t.String({ minLength: 1 })), active: t.Optional(t.Boolean()) },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Update bundle name/active (amounts immutable)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(creditBundles)
          .where(eq(creditBundles.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Bundle not found");
        const before = rows[0];
        const set: { name?: string; active?: boolean } = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.active !== undefined) set.active = body.active;
        if (Object.keys(set).length === 0) return json(before);
        const after = { ...before, ...set };
        await db.transaction(async (tx) => {
          await tx.update(creditBundles).set(set).where(eq(creditBundles.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "bundle.update",
            target: params.id,
            detail: { before, after },
          });
        });
        return json(after);
      },
    );

  const planRoutes = new Elysia({ name: "admin-subscription-plans" })
    .get(
      "/api/v1/admin/subscription-plans",
      {
        detail: {
          tags: ["Admin"],
          summary: "List subscription plans",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(subscriptionPlans)
          .orderBy(desc(subscriptionPlans.created_at));
        return json({ data: rows });
      },
    )
    .post(
      "/api/v1/admin/subscription-plans",
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          price_vnd: t.Optional(t.Integer()),
          credit_per_period_vnd: t.Optional(t.Integer()),
          price_usd: t.Optional(t.String()),
          credit_per_period_usd: t.Optional(t.String()),
          period_days: t.Optional(t.Integer()),
          rate_limit_per_minute: t.Optional(t.Integer()),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create subscription plan",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        // Per-field mixed currency (same contract as bundles): each of
        // price and credit_per_period is independently USD text or VND
        // integer, never both variants of one field.
        if (body.price_vnd !== undefined && body.price_usd !== undefined)
          return jsonError(400, "INVALID", "cannot set both price_vnd and price_usd for one field");
        if (body.credit_per_period_vnd !== undefined && body.credit_per_period_usd !== undefined)
          return jsonError(
            400,
            "INVALID",
            "cannot set both credit_per_period_vnd and credit_per_period_usd for one field",
          );
        const hasPlanUsd = body.price_usd !== undefined || body.credit_per_period_usd !== undefined;
        if (body.price_vnd === undefined && body.price_usd === undefined)
          return jsonError(400, "INVALID", "plan requires price_vnd or price_usd");
        if (body.credit_per_period_vnd === undefined && body.credit_per_period_usd === undefined)
          return jsonError(
            400,
            "INVALID",
            "plan requires credit_per_period_vnd or credit_per_period_usd",
          );
        if (body.period_days !== undefined && !(body.period_days >= 1))
          return jsonError(400, "INVALID", "period_days must be >= 1");
        if (body.rate_limit_per_minute !== undefined && !validRateLimit(body.rate_limit_per_minute))
          return jsonError(
            400,
            "INVALID",
            "rate_limit_per_minute must be an integer between 1 and 600",
          );
        const id = crypto.randomUUID();
        if (hasPlanUsd) {
          // VND-side values validate before the transaction (mirrors bundles);
          // ONE transaction owns FX read, derivation, insert, and audit.
          // Validation failures return before any write.
          if (body.price_vnd !== undefined && !posInt(body.price_vnd))
            return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
          if (body.credit_per_period_vnd !== undefined && !nonNegInt(body.credit_per_period_vnd))
            return jsonError(
              400,
              "INVALID",
              "credit_per_period_vnd must be a non-negative integer",
            );
          const result = await db.transaction(async (tx) => {
            const resolved = await resolveMixedPlanAmounts(tx, body);
            if (!resolved.ok) return { ok: false, message: resolved.message } as const;
            const row: Record<string, unknown> = {
              id,
              name: body.name,
              price_vnd: resolved.price.vnd,
              credit_per_period_vnd: resolved.credit.vnd,
              period_days: body.period_days ?? 30,
              rate_limit_per_minute: body.rate_limit_per_minute ?? 15,
              active: true,
              created_at: Date.now(),
              price_usd: resolved.price.usd,
              credit_per_period_usd: resolved.credit.usd,
              creation_fx_rate_vnd_per_usd: resolved.fxRateVndPerUsd,
            };
            await tx.insert(subscriptionPlans).values(row as typeof subscriptionPlans.$inferInsert);
            await writeAudit(tx, {
              actorUserId: g.userId,
              workspaceId: null,
              action: "plan.create",
              target: id,
              detail: row,
            });
            return { ok: true, row } as const;
          });
          if (!result.ok) return jsonError(400, "INVALID", result.message);
          return json(result.row, 201);
        }
        {
          if (!posInt(body.price_vnd))
            return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
          if (!nonNegInt(body.credit_per_period_vnd))
            return jsonError(
              400,
              "INVALID",
              "credit_per_period_vnd must be a non-negative integer",
            );
          const row: Record<string, unknown> = {
            id,
            name: body.name,
            price_vnd: body.price_vnd,
            credit_per_period_vnd: body.credit_per_period_vnd,
            period_days: body.period_days ?? 30,
            rate_limit_per_minute: body.rate_limit_per_minute ?? 15,
            active: true,
            created_at: Date.now(),
            price_usd: null,
            credit_per_period_usd: null,
            creation_fx_rate_vnd_per_usd: null,
          };
          await db.transaction(async (tx) => {
            await tx.insert(subscriptionPlans).values(row as typeof subscriptionPlans.$inferInsert);
            await writeAudit(tx, {
              actorUserId: g.userId,
              workspaceId: null,
              action: "plan.create",
              target: id,
              detail: row,
            });
          });
          return json(row, 201);
        }
      },
    )
    .post(
      "/api/v1/admin/subscription-plans/:id/revise",
      {
        params: t.Object({ id: t.String() }),
        // Financial fields only — rate_limit_per_minute is NOT revisable here
        // (additionalProperties:false rejects it); live RPM stays managed by
        // the PATCH endpoint and is never retroactively changed by a revision.
        body: t.Object(
          {
            name: t.String({ minLength: 1 }),
            price_vnd: t.Optional(t.Integer()),
            credit_per_period_vnd: t.Optional(t.Integer()),
            price_usd: t.Optional(t.String()),
            credit_per_period_usd: t.Optional(t.String()),
            period_days: t.Optional(t.Integer()),
          },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Revise plan financial terms (supersedes with a successor)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        if (body.price_vnd !== undefined && body.price_usd !== undefined)
          return jsonError(400, "INVALID", "cannot set both price_vnd and price_usd for one field");
        if (body.credit_per_period_vnd !== undefined && body.credit_per_period_usd !== undefined)
          return jsonError(
            400,
            "INVALID",
            "cannot set both credit_per_period_vnd and credit_per_period_usd for one field",
          );
        if (body.price_vnd === undefined && body.price_usd === undefined)
          return jsonError(400, "INVALID", "plan requires price_vnd or price_usd");
        if (body.credit_per_period_vnd === undefined && body.credit_per_period_usd === undefined)
          return jsonError(
            400,
            "INVALID",
            "plan requires credit_per_period_vnd or credit_per_period_usd",
          );
        if (body.period_days !== undefined && !(body.period_days >= 1))
          return jsonError(400, "INVALID", "period_days must be >= 1");
        if (body.price_vnd !== undefined && !posInt(body.price_vnd))
          return jsonError(400, "INVALID", "price_vnd must be a positive integer VND amount");
        if (body.credit_per_period_vnd !== undefined && !nonNegInt(body.credit_per_period_vnd))
          return jsonError(400, "INVALID", "credit_per_period_vnd must be a non-negative integer");
        const id = crypto.randomUUID();
        // Same one-transaction contract as the bundle revise above.
        const result = await db.transaction(async (tx) => {
          const oldRows = await tx
            .select()
            .from(subscriptionPlans)
            .where(eq(subscriptionPlans.id, params.id))
            .limit(1)
            .for("update");
          const old = oldRows[0];
          if (!old) return { kind: "missing" } as const;
          const resolved = await resolveMixedPlanAmounts(tx, body);
          if (!resolved.ok) return { kind: "invalid", message: resolved.message } as const;
          const periodDays = body.period_days ?? 30;
          // Replay key over the AUTHORED body (canonical USD text / authored
          // VND integers + period), never the FX-resolved VND — same contract
          // as the bundle revise above.
          const revisionKey = revisionKeyFor("plan", g.userId, params.id, {
            name: body.name,
            price:
              body.price_usd !== undefined
                ? { usd: canonicalUsd(body.price_usd) }
                : { vnd: body.price_vnd },
            credit:
              body.credit_per_period_usd !== undefined
                ? { usd: canonicalUsd(body.credit_per_period_usd) }
                : { vnd: body.credit_per_period_vnd },
            period_days: periodDays,
          });
          // Superseded check BEFORE the no-op branch (same ordering as the
          // bundle revise): a closed row is never returned as a no-op 200.
          if (old.successor_id !== null) {
            const succ = await tx
              .select()
              .from(subscriptionPlans)
              .where(eq(subscriptionPlans.revision_key, revisionKey))
              .limit(1);
            if (succ[0]) return { kind: "replay", row: succ[0] } as const;
            return { kind: "conflict" } as const;
          }
          if (
            moneyEquivalent(resolved.price, old.price_vnd, old.price_usd) &&
            moneyEquivalent(
              resolved.credit,
              old.credit_per_period_vnd,
              old.credit_per_period_usd,
            ) &&
            periodDays === old.period_days
          ) {
            // No-op: equivalent financial terms (price, credit, period), old
            // row returned unchanged, no successor, no audit revision.
            return { kind: "noop", row: old } as const;
          }
          const row: Record<string, unknown> = {
            id,
            name: body.name,
            price_vnd: resolved.price.vnd,
            credit_per_period_vnd: resolved.credit.vnd,
            period_days: periodDays,
            // Carry the live RPM: rate_limit_per_minute stays PATCH-editable
            // (never a frozen revision term), so the successor must keep the
            // current value instead of resetting new purchases to default.
            rate_limit_per_minute: old.rate_limit_per_minute,
            active: true,
            created_at: Date.now(),
            price_usd: resolved.price.usd,
            credit_per_period_usd: resolved.credit.usd,
            creation_fx_rate_vnd_per_usd:
              resolved.price.usd !== null || resolved.credit.usd !== null
                ? resolved.fxRateVndPerUsd
                : null,
            revision_key: revisionKey,
            // Never superseded at creation: the link lives on the OLD row.
            successor_id: null,
          };
          await tx.insert(subscriptionPlans).values(row as typeof subscriptionPlans.$inferInsert);
          await tx
            .update(subscriptionPlans)
            .set({ active: false, successor_id: id })
            .where(eq(subscriptionPlans.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "plan.revise",
            target: params.id,
            detail: { before: old, successor: row },
          });
          return { kind: "created", row } as const;
        });
        if (result.kind === "missing") return jsonError(404, "NOT_FOUND", "Plan not found");
        if (result.kind === "invalid") return jsonError(400, "INVALID", result.message);
        if (result.kind === "conflict")
          return jsonError(
            409,
            "RESOURCE_SUPERSEDED",
            "Plan already superseded by a different revision",
          );
        if (result.kind === "created") return json({ data: result.row }, 201);
        return json({ data: result.row });
      },
    )
    .patch(
      "/api/v1/admin/subscription-plans/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1 })),
            active: t.Optional(t.Boolean()),
            rate_limit_per_minute: t.Optional(t.Integer()),
          },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Update plan name/active/rate limit (amounts immutable)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Plan not found");
        const before = rows[0];
        const set: { name?: string; active?: boolean; rate_limit_per_minute?: number } = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.active !== undefined) set.active = body.active;
        if (body.rate_limit_per_minute !== undefined) {
          if (!validRateLimit(body.rate_limit_per_minute))
            return jsonError(
              400,
              "INVALID",
              "rate_limit_per_minute must be an integer between 1 and 600",
            );
          set.rate_limit_per_minute = body.rate_limit_per_minute;
        }
        if (Object.keys(set).length === 0) return json(before);
        const after = { ...before, ...set };
        await db.transaction(async (tx) => {
          await tx.update(subscriptionPlans).set(set).where(eq(subscriptionPlans.id, params.id));
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "plan.update",
            target: params.id,
            detail: { before, after },
          });
        });
        return json(after);
      },
    );

  // Composed plugin: .use keeps each route group's handlers intact without
  // cross-group chaining (Elysia route builders cannot be .concat'd).
  return new Elysia({ name: "admin-bundles" }).use(bundleRoutes).use(planRoutes);
};
