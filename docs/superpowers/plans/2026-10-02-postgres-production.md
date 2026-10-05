# Plan: PostgreSQL in production, SQLite for local dev

Date: 2026-10-02
Status: PLAN ONLY — no product code written by this task.
Scope note: another worker concurrently adds a requests soft-delete column as **migration 0007**; this plan treats 0007 as part of the baseline and does not touch it.

---

## 1. Audit (measured on the dirty tree, `--exclude-dir=node_modules`)

### packages/db

- `src/client.ts`: `createDb(path)` wraps `bun:sqlite` `Database`, sets 3 PRAGMAs (`journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`). 3 exec calls.
- `src/schema.ts`: 24 `sqliteTable` definitions + 4 Better-Auth-generated tables in `src/auth-schema.ts` (users, session, account, verification — all `sqliteTable`). Money/tokens are `integer` columns guarded by `typeof(col) = 'integer'` CHECKs — **20 `typeof(` occurrences** inside **52 `check(` constraints**, bounded by exported `MAX_SAFE_INTEGER_MONEY = 2^53-1` via `intBounded()` helper.
- Column modes: 5 `mode: "boolean"` integer columns, 2 `mode: "json"` text columns (`models.capabilities`, `auditLog.detail`).
- Partial unique indexes with SQL predicates: `ledger_entries` has 3 (`kind = 'settle'`, `kind = 'topup'`, `kind = 'refund'`) — these translate directly to PG partial indexes.
- `src/orm.ts`: `orm(db)` caches one `drizzle(db, {schema})` per raw connection in a `WeakMap<Database, Orm>`; `runChanges(stmt)` re-types bun:sqlite's `Changes { changes }` from a `void`-typed `.run()` — used by wallet CAS paths.
- `src/migrate.ts`: custom migrator. Raw SQL: `sqlite_master` table listing, `PRAGMA table_info(users)` preflight, `PRAGMA foreign_keys` save/restore, `PRAGMA foreign_key_check`, `BEGIN/COMMIT/ROLLBACK` via `db.exec`, hand-creates `__drizzle_migrations (id SERIAL PRIMARY KEY, hash text, created_at numeric)` and applies `drizzle/0000..0006` (**7 raw .sql migration files**, plus concurrent **0007**).
- `drizzle.config.ts`: `dialect: "sqlite"`, out `./drizzle`.
- Test fixtures: ~40 `createDb(":memory:")` / small-file call sites across `packages/db/test` (3 files), `packages/wallet/test` (5), `packages/keys/test` (1), `packages/catalog/test` (2), `apps/api/test` (27 files).

### Raw driver-API callers (blast radius)

`grep -c "\.prepare(|\.exec(|\.transaction("` over source (non-test):

- `packages/wallet/src/billing.ts`: 39 (largest; raw reserve/settle/CAS SQL, see below)
- `packages/wallet/src/wallet.ts`: ~15 raw (`runInImmediate` BEGIN IMMEDIATE wrapper, creditWallet CAS `UPDATE wallets SET balance=?, version=? WHERE id=? AND balance=? AND version=?`)
- `packages/wallet/src/reservation.ts`: 8 (dispatch CAS `reserved→dispatching` with `version = version + 1`, release CAS, own `db.exec("BEGIN IMMEDIATE")`)
- `packages/payments/src/credit.ts`: ~4 (relies on `runInImmediate` nesting semantics)
- `packages/keys/src/keys.ts`, `packages/catalog/src/*`: light raw use
- `apps/api/src/routes/admin-catalog.ts`: 27 (6 sync `db.transaction(() => …)` blocks), `admin-models.ts` 2, `keys.ts` 4, `workspaces.ts` 2, `payments.ts` 1, `dashboard.ts` SQLite-only `sql`date(created_at/1000,'unixepoch')`` group-by (x2)
- `apps/api/src/app.ts`: `createDb(HBR_DB_PATH || ":memory:")` + `migrate(d)` at boot; `apps/api/src/auth.ts`: module-level default DB, `betterAuth({ database: drizzleAdapter(drizzle(db,{schema}), …) })`
- `apps/api/src/routes/admin-extra.ts:308`: reads `PRAGMA journal_mode` for admin health display.

### Wallet money/CAS transactions (correctness-critical)

- Reserve: `UPDATE wallets SET reserved = reserved + ?, version = version + 1 WHERE id = ? AND balance - reserved >= ?` (availability CAS, changes==0 → typed InsufficientBalance).
- Settle: recompute + `UPDATE wallets SET balance=?, reserved=?, version=? WHERE id=? AND balance=? AND reserved=? AND version=?` (3-column CAS) + ledger insert, all inside `runInImmediate` (BEGIN IMMEDIATE).
- Dispatch CAS: drizzle `.set({reserved: sql`...`, version: sql`...`})` via `runChanges`.
- Isolation model today: SQLite writer serialization via BEGIN IMMEDIATE. Under PG concurrent connections this becomes real row-level concurrency → needs `FOR UPDATE` (or `SELECT … FOR UPDATE` before read-modify-write) or conditional-UPDATE + retry, because BEGIN IMMEDIATE does not exist in PG.

### Better Auth

`@better-auth/drizzle-adapter` receives the drizzle instance. It works with any drizzle dialect; switching to a PG drizzle instance is transparent to Better Auth, but `auth-schema.ts` tables must exist in the PG schema (regenerate via drizzle-kit pg or dual-export).

---

## 2. Decisions (recommendations, lazy-first)

### D1. Driver: keep sync-shaped app code — use **Bun.SQL via `drizzle-orm/bun-sql`**, not postgres-js

- `drizzle-orm/bun-sql` exists (drizzle-orm ≥0.44) and wraps Bun's native `Bun.SQL` (bundled with Bun 1.4, no new npm dep — important: no new deps allowed this run; the implementation task may add `drizzle-orm/bun-sql` which is already in the installed drizzle-orm).
- postgres-js would be a second runtime dep for zero benefit here; Bun.SQL is native, faster, and already available. **Skip** node-postgres.
- Caveat to verify in implementation: `bun-sql` drizzle transaction API is async (`await db.transaction(async tx => …)`), while current call sites use **sync** `db.transaction(() => …)`. See D4.

### D2. Sync→async blast radius: contain, don't rewrite

- ~45 raw `prepare/exec` call sites in src are synchronous bun:sqlite. Bun.SQL is async. Rewriting all of them to async is the biggest cost (~2 days incl. tests).
- Containment strategy: introduce a small internal `Db` facade in packages/db with two implementations (sqlite sync / pg async) exposing the ~8 operations the app actually uses: `run(sql, params) -> {changes}`, `get`, `all`, `transaction(fn)`. Wallet/billing/routes code against the facade; sqlite path stays sync internally, pg path returns promises. **Where the facade's API must become async, change signatures once at the facade, not per call site.** Honest estimate: the wallet/billing raw SQL is deeply sync-shaped (compute-then-CAS in JS); the pragmatic call is **make the facade async end-to-end and touch every caller** — see effort in §4. A "keep everything sync via Better-SQLite3-style worker" hack is not available in Bun; do not attempt.
- Simpler alternative evaluated and **rejected**: run PG through a sync shim. No such shim exists for Bun.SQL; fake-sync via Atomics/worker is 3am-page material.

### D3. Dual-dialect schema strategy

- Keep `schema.ts` as source of truth. Add `schema-pg.ts` that imports the same table/column names but built with `pgTable/pgText/pgInteger/pgBigint/pgCheck`. Mechanical translation, one table at a time.
- **Money columns**: use `integer` in PG too (PG int4 is ±2.1B) only where values provably fit (tokens, ms latencies); for VND amounts and USD micros use `bigint({ mode: "number" })` + keep the existing `intBounded` CHECK (`<= 2^53-1`) so JS `number` stays exact. PG bigint is int64; the CHECK is the JS-safety guarantee. Add an app-side `assertSafeInt` helper for write paths (cheap belt-and-braces).
- **CHECK translation** (`typeof(x)='integer'`): PG has no `typeof`; every type-CHECK becomes a range/null CHECK (`x IS NOT NULL AND x >= 0 AND x <= 9007199254740991`). Enum CHECKs (`IN ('a','b')`) translate verbatim. Count: 20 typeof sites inside 52 checks — mostly mechanical; the `intBounded` helper already composes, so define `pgIntBounded` alongside.
- Boolean-mode integer columns → PG `boolean` (5 columns) or keep smallint + CHECK for literal fidelity; recommend real `boolean`, drizzle mode handles it.
- JSON-mode text columns (2) → PG `jsonb` or keep `text`; recommend `jsonb`.
- Timestamps stay `bigint` epoch-ms (do NOT migrate to timestamptz in this change — that's a second migration risk for zero production need).
- Partial unique indexes (`where: sql`) translate 1:1 to PG partial indexes.

### D4. Transactions / CAS under PG

- `BEGIN IMMEDIATE` doesn't exist in PG. Map `runInImmediate`/`db.transaction` to drizzle PG `db.transaction(async fn)`; nesting (credit.ts) becomes PG SAVEPOINT via nested drizzle transactions — drizzle supports nested tx → the "outermost owns commit" comment semantics carry over.
- Wallet CAS: the existing conditional-UPDATE patterns (`WHERE balance = ? AND version = ?`, `WHERE balance - reserved >= ?`) are **already correct under READ COMMITTED** as compare-and-swap on a single row (PG row-locking makes the UPDATE atomic; changes==0 → miss). Keep them. For read-modify-write spans (settle recompute), add `SELECT … FOR UPDATE` on the wallet row inside the tx. Default isolation READ COMMITTED is sufficient; do not adopt SERIALIZABLE.
- `runChanges` keeps its shape; the pg `run()` result exposes `rowCount`/`changes` — retype at the facade.
- dashboard `date(created_at/1000,'unixepoch')` → PG `to_timestamp(created_at/1000.0)::date` (2 sites).

### D5. Migrations

- Create `packages/db/drizzle-pg/` with a **single generated baseline** (`drizzle-kit generate --dialect=postgresql`) representing the post-0007 schema (including the concurrent soft-delete column). Do NOT port 0000–0007 SQL by hand; existing PG deploys start from baseline only. Add `__drizzle_migrations` handling via `drizzle-orm/postgresql-js`-style `migrate()` or reuse the custom migrator with PG dialect (custom migrator needs its PG twin: drop sqlite_master/PRAGMA preflight, keep the FK-check intent via `SET CONSTRAINTS ALL DEFERRED` or post-migrate validation query).
- Keep the users-preflight safety check as a PG query.

### D6. DATABASE_URL selection

- `packages/db/src/client.ts` gains `createDbFromUrl(url)`: `postgresql://`/`postgres://` → `Bun.SQL`/drizzle-pg handle; otherwise (path or `:memory:`) → current sqlite path. `apps/api/src/app.ts` + `auth.ts` switch from `HBR_DB_PATH` to `DATABASE_URL` (fallback `HBR_DB_PATH` → sqlite so local dev and tests are untouched). Admin health `PRAGMA journal_mode` read (admin-extra.ts:308) becomes dialect-conditional (report `pg` version string for PG).

### D7. Tests

- Default stays SQLite `:memory:` — zero test churn for the 40 fixture sites.
- Add opt-in PG suite: `HBR_TEST_PG=postgres://…` env gate; when set, wallet/billing/CAS + migration tests run against a disposable PG database (created/dropped per run). CI: PG service container, gate off by default. Priority tests to cover under PG: wallet CAS concurrency (2 connections, billing.test.ts:619 pattern), settle atomicity, migration baseline idempotence, Better Auth round-trip.

### D8. Existing-deploy data migration (SQLite → PG)

- One-off script `packages/db/scripts/sqlite-to-pg.ts`: open SQLite read-only (WAL), open PG, wrap per-table copy in PG transaction, `SET session_replication_role = replica` (or `ALTER TABLE … DISABLE TRIGGER ALL`) to bypass FK ordering, copy rows in dependency order, verify row counts + `MAX_SAFE_INTEGER_MONEY` bounds per money column, write a marker row. Estimated ~4h incl. verification. Runs offline during deploy maintenance window; rollback = keep SQLite file until verification passes.

---

## 3. Implementation phases (honest hours, single experienced dev)

| Phase     | Work                                                                                                                                                                           | Hours                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 0         | Staging: provision PG (staging host or docker-compose on staging only — NOT repo docker-compose.yml, owned by another worker), `DATABASE_URL` secret wiring                    | 1.5                        |
| 1         | PG schema twin: `schema-pg.ts` + `auth-schema` pg twin, CHECK/typeof translation, partial indexes, bigint money columns; drizzle-kit pg baseline incl. 0007 soft-delete column | 6–8                        |
| 2         | `client.ts` `createDbFromUrl` + facade (`run/get/all/transaction/runChanges`), sqlite path unchanged                                                                           | 4                          |
| 3         | Async conversion of wallet/billing/reservation/payments raw SQL + call sites; CAS/`FOR UPDATE` review                                                                          | 8–10                       |
| 4         | apps/api routes: async transactions (admin-catalog 6 blocks, keys 4, workspaces 2, admin-models 2, payments 1), dashboard date SQL, admin-extra health                         | 5–6                        |
| 5         | Better Auth on pg drizzle instance; boot `migrate` PG twin                                                                                                                     | 3                          |
| 6         | Opt-in PG test harness + port ~10 highest-value tests (wallet CAS, settle, migrations, auth)                                                                                   | 6–8                        |
| 7         | sqlite→pg migration script + verification                                                                                                                                      | 4                          |
| 8         | Staging deploy: run baseline migrations, run data migration, soak, smoke (gateway reserve/settle round trip, admin, webhooks)                                                  | 4–5                        |
| 9         | Production deploy runbook + rollback plan (keep SQLite file, feature-flag `DATABASE_URL`)                                                                                      | 2                          |
| **Total** |                                                                                                                                                                                | **~43–52 h (1–1.5 weeks)** |

Biggest schedule risk: phase 3 async conversion — if `drizzle-orm/bun-sql` transaction semantics fight the sync callers more than expected, fall back to `postgres-js` driver (same drizzle API, different wire driver, no schema change) before considering deeper rewrites.

## 4. Staging plan

1. Deploy api build with `DATABASE_URL` pointing at staging PG, `HBR_DB_PATH` unset; boot applies pg baseline.
2. Run data migration from a copy of production SQLite; run verification script; compare counts/bounds.
3. Soak ≥48h with traffic mirror or synthetic gateway load; watch: CAS-miss rate (should be ~0, was structurally impossible under BEGIN IMMEDIATE), p99 reserve latency, settle ledger invariants (`balance >= reserved`, one settle per reservation).
4. Production: maintenance window, final SQLite snapshot, data migration, smoke, keep SQLite file read-only for 2 weeks as rollback.

## 5. Residual risks

- Sync→async conversion touches ~50 source call sites — highest regression surface; mitigated by existing wallet/ledger invariant tests.
- `runInImmediate` nesting semantics must map to PG SAVEPOINTs exactly; one subtle bug here double-charges or double-releases.
- Better Auth adapter on PG is supported but untested in this repo; phase 5 test needed.
- Concurrent worker's migration 0007 must land before phase 1 baseline generation; if it lands differently, regenerate baseline.
- drizzle-orm/bun-sql is newer than bun-sqlite driver; pin and smoke the exact version in phase 1.
