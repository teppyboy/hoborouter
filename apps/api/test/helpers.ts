// Shared test scaffolding: in-memory DB + migrated schema + Better Auth + app.
import { type Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";

export async function makeApp() {
  const db = createDb(":memory:");
  migrate(db);
  const auth = createAuth(db);
  const app = buildApp({ db, auth });
  return { db, auth, app };
}

export const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

export async function signUp(
  app: ReturnType<typeof buildApp>,
  email: string,
  name = "U",
): Promise<string> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery staple", name }),
    }),
  );
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return cookieOf(res);
}

export function req(
  app: ReturnType<typeof buildApp>,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
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

/** Direct DB helpers (setup only — authz itself goes through HTTP). */
export function createWorkspace(db: Database, id: string, ownerId: string, name = "ws") {
  const now = Date.now();
  db.prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?,?,'active',?)").run(
    id,
    name,
    now,
  );
  db.prepare(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'owner')",
  ).run(id, ownerId);
}

export function addMember(db: Database, wsId: string, userId: string, role: string) {
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)").run(
    wsId,
    userId,
    role,
  );
}

export function makeInstanceAdmin(db: Database, userId: string) {
  db.prepare("INSERT INTO instance_admins (user_id, created_at) VALUES (?,?)").run(
    userId,
    Date.now(),
  );
}

export function userIdByEmail(db: Database, email: string): string {
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as {
    id: string;
  } | null;
  if (!row) throw new Error("no user " + email);
  return row.id;
}
