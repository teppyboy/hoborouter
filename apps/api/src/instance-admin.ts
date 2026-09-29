// Instance-admin bootstrap core: idempotently upsert the user matching an
// email into instance_admins. The instance-admin role is INDEPENDENT of
// workspace roles; this grants nothing else.
import type { Database } from "bun:sqlite";

export function bootstrapInstanceAdmin(db: Database, email: string): { inserted: boolean } {
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  if (!user) throw new Error(`No user found with email ${email}`);
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO instance_admins (user_id, created_at, added_by) VALUES (?, ?, NULL)",
    )
    .run(user.id, Date.now());
  return { inserted: result.changes === 1 };
}
