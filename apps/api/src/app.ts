import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { createDb, migrate } from "@hoborouter/db";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "./auth-types";
import { healthRoutes } from "./routes/health";
import { staticSpa } from "./static-spa";
import { workspacesRoutes } from "./routes/workspaces";
import { membersRoutes } from "./routes/members";
import { auditRoutes } from "./routes/audit";
import { keysRoutes } from "./routes/keys";
import { createAuth } from "./auth";

const defaultWebDist = new URL("../../web/dist", import.meta.url).pathname;

export interface AppDeps {
  db?: Database;
  auth?: BetterAuthInstance;
}

export const buildApp = (deps: AppDeps = {}) => {
  const webDist = process.env.HBR_WEB_DIST || defaultWebDist;
  const db =
    deps.db ??
    (() => {
      const d = createDb(process.env.HBR_DB_PATH || ":memory:");
      migrate(d);
      return d;
    })();
  const auth = deps.auth ?? createAuth(db);

  return new Elysia({ name: "hoborouter-api" })
    .use(healthRoutes)
    .use(openapi({ path: "/docs", specPath: "/openapi.json" }))
    .all("/api/auth/*", (ctx) => auth.handler(ctx.request))
    .use(workspacesRoutes(db, auth))
    .use(membersRoutes(db, auth))
    .use(auditRoutes(db, auth))
    .use(keysRoutes(db, auth))
    .get(
      "/api/*",
      () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    )
    .use(staticSpa(webDist));
};
