// Admin user edit + password reset contract routes:
// - PATCH /api/v1/admin/users/:id        { name?, email? } -> { user }
// - POST  /api/v1/admin/users/:id/reset-password { newPassword } -> { success: true }
//
// Passwords/hashes never appear in responses, audits, or logs: audits carry
// safe changed fields only (user.update) or nothing (user.password_reset).
// Roles are never touched here (admins live in instance_admins, not Better
// Auth admin roles); money/history untouched.
//
// Both routes do target lookup/revalidation, the change, session revocation,
// and the audit row inside ONE transaction. The target row is locked with
// SELECT ... FOR UPDATE, serializing against removeUserIdentity's removal
// update so an anonymized/removed account can never be revived mid-flight.
// The audit write shares the transaction: a failed audit rolls the whole
// change back (no unaudited edits).
import { Elysia, t } from "elysia";
import { and, eq, ne, sql } from "drizzle-orm";
import { type Db, type Tx, account, isUniqueViolation, users } from "@hoborouter/db";
import { checkPassword } from "@hoborouter/shared";
import type { BetterAuthInstance } from "../auth-types";
import { jsonError, requireInstanceAdmin, requireSession, writeAudit } from "../authz";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Removal fallback (admin-extra removeUserIdentity) anonymizes the users row
 * in place instead of deleting it. Editing/resetting such an account would
 * revive it as a loginable identity — treat it as gone (404, same as a
 * deleted row).
 */
const isAnonymized = (u: { id: string; email: string; name: string }) =>
  u.email === `deleted+${u.id}@invalid` && u.name === "Deleted user";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function guard(db: Db, auth: BetterAuthInstance, request: Request) {
  const gate = await requireSession(auth, request);
  if ("error" in gate) return { error: gate.error } as const;
  const denied = await requireInstanceAdmin(db, gate.session.user.id);
  if (denied) return { error: denied } as const;
  return { session: gate.session } as const;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Revoke every session of the target user (email change / password reset). */
const revokeSessions = (db: Db | Tx, userId: string) =>
  db.execute(sql`delete from session where user_id = ${userId}`);

/** Lock and revalidate the target inside a tx; 404 if gone or anonymized. */
const lockTarget = async (tx: Tx, id: string) => {
  const target = (
    await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      // Same lock the removal path's update takes: edit/reset vs removal serialize.
      .for("update")
  )[0];
  if (!target || isAnonymized(target)) return null;
  return target;
};

export const adminUserEditRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-user-edit" })
    .patch(
      "/api/v1/admin/users/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Edit user name/email",
          description:
            "Instance-admin-only. Does not change roles. An email change sets emailVerified=false and revokes all of the target user's sessions; a name-only change leaves sessions alone.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const body = await readJsonBody(request);
        if (!body) return jsonError(400, "INVALID", "Invalid JSON body");
        const hasName = typeof body.name === "string";
        const hasEmail = typeof body.email === "string";
        if (!hasName && !hasEmail)
          return jsonError(400, "INVALID", "At least one of name or email is required");
        const name = hasName ? (body.name as string).trim() : undefined;
        if (name !== undefined && (name.length < 1 || name.length > 80))
          return jsonError(400, "INVALID", "name must be 1..80 characters");
        const email = hasEmail ? (body.email as string).trim().toLowerCase() : undefined;
        if (email !== undefined && (!EMAIL_RE.test(email) || email.length > 254))
          return jsonError(400, "INVALID", "email must be valid and at most 254 characters");

        let resp: Response | undefined;
        // The email change is only "real" when it differs from the target's
        // current address; tracked outside the tx so the post-commit
        // notification knows whether anything moved.
        let emailChangedTo: string | undefined;
        try {
          await db.transaction(async (tx) => {
            const target = await lockTarget(tx, params.id);
            if (!target) {
              resp = jsonError(404, "NOT_FOUND", "User not found");
              return;
            }
            const emailChanged = email !== undefined && email !== target.email;
            if (emailChanged) emailChangedTo = email!;
            if (emailChanged) {
              // Precheck the unique constraint (better error than a raw 23505).
              const dup = await tx
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.email, email!), ne(users.id, params.id)))
                .limit(1);
              if (dup[0]) {
                resp = jsonError(409, "EMAIL_TAKEN", "Email already registered");
                return;
              }
            }
            const set = {
              ...(name !== undefined && name !== target.name ? { name } : {}),
              // Email change invalidates verified-ness: nobody verified the
              // new address. Name-only changes leave this untouched.
              ...(emailChanged ? { email: email!, emailVerified: false } : {}),
            };
            // No-op edit (nothing actually changes) still succeeds with 200.
            if (Object.keys(set).length > 0)
              await tx.update(users).set(set).where(eq(users.id, params.id));
            if (emailChanged) await revokeSessions(tx, params.id);
            await writeAudit(tx, {
              actorUserId: g.session.user.id,
              workspaceId: null,
              action: "user.update",
              target: params.id,
              // Changed-field NAMES only: no values, no credentials — the audit
              // trail identifies what moved, never account contents.
              detail: {
                fields: [
                  ...(name !== undefined && name !== target.name ? ["name"] : []),
                  ...(emailChanged ? ["email"] : []),
                ],
              },
            });
            resp = json({
              user: { id: params.id, name: name ?? target.name, email: email ?? target.email },
            });
          });
        } catch (err) {
          // Concurrent signup could still win the unique email race.
          if (isUniqueViolation(err))
            return jsonError(409, "EMAIL_TAKEN", "Email already registered");
          throw err;
        }
        // Committed: notify the target's NEW address (never the admin's session
        // context — headers omitted so the admin session can't hijack the
        // recipient). Notification only: a delivery failure leaves the change
        // in place and is swallowed; the user can still request a resend.
        if (emailChangedTo && auth.api.sendVerificationEmail) {
          try {
            await auth.api.sendVerificationEmail({ body: { email: emailChangedTo } });
          } catch {
            // Best-effort notification; the committed change must not 500.
          }
        }
        return resp!;
      },
    )
    .post(
      "/api/v1/admin/users/:id/reset-password",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Reset user password",
          description:
            "Instance-admin-only. Sets a new credential-account password (no old password needed; the admin is already authorized) and revokes all of the target user's sessions. OAuth accounts are never touched; a credential account is created for OAuth-only users.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const body = await readJsonBody(request);
        const newPassword = body?.newPassword;
        if (typeof newPassword !== "string")
          return jsonError(400, "INVALID", "newPassword is required");
        // Same shared policy as signup/change-password (see auth.ts hooks).
        const pwProblems = checkPassword(newPassword);
        if (pwProblems.length > 0)
          return jsonError(
            400,
            "INVALID",
            `Password does not meet the requirements: ${pwProblems.join("; ")}`,
          );
        // Initial validity check (no lock) before hashing; the locked target
        // is rechecked inside the transaction before any account write.
        const initial = (
          await db
            .select({ id: users.id, email: users.email, name: users.name })
            .from(users)
            .where(eq(users.id, params.id))
            .limit(1)
        )[0];
        if (!initial) return jsonError(404, "NOT_FOUND", "User not found");
        if (isAnonymized(initial)) return jsonError(404, "NOT_FOUND", "User not found");
        if (!auth.$context)
          return jsonError(500, "AUTH_UNAVAILABLE", "Password hashing is unavailable");
        // Better Auth's configured hasher — same scheme signup/login verify.
        const hash = await (await auth.$context).password.hash(newPassword);
        let resp: Response | undefined;
        await db.transaction(async (tx) => {
          const target = await lockTarget(tx, params.id);
          if (!target) {
            resp = jsonError(404, "NOT_FOUND", "User not found");
            return;
          }
          const cred = await tx
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.userId, params.id), eq(account.providerId, "credential")))
            .limit(1);
          if (cred[0]) {
            await tx.update(account).set({ password: hash }).where(eq(account.id, cred[0].id));
          } else {
            // OAuth-only user: add a credential account so sign-in works.
            // Existing OAuth account rows are never modified.
            await tx.insert(account).values({
              id: crypto.randomUUID(),
              accountId: params.id,
              providerId: "credential",
              userId: params.id,
              password: hash,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
          await revokeSessions(tx, params.id);
          await writeAudit(tx, {
            actorUserId: g.session.user.id,
            workspaceId: null,
            // No detail: the password (or its hash) must never reach the audit log.
            action: "user.password_reset",
            target: params.id,
          });
          resp = json({ success: true });
        });
        return resp!;
      },
    );
