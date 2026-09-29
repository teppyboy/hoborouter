// Instance-admin bootstrap CLI: reads HBR_DB_PATH and
// HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL, idempotently upserts the matching
// user into instance_admins. Run once per deployment by the operator.
import { createDb, migrate } from "@hoborouter/db";
import { bootstrapInstanceAdmin } from "../apps/api/src/instance-admin";

const dbPath = process.env.HBR_DB_PATH;
const email = process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL;

if (!dbPath) {
  console.error("HBR_DB_PATH is required");
  process.exit(1);
}
if (!email) {
  console.error("HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL is required");
  process.exit(1);
}

const db = createDb(dbPath);
migrate(db);
const { inserted } = bootstrapInstanceAdmin(db, email);
console.log(
  inserted ? `instance admin provisioned: ${email}` : `instance admin already present: ${email}`,
);
