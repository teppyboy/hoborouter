// Instance-admin bootstrap core: idempotently upsert the user matching an
// email into instance_admins. The instance-admin role is INDEPENDENT of
// workspace roles; this grants nothing else.
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { users, instanceAdmins, orm, runChanges } from "@hoborouter/db";

export function bootstrapInstanceAdmin(db: Database, email: string): { inserted: boolean } {
  const user = orm(db).select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (!user) throw new Error(`No user found with email ${email}`);
  const result = runChanges(
    orm(db)
      .insert(instanceAdmins)
      .values({ user_id: user.id, created_at: Date.now(), added_by: null })
      .onConflictDoNothing(),
  );
  return { inserted: result.changes === 1 };
}
