// Shared test scaffolding: isolated Postgres test DB + migrated schema +
// Better Auth + app. Each call creates a throwaway database (hbr_t_<random>);
// call close() in afterAll to drop it.
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { afterAll } from "bun:test";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";

// Auto-cleanup: every test file importing helpers registers ONE afterAll that
// drops every test database opened via makeApp (per-test makeApp callers need
// no explicit close).
const openDbs: (() => Promise<void>)[] = [];
export const trackDrop = (drop: () => Promise<void>) => openDbs.push(drop);
afterAll(async () => {
  for (const close of openDbs) await close();
});

export async function makeApp() {
  const t = await createTestDb();
  // Idempotent close: tests may close a pool early (afterEach) to free
  // connections; the global afterAll must not double-drop.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await t.drop();
  };
  openDbs.push(close);
  const db = t.db;
  const auth = createAuth(db);
  const app = await buildApp({ db, auth });
  return { db, auth, app, close };
}

export const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

export async function signUp(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
  name = "U",
): Promise<string> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Correct-Horse-Battery-Staple-1", name }),
    }),
  );
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return cookieOf(res);
}

export function req(
  app: Awaited<ReturnType<typeof buildApp>>,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

/** Raw SQL helper for test seeding/assertions: sqlite-style `?` params → Postgres `$n`. */
export async function q<T = Record<string, unknown>>(
  db: Db,
  query: string,
  ...params: unknown[]
): Promise<T[]> {
  let i = 0;
  const pg = query.replace(/\?/g, () => `$${++i}`);
  const rows = (await db.$client.unsafe(pg, params as never[])) as T[];
  // bun SQL returns int8 (bigint) columns as strings; coerce for assertions.
  return rows.map((r) => {
    const o = { ...(r as Record<string, unknown>) };
    for (const k of Object.keys(o)) {
      if (
        typeof o[k] === "string" &&
        /^-?\d+$/.test(o[k] as string) &&
        (o[k] as string).length < 16
      )
        o[k] = Number(o[k]);
    }
    return o as T;
  });
}

/** Direct DB helpers (setup only — authz itself goes through HTTP). */
export async function createWorkspace(db: Db, id: string, ownerId: string, name = "ws") {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${id}, ${name}, 'active', ${now})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${id}, ${ownerId}, 'owner')`,
  );
}

export async function addMember(db: Db, wsId: string, userId: string, role: string) {
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, ${role})`,
  );
}

export async function makeInstanceAdmin(db: Db, userId: string) {
  await db.execute(
    sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${userId}, ${Date.now()})`,
  );
}

export async function userIdByEmail(db: Db, email: string): Promise<string> {
  const res = (await db.execute(
    sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`,
  )) as unknown as { id: string }[];
  const row = res[0];
  if (!row) throw new Error("no user " + email);
  return row.id;
}
