// Task 3B: auth route mounting, cookie sessions, unauthed 401.
import { beforeAll, describe, expect, test } from "bun:test";
import { makeApp, req, signUp, cookieOf } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  ctx = await makeApp();
});

describe("Better Auth mounted at /api/auth/*", () => {
  test("sign-up sets session cookie", async () => {
    const res = await req(ctx.app, "/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "a@example.com", password: "Correct-Horse-Battery-Staple-1", name: "A" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(
      true,
    );
  });

  test("sign-in returns session cookie", async () => {
    await signUp(ctx.app, "b@example.com", "B");
    const res = await req(ctx.app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "b@example.com", password: "Correct-Horse-Battery-Staple-1" },
    });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toContain("better-auth.session_token=");
  });

  test("unauthenticated /api/v1/workspaces → 401", async () => {
    const res = await req(ctx.app, "/api/v1/workspaces");
    expect(res.status).toBe(401);
  });

  test("authenticated with cookie → 200 (empty list)", async () => {
    const cookie = await signUp(ctx.app, "c@example.com", "C");
    const res = await req(ctx.app, "/api/v1/workspaces", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
