// Admin request-log removal (soft delete) via DELETE /api/v1/admin/requests/:id.
// Covers: admin 200 + idempotent repeat (single audit row), member/owner 403,
// unauthenticated 401, unknown id 404, row hidden from workspace logs list,
// visible counts drop, and money untouched (wallet, ledger, spend totals).
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  makeApp,
  signUp,
  req,
  createWorkspace,
  addMember,
  makeInstanceAdmin,
  userIdByEmail,
} from "./helpers";

const OWNER = "own@example.com";
const MEMBER = "mem@example.com";
const INST = "inst@example.com";
const WS = "ws-soft-del";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let db: Database;
let owner: string;
let member: string;
let inst: string;

function seedRequest(id: string, workspaceId: string) {
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at) VALUES (?, 'pub', 'pub', 'Pub', 'openai', ?, ?)",
  ).run("mod-" + id, Date.now(), Date.now());
  db.prepare(
    "INSERT INTO requests (id, workspace_id, endpoint, mode, status, created_at, model_id) VALUES (?, ?, '/v1/chat/completions', 'stream', 'ok', ?, 'mod-' || ?)",
  ).run(id, workspaceId, Date.now(), id);
}

function seedUsageLog(id: string, requestId: string, workspaceId: string, status: string) {
  db.prepare(
    `INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model,
      upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status,
      charged_vnd, created_at)
     VALUES (?, ?, ?, ?, 'openai', 'pub', 'up', 10, 20, 0, 0, ?, 1000, ?)`,
  ).run(id, "idem-" + id, requestId, workspaceId, status, Date.now());
}

function seedWallet(workspaceId: string) {
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, balance, reserved, created_at) VALUES (?, ?, 50000, 0, ?)",
  ).run("wal-" + workspaceId, workspaceId, Date.now());
  db.prepare(
    "INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at) VALUES ('led-1', 'wal-' || ?, 'credit', 50000, 'topup', 50000, 'seed', ?)",
  ).run(workspaceId, Date.now());
}

beforeAll(async () => {
  ctx = await makeApp();
  db = ctx.db;
  owner = await signUp(ctx.app, OWNER);
  member = await signUp(ctx.app, MEMBER);
  inst = await signUp(ctx.app, INST);
  createWorkspace(db, WS, userIdByEmail(db, OWNER));
  addMember(db, WS, userIdByEmail(db, MEMBER), "member");
  makeInstanceAdmin(db, userIdByEmail(db, INST));
  seedRequest("req-1", WS);
  seedUsageLog("log-1", "req-1", WS, "ok");
  seedWallet(WS);
});

const snapshotMoney = () => {
  const wallet = db.prepare("SELECT balance FROM wallets WHERE id = ?").get("wal-" + WS) as {
    balance: number;
  };
  const ledger = db
    .prepare("SELECT count(*) AS n FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE w.workspace_id = ?")
    .get(WS) as { n: number };
  const summary = ctx.app.handle(
    new Request(`http://localhost/api/v1/workspaces/${WS}/usage-summary?days=30`, {
      headers: { cookie: owner },
    }),
  );
  return { wallet: wallet.balance, ledger: ledger.n, summary };
};

describe("DELETE /api/v1/admin/requests/:id", () => {
  test("unauthenticated -> 401", async () => {
    const res = await req(ctx.app, "/api/v1/admin/requests/req-1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("workspace owner -> 403 (not instance admin)", async () => {
    const res = await req(ctx.app, "/api/v1/admin/requests/req-1", {
      method: "DELETE",
      cookie: owner,
    });
    expect(res.status).toBe(403);
  });

  test("workspace member -> 403", async () => {
    const res = await req(ctx.app, "/api/v1/admin/requests/req-1", {
      method: "DELETE",
      cookie: member,
    });
    expect(res.status).toBe(403);
  });

  test("unknown id -> 404", async () => {
    const res = await req(ctx.app, "/api/v1/admin/requests/nope", {
      method: "DELETE",
      cookie: inst,
    });
    expect(res.status).toBe(404);
  });

  test("instance admin -> 200, repeat 200 with a single audit row, money unchanged", async () => {
    const before = snapshotMoney();
    const beforeSummary = await before.summary.then((r) => r.json());

    const res = await req(ctx.app, "/api/v1/admin/requests/req-1", {
      method: "DELETE",
      cookie: inst,
    });
    expect(res.status).toBe(200);

    // Row is soft-deleted, wallet/ledger untouched.
    const row = db.prepare("SELECT deleted_at, deleted_by FROM requests WHERE id = ?").get("req-1") as {
      deleted_at: number | null;
      deleted_by: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(userIdByEmail(db, INST));

    const afterSummary = await snapshotMoney().summary.then((r) => r.json());
    // Visible counts drop; financial totals keep the deleted log.
    expect(beforeSummary.totals.visible_requests).toBe(1);
    expect(afterSummary.totals.visible_requests).toBe(0);
    expect(afterSummary.totals.visible_errors).toBe(0);
    expect(afterSummary.totals.requests).toBe(beforeSummary.totals.requests);
    expect(afterSummary.totals.spend_vnd).toBe(beforeSummary.totals.spend_vnd);

    // Log list no longer shows the deleted request's log.
    const listRes = await ctx.app.handle(
      new Request(`http://localhost/api/v1/workspaces/${WS}/usage-logs?limit=50`, {
        headers: { cookie: owner },
      }),
    );
    const list = (await listRes.json()) as { data: { request_id: string }[] };
    expect(list.data.some((r) => r.request_id === "req-1")).toBe(false);

    // Idempotent repeat: still 200, exactly one audit row.
    const repeat = await req(ctx.app, "/api/v1/admin/requests/req-1", {
      method: "DELETE",
      cookie: inst,
    });
    expect(repeat.status).toBe(200);
    const audits = db
      .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'request.delete' AND target = ?")
      .get("req-1") as { n: number };
    expect(audits.n).toBe(1);

    // Money untouched across both calls.
    const after = await snapshotMoney();
    expect(after.wallet).toBe(before.wallet);
    expect(after.ledger).toBe(before.ledger);
  });
});
