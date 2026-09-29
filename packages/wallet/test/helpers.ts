// Task 8 test fixture helper — ONLY place test fixtures are defined for wallet tests.
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";

export const NOW = 1_700_000_000_000;

export interface Fixture {
  wsA: string;
  wsB: string;
  keyA: string; // active, workspace A
  keyB: string; // active, workspace B
  keyRevoked: string; // revoked, workspace A
  walletA: string;
  walletB: string;
  mbGlobal: string; // published, workspace NULL
  mbA: string; // published, workspace A
  mbB: string; // published, workspace B
  mbDisabled: string; // disabled, workspace A
  snapGlobal: string; // snapshot OF mbGlobal
  snapA: string; // snapshot OF mbA
  snapB: string; // snapshot OF mbB
}

export function makeDb(): Database {
  const db = createDb(":memory:");
  migrate(db);
  return db;
}

export function makePayment(db: Database, id: string, workspaceId: string): void {
  db.prepare(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?, ?, 1000, 'succeeded', 'mock', ?, ?)",
  ).run(id, workspaceId, `order-${id}`, NOW);
}

export function seedFixture(db: Database): Fixture {
  const f: Fixture = {
    wsA: "ws-a",
    wsB: "ws-b",
    keyA: "key-a",
    keyB: "key-b",
    keyRevoked: "key-revoked",
    walletA: "wallet-a",
    walletB: "wallet-b",
    mbGlobal: "mb-global",
    mbA: "mb-a",
    mbB: "mb-b",
    mbDisabled: "mb-disabled",
    snapGlobal: "snap-global",
    snapA: "snap-a",
    snapB: "snap-b",
  };
  db.prepare(
    "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u1','U1','u1@t.local',?,?), ('u2','U2','u2@t.local',?,?)",
  ).run(NOW, NOW, NOW, NOW);
  const ws = db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES (?, ?, 'active', ?)",
  );
  ws.run(f.wsA, "A", NOW);
  ws.run(f.wsB, "B", NOW);
  const key = db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?, ?, ?, 'sk-hbr-x', ?, ?, ?)",
  );
  key.run(f.keyA, f.wsA, "hash-a", "key a", "active", NOW);
  key.run(f.keyB, f.wsB, "hash-b", "key b", "active", NOW);
  key.run(f.keyRevoked, f.wsA, "hash-r", "key r", "revoked", NOW);
  const wallet = db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?, ?, 'VND', 0, 0, 0, ?)",
  );
  wallet.run(f.walletA, f.wsA, NOW);
  wallet.run(f.walletB, f.wsB, NOW);
  const mb = db.prepare(
    "INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES (?, ?, ?, ?, ?, 1000, 2000, ?)",
  );
  mb.run(f.mbGlobal, null, "gpt-global", "alias-global", "published", NOW);
  mb.run(f.mbA, f.wsA, "gpt-a", "alias-a", "published", NOW);
  mb.run(f.mbB, f.wsB, "gpt-b", "alias-b", "published", NOW);
  mb.run(f.mbDisabled, f.wsA, "gpt-d", "alias-d", "disabled", NOW);
  const snap = db.prepare(
    "INSERT INTO price_snapshots (id, binding_id, price_input, price_output, created_at) VALUES (?, ?, 1000, 2000, ?)",
  );
  snap.run(f.snapGlobal, f.mbGlobal, NOW);
  snap.run(f.snapA, f.mbA, NOW);
  snap.run(f.snapB, f.mbB, NOW);
  return f;
}
