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
import { cpaHealthRoutes } from "./routes/cpahealth";
import { adminModelsRoutes } from "./routes/admin-models";
import { adminCatalogRoutes } from "./routes/admin-catalog";
import { v1ModelsRoutes } from "./routes/v1-models";
import { paymentsRoutes } from "./routes/payments";
import { mockWebhookRoutes } from "./routes/webhooks-mock";
import { mockWebhookConfig } from "./mock-config";
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
  const mockPayments = mockWebhookConfig();

  const app = new Elysia({ name: "hoborouter-api" })
    .use(healthRoutes)
    .use(openapi({ path: "/docs", specPath: "/openapi.json" }))
    .all("/api/auth/*", (ctx) => auth.handler(ctx.request))
    .use(workspacesRoutes(db, auth))
    .use(membersRoutes(db, auth))
    .use(auditRoutes(db, auth))
    .use(keysRoutes(db, auth))
    .use(paymentsRoutes(db, auth, mockPayments))
    .use(mockWebhookRoutes(db, mockPayments))
    .use(cpaHealthRoutes(db, auth))
    .use(adminModelsRoutes(db, auth))
    .use(adminCatalogRoutes(db, auth))
    .use(v1ModelsRoutes(db))
    .get(
      "/api/*",
      () =>
        new Response(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "Not found" },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
    )
    .use(staticSpa(webDist));

  const handle = app.handle.bind(app);
  Object.defineProperty(app, "handle", {
    configurable: true,
    value: async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      const requestId = crypto.randomUUID();
      const headers = new Headers(request.headers);
      for (const name of ["x-cpa-trace-id", "x-request-id", "openai-request-id"]) {
        headers.delete(name);
      }
      const cleanRequest = new Request(request, { headers });
      let response: Response;
      try {
        response = await handle(cleanRequest);
      } catch {
        response = new Response(null, { status: 500 });
      }
      const status = response.status;
      if (status >= 400) {
        let code = status >= 500 ? "INTERNAL_ERROR" : status === 404 ? "NOT_FOUND" : "ERROR";
        let message = status >= 500 ? "Internal server error" : "Request failed";
        if (status < 500) {
          try {
            const body = await response.clone().json();
            const error = body?.error ?? body;
            if (typeof error?.code === "string") code = error.code;
            if (typeof error?.message === "string") message = error.message;
          } catch {
            // Keep the generic safe response.
          }
        }
        return await boundaryResponse(
          request,
          status,
          JSON.stringify({ error: { code, message, request_id: requestId } }),
          response,
          requestId,
          true,
        );
      }
      return await boundaryResponse(request, status, response, response, requestId, false);
    },
  });
  return app;
};

async function boundaryResponse(
  request: Request,
  status: number,
  body: BodyInit | Response | null,
  source: Response,
  requestId: string,
  json: boolean,
): Promise<Response> {
  const headers = new Headers();
  const cookies =
    (source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const [name, value] of source.headers) {
    if (name.toLowerCase() !== "set-cookie") headers.append(name, value);
  }
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  headers.set("x-hbr-request-id", requestId);
  if (json) {
    headers.set("content-type", "application/json");
    headers.delete("content-length");
  }
  const noBody = request.method === "HEAD" || status === 204 || status === 304;
  const responseBody =
    noBody || body === null ? null : body instanceof Response ? await body.arrayBuffer() : body;
  return new Response(responseBody, { status, headers });
}
