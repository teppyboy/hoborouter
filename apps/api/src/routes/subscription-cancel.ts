// Cancel-subscription routes (member+, workspace-scoped). Owner decision (b):
// canceling stops renewal only — the row keeps status 'active', credit stays
// spendable through current_period_end, and the existing lazy expiry (O5)
// forfeits the leftover at period end exactly as for an uncanceled
// subscription. Cancel moves no money: no wallet update, no ledger entry.
// The paired PUT clears the cancel marker (Renew): re-enables the normal
// renewal path, still moving no money — no refund, no credit, no new charge;
// the period end and expiry behavior are untouched.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { cancelSubscription, resumeSubscription, runInImmediate } from "@hoborouter/wallet";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, wsRole, jsonError } from "../authz";

export const subscriptionCancelRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "subscription-cancel" })
    .delete(
      "/api/v1/workspaces/:id/subscription",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Cancel the workspace's active subscription",
          description:
            "Stops renewal; no refund or forfeit. Credit stays usable until the current period ends, then normal expiry applies. Idempotent.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const role = await wsRole(db, params.id, gate.session.user.id);
        // Unknown workspace AND non-member both 404: no existence leak.
        if (!role) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const canceled = await runInImmediate(db, (tx) =>
          cancelSubscription(tx, params.id, Date.now()),
        );
        if (!canceled) return jsonError(404, "NOT_FOUND", "No active subscription");
        return new Response(
          JSON.stringify({
            id: canceled.id,
            status: "active",
            canceled_at: canceled.canceled_at,
            period_end: canceled.current_period_end,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    )
    .put(
      "/api/v1/workspaces/:id/subscription",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Renew (re-enable renewal on) the workspace's canceled subscription",
          description:
            "Clears the cancel marker so the subscription re-enters the normal renewal path. No refund, credit, or new charge; the current period is unchanged. Idempotent.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const role = await wsRole(db, params.id, gate.session.user.id);
        // Unknown workspace AND non-member both 404: no existence leak.
        if (!role) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const resumed = await runInImmediate(db, (tx) =>
          resumeSubscription(tx, params.id, Date.now()),
        );
        if (!resumed) return jsonError(404, "NOT_FOUND", "No active subscription");
        return new Response(
          JSON.stringify({
            id: resumed.id,
            status: "active",
            canceled: false,
            period_end: resumed.current_period_end,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
