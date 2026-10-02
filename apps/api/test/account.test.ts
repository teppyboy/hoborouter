// Account backend: /api/auth updateUser + change-password, /api/v1/account/email,
// avatar upload/serve/delete roundtrip. Real HTTP against the built app.
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeApp, req, signUp, userIdByEmail } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let avatarDir = "";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4, 5, 6,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 5, 6,
]);

beforeAll(async () => {
  avatarDir = join(tmpdir(), `hbr-avatars-${Date.now()}`);
  mkdirSync(avatarDir, { recursive: true });
  process.env.HBR_AVATAR_DIR = avatarDir;
  ctx = await makeApp();
});

afterAll(() => {
  delete process.env.HBR_AVATAR_DIR;
  rmSync(avatarDir, { recursive: true, force: true });
});

describe("Better Auth updateUser + changePassword", () => {
  test("updateUser renames, changePassword swaps password", async () => {
    const cookie = await signUp(ctx.app, "rename@example.com", "Old");
    const upd = await req(ctx.app, "/api/auth/update-user", {
      method: "POST",
      cookie,
      body: { name: "New Name" },
    });
    expect(upd.status).toBe(200);
    const oldPw = "correct horse battery staple";
    const ch = await req(ctx.app, "/api/auth/change-password", {
      method: "POST",
      cookie,
      body: {
        currentPassword: oldPw,
        newPassword: "newer horse battery staple",
        revokeOtherSessions: true,
      },
    });
    expect(ch.status).toBe(200);
    // old password rejected, new accepted
    const rej = await req(ctx.app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "rename@example.com", password: oldPw },
    });
    expect(rej.status).toBe(401);
    const ok = await req(ctx.app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "rename@example.com", password: "newer horse battery staple" },
    });
    expect(ok.status).toBe(200);
  });

  test("updateUser accepts 80-char name (length clamp is client-side)", async () => {
    const cookie = await signUp(ctx.app, "trim@example.com", "T");
    const ok = await req(ctx.app, "/api/auth/update-user", {
      method: "POST",
      cookie,
      body: { name: "x".repeat(80) },
    });
    expect(ok.status).toBe(200);
  });
});

describe("POST /api/v1/account/email", () => {
  test("401 without session", async () => {
    const res = await req(ctx.app, "/api/v1/account/email", {
      method: "POST",
      body: { email: "x@example.com", currentPassword: "y" },
    });
    expect(res.status).toBe(401);
  });

  test("403 WRONG_PASSWORD on wrong password", async () => {
    const cookie = await signUp(ctx.app, "email1@example.com", "E1");
    const res = await req(ctx.app, "/api/v1/account/email", {
      method: "POST",
      cookie,
      body: { email: "new@example.com", currentPassword: "nope" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("WRONG_PASSWORD");
  });

  test("409 EMAIL_TAKEN on duplicate", async () => {
    await signUp(ctx.app, "taken@example.com", "Taken");
    const cookie = await signUp(ctx.app, "email2@example.com", "E2");
    const res = await req(ctx.app, "/api/v1/account/email", {
      method: "POST",
      cookie,
      body: {
        email: "TAKEN@example.com",
        currentPassword: "correct horse battery staple",
      },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("EMAIL_TAKEN");
  });

  test("400 INVALID on malformed email", async () => {
    const cookie = await signUp(ctx.app, "email3@example.com", "E3");
    const res = await req(ctx.app, "/api/v1/account/email", {
      method: "POST",
      cookie,
      body: { email: "not-an-email", currentPassword: "correct horse battery staple" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID");
  });

  test("200 success: trimmed+lowercased, user returned, audit written", async () => {
    const cookie = await signUp(ctx.app, "email4@example.com", "E4");
    const res = await req(ctx.app, "/api/v1/account/email", {
      method: "POST",
      cookie,
      body: {
        email: "  Email4-New@EXAMPLE.com  ",
        currentPassword: "correct horse battery staple",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; name: string; image: unknown } };
    expect(body.user.email).toBe("email4-new@example.com");
    expect(body.user.name).toBe("E4");
    expect(body.user.image).toBeNull();
    const audit = ctx.db
      .prepare("SELECT action FROM audit_log WHERE action = 'user.email_change'")
      .all();
    expect(audit.length).toBe(1);
  });
});

describe("avatar upload/serve/delete", () => {
  const raw = (
    app: Awaited<ReturnType<typeof makeApp>>["app"],
    path: string,
    body: BodyInit,
    headers: Record<string, string> = {},
    cookie?: string,
  ) =>
    app.handle(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: cookie ? { ...headers, cookie } : headers,
        body,
      }),
    );

  test("401 unauthenticated upload", async () => {
    const res = await raw(ctx.app, "/api/v1/account/avatar", PNG, {
      "content-type": "image/png",
    });
    expect(res.status).toBe(401);
  });

  test("400 INVALID_IMAGE on bad magic bytes despite image/png mime", async () => {
    const cookie = await signUp(ctx.app, "av1@example.com", "A1");
    const fake = new Uint8Array([1, 2, 3, 4]);
    const res = await raw(
      ctx.app,
      "/api/v1/account/avatar",
      fake,
      { "content-type": "image/png" },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_IMAGE");
  });

  test("413 TOO_LARGE over 1 MiB", async () => {
    const cookie = await signUp(ctx.app, "av2@example.com", "A2");
    const big = new Uint8Array(1_048_577);
    big.set(PNG);
    const res = await raw(
      ctx.app,
      "/api/v1/account/avatar",
      big,
      { "content-type": "image/png" },
      cookie,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TOO_LARGE");
  });

  test("413 TOO_LARGE streamed body without content-length header", async () => {
    const cookie = await signUp(ctx.app, "av8@example.com", "A8");
    const big = new Uint8Array(1_048_577);
    big.set(PNG);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const req2 = new Request("http://localhost/api/v1/account/avatar", {
      method: "POST",
      headers: { "content-type": "image/png", cookie },
      body: stream,
      // @ts-expect-error duplex is undici-only and not in Bun's RequestInit
      duplex: "half",
    });
    expect(req2.headers.get("content-length")).toBeNull();
    const res = await ctx.app.handle(req2);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TOO_LARGE");
  });

  test("400 INVALID_IMAGE on unsupported content-type", async () => {
    const cookie = await signUp(ctx.app, "av3@example.com", "A3");
    const res = await raw(
      ctx.app,
      "/api/v1/account/avatar",
      PNG,
      { "content-type": "image/gif" },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  test("upload → serve roundtrip with headers, then delete → 404", async () => {
    const cookie = await signUp(ctx.app, "av4@example.com", "A4");
    const res = await raw(
      ctx.app,
      "/api/v1/account/avatar",
      PNG,
      { "content-type": "image/png" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; image: string } };
    expect(body.user.image).toContain(`/api/v1/avatars/${body.user.id}?v=`);

    // serve (strip cache-busting query for the GET)
    const serve = await ctx.app.handle(
      new Request(`http://localhost/api/v1/avatars/${body.user.id}`),
    );
    expect(serve.status).toBe(200);
    expect(serve.headers.get("content-type")).toBe("image/png");
    expect(serve.headers.get("x-content-type-options")).toBe("nosniff");
    expect(serve.headers.get("cache-control")).toContain("max-age=86400");
    const bytes = new Uint8Array(await serve.arrayBuffer());
    expect(bytes).toEqual(PNG);

    // delete
    const del = await ctx.app.handle(
      new Request("http://localhost/api/v1/account/avatar", { method: "DELETE", headers: { cookie } }),
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { user: { image: string | null } };
    expect(delBody.user.image).toBeNull();
    const gone = await ctx.app.handle(
      new Request(`http://localhost/api/v1/avatars/${body.user.id}`),
    );
    expect(gone.status).toBe(404);
  });

  test("jpeg and webp magic bytes accepted and served with correct mime", async () => {
    for (const [email, bytes, mime] of [
      ["av5@example.com", JPEG, "image/jpeg"],
      ["av6@example.com", WEBP, "image/webp"],
    ] as const) {
      const cookie = await signUp(ctx.app, email, "X");
      const res = await raw(
        ctx.app,
        "/api/v1/account/avatar",
        bytes,
        { "content-type": mime },
        cookie,
      );
      expect(res.status).toBe(200);
      const id = userIdByEmail(ctx.db, email);
      const serve = await ctx.app.handle(new Request(`http://localhost/api/v1/avatars/${id}`));
      expect(serve.headers.get("content-type")).toBe(mime);
    }
    // files live in the configured temp dir
    const id5 = userIdByEmail(ctx.db, "av5@example.com");
    expect(existsSync(join(avatarDir, `${id5}.jpg`))).toBe(true);
  });

  test("re-upload with different ext removes the stale file", async () => {
    const cookie = await signUp(ctx.app, "av7@example.com", "A7");
    await raw(ctx.app, "/api/v1/account/avatar", PNG, { "content-type": "image/png" }, cookie);
    await raw(ctx.app, "/api/v1/account/avatar", JPEG, { "content-type": "image/jpeg" }, cookie);
    const id = userIdByEmail(ctx.db, "av7@example.com");
    expect(existsSync(`${avatarDir}/${id}.png`)).toBe(false);
    expect(existsSync(`${avatarDir}/${id}.jpg`)).toBe(true);
  });

  test("traversal userId rejected; unknown user 404", async () => {
    // URL normalization may 404 these before the param regex runs; either way no file escape.
    const trav = await ctx.app.handle(
      new Request("http://localhost/api/v1/avatars/..%2F..%2Fsecret"),
    );
    expect([400, 404]).toContain(trav.status);
    const plain = await ctx.app.handle(new Request("http://localhost/api/v1/avatars/../../etc"));
    expect([400, 404]).toContain(plain.status);
    const missing = await ctx.app.handle(
      new Request("http://localhost/api/v1/avatars/nonexistentuser123"),
    );
    expect(missing.status).toBe(404);
  });
});
