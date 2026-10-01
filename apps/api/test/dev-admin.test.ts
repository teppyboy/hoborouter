// Dev-only instance-admin auto-bootstrap on signup (HBR_DEV_ADMIN_EMAIL).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { makeApp } from "./helpers";

let db: Database;

const isAdmin = (email: string) => {
  const row = db
    .prepare("SELECT 1 FROM instance_admins ia JOIN users u ON u.id = ia.user_id WHERE u.email = ?")
    .get(email);
  return !!row;
};

const signupViaAuth = async (app: Awaited<ReturnType<typeof makeApp>>, email: string) => {
  const res = await app.app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery staple", name: "U" }),
    }),
  );
  if (!res.ok) console.error("signup failed", res.status, await res.text());
};

describe("dev instance-admin bootstrap", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_URL = "http://localhost:5199";
    process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    delete process.env.HBR_DEV_ADMIN_EMAIL;
  });

  test("development + matching email -> admin (case-insensitive)", async () => {
    process.env.NODE_ENV = "development";
    // Better Auth lowercases emails on signup, so exercise case-insensitivity
    // through the configured email instead of the signup input.
    process.env.HBR_DEV_ADMIN_EMAIL = "ADMIN@E2E.TEST";
    const app = await makeApp();
    db = app.db;
    await signupViaAuth(app, "admin@e2e.test");
    expect(isAdmin("admin@e2e.test")).toBe(true);
  });

  test("development + non-matching email -> not admin", async () => {
    process.env.NODE_ENV = "development";
    process.env.HBR_DEV_ADMIN_EMAIL = "admin@e2e.test";
    const app = await makeApp();
    db = app.db;
    await signupViaAuth(app, "someone@e2e.test");
    expect(isAdmin("someone@e2e.test")).toBe(false);
  });

  test("production + matching email -> not admin", async () => {
    process.env.NODE_ENV = "production";
    process.env.HBR_DEV_ADMIN_EMAIL = "admin@e2e.test";
    const app = await makeApp();
    db = app.db;
    await signupViaAuth(app, "admin@e2e.test");
    expect(isAdmin("admin@e2e.test")).toBe(false);
  });
});
