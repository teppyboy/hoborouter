import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { createAuth } from "@hoborouter/api/auth";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";

const DRIZZLE_DIR = new URL("../../../packages/db/drizzle/", import.meta.url).pathname;

const AUTH_COLUMNS = [
  "name",
  "email",
  "email_verified",
  "image",
  "created_at",
  "updated_at",
] as const;

function tableColumns(db: Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c: any) => c.name);
}

function fkCheck(db: Database): unknown[] {
  return db.prepare("PRAGMA foreign_key_check").all();
}

/**
 * Build a Task 2 snapshot DB: apply ONLY 0000+0001 via the drizzle migrator
 * (journal-aware), using a temp migrations folder that omits 0002. This keeps
 * __drizzle_migrations in sync so the subsequent full `migrate(db)` applies
 * only 0002 — simulating a real Task 2 deployment upgrade.
 */
function applyTask2Migrations(db: Database): void {
  const tmp = join(tmpdir(), `hbr-t2-snap-${Date.now()}`);
  mkdirSync(join(tmp, "meta"), { recursive: true });
  for (const f of readdirSync(DRIZZLE_DIR)) {
    if (/^000[01]_.*\.sql$/.test(f)) cpSync(join(DRIZZLE_DIR, f), join(tmp, f));
  }
  for (const f of ["_journal.json", "0000_snapshot.json", "0001_snapshot.json"]) {
    cpSync(join(DRIZZLE_DIR, "meta", f), join(tmp, "meta", f));
  }
  // journal still lists 0002; strip entries after 0001 so the migrator stops there
  const journal = JSON.parse(readFileSync(join(tmp, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: any) => e.idx <= 1);
  writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify(journal));
  drizzleMigrate(drizzle(db), { migrationsFolder: tmp });
  rmSync(tmp, { recursive: true, force: true });
}

async function assertAuthRoundTrip(db: Database) {
  const auth = createAuth(db);
  const email = "roundtrip@example.com";
  const signUp = await auth.api.signUpEmail({
    body: { email, name: "Round Trip", password: "correct horse battery staple" },
  });
  expect(signUp.user.email).toBe(email);

  const signIn = await auth.api.signInEmail({
    body: { email, password: "correct horse battery staple" },
    asResponse: true,
  });
  const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(session?.user.email).toBe(email);
  expect(session?.session.id).toBeTruthy();
}

describe("better-auth migration (0002)", () => {
  test("fresh DB: users gains auth columns, session/account/verification exist, FKs valid, round-trip works", async () => {
    const db = createDb(":memory:");
    migrate(db);

    for (const col of AUTH_COLUMNS) {
      expect(tableColumns(db, "users")).toContain(col);
    }
    for (const table of ["session", "account", "verification"]) {
      expect(tableColumns(db, table).length).toBeGreaterThan(0);
    }
    // users table NOT recreated: it must still be the Task 2 table (no migration created it again)
    expect(tableColumns(db, "users")).toContain("id");
    expect(fkCheck(db)).toEqual([]);

    await assertAuthRoundTrip(db);
  });

  test("upgrade from empty-users Task 2 snapshot: 0002 applies, FKs valid, round-trip works", async () => {
    const db = createDb(":memory:");
    applyTask2Migrations(db);
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });

    migrate(db); // applies 0002 on top

    for (const col of AUTH_COLUMNS) {
      expect(tableColumns(db, "users")).toContain(col);
    }
    for (const table of ["session", "account", "verification"]) {
      expect(tableColumns(db, table).length).toBeGreaterThan(0);
    }
    expect(fkCheck(db)).toEqual([]);

    await assertAuthRoundTrip(db);
  });
});
