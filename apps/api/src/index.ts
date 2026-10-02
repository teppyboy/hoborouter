import { buildApp } from "./app";
import { bootstrapInstanceAdmin } from "./instance-admin";
import { createDb, migrate, closeDb } from "@hoborouter/db";

export { buildApp, bootstrapInstanceAdmin };

const db = createDb();
await migrate(db);
const app = await buildApp({ db });
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
process.on("SIGTERM", () => closeDb(db).then(() => process.exit(0)));
