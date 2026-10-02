import { buildApp } from "./app";
import { bootstrapInstanceAdmin } from "./instance-admin";
import { createDb, migrate, closeDb } from "@hoborouter/db";

export { buildApp, bootstrapInstanceAdmin };

const db = createDb();
await migrate(db);
const app = await buildApp({ db });
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: (req) => app.handle(req),
});

console.log(`hoborouter api listening on :${port}`);
process.on("SIGTERM", () => closeDb(db).then(() => process.exit(0)));
