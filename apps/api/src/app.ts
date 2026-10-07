import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { createDb, type Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "./auth-types";
import { healthRoutes } from "./routes/health";
import { staticSpa } from "./static-spa";
import { workspacesRoutes } from "./routes/workspaces";
import { membersRoutes } from "./routes/members";
import { auditRoutes } from "./routes/audit";
import { keysRoutes } from "./routes/keys";
import { chatsRoutes } from "./routes/chats";
import { cpaManagementProxyRoutes } from "./cpa-management-core";
import { cpaHealthRoutes } from "./routes/cpahealth";
import { adminModelsRoutes } from "./routes/admin-models";
import { adminCatalogRoutes } from "./routes/admin-catalog";
import { v1ModelsRoutes } from "./routes/v1-models";
import { gatewayRoutes } from "./routes/v1-gateway";
import { recoverPending } from "@hoborouter/wallet";
import { paymentsRoutes } from "./routes/payments";
import { bundlesRoutes } from "./routes/bundles";
import { throughputRoutes } from "./routes/throughput";
import { adminThroughputRoutes } from "./routes/admin-throughput";
import { adminBundlesRoutes } from "./routes/admin-bundles";
import { mockWebhookRoutes } from "./routes/webhooks-mock";
import { payosWebhookRoutes } from "./routes/webhooks-payos";
import { dashboardRoutes } from "./routes/dashboard";
import { adminExtraRoutes } from "./routes/admin-extra";
import { adminPaymentRejectRoutes } from "./routes/admin-payment-reject";
import { adminPaymentLateCreditRoutes } from "./routes/admin-payment-late-credit";
import { adminUserEditRoutes } from "./routes/admin-user-edit";
import { adminCpaMutationRoutes } from "./routes/admin-cpa-mutations";
import { adminSettingsRoutes } from "./routes/admin-settings";
import { adminRequestsRoutes } from "./routes/admin-requests";
import { adminBusinessRoutes } from "./routes/admin-business";
import { adminPromotionsRoutes } from "./routes/admin-promotions";
import { adminSupportLeadRoutes } from "./routes/admin-support-leads";
import { promotionsRoutes } from "./routes/promotions";
import { subscriptionCancelRoutes } from "./routes/subscription-cancel";
import { supportLeadRoutes } from "./routes/support-leads";
import { supportSettingsRoutes } from "./routes/support-settings";
import { publicCatalogRoutes } from "./routes/public-catalog";
import { catalogPublicRoutes } from "./routes/catalog-public";
import { publicConfigRoutes } from "./routes/public-config";
import { accountRoutes } from "./routes/account";
import { payosConfigFromEnv, type PayosConfig } from "@hoborouter/payments";
import { mockWebhookConfig } from "./mock-config";
import { createAuth } from "./auth";

const defaultWebDist = new URL("../../web/dist", import.meta.url).pathname;

const openapiDocumentation = {
  info: {
    title: "Hoborouter API",
    version: "1.0.0",
    description:
      "Hoborouter control-plane API (versioned under /api/v1), OpenAI-compatible gateway (/v1), and Better Auth endpoints (/api/auth). Session-cookie routes use cookieAuth; programmatic keys use bearerAuth.",
  },
  tags: [
    { name: "Workspaces", description: "Workspace create, list, and management" },
    { name: "Members", description: "Workspace membership and roles" },
    { name: "Keys", description: "API key (sk-hbr-) issuance and lifecycle" },
    { name: "Audit", description: "Audit log query" },
    { name: "Catalog", description: "Public model catalog" },
    { name: "Admin", description: "Instance-admin catalog and payments management" },
    { name: "Dashboard", description: "Wallet, ledger, request, and usage views" },
    { name: "Billing", description: "Payments and wallet top-ups" },
    { name: "Payments", description: "Payment provider callbacks" },
    { name: "System", description: "CPA health and system status" },
    { name: "Health", description: "Liveness and readiness" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description: "Better Auth session cookie",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Programmatic API key (sk-hbr-...)",
      },
    },
  },
} satisfies Partial<import("openapi-types").OpenAPIV3.Document>;

export interface AppDeps {
  db?: Db;
  auth?: BetterAuthInstance;
  /** Test injection: payOS config + fetch for the member create route. */
  payos?: {
    cfg: PayosConfig;
    fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  };
}

// Async: startup reconciliation (recoverPending) is awaited so tests and boot
// observe a fully reconciled app. Migration happens in boot (src/index.ts) or
// the test harness, NOT here — buildApp never mutates the schema.
export const buildApp = async (deps: AppDeps = {}) => {
  const webDist = process.env.HBR_WEB_DIST || defaultWebDist;
  const db = deps.db ?? createDb();
  const auth = deps.auth ?? createAuth(db);
  const mockPayments = mockWebhookConfig();

  const authHandler = (ctx: { request: Request }) => auth.handler(ctx.request);

  const app = new Elysia({ name: "hoborouter-api" })
    .use(healthRoutes)
    .use(
      openapi({
        path: "/docs",
        specPath: "/openapi.json",
        documentation: openapiDocumentation,
      }),
    )
    // Elysia 2.0.0-exp.64: the method-specific .get("/api/*") 404 wildcard
    // beats .all("/api/auth/*") for GET, so register GET explicitly.
    .get("/api/auth/*", authHandler)
    .all("/api/auth/*", authHandler);
  // Registered via loop instead of a .use() chain: chaining 30+ route groups
  // nests Elysia's instance type past TS's instantiation-depth limit (TS2589).
  // Same registration order as before; only the type surface is flatter.
  const routeGroups = [
    workspacesRoutes(db, auth),
    membersRoutes(db, auth),
    auditRoutes(db, auth),
    keysRoutes(db, auth),
    chatsRoutes(db, auth),
    paymentsRoutes(db, auth, deps.payos?.cfg ?? payosConfigFromEnv(), deps.payos?.fetch),
    bundlesRoutes(db, auth, deps.payos?.cfg ?? payosConfigFromEnv(), deps.payos?.fetch),
    mockWebhookRoutes(db, mockPayments),
    payosWebhookRoutes(db, payosConfigFromEnv()),
    cpaHealthRoutes(db, auth),
    cpaManagementProxyRoutes(db, auth),
    adminModelsRoutes(db, auth),
    adminCatalogRoutes(db, auth),
    dashboardRoutes(db, auth),
    adminExtraRoutes(db, auth),
    adminPaymentRejectRoutes(db, auth),
    adminPaymentLateCreditRoutes(db, auth),
    adminUserEditRoutes(db, auth),
    adminSettingsRoutes(db, auth),
    adminCpaMutationRoutes(db, auth),
    adminBundlesRoutes(db, auth),
    throughputRoutes(db, auth, deps.payos?.cfg ?? payosConfigFromEnv(), deps.payos?.fetch),
    adminThroughputRoutes(db, auth),
    adminRequestsRoutes(db, auth),
    catalogPublicRoutes(db, auth),
    publicConfigRoutes(),
    accountRoutes(db, auth),
    publicCatalogRoutes(db),
    supportSettingsRoutes(db, auth),
    adminBusinessRoutes(db, auth),
    adminPromotionsRoutes(db, auth),
    adminSupportLeadRoutes(db, auth),
    promotionsRoutes(db, auth),
    supportLeadRoutes(db, auth),
    subscriptionCancelRoutes(db, auth),
    v1ModelsRoutes(db),
    gatewayRoutes(db),
  ];
  for (const group of routeGroups) app.use(group);
  app.get(
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
  );

  // CI runs tests before building the web app; a missing dist must not crash
  // boot — log once and serve the API without the SPA.
  if (existsSync(webDist)) app.use(staticSpa(webDist));
  else console.warn(`[hoborouter] web dist not found at ${webDist}; serving API without SPA`);

  // Crash-safe reconciliation of stale reserved/dispatching rows at startup.
  await recoverPending(db, Date.now());

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
      // Bun ignores init.headers when cloning a Request, so rebuild from the
      // URL to actually drop the stripped headers.
      const cleanRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: request.redirect,
        signal: request.signal,
        // @ts-expect-error Bun requires duplex for streaming request bodies
        duplex: "half",
      });
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
        let extras: Record<string, unknown> = {};
        // Elysia 2.0.0-exp.64 emits validation failures as 422
        // application/problem+json { type: 'validation', title, status } —
        // no 'VALIDATION' code field. Normalize to the API's 400 contract
        // without echoing internal schema details.
        if (status === 422) {
          return await boundaryResponse(
            request,
            400,
            JSON.stringify({ error: { code: "INVALID", message: "Request failed validation" } }),
            response,
            requestId,
            true,
          );
        }
        // Server-generated 502/503/504 JSON errors (e.g. CPA_* codes) carry
        // actionable detail for the instance admin; 500 stays masked.
        if (status === 502 || status === 503 || status === 504) {
          try {
            const body = await response.clone().json();
            const error = body?.error ?? body;
            if (typeof error?.code === "string") code = error.code;
            if (typeof error?.message === "string") message = error.message;
          } catch {
            // Keep the generic safe response.
          }
        }
        if (status < 500) {
          try {
            const body = await response.clone().json();
            const error = body?.error ?? body;
            if (typeof error?.code === "string") code = error.code;
            if (typeof error?.message === "string") message = error.message;
            // Preserve the contract-defined extra error field `workspaces`
            // (SOLE_OWNER workspace list, 4xx client routes only); never
            // forward arbitrary route fields through the boundary.
            if (
              status >= 400 &&
              status <= 499 &&
              error &&
              typeof error === "object" &&
              Array.isArray((error as Record<string, unknown>).workspaces)
            ) {
              extras = { workspaces: (error as Record<string, unknown>).workspaces };
            }
          } catch {
            // Keep the generic safe response.
          }
        }
        return await boundaryResponse(
          request,
          status,
          JSON.stringify({ error: { code, message, ...extras, request_id: requestId } }),
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
  // json === false is a passthrough of a route-produced Response: stream its
  // body untouched so SSE reaches the client incrementally. Buffering is only
  // for small JSON error bodies built by this boundary.
  const responseBody =
    noBody || body === null
      ? null
      : body instanceof Response
        ? json
          ? await body.arrayBuffer()
          : body.body
        : body;
  return new Response(responseBody, { status, headers });
}
