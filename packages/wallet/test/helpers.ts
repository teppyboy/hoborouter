// Task 8 test fixture helper — ONLY place test fixtures are defined for wallet tests.
import { sql, type SQL } from "drizzle-orm";
import { createTestDb, type Db, type Tx } from "@hoborouter/db";

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

/** Run a raw SQL query and return its rows (works for Db and Tx). */
export async function q<T = Record<string, unknown>>(db: Db | Tx, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

export async function q1<T = Record<string, unknown>>(db: Db | Tx, query: SQL): Promise<T> {
  const rows = await q<T>(db, query);
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
  const row = rows[0];
  if (row === undefined) throw new Error(`expected 1 row, got ${rows.length}`);
  return row;
}

export async function makeDb(): Promise<{
  db: Db;
  url: string;
  drop: () => Promise<void>;
}> {
  const t = await createTestDb();
  return { db: t.db, url: t.url, drop: t.drop };
}

export async function makePayment(db: Db, id: string, workspaceId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
        VALUES (${id}, ${workspaceId}, 1000, 'succeeded', 'mock', ${`order-${id}`}, ${NOW})`,
  );
}

export async function seedFixture(db: Db): Promise<Fixture> {
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
  await db.execute(
    sql`INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u1','U1','u1@t.local',${NOW},${NOW}), ('u2','U2','u2@t.local',${NOW},${NOW})`,
  );
  for (const [id, name] of [
    [f.wsA, "A"],
    [f.wsB, "B"],
  ] as const) {
    await db.execute(sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${id}, ${name}, 'active', ${NOW})`);
  }
  const keys: Array<[string, string, string, string, string]> = [
    [f.keyA, f.wsA, "hash-a", "key a", "active"],
    [f.keyB, f.wsB, "hash-b", "key b", "active"],
    [f.keyRevoked, f.wsA, "hash-r", "key r", "revoked"],
  ];
  for (const [id, ws, hash, name, status] of keys) {
    await db.execute(
      sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (${id}, ${ws}, ${hash}, 'sk-hbr-x', ${name}, ${status}, ${NOW})`,
    );
  }
  const wallets: Array<[string, string]> = [
    [f.walletA, f.wsA],
    [f.walletB, f.wsB],
  ];
  for (const [id, ws] of wallets) {
    await db.execute(
      sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (${id}, ${ws}, 'VND', 0, 0, 0, ${NOW})`,
    );
  }
  const mbs: Array<[string, string | null, string, string, string]> = [
    [f.mbGlobal, null, "gpt-global", "alias-global", "published"],
    [f.mbA, f.wsA, "gpt-a", "alias-a", "published"],
    [f.mbB, f.wsB, "gpt-b", "alias-b", "published"],
    [f.mbDisabled, f.wsA, "gpt-d", "alias-d", "disabled"],
  ];
  for (const [id, ws, pub, alias, status] of mbs) {
    await db.execute(
      sql`INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES (${id}, ${ws}, ${pub}, ${alias}, ${status}, 1000, 2000, ${NOW})`,
    );
  }
  const snaps: Array<[string, string]> = [
    [f.snapGlobal, f.mbGlobal],
    [f.snapA, f.mbA],
    [f.snapB, f.mbB],
  ];
  for (const [id, binding] of snaps) {
    await db.execute(
      sql`INSERT INTO price_snapshots (id, binding_id, price_input, price_output, created_at) VALUES (${id}, ${binding}, 1000, 2000, ${NOW})`,
    );
  }
  return f;
}
