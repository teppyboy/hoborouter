// Instance-admin promo code management. The plaintext code is generated with
// CSPRNG randomness, revealed exactly once in the create response, and never
// stored (only its SHA-256, normalized trim().toUpperCase()). No logging of
// the code anywhere. GET/PATCH responses and audit rows never carry
// code_hash or plaintext: the hash is a credential-equivalent secret.
// No hard DELETE: the DELETE endpoint soft-removes (deleted_at + active=false)
// so redemption/payment/ledger history keeps its FK; deleted codes are
// invisible to list/redeem/preview but their rows remain.
import { Elysia, t } from "elysia";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { MAX_SAFE_INTEGER_MONEY, promoCodes } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";
import { hashPromoCode, normalizePromoCodeWithReason } from "../promo-code";

// Legacy import site for the hash helper (bmc/promo test suites import from
// here); the single implementation lives in promo-code.ts.
export { hashPromoCode };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const posInt = (v: number) => Number.isSafeInteger(v) && v > 0;

// Percent-voucher bounds: bp in 1..9999 (never 10000 — a 100% discount would
// drive the final due to zero, which the payments.amount > 0 CHECK forbids);
// cap is a positive safe-integer VND amount.
const percentBpValid = (v: number) => Number.isSafeInteger(v) && v >= 1 && v <= 9999;

// Safe subset of a promo row: never code_hash. This shape is also the list
// item shape, so a hash leak cannot happen by forgetting a select column.
const safePromo = (r: {
  id: string;
  name: string;
  kind?: "fixed" | "percent";
  amount_vnd?: string | number | null;
  percent_bp?: number | null;
  max_discount_vnd?: string | number | null;
  max_uses: number;
  uses?: number;
  expires_at?: string | number | null;
  active?: boolean;
  created_at: string | number;
}) => ({
  id: r.id,
  name: r.name,
  kind: r.kind ?? "fixed",
  amount_vnd: r.amount_vnd === null || r.amount_vnd === undefined ? null : Number(r.amount_vnd),
  percent_bp: r.percent_bp ?? null,
  max_discount_vnd:
    r.max_discount_vnd === null || r.max_discount_vnd === undefined
      ? null
      : Number(r.max_discount_vnd),
  max_uses: r.max_uses,
  uses: r.uses ?? 0,
  expires_at: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
  active: r.active ?? true,
  created_at: Number(r.created_at),
});

// 16 CSPRNG bytes -> 32 uppercase hex chars. Redeem-side lookup contract:
// normalize trim().toUpperCase(), allowed /^[A-F0-9]{32}$/, SHA-256 the result.
export const generatePromoCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};

export const adminPromotionsRoutes = (db: Db, auth: BetterAuthInstance) => {
  const guard = async (request: Request) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return { error: gate.error } as const;
    const denied = await requireInstanceAdmin(db, gate.session.user.id);
    if (denied) return { error: denied } as const;
    return { userId: gate.session.user.id } as const;
  };

  return new Elysia({ name: "admin-promotions" })
    .get(
      "/api/v1/admin/promotions",
      {
        detail: { tags: ["Admin"], summary: "List promo codes", security: [{ cookieAuth: [] }] },
      },
      async ({ request }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const rows = await db
          .select({
            id: promoCodes.id,
            name: promoCodes.name,
            kind: promoCodes.kind,
            amount_vnd: promoCodes.amount_vnd,
            percent_bp: promoCodes.percent_bp,
            max_discount_vnd: promoCodes.max_discount_vnd,
            max_uses: promoCodes.max_uses,
            uses: promoCodes.uses,
            expires_at: promoCodes.expires_at,
            active: promoCodes.active,
            created_at: promoCodes.created_at,
          })
          .from(promoCodes)
          .where(isNull(promoCodes.deleted_at))
          .orderBy(desc(promoCodes.created_at));
        return json({ data: rows.map(safePromo) });
      },
    )
    .post(
      "/api/v1/admin/promotions",
      {
        // Permissive body + manual checks: every validation failure returns a
        // uniform 400 INVALID rather than Elysia's schema-level 422, and
        // non-integer numbers (1.5) are rejected by posInt, not by schema.
        body: t.Optional(t.Record(t.String(), t.Any())),
        detail: {
          tags: ["Admin"],
          summary: "Create promo code (code revealed once)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.name !== "string" || b.name.length === 0)
          return jsonError(400, "INVALID", "name must be a non-empty string");
        // Explicit kind: 'fixed' (legacy default, amount_vnd credit) or
        // 'percent' (basis points + VND cap off a top-up payment). The two
        // shapes are mutually exclusive — no mixed or absent funding.
        const kind = b.kind === undefined ? "fixed" : b.kind;
        if (kind !== "fixed" && kind !== "percent")
          return jsonError(400, "INVALID", "kind must be 'fixed' or 'percent'");
        const amountVnd = b.amount_vnd;
        const percentBp = b.percent_bp;
        const maxDiscountVnd = b.max_discount_vnd;
        const maxUses = b.max_uses;
        const expiresAt = b.expires_at;
        if (kind === "fixed") {
          if (percentBp !== undefined || maxDiscountVnd !== undefined)
            return jsonError(
              400,
              "INVALID",
              "percent_bp/max_discount_vnd are only valid with kind='percent'",
            );
          if (!posInt(amountVnd as number) || (amountVnd as number) > MAX_SAFE_INTEGER_MONEY)
            return jsonError(400, "INVALID", "amount_vnd must be a positive integer VND amount");
        } else {
          if (amountVnd !== undefined)
            return jsonError(
              400,
              "INVALID",
              "amount_vnd is only valid with kind='fixed'; percent promos use percent_bp + max_discount_vnd",
            );
          if (!percentBpValid(percentBp as number))
            return jsonError(
              400,
              "INVALID",
              "percent_bp must be an integer between 1 and 9999 basis points",
            );
          if (
            !posInt(maxDiscountVnd as number) ||
            (maxDiscountVnd as number) > MAX_SAFE_INTEGER_MONEY
          )
            return jsonError(400, "INVALID", "max_discount_vnd must be a positive integer VND cap");
        }
        if (!posInt(maxUses as number))
          return jsonError(400, "INVALID", "max_uses must be a positive integer");
        // Optional custom code: absent -> CSPRNG 32-hex legacy path unchanged;
        // present -> canonical normalization with an admin-visible reason.
        // The stored value is the hash of the NORMALIZED code; the plaintext
        // (normalized form) is revealed once in the create response.
        let code: string;
        if (b.code === undefined || b.code === null) {
          code = generatePromoCode();
        } else {
          if (typeof b.code !== "string")
            return jsonError(400, "INVALID_CODE", "code must be a string");
          const n = normalizePromoCodeWithReason(b.code);
          if ("reason" in n)
            return jsonError(
              400,
              "INVALID_CODE",
              n.reason === "empty"
                ? "code must not be empty"
                : n.reason === "invalid_characters"
                  ? "code contains control or format characters"
                  : "code exceeds 64 characters (128 bytes) after uppercasing",
            );
          code = n.code;
        }
        const now = Date.now();
        if (
          expiresAt !== null &&
          (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
        )
          return jsonError(400, "INVALID", "expires_at must be null or a future timestamp in ms");
        const row: typeof promoCodes.$inferInsert = {
          id: crypto.randomUUID(),
          code_hash: hashPromoCode(code),
          name: b.name,
          kind,
          amount_vnd: kind === "fixed" ? (amountVnd as number) : null,
          percent_bp: kind === "percent" ? (percentBp as number) : null,
          max_discount_vnd: kind === "percent" ? (maxDiscountVnd as number) : null,
          max_uses: maxUses as number,
          uses: 0,
          expires_at: expiresAt as number | null,
          active: true,
          created_at: now,
        };
        let duplicate = false;
        await db.transaction(async (tx) => {
          // Race-free uniqueness answer: the check runs under the same
          // transaction as the insert, so a variant of an existing code (same
          // normalized hash) answers 400 CODE_EXISTS instead of tripping the
          // code_hash UNIQUE index as a 500. Generated codes are CSPRNG and
          // effectively never collide, but they share the same gate.
          const dup = await tx
            .select({ id: promoCodes.id })
            .from(promoCodes)
            .where(eq(promoCodes.code_hash, row.code_hash))
            .limit(1);
          if (dup.length > 0) {
            duplicate = true;
            return;
          }
          await tx.insert(promoCodes).values(row);
          // Audit detail carries only safe fields: no code_hash, no plaintext.
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "promo.create",
            target: row.id,
            detail: {
              name: row.name,
              kind: row.kind,
              ...(row.kind === "fixed"
                ? { amount_vnd: row.amount_vnd }
                : { percent_bp: row.percent_bp, max_discount_vnd: row.max_discount_vnd }),
              max_uses: row.max_uses,
              expires_at: row.expires_at,
            },
          });
        });
        if (duplicate)
          return jsonError(400, "CODE_EXISTS", "A promo code with this code already exists");
        // The one and only reveal of the plaintext code.
        return json({ promo: safePromo(row), code }, 201);
      },
    )
    .patch(
      "/api/v1/admin/promotions/:id",
      {
        params: t.Object({ id: t.String() }),
        // additionalProperties:false enforces immutability of amounts/limits at
        // the boundary: amount_vnd/max_uses/expires_at edits are rejected, not
        // silently ignored (settlement reads amount at redemption time).
        body: t.Object(
          { name: t.Optional(t.String({ minLength: 1 })), active: t.Optional(t.Boolean()) },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["Admin"],
          summary: "Update promo name/active (amounts/limits immutable)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        let resp: Response | undefined;
        await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(promoCodes)
            .where(and(eq(promoCodes.id, params.id), isNull(promoCodes.deleted_at)))
            .limit(1)
            .for("update");
          const row = rows[0];
          if (!row) {
            resp = jsonError(404, "NOT_FOUND", "Promo code not found");
            return;
          }
          const set: { name?: string; active?: boolean } = {};
          if (body.name !== undefined) set.name = body.name;
          if (body.active !== undefined) set.active = body.active;
          if (Object.keys(set).length === 0) {
            resp = json(safePromo(row));
            return;
          }
          const updated = await tx
            .update(promoCodes)
            .set(set)
            .where(eq(promoCodes.id, params.id))
            .returning({
              id: promoCodes.id,
              name: promoCodes.name,
              kind: promoCodes.kind,
              amount_vnd: promoCodes.amount_vnd,
              percent_bp: promoCodes.percent_bp,
              max_discount_vnd: promoCodes.max_discount_vnd,
              max_uses: promoCodes.max_uses,
              uses: promoCodes.uses,
              expires_at: promoCodes.expires_at,
              active: promoCodes.active,
              created_at: promoCodes.created_at,
            });
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "promo.update",
            target: params.id,
            // Hash is a credential-equivalent secret; audit detail omits it.
            detail: { before: { name: row.name, active: row.active }, after: set },
          });
          resp = json(safePromo(updated[0]!));
        });
        return resp!;
      },
    )
    .delete(
      "/api/v1/admin/promotions/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Soft-remove a promo code",
          description:
            "Soft-removes the promo code (deleted_at + active=false). Redemption, payment, and ledger history are never touched. Deleted codes are excluded from list/redeem/preview and their code hash cannot be reused (unique index on the retained row).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(request);
        if ("error" in g) return g.error;
        let resp: Response | undefined;
        await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(promoCodes)
            .where(and(eq(promoCodes.id, params.id), isNull(promoCodes.deleted_at)))
            .limit(1)
            .for("update");
          const row = rows[0];
          if (!row) {
            resp = jsonError(404, "NOT_FOUND", "Promo code not found");
            return;
          }
          const now = Date.now();
          await tx
            .update(promoCodes)
            .set({ deleted_at: now, active: false })
            .where(eq(promoCodes.id, params.id));
          // Audit detail carries no code_hash and no plaintext (credential-
          // equivalent secrets, same rule as create/update).
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "promo.delete",
            target: params.id,
            detail: { name: row.name, deleted_at: now },
          });
          resp = json({ ok: true });
        });
        return resp!;
      },
    );
};
