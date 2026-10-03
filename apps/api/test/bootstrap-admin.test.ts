// Production bootstrap path: HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL grants
// instance admin on signup in ANY environment, but only while the instance
// has zero instance admins.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Db } from "@hoborouter/db";
import { makeApp, q, signUp } from "./helpers";
import { bootstrapFirstInstanceAdmin } from "../src/instance-admin";

const adminCount = async (db: Db) => {
  const rows = await q(db, "SELECT COUNT(*)::int AS n FROM instance_admins");
  return (rows[0]?.n as number | undefined) ?? 0;
};

const isAdmin = async (db: Db, email: string) => {
  const rows = await q(
    db,
    "SELECT 1 FROM instance_admins ia JOIN users u ON u.id = ia.user_id WHERE u.email = ?",
    email,
  );
  return rows.length > 0;
};

describe("HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_URL = "http://localhost:5199";
    process.env.BETTER_AUTH_SECRET = "x".repeat(32);
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    delete process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL;
  });

  test("production + env set + zero admins -> matching email becomes admin (case-insensitive)", async () => {
    // Better Auth lowercases emails on signup, so exercise case-insensitivity
    // through the configured email instead of the signup input.
    process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL = "ADMIN@E2E.TEST";
    const { db, app } = await makeApp();
    await signUp(app, "admin@e2e.test");
    expect(await isAdmin(db, "admin@e2e.test")).toBe(true);
    expect(await adminCount(db)).toBe(1);
  });

  test("env still set after an admin exists -> later signup is NOT admin", async () => {
    process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL = "admin@e2e.test";
    const { db, app } = await makeApp();
    await signUp(app, "admin@e2e.test");
    await signUp(app, "second@e2e.test");
    expect(await isAdmin(db, "second@e2e.test")).toBe(false);
    expect(await adminCount(db)).toBe(1);
  });

  test("env set + admin already exists + matching email signs up -> NOT admin", async () => {
    process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL = "admin@e2e.test";
    const { db, app } = await makeApp();
    // Seed a pre-existing admin so the instance is not admin-less.
    await signUp(app, "owner@e2e.test");
    await q(
      db,
      "INSERT INTO instance_admins (user_id, created_at) SELECT id, ? FROM users WHERE email = ?",
      Date.now(),
      "owner@e2e.test",
    );
    await signUp(app, "admin@e2e.test");
    expect(await isAdmin(db, "admin@e2e.test")).toBe(false);
    expect(await adminCount(db)).toBe(1);
  });

  test("different email -> not admin", async () => {
    process.env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL = "admin@e2e.test";
    const { db, app } = await makeApp();
    await signUp(app, "someone@e2e.test");
    expect(await isAdmin(db, "someone@e2e.test")).toBe(false);
    expect(await adminCount(db)).toBe(0);
  });

  test("env unset -> not admin", async () => {
    const { db, app } = await makeApp();
    await signUp(app, "admin@e2e.test");
    expect(await isAdmin(db, "admin@e2e.test")).toBe(false);
  });

  test("startup helper: grants when user exists + zero admins", async () => {
    const { db, app } = await makeApp();
    await signUp(app, "admin@e2e.test");
    expect(await bootstrapFirstInstanceAdmin(db, "ADMIN@e2e.test")).toBe(true);
    expect(await adminCount(db)).toBe(1);
    // Idempotent: second call is a no-op (admin now exists).
    expect(await bootstrapFirstInstanceAdmin(db, "admin@e2e.test")).toBe(false);
  });

  test("startup helper: missing user tolerated (no throw)", async () => {
    const { db } = await makeApp();
    await expect(bootstrapFirstInstanceAdmin(db, "nobody@e2e.test")).resolves.toBe(false);
  });
});
