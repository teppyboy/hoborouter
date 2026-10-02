// Tests for scripts/sqlite-to-pg.ts: builds a legacy-schema SQLite DB
// (migrations from commit 3af6325), copies it into a throwaway Postgres
// database and verifies counts, money invariants and type conversions.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const OLD_MIGRATIONS_COMMIT = "3af6325";
const OLD_MIGRATION_FILES = [
  "0000_common_zarda.sql",
  "0001_append_only_triggers.sql",
  "0002_foamy_luminals.sql",
  "0003_paid_gateway_task2a.sql",
  "0004_paid_gateway_fix.sql",
  "0005_api_key_statuses.sql",
  "0006_prompt_caching.sql",
  "0007_requests_soft_delete.sql",
];

const NOW = 1_700_000_000_000;

let dir: string;
let sqlitePath: string;
let targetUrl: string;
let closeTarget: () => Promise<void>;

async function applyOldMigrations(db: InstanceType<typeof Database>) {
  for (const f of OLD_MIGRATION_FILES) {
    const sqlText = execFileSync("git", [
      "show",
      `${OLD_MIGRATIONS_COMMIT}:packages/db/drizzle/${f}`,
    ]).toString();
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) db.run(trimmed);
    }
  }
}

function seedLegacy(db: InstanceType<typeof Database>) {
  db.run(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    ["u1", "Owner", "owner@example.com", 0, NOW, NOW, "u2", "Admin", "admin@example.com", 1, NOW, NOW],
  );
  db.run("INSERT INTO workspaces (id, name, status, created_at) VALUES (?, ?, ?, ?)", [
    "w1",
    "WS",
    "active",
    NOW,
  ]);
  db.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)", [
    "w1",
    "u1",
    "owner",
  ]);
  db.run(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["wal1", "w1", "VND", 87600, 0, 2, NOW],
  );
  db.run(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["p1", "w1", 100000, "succeeded", "manual", "ORD-1", NOW],
  );
  db.run(
    "INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, payment_id, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["l1", "wal1", "credit", 100000, "topup", "p1", 100000, NOW],
  );
  db.run(
    "INSERT INTO models (id, public_id, slug, display_name, provider, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["m1", "pub-model", "pub-model", "Pub Model", "openai", '{"context":128000}', NOW, NOW],
  );
  db.run(
    "INSERT INTO requests (id, workspace_id, model_id, endpoint, mode, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["r1", "w1", "m1", "/v1/chat/completions", "stream", "ok", NOW],
  );
  // Soft-deleted request must survive the copy (audit trail only).
  db.run(
    "INSERT INTO requests (id, workspace_id, model_id, endpoint, mode, status, created_at, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["r2", "w1", "m1", "/v1/chat/completions", "stream", "ok", NOW, NOW, "u2"],
  );
  db.run(
    "INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["l2", "wal1", "debit", 12400, "settle", 87600, NOW],
  );
  db.run(
    "INSERT INTO usage_events (id, source_request_id, tokens_input, tokens_output, tokens_reasoning, tokens_cached, tokens_total, failed, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["e1", "r1", 100, 50, 0, 10, 150, 0, NOW],
  );
  db.run(
    "INSERT INTO audit_log (id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    ["a1", "test.action", "w1", '{"ip":"127.0.0.1"}', NOW],
  );
}

function runScript(extraArgs: string[]): { exitCode: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, "scripts/sqlite-to-pg.ts", ...extraArgs], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

beforeAll(async () => {
  const { createTestDb, closeDb } = await import("../packages/db/src/index");
  const testDb = await createTestDb();
  targetUrl = testDb.url;
  closeTarget = () => closeDb(testDb.db);

  dir = mkdtempSync(join(tmpdir(), "sqlite-to-pg-"));
  sqlitePath = join(dir, "legacy.sqlite");
  const legacy = new Database(sqlitePath);
  try {
    await applyOldMigrations(legacy);
    seedLegacy(legacy);
  } finally {
    legacy.close();
  }
});

afterAll(async () => {
  await closeTarget();
  rmSync(dir, { recursive: true, force: true });
});

describe("sqlite-to-pg", () => {
  test("copies legacy schema, converts types, verifies invariants", async () => {
    const res = runScript(["--from", sqlitePath, "--to", targetUrl]);
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Verification passed");

    const { createDb, closeDb } = await import("../packages/db/src/index");
    const db = createDb(targetUrl);
    try {
      const counts = (
        await db.execute(
          "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM wallets) AS wallets, (SELECT COUNT(*) FROM ledger_entries) AS ledger_entries, (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM requests) AS requests, (SELECT COUNT(*) FROM usage_events) AS usage_events",
        )
      )[0] as unknown as Record<string, number>;
      // Bun.SQL returns counts as strings; normalize before comparing.
      const normalized = Object.fromEntries(
        Object.entries(counts).map(([k, v]) => [k, Number(v)]),
      );
      expect(normalized).toEqual({
        users: 2,
        workspaces: 1,
        wallets: 1,
        ledger_entries: 2,
        payments: 1,
        requests: 2,
        usage_events: 1,
      });

      // 0/1 -> boolean conversions.
      const user = (await db.execute("SELECT email_verified FROM users WHERE id = 'u2'"))[0] as unknown as {
        email_verified: boolean;
      };
      expect(user.email_verified).toBe(true);
      const model = (
        await db.execute("SELECT enabled, capabilities FROM models WHERE id = 'm1'")
      )[0] as unknown as { enabled: boolean; capabilities: unknown };
      expect(model.enabled).toBe(true);
      expect(
        typeof model.capabilities === "string"
          ? JSON.parse(model.capabilities)
          : model.capabilities,
      ).toEqual({ context: 128000 });
      const event = (await db.execute("SELECT failed FROM usage_events WHERE id = 'e1'"))[0] as unknown as {
        failed: boolean;
      };
      expect(event.failed).toBe(false);

      // Soft-deleted request preserved.
      const deleted = (
        await db.execute("SELECT deleted_at, deleted_by FROM requests WHERE id = 'r2'")
      )[0] as unknown as { deleted_at: number; deleted_by: string };
      expect(Number(deleted.deleted_at)).toBe(NOW);
      expect(deleted.deleted_by).toBe("u2");

      // Wallet balance matches ledger sum after copy.
      const wallet = (
        await db.execute(
          "SELECT w.balance, COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0) AS s FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id GROUP BY w.id, w.balance",
        )
      )[0] as unknown as { balance: number; s: number };
      expect(Number(wallet.balance)).toBe(87600);
      expect(Number(wallet.s)).toBe(87600);

      // JSON audit detail round-trips as jsonb.
      const audit = (await db.execute("SELECT detail FROM audit_log WHERE id = 'a1'"))[0] as {
        detail: unknown;
      };
      expect(
        typeof audit.detail === "string" ? JSON.parse(audit.detail) : audit.detail,
      ).toEqual({ ip: "127.0.0.1" });
    } finally {
      await closeDb(db);
    }
  });

  test("refuses to re-copy non-empty target without --force", () => {
    const res = runScript(["--from", sqlitePath, "--to", targetUrl]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--force");
  });

  test("--force truncates and re-copies idempotently", async () => {
    const res = runScript(["--from", sqlitePath, "--to", targetUrl, "--force"]);
    expect(res.exitCode).toBe(0);
    const { createDb, closeDb } = await import("../packages/db/src/index");
    const db = createDb(targetUrl);
    try {
      const counts = (await db.execute("SELECT COUNT(*) AS c FROM ledger_entries"))[0] as unknown as unknown as { c: number };
      expect(Number(counts.c)).toBe(2);
    } finally {
      await closeDb(db);
    }
  });
});
