// Instance-admin bootstrap core: idempotently upsert the user matching an
// email into instance_admins. The instance-admin role is INDEPENDENT of
// workspace roles; this grants nothing else.
import type { Db } from "@hoborouter/db";
import { eq, sql } from "drizzle-orm";
import { users, instanceAdmins } from "@hoborouter/db";

export async function bootstrapInstanceAdmin(
  db: Db,
  email: string,
): Promise<{ inserted: boolean }> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user) throw new Error(`No user found with email ${email}`);
  const inserted = await db
    .insert(instanceAdmins)
    .values({ user_id: user.id, created_at: Date.now(), added_by: null })
    .onConflictDoNothing()
    .returning({ user_id: instanceAdmins.user_id });
  return { inserted: inserted.length === 1 };
}

// HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL path: grant the bootstrap email instance
// admin ONLY while the instance has zero admins — once any admin exists this
// is a no-op, so a leftover env var cannot mint more admins later. Tolerates a
// missing user (returns false) so the startup call is safe before first signup.
// Safe against the zero-admins race: only the single bootstrap email is
// grantable and user emails are unique, so at most one grant can ever land.
export async function bootstrapFirstInstanceAdmin(
  db: Db,
  email: string,
): Promise<boolean> {
  const admins = await db
    .select({ user_id: instanceAdmins.user_id })
    .from(instanceAdmins)
    .limit(1);
  if (admins.length > 0) return false;
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  if (!rows[0]) return false;
  // Delegate with the stored (canonical-case) email so the exact-match lookup
  // inside bootstrapInstanceAdmin still finds the user.
  const { inserted } = await bootstrapInstanceAdmin(db, rows[0].email);
  return inserted;
}
