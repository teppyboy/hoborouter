// Instance-admin bootstrap CLI: reads DATABASE_URL and
// HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL, idempotently upserts the matching
// user into instance_admins. Run once per deployment by the operator.
import { createDb, closeDb, migrate } from "@hoborouter/db";
import { bootstrapInstanceAdmin } from "../apps/api/src/instance-admin";

const email = process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL;
if (!email) {
  console.error("HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL is required");
  process.exit(1);
}

// createDb throws a clear error unless DATABASE_URL is a postgres:// URL.
const db = createDb();
try {
  await migrate(db);
  const { inserted } = await bootstrapInstanceAdmin(db, email);
  console.log(
    inserted ? `instance admin provisioned: ${email}` : `instance admin already present: ${email}`,
  );
} finally {
  await closeDb(db);
}
