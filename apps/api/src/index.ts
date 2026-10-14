import { buildApp } from "./app";
import { startPaymentExpirySweep } from "./payment-expiry";
import { startAttachmentGc } from "./attachment-gc";
import { bootstrapFirstInstanceAdmin } from "./instance-admin";
import { createDb, migrate, closeDb } from "@hoborouter/db";
import { loadConfig } from "./config/loader";

export { buildApp } from "./app";
export { bootstrapInstanceAdmin } from "./instance-admin";

// Loader first: one typed config (YAML + env merged per field, env > YAML >
// default), validated once after merge, then injected everywhere. The loader
// never mutates process.env.
const cfg = await loadConfig();
const db = createDb(cfg.database.url);
await migrate(db);
// Production bootstrap: if the configured email already signed up before this
// was configured, grant it now (no-op when an admin already exists or the
// user hasn't signed up yet).
if (cfg.bootstrap.instanceAdminEmail) {
  await bootstrapFirstInstanceAdmin(db, cfg.bootstrap.instanceAdminEmail);
}
const app = await buildApp({ db, cfg });
const stopPaymentExpirySweep = startPaymentExpirySweep(db);
const stopAttachmentGc = startAttachmentGc(db);

Bun.serve({
  port: cfg.server.port,
  // Bun's default idleTimeout (10 s) kills connections that send nothing for
  // 10 s — slow reasoning streams would be cut mid-generation. 255 s is Bun's max.
  idleTimeout: Math.min(255, cfg.server.idleTimeoutS),
  fetch: (req) => app.handle(req),
});

console.log(`hoborouter api listening on :${cfg.server.port}`);
process.on("SIGTERM", () => {
  stopPaymentExpirySweep();
  stopAttachmentGc();
  closeDb(db).then(() => process.exit(0));
});
