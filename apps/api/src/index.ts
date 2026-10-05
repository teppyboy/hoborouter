import { buildApp } from "./app";
import { startPaymentExpirySweep } from "./payment-expiry";
import { bootstrapFirstInstanceAdmin } from "./instance-admin";
import { createDb, migrate, closeDb } from "@hoborouter/db";

export { buildApp } from "./app";
export { bootstrapInstanceAdmin } from "./instance-admin";

const db = createDb();
await migrate(db);
// Production bootstrap: if the configured email already signed up before this
// env var was set, grant it now (no-op when an admin already exists or the
// user hasn't signed up yet).
if (process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL) {
  await bootstrapFirstInstanceAdmin(db, process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL);
}
const app = await buildApp({ db });
const stopPaymentExpirySweep = startPaymentExpirySweep(db);
const port = Number(process.env.PORT ?? 3000);
const idleRaw = Number(process.env.HBR_IDLE_TIMEOUT_S);

Bun.serve({
  port,
  // Bun's default idleTimeout (10 s) kills connections that send nothing for
  // 10 s — slow reasoning streams would be cut mid-generation. 255 s is Bun's max.
  idleTimeout: idleRaw > 0 ? Math.min(255, idleRaw) : 255,
  fetch: (req) => app.handle(req),
});

console.log(`hoborouter api listening on :${port}`);
process.on("SIGTERM", () => {
  stopPaymentExpirySweep();
  closeDb(db).then(() => process.exit(0));
});
