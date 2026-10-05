// Instance-admin promo code management. The plaintext code is generated with
// CSPRNG randomness, revealed exactly once in the create response, and never
// stored (only its SHA-256, normalized trim().toUpperCase()). No logging of
// the code anywhere. GET/PATCH responses and audit rows never carry
// code_hash or plaintext: the hash is a credential-equivalent secret.
// No DELETE: promo codes are deactivated (active=false) so redemption history
// keeps its FK and the code's usage trail stays intact.
import { Elysia, t } from "elysia";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { MAX_SAFE_INTEGER_MONEY, promoCodes } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit, jsonError } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const posInt = (v: number) => Number.isSafeInteger(v) && v > 0;

// Safe subset of a promo row: never code_hash. This shape is also the list
// item shape, so a hash leak cannot happen by forgetting a select column.
const safePromo = (r: {
  id: string;
  name: string;
  amount_vnd: string | number;
  max_uses: number;
  uses: number;
  expires_at: string | number | null;
  active: boolean;
  created_at: string | number;
}) => ({
  id: r.id,
  name: r.name,
  amount_vnd: Number(r.amount_vnd),
  max_uses: r.max_uses,
  uses: r.uses,
  expires_at: r.expires_at === null ? null : Number(r.expires_at),
  active: r.active,
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

export const hashPromoCode = (code: string): string =>
  new Bun.CryptoHasher("sha256").update(code.trim().toUpperCase()).digest("hex");

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
            amount_vnd: promoCodes.amount_vnd,
            max_uses: promoCodes.max_uses,
            uses: promoCodes.uses,
            expires_at: promoCodes.expires_at,
            active: promoCodes.active,
            created_at: promoCodes.created_at,
          })
          .from(promoCodes)
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
        const amountVnd = b.amount_vnd;
        const maxUses = b.max_uses;
        const expiresAt = b.expires_at;
        if (!posInt(amountVnd as number) || (amountVnd as number) > MAX_SAFE_INTEGER_MONEY)
          return jsonError(400, "INVALID", "amount_vnd must be a positive integer VND amount");
        if (!posInt(maxUses as number))
          return jsonError(400, "INVALID", "max_uses must be a positive integer");
        const now = Date.now();
        if (
          expiresAt !== null &&
          (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
        )
          return jsonError(400, "INVALID", "expires_at must be null or a future timestamp in ms");
        const code = generatePromoCode();
        const row = {
          id: crypto.randomUUID(),
          code_hash: hashPromoCode(code),
          name: b.name,
          amount_vnd: amountVnd as number,
          max_uses: maxUses as number,
          uses: 0,
          expires_at: expiresAt as number | null,
          active: true,
          created_at: now,
        };
        await db.transaction(async (tx) => {
          await tx.insert(promoCodes).values(row);
          // Audit detail carries only safe fields: no code_hash, no plaintext.
          await writeAudit(tx, {
            actorUserId: g.userId,
            workspaceId: null,
            action: "promo.create",
            target: row.id,
            detail: {
              name: row.name,
              amount_vnd: row.amount_vnd,
              max_uses: row.max_uses,
              expires_at: row.expires_at,
            },
          });
        });
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
            .where(eq(promoCodes.id, params.id))
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
              amount_vnd: promoCodes.amount_vnd,
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
    );
};
