// GET /api/v1/admin/workspaces/:workspaceId/pending-billing: bounded,
// instance-admin-only read of ambiguous billing records (non-terminal requests
// plus terminal requests whose reservation is still held). Read-only: never
// mutates wallets, reservations or history. Mounted standalone (app.ts
// registration is the integration owner's lane).
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { q } from "./helpers";
import { makeApp, signUp, userIdByEmail, makeInstanceAdmin, cookieOf } from "./helpers";
import { createAuth } from "../src/auth";
import { adminWalletPendingRoutes } from "../src/routes/admin-wallet-pending";

let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

const NOW = 1_700_000_000_000;

async function makeAdmin() {
  const made = await makeApp();
  drops.push(made.close);
  const { db, app } = made;
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const cookie = await signUp(app, email, "Admin");
  await makeInstanceAdmin(db, await userIdByEmail(db, email));
  return { db, app, cookie };
}

async function seedBillingCanvas(db: Awaited<ReturnType<typeof makeApp>>["db"], ws: string) {
  await db.execute(
    sql`insert into workspaces (id, name, status, created_at) values (${ws}, ${ws}, 'active', ${NOW})`,
  );
  await db.execute(
    sql`insert into users (id, name, email, created_at, updated_at) values ('u-seed', 'U', 'seed@t.local', ${NOW}, ${NOW})`,
  );
  await db.execute(
    sql`insert into api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) values ('key-seed', ${ws}, 'hash', 'sk-hbr-x', 'k', 'active', ${NOW})`,
  );
  await db.execute(
    sql`insert into wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at) values ('wal-seed', ${ws}, 'topup', 'VND', 50000, 0, 0, ${NOW})`,
  );
  await db.execute(
    sql`insert into models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) values ('model-seed', 'pub-seed', 'slug-seed', 'Seed', 'openai', true, true, ${NOW}, ${NOW})`,
  );
  await db.execute(
    sql`insert into model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at) values ('price-seed', 'model-seed', 1000000, 2000000, 500000, 3000000, 1000000, ${NOW})`,
  );
  await db.execute(
    sql`insert into provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) values ('pm-seed', 'model-seed', 'openai', 'up-seed', true, ${NOW}, ${NOW})`,
  );
}

type RequestSeed = {
  id: string;
  dispatch_state: "reserved" | "dispatching" | "terminal";
  status: "pending" | "ok" | "client_abort" | "upstream_error" | "unknown";
  created_at: number;
  reservation?: { status: "held" | "settled" | "settled_full_hold" | "released" };
};

async function seedRequest(db: Awaited<ReturnType<typeof makeApp>>["db"], s: RequestSeed) {
  await db.execute(
    sql`insert into requests (id, workspace_id, endpoint, mode, status, dispatch_state, created_at, model_id) values (${s.id}, 'ws-p', '/v1/chat/completions', 'stream', ${s.status}, ${s.dispatch_state}, ${s.created_at}, 'model-seed')`,
  );
  if (s.reservation) {
    await db.execute(
      sql`insert into billing_reservations (id, wallet_id, request_id, model_id, model_price_id, usd_vnd_exchange_rate, markup_ppm, cap_vnd, status, created_at) values (${`br-${s.id}`}, 'wal-seed', ${s.id}, 'model-seed', 'price-seed', 26000, 1000000, 1234, ${s.reservation.status}, ${s.created_at})`,
    );
  }
}

describe("GET /api/v1/admin/workspaces/:ws/pending-billing", () => {
  test("returns non-terminal + terminal-with-held, excludes resolved terminal; reservation snapshot exact", async () => {
    const { db, cookie } = await makeAdmin();
    await seedBillingCanvas(db, "ws-p");
    await seedRequest(db, { id: "r-old", dispatch_state: "dispatching", status: "pending", created_at: NOW });
    await seedRequest(db, { id: "r-held", dispatch_state: "terminal", status: "unknown", created_at: NOW + 1, reservation: { status: "held" } });
    await seedRequest(db, { id: "r-done", dispatch_state: "terminal", status: "ok", created_at: NOW + 2, reservation: { status: "settled" } });
    await seedRequest(db, { id: "r-plain", dispatch_state: "terminal", status: "ok", created_at: NOW + 3 });
    const plugin = adminWalletPendingRoutes(db, createAuth(db));
    const res = await plugin.handle(
      new Request("http://t/api/v1/admin/workspaces/ws-p/pending-billing", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        request_id: string;
        created_at: number;
        dispatch_state: string;
        status: string;
        endpoint: string;
        billing_reservation: { id: string; status: string; cap_vnd: number } | null;
      }[];
      total: number;
      limit: number;
    };
    expect(body.data.map((r) => r.request_id)).toEqual(["r-old", "r-held"]); // oldest first
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    const rOld = body.data[0]!;
    expect(typeof rOld.created_at).toBe("number");
    expect(rOld.endpoint).toBe("/v1/chat/completions");
    expect(rOld.billing_reservation).toBeNull(); // no reservation row -> null, not invented
    expect(body.data[1]!.billing_reservation).toEqual({
      id: "br-r-held",
      status: "held",
      cap_vnd: 1234,
    });
  });

  test("bounded: hard limit 50 rows, total reports the real count", async () => {
    const { db, cookie } = await makeAdmin();
    await seedBillingCanvas(db, "ws-p");
    for (let i = 0; i < 53; i++) {
      await seedRequest(db, {
        id: `r-${String(i).padStart(3, "0")}`,
        dispatch_state: "dispatching",
        status: "pending",
        created_at: NOW + i,
      });
    }
    const plugin = adminWalletPendingRoutes(db, createAuth(db));
    const res = await plugin.handle(
      new Request("http://t/api/v1/admin/workspaces/ws-p/pending-billing", {
        headers: { cookie },
      }),
    );
    const body = (await res.json()) as { data: unknown[]; total: number; limit: number };
    expect(body.data).toHaveLength(50);
    expect(body.total).toBe(53);
    expect(body.limit).toBe(50);
  });

  test("non-admin 403; unknown workspace 404", async () => {
    const { db, app, cookie } = await makeAdmin();
    const plainCookie = cookieOf(
      await app.handle(
        new Request("http://localhost/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: `u-${crypto.randomUUID()}@example.com`,
            password: "Correct-Horse-Battery-Staple-1",
            name: "U",
          }),
        }),
      ),
    );
    const plugin = adminWalletPendingRoutes(db, createAuth(db));
    const forbidden = await plugin.handle(
      new Request("http://t/api/v1/admin/workspaces/ws-x/pending-billing", {
        headers: { cookie: plainCookie },
      }),
    );
    expect(forbidden.status).toBe(403);
    const missing = await plugin.handle(
      new Request("http://t/api/v1/admin/workspaces/nope/pending-billing", {
        headers: { cookie },
      }),
    );
    expect(missing.status).toBe(404);
  });

  test("read-only: no wallet/reservation mutation on the read path", async () => {
    const { db, cookie } = await makeAdmin();
    await seedBillingCanvas(db, "ws-p");
    await seedRequest(db, { id: "r-1", dispatch_state: "reserved", status: "pending", created_at: NOW, reservation: { status: "held" } });
    const plugin = adminWalletPendingRoutes(db, createAuth(db));
    await plugin.handle(
      new Request("http://t/api/v1/admin/workspaces/ws-p/pending-billing", { headers: { cookie } }),
    );
    const w = await q<{ balance: number; reserved: number }>(
      db,
      "select balance, reserved from wallets where id = 'wal-seed'",
    );
    expect(w[0]!.balance).toBe(50000);
    expect(w[0]!.reserved).toBe(0);
    const br = await q<{ status: string }>(
      db,
      "select status from billing_reservations where id = 'br-r-1'",
    );
    expect(br[0]!.status).toBe("held");
  });
});
