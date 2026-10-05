// One-time migration tool: copy a legacy SQLite database into PostgreSQL.
// Usage: bun scripts/sqlite-to-pg.ts --from <sqlite file> [--to <DATABASE_URL>] [--force]
//
// Opens the SQLite file READ-ONLY, migrates the target Postgres, then copies
// every table in FK dependency order inside a single Postgres transaction.
// Verifies row counts, money-column bounds and wallet/ledger consistency
// before committing; any mismatch rolls everything back.
//
// This script is the only place bun:sqlite is still allowed (legacy reader).
// NOTE: imports only @hoborouter/db (not drizzle-orm directly) because
// drizzle-orm is only resolvable from within packages/db.
import { Database } from "bun:sqlite";
import {
  closeDb,
  createDb,
  migrate,
  schema,
  MAX_SAFE_INTEGER_MONEY,
  type Db,
} from "@hoborouter/db";
import type { PgTable } from "drizzle-orm/pg-core";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const from = arg("--from");
const force = args.includes("--force");
if (!from) {
  console.error(
    "Usage: bun scripts/sqlite-to-pg.ts --from <sqlite file> [--to <DATABASE_URL>] [--force]",
  );
  process.exit(1);
}

const targetUrl = arg("--to") ?? process.env.DATABASE_URL;
if (!targetUrl) {
  console.error("No target: pass --to <DATABASE_URL> or set DATABASE_URL");
  process.exit(1);
}

// FK dependency order (parents before children; ledger_entries after
// reservations/billing_reservations/payments because it references them).
const TABLES: Array<[string, PgTable]> = [
  ["workspaces", schema.workspaces],
  ["users", schema.users],
  ["session", schema.session],
  ["account", schema.account],
  ["verification", schema.verification],
  ["workspace_members", schema.workspaceMembers],
  ["instance_admins", schema.instanceAdmins],
  ["api_keys", schema.apiKeys],
  ["key_rate_limits", schema.keyRateLimits],
  ["wallets", schema.wallets],
  ["payments", schema.payments],
  ["payment_events", schema.paymentEvents],
  ["models", schema.models],
  ["provider_model_mappings", schema.providerModelMappings],
  ["model_prices", schema.modelPrices],
  ["api_key_model_permissions", schema.apiKeyModelPermissions],
  ["model_bindings", schema.modelBindings],
  ["price_snapshots", schema.priceSnapshots],
  ["requests", schema.requests],
  ["usage_events", schema.usageEvents],
  ["reservations", schema.reservations],
  ["billing_reservations", schema.billingReservations],
  ["usage_logs", schema.usageLogs],
  ["ledger_entries", schema.ledgerEntries],
  ["instance_settings", schema.instanceSettings],
  ["settlements", schema.settlements],
  ["settlement_usage_events", schema.settlementUsageEvents],
  ["unknown_resolutions", schema.unknownResolutions],
  ["refund_operations", schema.refundOperations],
  ["audit_log", schema.auditLog],
];

/** Minimal column info needed for the copy; read off the drizzle table object. */
type ColumnInfo = { key: string; db: string; dataType: string; custom: boolean };

function tableColumns(table: PgTable): ColumnInfo[] {
  const out: ColumnInfo[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { dataType?: unknown }).dataType === "string"
    ) {
      const col = value as { name: string; dataType: string; columnType?: string };
      // auth-schema.tsMs() is a customType with dataType bigint whose toDriver
      // expects a Date (not an epoch-ms number like plain bigint mode 'number').
      out.push({
        key,
        db: col.name,
        dataType: col.dataType,
        custom: col.columnType === "PgCustomColumn",
      });
    }
  }
  return out;
}

/** Runtime value after SQLite -> Postgres column conversion. */
type CellValue = string | number | boolean | null | object;

/** Convert a raw SQLite value to the Postgres column's expected runtime value. */
function convert(dataType: string, v: unknown, custom: boolean): CellValue {
  if (v === null || v === undefined) return null;
  if (dataType === "boolean") {
    // Legacy SQLite stored booleans as 0/1 integers.
    if (typeof v === "number") return v !== 0;
    if (typeof v === "boolean") return v;
    throw new Error(`unexpected boolean value: ${JSON.stringify(v)}`);
  }
  if (dataType === "json") {
    // Legacy SQLite stored JSON as text; jsonb needs the parsed value.
    return typeof v === "string" ? JSON.parse(v) : v;
  }
  if (custom && typeof v === "number") {
    // tsMs() custom columns (Better Auth timestamps) expect Date at drizzle level.
    return new Date(v);
  }
  return v as CellValue;
}

/** Table names here are compile-time constants from TABLES, never user input. */
function sqlIdent(name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

function countSql(name: string): string {
  return "SELECT COUNT(*) AS c FROM " + sqlIdent(name);
}

function selectAllSql(name: string): string {
  return "SELECT * FROM " + sqlIdent(name);
}

async function targetUserTables(db: Db): Promise<string[]> {
  const rows = (await db.execute(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'",
  )) as Array<{ tablename: string }>;
  return rows.map((r) => r.tablename);
}

async function main(): Promise<void> {
  // READ-ONLY: this tool must never mutate the legacy database.
  const sqlite = new Database(from!, { readonly: true });
  const db = createDb(targetUrl!);
  try {
    console.log("Migrating target schema...");
    await migrate(db);

    const existing = await targetUserTables(db);
    const nonEmpty: string[] = [];
    for (const t of existing) {
      const rows = (await db.execute("SELECT COUNT(*)::text AS c FROM " + sqlIdent(t))) as Array<{
        c: string;
      }>;
      if (Number(rows[0]!.c) > 0) nonEmpty.push(t);
    }
    if (nonEmpty.length > 0 && !force) {
      console.error(
        `Target is not empty (${nonEmpty.join(", ")}). Use --force to truncate and re-copy.`,
      );
      process.exit(1);
    }

    const sourceCounts = TABLES.map(([name]) => {
      const row = sqlite.prepare(countSql(name)).get() as { c: number };
      return row.c;
    });

    await db.transaction(async (tx) => {
      if (nonEmpty.length > 0) {
        // Only reachable with --force. Truncate in reverse FK order.
        for (const name of [...TABLES.map(([n]) => n)].reverse()) {
          if (nonEmpty.includes(name)) await tx.execute("TRUNCATE " + sqlIdent(name) + " CASCADE");
        }
      }

      for (let i = 0; i < TABLES.length; i++) {
        const [name, table] = TABLES[i]!;
        const rows = sqlite.prepare(selectAllSql(name)).all() as Array<Record<string, unknown>>;
        if (rows.length === 0) {
          console.log(`  ${name}: 0 rows`);
          continue;
        }
        const byDb = new Map(tableColumns(table).map((c) => [c.db, c]));
        const mapped = rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            const col = byDb.get(k);
            if (!col) throw new Error(`table ${name}: unknown source column ${k}`);
            out[col.key] = convert(col.dataType, v, col.custom);
          }
          return out;
        });
        const chunkSize = 500;
        for (let j = 0; j < mapped.length; j += chunkSize) {
          await tx.insert(table).values(mapped.slice(j, j + chunkSize));
        }
        console.log(`  ${name}: ${rows.length} rows`);
      }

      // --- verification (inside the transaction; throw = rollback) ---

      // 1. Per-table row counts.
      for (let i = 0; i < TABLES.length; i++) {
        const [name] = TABLES[i]!;
        const rows = (await tx.execute(
          "SELECT COUNT(*)::text AS c FROM " + sqlIdent(name),
        )) as Array<{ c: string }>;
        const actual = Number(rows[0]!.c);
        if (actual !== sourceCounts[i]) {
          throw new Error(
            `row count mismatch for ${name}: expected ${sourceCounts[i]}, got ${actual}`,
          );
        }
      }

      // 2. Every bigint (money/token/epoch) column within [0, MAX_SAFE_INTEGER_MONEY].
      for (const [name, table] of TABLES) {
        for (const col of tableColumns(table)) {
          if (col.dataType !== "bigint") continue;
          const rows = (await tx.execute(
            `SELECT COUNT(*)::text AS c FROM ${sqlIdent(name)} WHERE ${sqlIdent(col.db)} < 0 OR ${sqlIdent(col.db)} > ${MAX_SAFE_INTEGER_MONEY}`,
          )) as Array<{ c: string }>;
          if (Number(rows[0]!.c) > 0) {
            throw new Error(`${name}.${col.db}: values outside 0..${MAX_SAFE_INTEGER_MONEY}`);
          }
        }
      }

      // 3. Wallet balances must equal the ledger sum (append-only invariant).
      const walletRows = (await tx.execute(
        "SELECT w.id, w.balance::text AS balance, COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0)::text AS ledger_sum FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id GROUP BY w.id, w.balance",
      )) as Array<{ id: string; balance: string; ledger_sum: string }>;
      for (const r of walletRows) {
        if (Number(r.balance) !== Number(r.ledger_sum)) {
          throw new Error(`wallet ${r.id}: balance ${r.balance} != ledger sum ${r.ledger_sum}`);
        }
      }
      console.log("Verification passed: counts, money bounds, wallet/ledger consistency.");
    });

    console.log(`Copy complete: ${TABLES.length} tables.`);
  } finally {
    sqlite.close();
    await closeDb(db);
  }
}

main().catch((err) => {
  console.error("Copy failed (rolled back):", err instanceof Error ? err.message : err);
  process.exit(1);
});
