import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createDb } from "../src/client";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "../src/migrate";
import {
  wallets,
  workspaces,
  ledgerEntries,
  payments,
  paymentEvents,
  reservations,
  requests,
  priceSnapshots,
  modelBindings,
  settlements,
  usageEvents,
  settlementUsageEvents,
  unknownResolutions,
  refundOperations,
  users,
  workspaceMembers,
} from "../src/schema";

let dir: string;
let db: Database;
let d: ReturnType<typeof drizzle>;

function wsRow(id: string): typeof workspaces.$inferInsert {
  return { id, name: "ws", status: "active", created_at: 1 };
}

// inserts a valid wallet row; options override fields for negative tests
function walletRow(
  id: string,
  workspaceId: string,
  over: Partial<typeof wallets.$inferInsert> = {},
): typeof wallets.$inferInsert {
  return {
    id,
    workspace_id: workspaceId,
    currency: "VND",
    balance: 100,
    reserved: 0,
    version: 0,
    created_at: 1,
    ...over,
  };
}

function ledgerRow(
  id: string,
  walletId: string,
  over: Partial<typeof ledgerEntries.$inferInsert> = {},
): typeof ledgerEntries.$inferInsert {
  return {
    id,
    wallet_id: walletId,
    direction: "credit" as const,
    amount: 100,
    kind: "topup" as const,
    reservation_id: null,
    original_ledger_entry_id: null,
    payment_id: null,
    balance_after: 100,
    memo: null,
    created_at: 1,
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hbr-db-"));
  db = createDb(join(dir, "test.sqlite"));
  migrate(db);
  d = drizzle(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("pragmas: WAL journal mode and foreign_keys ON on fresh createDb connection", () => {
  const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(mode.journal_mode).toBe("wal");
  const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(fk.foreign_keys).toBe(1);
});

test("migrate is idempotent (runs cleanly twice)", () => {
  expect(() => migrate(db)).not.toThrow();
});

test("orphan FK rejection: wallets with nonexistent workspace", () => {
  expect(() => d.insert(wallets).values(walletRow("w1", "no-such-ws")).run()).toThrow();
});

test("orphan FK rejection: ledger_entries with nonexistent wallet", () => {
  expect(() => d.insert(ledgerEntries).values(ledgerRow("l1", "no-such-wallet")).run()).toThrow();
});

test("orphan FK rejection: reservations with nonexistent wallet or price_snapshot", () => {
  // seed a workspace, request chain for the FK-valid variant
  d.insert(users)
    .values({ id: "u0", name: "u0", email: "u0@test.local", createdAt: new Date(0) })
    .run();
  d.insert(workspaces).values(wsRow("ws0")).run();
  d.insert(modelBindings)
    .values({
      id: "mb0",
      workspace_id: null,
      public_model: "m",
      cpa_alias: "a",
      status: "published",
      price_input_per_1m: 1,
      price_output_per_1m: 1,
      effective_at: 1,
    })
    .run();
  d.insert(requests)
    .values({
      id: "r0",
      workspace_id: "ws0",
      api_key_id: null,
      model_binding_id: "mb0",
      endpoint: "/v1/chat/completions",
      mode: "stream",
      cpa_trace_id: null,
      status: "pending",
      http_status: null,
      ttft_ms: null,
      duration_ms: null,
      created_at: 1,
    })
    .run();

  expect(() =>
    d
      .insert(reservations)
      .values({
        id: "res-x",
        wallet_id: "no-such-wallet",
        gateway_request_id: "r0",
        api_key_id: null,
        price_snapshot_id: "no-such-snap",
        status: "held",
        cap_amount: 10,
        estimated_input_tokens: 0,
        created_at: 1,
        resolved_at: null,
        expires_at: null,
      })
      .run(),
  ).toThrow();

  // valid wallet, nonexistent snapshot
  d.insert(wallets).values(walletRow("w-ok", "ws0")).run();
  expect(() =>
    d
      .insert(reservations)
      .values({
        id: "res-y",
        wallet_id: "w-ok",
        gateway_request_id: "r0",
        api_key_id: null,
        price_snapshot_id: "no-such-snap",
        status: "held",
        cap_amount: 10,
        estimated_input_tokens: 0,
        created_at: 1,
        resolved_at: null,
        expires_at: null,
      })
      .run(),
  ).toThrow();
});

describe("wallet check constraints", () => {
  test("balance = -1 throws", () => {
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w2", "ws0", { balance: -1 }))
        .run(),
    ).toThrow();
  });
  test("reserved > balance throws", () => {
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w3", "ws0", { balance: 10, reserved: 11 }))
        .run(),
    ).toThrow();
  });
  test("balance = 1.5 throws (typeof CHECK)", () => {
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w4", "ws0", { balance: 1.5 }))
        .run(),
    ).toThrow();
  });
  test("reserved = 1.5 throws (typeof CHECK)", () => {
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w5", "ws0", { balance: 10, reserved: 1.5 }))
        .run(),
    ).toThrow();
  });
});

describe("ledger_entries constraints", () => {
  beforeAll(() => {
    d.insert(payments)
      .values({
        id: "p1",
        workspace_id: "ws0",
        amount: 100,
        status: "succeeded",
        provider: "mock",
        provider_order_code: "ord-1",
        created_at: 1,
        expires_at: null,
      })
      .run();
  });

  test("second topup row with same payment_id throws (partial unique)", () => {
    d.insert(ledgerEntries)
      .values(ledgerRow("l-ok", "w-ok", { payment_id: "p1" }))
      .run();
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-dup", "w-ok", { payment_id: "p1" }))
        .run(),
    ).toThrow();
  });
  test("topup with different payment_id is fine", () => {
    d.insert(payments)
      .values({
        id: "p2",
        workspace_id: "ws0",
        amount: 100,
        status: "succeeded",
        provider: "mock",
        provider_order_code: "ord-2",
        created_at: 1,
        expires_at: null,
      })
      .run();
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-ok2", "w-ok", { payment_id: "p2" }))
        .run(),
    ).not.toThrow();
  });
  test("amount = 0 throws (CHECK amount > 0)", () => {
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-zero", "w-ok", { payment_id: null, amount: 0 }))
        .run(),
    ).toThrow();
  });
  test("negative amount throws", () => {
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-neg", "w-ok", { payment_id: null, amount: -5 }))
        .run(),
    ).toThrow();
  });
  test("amount = 1.5 throws (typeof CHECK)", () => {
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(ledgerRow("l-frac", "w-ok", { payment_id: null, amount: 1.5 }))
        .run(),
    ).toThrow();
  });
  test("refund row with NULL original_ledger_entry_id throws", () => {
    expect(() =>
      d
        .insert(ledgerEntries)
        .values(
          ledgerRow("l-refund", "w-ok", {
            kind: "refund",
            direction: "credit" as const,
            original_ledger_entry_id: null,
          }),
        )
        .run(),
    ).toThrow();
  });
  test("append-only: UPDATE ledger_entries throws (trigger RAISE ABORT)", () => {
    expect(() => db.prepare("UPDATE ledger_entries SET amount = 1").run()).toThrow();
  });
  test("append-only: DELETE FROM ledger_entries throws (trigger RAISE ABORT)", () => {
    expect(() => db.prepare("DELETE FROM ledger_entries").run()).toThrow();
  });
});

describe("Phase 2 table uniqueness (constraints ship now, code later)", () => {
  function reservation(id: string, gatewayRequestId: string, snapId: string) {
    d.insert(reservations)
      .values({
        id,
        wallet_id: "w-ok",
        gateway_request_id: gatewayRequestId,
        api_key_id: null,
        price_snapshot_id: snapId,
        status: "held",
        cap_amount: 10,
        estimated_input_tokens: 0,
        created_at: 1,
        resolved_at: null,
        expires_at: null,
      })
      .run();
  }

  beforeAll(() => {
    d.insert(priceSnapshots)
      .values({
        id: "snap1",
        binding_id: "mb0",
        price_input: 10,
        price_output: 20,
        created_at: 1,
      })
      .run();
    d.insert(requests)
      .values({
        id: "r1",
        workspace_id: "ws0",
        api_key_id: null,
        model_binding_id: "mb0",
        endpoint: "/v1/responses",
        mode: "non-stream",
        cpa_trace_id: null,
        status: "pending",
        http_status: null,
        ttft_ms: null,
        duration_ms: null,
        created_at: 1,
      })
      .run();
    reservation("res1", "r1", "snap1");
    d.insert(usageEvents)
      .values({
        id: "ue1",
        source_request_id: "trace-1",
        cpa_execution_uuid: null,
        gateway_request_id: "r1",
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cached: 0,
        tokens_total: 0,
        failed: false,
        latency_ms: null,
        raw_payload: null,
        ingested_at: 1,
      })
      .run();
  });

  test("reservations.gateway_request_id is UNIQUE", () => {
    d.insert(requests)
      .values({
        id: "r2",
        workspace_id: "ws0",
        api_key_id: null,
        model_binding_id: "mb0",
        endpoint: "/v1/responses",
        mode: "non-stream",
        cpa_trace_id: null,
        status: "pending",
        http_status: null,
        ttft_ms: null,
        duration_ms: null,
        created_at: 1,
      })
      .run();
    expect(() => reservation("res2", "r1", "snap1")).toThrow();
  });

  test("second kind='settle' ledger row with same reservation_id throws (partial unique)", () => {
    const base = {
      wallet_id: "w-ok",
      direction: "debit" as const,
      amount: 5,
      kind: "settle" as const,
      reservation_id: "res1",
      payment_id: null,
      balance_after: 95,
      created_at: 1,
    };
    d.insert(ledgerEntries)
      .values({ id: "l-s1", ...base })
      .run();
    expect(() =>
      d
        .insert(ledgerEntries)
        .values({ id: "l-s2", ...base })
        .run(),
    ).toThrow();
  });

  test("settlements.reservation_id UNIQUE", () => {
    const s = {
      reservation_id: "res1",
      charged_input: 1,
      charged_output: 2,
      charged_total: 3,
      settled_at: 1,
    };
    d.insert(settlements)
      .values({ id: "st1", ...s })
      .run();
    expect(() =>
      d
        .insert(settlements)
        .values({ id: "st2", ...s })
        .run(),
    ).toThrow();
  });

  test("settlementUsageEvents.usage_event_id UNIQUE", () => {
    d.insert(settlementUsageEvents).values({ settlement_id: "st1", usage_event_id: "ue1" }).run();
    expect(() =>
      d
        .insert(settlementUsageEvents)
        .values({ settlement_id: "other", usage_event_id: "ue1" })
        .run(),
    ).toThrow();
  });

  test("unknownResolutions.resolution_key and request_id UNIQUE", () => {
    const row: typeof unknownResolutions.$inferInsert = {
      id: "ur1",
      resolution_key: "rk1",
      request_id: "r1",
      reservation_id: "res1",
      payload_hash: "h",
      outcome: "hold_release" as const,
      result: "{}",
      actor_user_id: null,
      created_at: 1,
    };
    d.insert(unknownResolutions).values(row).run();
    expect(() =>
      d
        .insert(unknownResolutions)
        .values({ ...row, id: "ur2", resolution_key: "rk2" })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(unknownResolutions)
        .values({ ...row, id: "ur3", request_id: "r2" })
        .run(),
    ).toThrow();
  });

  test("refundOperations.operation_key and original_ledger_entry_id UNIQUE", () => {
    const row: typeof refundOperations.$inferInsert = {
      id: "ro1",
      operation_key: "op1",
      original_ledger_entry_id: "l-s1",
      request_id: "r1",
      reservation_id: "res1",
      payload_hash: "h",
      amount: 5,
      result: "{}",
      actor_user_id: null,
      created_at: 1,
    };
    d.insert(refundOperations).values(row).run();
    expect(() =>
      d
        .insert(refundOperations)
        .values({ ...row, id: "ro2", operation_key: "op2" })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(refundOperations)
        .values({ ...row, id: "ro3", original_ledger_entry_id: "l-s2" })
        .run(),
    ).toThrow();
  });

  test("paymentEvents UNIQUE (provider, provider_reference)", () => {
    const row: typeof paymentEvents.$inferInsert = {
      id: "pe1",
      payment_id: "p1",
      provider: "mock",
      provider_reference: "ref-1",
      raw_payload: null,
      signature_valid: null,
      processed_at: 1,
    };
    d.insert(paymentEvents).values(row).run();
    expect(() =>
      d
        .insert(paymentEvents)
        .values({ ...row, id: "pe2" })
        .run(),
    ).toThrow();
  });
});

test("price_snapshots immutable (trigger RAISE ABORT on UPDATE/DELETE)", () => {
  expect(() => db.prepare("UPDATE price_snapshots SET price_input = 1").run()).toThrow();
  expect(() => db.prepare("DELETE FROM price_snapshots").run()).toThrow();
});

test("workspace_members role CHECK rejects bad role", () => {
  expect(() =>
    d
      .insert(workspaceMembers)
      .values({
        workspace_id: "ws0",
        user_id: "u0",
        role: "superuser" as unknown as "owner",
      })
      .run(),
  ).toThrow();
});

test("price_snapshots.price_output = 1.5 throws (typeof CHECK)", () => {
  expect(() =>
    d
      .insert(priceSnapshots)
      .values({
        id: "snap-frac",
        binding_id: "mb0",
        price_input: 1,
        price_output: 1.5,
        created_at: 1,
      })
      .run(),
  ).toThrow();
});

test("money typeof on cap_amount / prices (fractional throws)", () => {
  expect(() =>
    d
      .insert(reservations)
      .values({
        id: "res-frac",
        wallet_id: "w-ok",
        gateway_request_id: "r1",
        api_key_id: null,
        price_snapshot_id: "snap1",
        status: "held",
        cap_amount: 1.5,
        estimated_input_tokens: 0,
        created_at: 1,
        resolved_at: null,
        expires_at: null,
      })
      .run(),
  ).toThrow();
});

describe("money domain bounds (CHECK constraints)", () => {
  // distinct workspaces/wallets/requests/reservations so unique indexes
  // don't mask the CHECK violations under test
  beforeAll(() => {
    d.insert(users)
      .values({ id: "u-cur", name: "u-cur", email: "u-cur@test.local", createdAt: new Date(0) })
      .run();
    d.insert(workspaces).values(wsRow("ws-cur")).run();
    d.insert(modelBindings)
      .values({
        id: "mb-cur",
        workspace_id: null,
        public_model: "m",
        cpa_alias: "a",
        status: "published",
        price_input_per_1m: 1,
        price_output_per_1m: 1,
        effective_at: 1,
      })
      .run();
    d.insert(priceSnapshots)
      .values({
        id: "snap-cur",
        binding_id: "mb-cur",
        price_input: 1,
        price_output: 1,
        created_at: 1,
      })
      .run();
    d.insert(requests)
      .values({
        id: "r-cur",
        workspace_id: "ws-cur",
        api_key_id: null,
        model_binding_id: "mb-cur",
        endpoint: "/v1/responses",
        mode: "non-stream",
        cpa_trace_id: null,
        status: "pending",
        http_status: null,
        ttft_ms: null,
        duration_ms: null,
        created_at: 1,
      })
      .run();
    d.insert(wallets)
      .values({
        id: "w-cur-ok",
        workspace_id: "ws-cur",
        currency: "VND",
        balance: 100,
        reserved: 0,
        version: 0,
        created_at: 1,
      })
      .run();
    d.insert(reservations)
      .values({
        id: "res-cur",
        wallet_id: "w-cur-ok",
        gateway_request_id: "r-cur",
        api_key_id: null,
        price_snapshot_id: "snap-cur",
        status: "held",
        cap_amount: 10,
        estimated_input_tokens: 0,
        created_at: 1,
        resolved_at: null,
        expires_at: null,
      })
      .run();
  });

  test("wallets.currency must be VND", () => {
    d.insert(workspaces).values(wsRow("ws-cur2")).run();
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w-cur", "ws-cur2", { currency: "USD" }))
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(wallets)
        .values(walletRow("w-cur2", "ws-cur2", { currency: "vnd" }))
        .run(),
    ).toThrow();
  });

  test("payments.amount must be > 0", () => {
    const base = {
      workspace_id: "ws0",
      status: "pending" as const,
      provider: "mock" as const,
      created_at: 1,
      expires_at: null,
    };
    expect(() =>
      d
        .insert(payments)
        .values({ ...base, id: "p-neg", amount: -1, provider_order_code: "ord-neg" })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(payments)
        .values({ ...base, id: "p-zero", amount: 0, provider_order_code: "ord-zero" })
        .run(),
    ).toThrow();
  });

  test("model_bindings prices must be >= 0", () => {
    const base = {
      workspace_id: null,
      public_model: "m",
      cpa_alias: "a",
      status: "published" as const,
      effective_at: 1,
    };
    expect(() =>
      d
        .insert(modelBindings)
        .values({ ...base, id: "mb-neg1", price_input_per_1m: -1, price_output_per_1m: 1 })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(modelBindings)
        .values({ ...base, id: "mb-neg2", price_input_per_1m: 1, price_output_per_1m: -1 })
        .run(),
    ).toThrow();
  });

  test("price_snapshots prices must be >= 0", () => {
    const base = { binding_id: "mb0", created_at: 1 };
    expect(() =>
      d
        .insert(priceSnapshots)
        .values({ ...base, id: "snap-neg1", price_input: -1, price_output: 1 })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(priceSnapshots)
        .values({ ...base, id: "snap-neg2", price_input: 1, price_output: -1 })
        .run(),
    ).toThrow();
  });

  test("reservations.cap_amount must be > 0", () => {
    d.insert(requests)
      .values({
        id: "r-cur2",
        workspace_id: "ws-cur",
        api_key_id: null,
        model_binding_id: "mb-cur",
        endpoint: "/v1/responses",
        mode: "non-stream",
        cpa_trace_id: null,
        status: "pending",
        http_status: null,
        ttft_ms: null,
        duration_ms: null,
        created_at: 1,
      })
      .run();
    const base = {
      wallet_id: "w-cur-ok",
      gateway_request_id: "r-cur2",
      api_key_id: null,
      price_snapshot_id: "snap-cur",
      status: "held" as const,
      estimated_input_tokens: 0,
      created_at: 1,
      resolved_at: null,
      expires_at: null,
    };
    expect(() =>
      d
        .insert(reservations)
        .values({ ...base, id: "res-neg", cap_amount: -1 })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(reservations)
        .values({ ...base, id: "res-zero", cap_amount: 0 })
        .run(),
    ).toThrow();
  });

  test("settlements.charged_input/charged_output must be >= 0", () => {
    const base = {
      reservation_id: "res-cur",
      charged_total: 0,
      settled_at: 1,
    };
    expect(() =>
      d
        .insert(settlements)
        .values({ ...base, id: "st-neg1", charged_input: -1, charged_output: 0 })
        .run(),
    ).toThrow();
    expect(() =>
      d
        .insert(settlements)
        .values({ ...base, id: "st-neg2", charged_input: 0, charged_output: -1 })
        .run(),
    ).toThrow();
  });
});

test("zero accidental paid traffic: db package makes no network calls and serves no routes", () => {
  // The requests table legitimately stores endpoint strings as data
  // (CHECK constraint), so we assert on behavior-carrying constructs only:
  // no HTTP client, no server, no route registration in the db package.
  const srcDir = join(import.meta.dir, "..", "src");
  for (const f of readdirSync(srcDir)) {
    const text = readFileSync(join(srcDir, f), "utf8");
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toContain("Elysia");
    expect(text).not.toContain("Bun.serve");
  }
});

test('every check("name") in schema.ts exists in the migrated database (constraint drift guard)', () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "schema.ts"), "utf8");
  const declared = [...source.matchAll(/\bcheck\(\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(declared.length).toBeGreaterThan(0);
  const master = db
    .prepare(
      "SELECT coalesce(group_concat(sql, ' '), '') AS sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL",
    )
    .get() as { sql: string };
  // sqlite_master quotes constraint names with backticks (drizzle-generated) or double quotes (0000-0002).
  // sqlite_master quotes constraint names with backticks (drizzle-generated) or double quotes (0000-0002).
  const missing = declared.filter(
    (name) => !master.sql.includes(`"${name}"`) && !master.sql.includes("`" + name + "`"),
  );
  expect(missing).toEqual([]);
});
