// Instance-admin bootstrap core: idempotently upsert the user matching an
// email into instance_admins. The instance-admin role is INDEPENDENT of
// workspace roles; this grants nothing else.
import type { Db } from "@hoborouter/db";
import { eq } from "drizzle-orm";
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
