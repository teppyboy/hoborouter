import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireInstanceAdmin, requireSession, writeAudit } from "../authz";
import {
  boundedPanelJson,
  CpaPanelService,
  PanelError,
  panelReadSchema,
  panelMutationSchema,
  panelExecuteSchema,
} from "../cpa-panel-core";
import { panelAsset } from "../cpa-panel-asset";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const failure = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

export function adminCpaPanelRoutes(
  db: Db,
  auth: BetterAuthInstance,
  env: Record<string, string | undefined> = process.env,
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>,
) {
  const origin = new URL(env.BETTER_AUTH_URL || env.HBR_BASE_URL || "http://localhost:3000").origin;
  const service = new CpaPanelService(
    env,
    fetcher,
    Date.now,
    async (actor, operation, path, status, latency) => {
      await writeAudit(db, {
        actorUserId: actor.userId,
        workspaceId: null,
        action: `cpa.panel.${operation}`,
        target: path,
        detail: { upstream_status: status, latency_ms: latency },
      });
    },
  );
  const handle = async (
    request: Request,
    action: "session" | "management.html" | "read" | "prepare" | "execute",
  ) => {
    try {
      const gate = await requireSession(auth, request);
      if (!gate.session) return failure(401, "UNAUTHORIZED", "Authentication required");
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return failure(403, "FORBIDDEN", "Instance admin required");
      if (new URL(request.url).search)
        return failure(400, "HBR_PANEL_INVALID", "Unexpected query parameters");
      const site = request.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none")
        return failure(403, "HBR_PANEL_ORIGIN", "Same-origin request required");
      const actor = { userId: gate.session.user.id, sessionId: gate.session.session.id };
      if (action === "management.html") return panelAsset(origin);
      if (action === "session") return json({ csrf_token: service.session(actor) });
      if (request.headers.get("origin") !== origin)
        return failure(403, "HBR_PANEL_ORIGIN", "Exact admin Origin required");
      service.validateCsrf(actor, request.headers.get("x-hbr-panel-csrf"));
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") || "",
        )
      )
        return failure(415, "HBR_PANEL_JSON_REQUIRED", "JSON content type required");
      let input: unknown;
      try {
        input = await boundedPanelJson(request);
      } catch {
        return failure(400, "HBR_PANEL_INVALID", "Invalid or oversized JSON body");
      }
      if (action === "read") {
        const parsed = panelReadSchema.safeParse(input);
        if (!parsed.success) return failure(400, "HBR_PANEL_INVALID", "Invalid panel operation");
        return json({ data: await service.read(parsed.data.operation, actor) });
      }
      if (action === "prepare") {
        const parsed = panelMutationSchema.safeParse(input);
        if (!parsed.success) return failure(400, "HBR_PANEL_INVALID", "Invalid panel proposal");
        const prepared = service.prepare(actor, parsed.data);
        await writeAudit(db, {
          actorUserId: actor.userId,
          workspaceId: null,
          action: "cpa.panel.prepare",
          target: parsed.data.operation,
          detail: null,
        });
        return json(prepared);
      }
      const parsed = panelExecuteSchema.safeParse(input);
      if (!parsed.success) return failure(400, "HBR_PANEL_INVALID", "Invalid panel approval");
      return json({ data: await service.execute(actor, parsed.data.approval_id) });
    } catch (error) {
      if (error instanceof PanelError) return failure(error.status, error.code, error.message);
      return failure(500, "HBR_PANEL_INTERNAL", "Panel request failed");
    }
  };
  const prefix = "/api/v1/admin/cpa/panel/";
  return new Elysia({ name: "admin-cpa-panel" })
    .get(`${prefix}session`, ({ request }) => handle(request, "session"))
    .get(`${prefix}management.html`, ({ request }) => handle(request, "management.html"))
    .post(`${prefix}read`, ({ request }) => handle(request, "read"))
    .post(`${prefix}prepare`, ({ request }) => handle(request, "prepare"))
    .post(`${prefix}execute`, ({ request }) => handle(request, "execute"));
}
