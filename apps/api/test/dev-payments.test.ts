// SECURITY: the legacy dev self-complete endpoint is permanently
// unregistered — POST /api/v1/dev/payments/:id/complete must 404 in every
// environment, even with HBR_DEV_PAYMENTS=1. Only the instance-admin
// complete endpoint (/api/v1/admin/payments/:id/complete) may credit.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail } from "./helpers";
import type { Db } from "@hoborouter/db";
import type { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let memberCookie: string;
let adminCookie: string;

beforeAll(async () => {
  ({ db, app } = await makeApp());
  memberCookie = await signUp(app, "dev404-member@test.dev", "Member");
  adminCookie = await signUp(app, "dev404-admin@test.dev", "Admin");
  await makeInstanceAdmin(db, await userIdByEmail(db, "dev404-admin@test.dev"));
});

afterAll(() => {
  delete process.env.HBR_DEV_PAYMENTS;
});

const POST = (cookie?: string) =>
  req(app, "/api/v1/dev/payments/some-id/complete", { method: "POST", cookie });

describe("dev self-complete endpoint is permanently unregistered", () => {
  test("flag=1, NODE_ENV=production -> 404 for member and admin", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    process.env.NODE_ENV = "production";
    expect((await POST(memberCookie)).status).toBe(404);
    expect((await POST(adminCookie)).status).toBe(404);
  });

  test("flag=1, NODE_ENV=test -> still 404 (no self-credit in any env)", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    process.env.NODE_ENV = "test";
    expect((await POST(memberCookie)).status).toBe(404);
    expect((await POST(adminCookie)).status).toBe(404);
  });

  test("unauthenticated -> 404", async () => {
    expect((await POST()).status).toBe(404);
  });
});
