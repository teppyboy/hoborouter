import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/client";
import { migrate } from "../src/migrate";

const installedDrizzle = new URL("../drizzle", import.meta.url).pathname;
const dbs: Database[] = [];
const tempDirs: string[] = [];

function fixture(): Database {
  const db = createDb(":memory:");
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) void dir; // OS temp cleanup left to OS
});

/** Build a temp migration folder exposing exactly `tags` (in order) from the installed journal, using the real SQL files. */
function makeMigrationFolder(
  tags: string[],
  mutate?: (tag: string, sql: string) => string,
): string {
  const journal = JSON.parse(
    readFileSync(join(installedDrizzle, "meta", "_journal.json"), "utf8"),
  ) as {
    entries: { when: number; tag: string; breakpoints: boolean }[];
  };
  const dir = mkdtempSync(join(tmpdir(), "hoborouter-mig-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "meta"));
  const entries = journal.entries
    .filter((e) => tags.includes(e.tag))
    .sort((a, b) => tags.indexOf(a.tag) - tags.indexOf(b.tag))
    .map((e, i) => ({ ...e, idx: i }));
  for (const entry of entries) {
    const sql = readFileSync(join(installedDrizzle, `${entry.tag}.sql`), "utf8");
    writeFileSync(join(dir, `${entry.tag}.sql`), mutate?.(entry.tag, sql) ?? sql);
  }
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: 7, dialect: "sqlite", entries }),
  );
  return dir;
}

function fkOn(db: Database): boolean {
  return (
    Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys) === 1
  );
}

function fkViolations(db: Database): unknown[] {
  return db.prepare("PRAGMA foreign_key_check").all();
}

/** Deterministic full schema snapshot (sqlite_master, excluding sqlite-internal objects). */
function schemaSnapshot(db: Database): string {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return JSON.stringify(rows);
}

/** Rows of `table` as JSON lines, order-independent. */
function rowsJson(db: Database, table: string, cols?: string[]): string {
  if (!/^\w+$/.test(table)) throw new Error(`bad table ${table}`);
  const columns =
    cols ??
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => {
      if (!/^\w+$/.test(c.name)) throw new Error(`bad column ${c.name}`);
      return c.name;
    });
  const rows = db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table}"`).all();
  return JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
}

function journalRows(db: Database): { hash: string; created_at: number }[] {
  return db
    .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
    .all() as {
    hash: string;
    created_at: number;
  }[];
}

function noTempRebuildTables(db: Database): void {
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((r) => r.name);
  for (const name of names) expect(name.startsWith("__new_")).toBe(false);
}

// ---------------------------------------------------------------------------
// Test 1: fresh migration, idempotency, FK restored
// ---------------------------------------------------------------------------

test("fresh migration: FK ON preserved, schema/journal identical on second run", () => {
  const db = fixture();
  expect(fkOn(db)).toBe(true);
  migrate(db);
  expect(fkOn(db)).toBe(true);
  expect(fkViolations(db)).toHaveLength(0);
  const schema1 = schemaSnapshot(db);
  const journal1 = JSON.stringify(journalRows(db));

  db.exec(
    "INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0);" +
      "INSERT INTO workspaces(id,name,created_at) VALUES ('w','w',0);",
  );
  migrate(db); // idempotent rerun must not touch schema or journal
  expect(schemaSnapshot(db)).toBe(schema1);
  expect(JSON.stringify(journalRows(db))).toBe(journal1);
  expect(fkOn(db)).toBe(true);
  const users = db.prepare("SELECT id FROM users").all() as { id: string }[];
  expect(users).toEqual([{ id: "u" }]);
});

test("fresh migration started with FK OFF: FK stays OFF after success (caller setting restored)", () => {
  const db = fixture();
  db.exec("PRAGMA foreign_keys = OFF");
  migrate(db);
  expect(fkOn(db)).toBe(false);
  expect(fkViolations(db)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 2: fully populated legacy graph at 0002 upgrades through 0003+0004
// ---------------------------------------------------------------------------

/** Populate every legacy table (0000/0002 schema) with one coherent row each. */
function populateLegacyGraph(db: Database): void {
  db.exec(`
    INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES ('u1','Alice','a@x',1,1,1);
    INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES ('u2','Bob','b@x',0,2,2);
    INSERT INTO workspaces(id,name,status,created_at) VALUES ('w1','WS','active',1);
    INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('w1','u1','owner');
    INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('w1','u2','member');
    INSERT INTO instance_admins(user_id,created_at,added_by) VALUES ('u1',1,NULL);
    INSERT INTO api_keys(id,workspace_id,key_hash,key_prefix,name,status,created_at) VALUES ('k1','w1','h1','p1','key1','active',1);
    INSERT INTO key_rate_limits(api_key_id,window,max_requests) VALUES ('k1','minute',60);
    INSERT INTO model_bindings(id,workspace_id,public_model,cpa_alias,status,price_input_per_1m,price_output_per_1m,effective_at)
      VALUES ('mb1','w1','gpt','alias','published',100,200,1);
    INSERT INTO price_snapshots(id,binding_id,price_input,price_output,created_at) VALUES ('ps1','mb1',100,200,1);
    INSERT INTO requests(id,workspace_id,api_key_id,model_binding_id,endpoint,mode,cpa_trace_id,status,http_status,created_at)
      VALUES ('r1','w1','k1','mb1','/v1/chat/completions','non-stream','trace','ok',200,1);
    INSERT INTO usage_events(id,source_request_id,cpa_execution_uuid,gateway_request_id,tokens_input,tokens_output,tokens_reasoning,tokens_cached,tokens_total,failed,ingested_at)
      VALUES ('ue1','r1',NULL,'r1',10,5,0,2,15,0,1);
    INSERT INTO reservations(id,wallet_id,gateway_request_id,api_key_id,price_snapshot_id,status,cap_amount,estimated_input_tokens,created_at)
      VALUES ('res1','w1','r1','k1','ps1','held',1000,10,1);
    INSERT INTO payments(id,workspace_id,amount,status,provider,provider_order_code,created_at)
      VALUES ('pay1','w1',50000,'succeeded','sepay','ORD1',1);
    INSERT INTO payment_events(id,payment_id,provider,provider_reference,signature_valid,processed_at)
      VALUES ('pe1','pay1','sepay','ref1',1,1);
    INSERT INTO wallets(id,workspace_id,currency,balance,reserved,version,created_at) VALUES ('w1','w1','VND',50000,1000,3,1);
    INSERT INTO ledger_entries(id,wallet_id,direction,amount,kind,payment_id,balance_after,created_at)
      VALUES ('le1','w1','credit',50000,'topup','pay1',50000,1);
    INSERT INTO ledger_entries(id,wallet_id,direction,amount,kind,reservation_id,balance_after,created_at)
      VALUES ('le2','w1','debit',1000,'settle','res1',49000,2);
    INSERT INTO settlements(id,reservation_id,charged_input,charged_output,charged_total,settled_at)
      VALUES ('s1','res1',10,5,1000,2);
    INSERT INTO settlement_usage_events(settlement_id,usage_event_id) VALUES ('s1','ue1');
    INSERT INTO ledger_entries(id,wallet_id,direction,amount,kind,original_ledger_entry_id,balance_after,created_at)
      VALUES ('le3','w1','credit',500,'refund','le1',49500,3);
    INSERT INTO refund_operations(id,operation_key,original_ledger_entry_id,request_id,reservation_id,payload_hash,amount,result,actor_user_id,created_at)
      VALUES ('ro1','opk1','le3','r1','res1','hash1',500,'applied','u1',3);
    INSERT INTO unknown_resolutions(id,resolution_key,request_id,reservation_id,payload_hash,outcome,result,actor_user_id,created_at)
      VALUES ('ur1','rk1','r1','res1','hash2','hold_release','ok','u1',3);
    INSERT INTO audit_log(id,actor_user_id,workspace_id,action,target,detail,created_at)
      VALUES ('al1','u1','w1','topup','pay1',NULL,3);
  `);
}

const LEGACY_TABLES = [
  "users",
  "workspaces",
  "workspace_members",
  "instance_admins",
  "api_keys",
  "key_rate_limits",
  "model_bindings",
  "price_snapshots",
  "requests",
  "usage_events",
  "reservations",
  "payments",
  "payment_events",
  "wallets",
  "ledger_entries",
  "settlements",
  "settlement_usage_events",
  "refund_operations",
  "unknown_resolutions",
  "audit_log",
] as const;

test("populated legacy graph at 0002: every legacy row preserved, FK clean, triggers/indexes intact", () => {
  const db = fixture();
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
    ]),
  });
  populateLegacyGraph(db);

  // Snapshot legacy rows using the column list as it exists at 0002.
  const legacyCols = new Map<string, string[]>(
    LEGACY_TABLES.map((t) => [
      t,
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
    ]),
  );
  const before = new Map(LEGACY_TABLES.map((t) => [t, rowsJson(db, t, legacyCols.get(t))]));
  const triggersBefore = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  migrate(db); // applies 0003 + 0004 with FK OFF then verifies before commit

  // Every legacy row value survives the rebuilds byte-for-byte.
  for (const t of LEGACY_TABLES) {
    const after = rowsJson(db, t, legacyCols.get(t));
    expect(after).toEqual(before.get(t)!);
  }
  // Append-only triggers from 0001 survive the rebuilds.
  const triggersAfter = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const t of triggersBefore) expect(triggersAfter).toContain(t);
  // Key indexes survive (rebuilt settlements/api_keys included).
  for (const idx of [
    "ledger_wallet_idx",
    "api_keys_key_hash",
    "settlements_reservation_id",
    "sue_usage_event_id",
  ]) {
    const n = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name=?")
      .get(idx) as { n: number };
    expect(n.n).toBe(1);
  }
  // Append-only enforcement still fires.
  expect(() => db.exec("UPDATE ledger_entries SET amount=1 WHERE id='le1'")).toThrow("append-only");
  expect(fkViolations(db)).toHaveLength(0);
  expect(fkOn(db)).toBe(true);
  noTempRebuildTables(db);
});

// ---------------------------------------------------------------------------
// Test 3: preflight
// ---------------------------------------------------------------------------

test("populated pre-0002 users without email: preflight rejects before ANY mutation", () => {
  const db = fixture();
  migrate(db, { migrationsFolder: makeMigrationFolder(["0000_common_zarda"]) });
  db.exec("INSERT INTO users(id) VALUES ('legacy-user')");

  const schema = schemaSnapshot(db);
  const userRows = rowsJson(db, "users");
  const journal = JSON.stringify(journalRows(db));

  let threw: unknown = undefined;
  try {
    migrate(db);
  } catch (e) {
    threw = e;
  }
  expect((threw as Error)?.message).toContain("preflight blocked");
  expect(schemaSnapshot(db)).toBe(schema);
  expect(rowsJson(db, "users")).toBe(userRows);
  expect(JSON.stringify(journalRows(db))).toBe(journal);
  expect(fkOn(db)).toBe(true);
});

test("populated db already at 0002 (users have email) proceeds through pending migrations", () => {
  const db = fixture();
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
    ]),
  });
  db.exec("INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0)");
  const userRows = rowsJson(db, "users");
  migrate(db);
  expect(rowsJson(db, "users")).toBe(userRows);
  expect(journalRows(db)).toHaveLength(7);
  expect(fkViolations(db)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 4: active caller transaction refuses before mutation
// ---------------------------------------------------------------------------

test("active caller transaction: migration refuses without mutating, caller txn intact", () => {
  const db = fixture();
  db.exec("BEGIN");
  db.exec("CREATE TABLE caller_work (id integer PRIMARY KEY)");
  let threw: unknown = undefined;
  try {
    migrate(db);
  } catch (e) {
    threw = e;
  }
  expect((threw as Error)?.message).toContain("active transaction");
  expect(db.inTransaction).toBe(true);
  // Caller's transaction still usable and still contains caller's work.
  db.exec("INSERT INTO caller_work VALUES (1)");
  db.exec("ROLLBACK");
  const n = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='caller_work'")
    .get() as { n: number };
  expect(n.n).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 5: injected failure AFTER api-key rebuild rolls back completely
// ---------------------------------------------------------------------------

function poisonedFolder(): string {
  return makeMigrationFolder(
    [
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
      "0003_paid_gateway_task2a",
      "0004_paid_gateway_fix",
    ],
    (tag, sql) =>
      tag === "0004_paid_gateway_fix"
        ? `${sql}--> statement-breakpoint\nINSERT INTO __mig_injected_failure VALUES (1)`
        : sql,
  );
}

function legacyAt0002Fixture(): Database {
  const db = fixture();
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
    ]),
  });
  populateLegacyGraph(db);
  return db;
}

test("failure after api-key rebuild: full rollback of schema, rows, journal; FK restored", () => {
  const db = legacyAt0002Fixture();
  expect(fkOn(db)).toBe(true);
  const legacyCols = new Map<string, string[]>(
    LEGACY_TABLES.map((t) => [
      t,
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
    ]),
  );
  const before = new Map(LEGACY_TABLES.map((t) => [t, rowsJson(db, t, legacyCols.get(t))]));
  const schema = schemaSnapshot(db);
  const journal = JSON.stringify(journalRows(db));

  let threw: unknown = undefined;
  try {
    migrate(db, { migrationsFolder: poisonedFolder() });
  } catch (e) {
    threw = e;
  }
  expect((threw as Error)?.message).toContain("__mig_injected_failure");
  expect(schemaSnapshot(db)).toBe(schema);
  for (const t of LEGACY_TABLES)
    expect(rowsJson(db, t, legacyCols.get(t)!)).toEqual(before.get(t)!);
  expect(JSON.stringify(journalRows(db))).toBe(journal);
  expect(fkOn(db)).toBe(true);
  expect(fkViolations(db)).toHaveLength(0);
  noTempRebuildTables(db);
});

test("failure after api-key rebuild with caller FK OFF: FK restored to OFF, rollback complete", () => {
  const db = legacyAt0002Fixture();
  db.exec("PRAGMA foreign_keys = OFF");
  const schema = schemaSnapshot(db);
  const journal = JSON.stringify(journalRows(db));
  let threw: unknown = undefined;
  try {
    migrate(db, { migrationsFolder: poisonedFolder() });
  } catch (e) {
    threw = e;
  }
  expect((threw as Error)?.message).toContain("__mig_injected_failure");
  expect(fkOn(db)).toBe(false);
  expect(schemaSnapshot(db)).toBe(schema);
  expect(JSON.stringify(journalRows(db))).toBe(journal);
  noTempRebuildTables(db);
});

// ---------------------------------------------------------------------------
// Test 6: pre-existing FK violations abort before commit, no changes
// ---------------------------------------------------------------------------

test("pre-existing FK violation: migration aborts at check, rolls back to unchanged state", () => {
  const db = legacyAt0002Fixture();
  // Plant an orphan row that only exists because FK is momentarily off.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('ghost-ws','u1','member')",
  );
  db.exec("PRAGMA foreign_keys = ON");
  // FK ON does not re-validate existing rows, so the orphan persists.
  expect(fkViolations(db).length).toBeGreaterThan(0);

  const before = new Map(LEGACY_TABLES.map((t) => [t, rowsJson(db, t)]));
  const schema = schemaSnapshot(db);
  const journal = JSON.stringify(journalRows(db));

  let threw: unknown = undefined;
  try {
    migrate(db);
  } catch (e) {
    threw = e;
  }
  expect((threw as Error)?.message).toContain("foreign key check failed");
  expect(schemaSnapshot(db)).toBe(schema);
  for (const t of LEGACY_TABLES) expect(rowsJson(db, t)).toEqual(before.get(t)!);
  expect(JSON.stringify(journalRows(db))).toBe(journal);
  expect(fkOn(db)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 7: requests rebuild in 0004 preserves requests rows + canonical children
// ---------------------------------------------------------------------------

test("0004 requests rebuild: requests rows and billing_reservations/usage_logs children preserved, model_binding_id now nullable", () => {
  const db = fixture();
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
      "0003_paid_gateway_task2a",
    ]),
  });
  db.exec(`
    INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0);
    INSERT INTO workspaces(id,name,created_at) VALUES ('w','w',0);
    INSERT INTO wallets(id,workspace_id,balance,reserved,created_at) VALUES ('wallet','w',1000,0,0);
    INSERT INTO models(id,public_id,slug,display_name,provider,created_at,updated_at) VALUES ('m','m','m','m','p',0,0);
    INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('price','m',1,1,1,1,1000000,0);
    INSERT INTO model_bindings(id,public_model,cpa_alias,status,price_input_per_1m,price_output_per_1m,effective_at) VALUES ('legacy','old','old','published',0,0,0);
    INSERT INTO requests(id,workspace_id,model_binding_id,endpoint,mode,status,created_at) VALUES ('r1','w','legacy','/v1/responses','non-stream','ok',0);
    INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br','wallet','r1','m','price',26000,1000000,50,'held',0);
    INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,created_at) VALUES ('ul','idem','r1','w','p','m','up',1,0,0,0,'ok',0);
  `);
  const tables = ["requests", "billing_reservations", "usage_logs"];
  const rowsSorted = (t: string): string[] => {
    if (!/^(requests|billing_reservations|usage_logs)$/.test(t)) throw new Error(`bad table ${t}`);
    return (db.prepare(`SELECT * FROM "${t}"`).all() as object[])
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort();
  };
  const before = new Map(tables.map((t) => [t, rowsSorted(t)]));

  migrate(db);

  for (const t of tables) expect(rowsSorted(t)).toEqual(before.get(t)!);
  // Canonical request with model_id only now legal; request with neither is not.
  expect(() =>
    db.exec(
      "INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r2','w','m','/v1/responses','non-stream','ok',0)",
    ),
  ).not.toThrow();
  expect(() =>
    db.exec(
      "INSERT INTO requests(id,workspace_id,endpoint,mode,status,created_at) VALUES ('r3','w','/v1/responses','non-stream','ok',0)",
    ),
  ).toThrow();
  expect(fkViolations(db)).toHaveLength(0);
  expect(fkOn(db)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 8: 0005 api_keys rebuild preserves rows/children, new statuses legal
// ---------------------------------------------------------------------------

test("0005 api_keys rebuild: api_keys rows and children preserved, FK clean, triggers/index intact, enabled/disabled accepted", () => {
  const db = fixture();
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
      "0003_paid_gateway_task2a",
      "0004_paid_gateway_fix",
    ]),
  });
  db.exec(`
    INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0);
    INSERT INTO workspaces(id,name,created_at) VALUES ('w','w',0);
    INSERT INTO api_keys(id,workspace_id,key_hash,key_prefix,name,status,created_at) VALUES ('k1','w','h1','p1','key1','active',1);
    INSERT INTO key_rate_limits(api_key_id,window,max_requests) VALUES ('k1','minute',60);
    INSERT INTO models(id,public_id,slug,display_name,provider,created_at,updated_at) VALUES ('m','m','m','m','p',0,0);
    INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('price','m',1,1,1,1,1000000,0);
    INSERT INTO requests(id,workspace_id,api_key_id,model_id,endpoint,mode,status,created_at) VALUES ('r1','w','k1','m','/v1/responses','non-stream','ok',0);
    INSERT INTO billing_reservations(id,wallet_id,request_id,api_key_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br','w','r1','k1','m','price',26000,1000000,50,'held',0);
    INSERT INTO usage_logs(id,idempotency_key,request_id,api_key_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,created_at) VALUES ('ul','idem','r1','k1','w','p','m','up',1,0,0,0,'ok',0);
    INSERT INTO api_key_model_permissions(api_key_id,model_id,created_at) VALUES ('k1','m',1);
  `);
  const tables = [
    "api_keys",
    "key_rate_limits",
    "requests",
    "billing_reservations",
    "usage_logs",
    "api_key_model_permissions",
  ];
  const before = new Map(tables.map((t) => [t, rowsJson(db, t)]));

  migrate(db); // applies 0005

  for (const t of tables) expect(rowsJson(db, t)).toEqual(before.get(t)!);
  expect(fkViolations(db)).toHaveLength(0);
  // Rebuilt table keeps 4-value status CHECK via triggers + CHECK.
  for (const s of ["enabled", "disabled"]) {
    expect(() =>
      db.exec(
        `INSERT INTO api_keys(id,workspace_id,key_hash,key_prefix,name,status,created_at) VALUES ('k-${s}','w','h-${s}','p','x','${s}',0)`,
      ),
    ).not.toThrow();
  }
  expect(() =>
    db.exec(
      "INSERT INTO api_keys(id,workspace_id,key_hash,key_prefix,name,status,created_at) VALUES ('kb','w','hb','p','x','bogus',0)",
    ),
  ).toThrow();
  // Guard triggers and key index survive.
  for (const name of ["api_keys_status_guard", "api_keys_status_update_guard"]) {
    const n = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(name) as { n: number };
    expect(n.n).toBe(1);
  }
  const idx = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='api_keys_key_hash'",
    )
    .get() as { n: number };
  expect(idx.n).toBe(1);
  expect(fkOn(db)).toBe(true);
  noTempRebuildTables(db);
});

// ---------------------------------------------------------------------------
// Test: settlements typeof CHECKs restored by 0005 rebuild (constraint drift fix)
// ---------------------------------------------------------------------------

function migrateTo0004(db: Database): void {
  migrate(db, {
    migrationsFolder: makeMigrationFolder([
      "0000_common_zarda",
      "0001_append_only_triggers",
      "0002_foamy_luminals",
      "0003_paid_gateway_task2a",
      "0004_paid_gateway_fix",
    ]),
  });
}

test("0005 rebuild preserves populated settlements + settlement_usage_events, restores typeof CHECKs and triggers", () => {
  const db = fixture();
  migrateTo0004(db);
  // Legacy-shaped settlement (reservation_id only) and canonical one (billing_reservation_id + usage_log_id).
  db.exec(`
    INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('u','u','u@x',0,0);
    INSERT INTO workspaces(id,name,created_at) VALUES ('w','w',0);
    INSERT INTO wallets(id,workspace_id,balance,reserved,created_at) VALUES ('wallet','w',1000000,0,0);
    INSERT INTO models(id,public_id,slug,display_name,provider,created_at,updated_at) VALUES ('m','m','m','m','p',0,0);
    INSERT INTO model_prices(id,model_id,input_usd_micro_per_1m,output_usd_micro_per_1m,cached_input_usd_micro_per_1m,reasoning_usd_micro_per_1m,markup_ppm,effective_at) VALUES ('price','m',1,1,1,1,1000000,0);
    INSERT INTO requests(id,workspace_id,model_id,endpoint,mode,status,created_at) VALUES ('r','w','m','/v1/responses','non-stream','ok',0);
    INSERT INTO reservations(id,wallet_id,gateway_request_id,api_key_id,price_snapshot_id,status,cap_amount,estimated_input_tokens,created_at)
      VALUES ('res','wallet','r',NULL,NULL,'held',1000,10,1);
    INSERT INTO billing_reservations(id,wallet_id,request_id,model_id,model_price_id,usd_vnd_exchange_rate,markup_ppm,cap_vnd,status,created_at) VALUES ('br','wallet','r','m','price',26000,1000000,50,'held',0);
    INSERT INTO usage_logs(id,idempotency_key,request_id,workspace_id,provider,public_model,upstream_model,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,status,charged_vnd,created_at) VALUES ('ul','idem','r','w','p','m','up',1,0,0,0,'ok',40,0);
    INSERT INTO usage_events(id,source_request_id,cpa_execution_uuid,gateway_request_id,tokens_input,tokens_output,tokens_reasoning,tokens_cached,tokens_total,failed,ingested_at)
      VALUES ('ue','r',NULL,'r',1,0,0,0,1,0,0);
    INSERT INTO settlements(id,reservation_id,charged_input,charged_output,charged_total,settled_at) VALUES ('sleg','res',10,5,1000,2);
    INSERT INTO settlements(id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id,reason,created_at) VALUES ('scan','br',5,7,12,3,40,'ul','final',3);
    INSERT INTO settlement_usage_events(settlement_id,usage_event_id) VALUES ('sleg','ue');
  `);
  const before = new Map(
    (["settlements", "settlement_usage_events"] as const).map((t) => [t, rowsJson(db, t)]),
  );

  migrate(db); // applies 0005 with the settlements rebuild

  for (const [t, snap] of before) {
    expect(rowsJson(db, t)).toEqual(snap);
  }
  expect(fkViolations(db)).toHaveLength(0);
  expect(fkOn(db)).toBe(true);
  noTempRebuildTables(db);

  // typeof CHECKs restored: non-integer text rejected on charged_input/output/total.
  for (const col of ["charged_input", "charged_output", "charged_total"]) {
    const stmt = db.prepare(
      `INSERT INTO settlements(id,reservation_id,${col},charged_input,charged_output,charged_total,settled_at) VALUES ('bad-${col}','res','abc',0,0,0,9)`,
    );
    expect(() => stmt.run()).toThrow();
  }

  // Triggers still fire: cap guard rejects UPDATE above cap on the canonical row.
  expect(() => db.exec("UPDATE settlements SET charged_vnd = 51 WHERE id = 'scan'")).toThrow(
    "charged_vnd exceeds cap",
  );
});
