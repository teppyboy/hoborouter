import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveStaticPath } from "../src/static-spa";
import { makeApp } from "./helpers";

const secretName = "hbr-secret.txt";
let fixtureDist = "";
let outsideFile = "";

let ctx: Awaited<ReturnType<typeof makeApp>>;
const req = (path: string) => ctx.app.handle(new Request(`http://localhost${path}`));

beforeAll(async () => {
  fixtureDist = join(tmpdir(), `hbr-fixture-${Date.now()}`);
  outsideFile = join(tmpdir(), secretName);
  mkdirSync(join(fixtureDist, "assets"), { recursive: true });
  writeFileSync(join(fixtureDist, "index.html"), "<!doctype html><html>SPA</html>");
  writeFileSync(join(fixtureDist, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(fixtureDist, ".env"), "SECRET=1");
  writeFileSync(outsideFile, "TOP-SECRET-OUTSIDE");
  symlinkSync(outsideFile, join(fixtureDist, "symlinked-secret.txt"));
  process.env.HBR_WEB_DIST = fixtureDist;
  ctx = await makeApp();
});

afterAll(() => {
  delete process.env.HBR_WEB_DIST; // don't leak the fixture path into other test files
  rmSync(fixtureDist, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
});

describe("health + openapi", () => {
  test("GET /healthz → 200 {status:'ok'}", async () => {
    const res = await req("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /openapi.json → 200 with /healthz path", async () => {
    const res = await req("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toBeTruthy();
    expect(Object.keys(doc.paths ?? {})).toContain("/healthz");
  });

  test("paid-traffic proxy routes not documented", async () => {
    const res = await req("/openapi.json");
    const doc = (await res.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});
    expect(paths.some((p) => p.startsWith("/v1/chat/completions"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/v1/responses"))).toBe(false);
  });
});

describe("static SPA serving", () => {
  test("GET / returns fixture index.html", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<!doctype html><html>SPA</html>");
  });

  test("SPA fallback: /some/spa/route returns index.html", async () => {
    const res = await req("/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<!doctype html><html>SPA</html>");
  });

  test("MIME: /assets/app.js → text/javascript", async () => {
    const res = await req("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  test("missing asset → 404", async () => {
    const res = await req("/assets/missing.js");
    expect(res.status).toBe(404);
  });

  test("dotfiles rejected → 404", async () => {
    const res = await req("/.env");
    expect(res.status).toBe(404);
  });

  test("traversal encoded blocked over HTTP", async () => {
    const res = await req(`/..%2f${secretName}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP-SECRET-OUTSIDE");
  });

  test("symlink escaping root blocked over HTTP", async () => {
    const res = await req("/symlinked-secret.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP-SECRET-OUTSIDE");
  });

  test("traversal paths rejected by resolver (HTTP URL normalizes `..` before the app sees them)", () => {
    const root = realpathSync(fixtureDist);
    expect(resolveStaticPath(root, `../${secretName}`)).toBeNull();
    expect(resolveStaticPath(root, "%2e%2e/%2e%2e/" + secretName)).toBeNull();
    expect(resolveStaticPath(root, "symlinked-secret.txt")).toBeNull();
    expect(resolveStaticPath(root, ".env")).toBeNull();
    expect(resolveStaticPath(root, "assets/app.js")).not.toBeNull();
  });

  test("API unknown route → 404 (not SPA fallback)", async () => {
    const res = await req("/api/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("reserved prefixes → JSON 404, never SPA HTML", async () => {
    for (const path of [
      "/api",
      "/v1",
      "/v1/chat/completions",
      "/v1/responses",
      "/webhooks",
      "/webhooks/x",
    ]) {
      const res = await req(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).not.toContain("<html>");
    }
  });

  test("/v1/models without key → 401 JSON (route exists, key-auth gated)", async () => {
    const res = await req("/v1/models");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("double-encoded reserved prefixes → 404, never SPA HTML", async () => {
    for (const path of [
      "/%2576%2531/models",
      "/%2561%2570%2569/keys",
      "/%2577%2565%2562%2568%256F%256F%256B%2573",
      "/%2577%2565%2562%2568%256F%256F%256B%2573/x",
    ]) {
      const res = await req(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
      expect(await res.text()).not.toContain("<html>");
    }
  });

  test("percent-encoded first segment → 404, never SPA HTML", async () => {
    for (const path of ["/%76%31/models", "/%61%70%69/keys", "/%252e%252e/secret", "/%zz"]) {
      const res = await req(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("<html>");
    }
    // "/%2e%2e/x" collapses to "/x" via WHATWG URL dot-segment removal before
    // routing — an ordinary SPA path, expected to serve HTML.
    const dotRes = await req("/%2e%2e/x");
    expect(dotRes.status).toBe(200);
  });

  test("encoded-slash / backslash wildcard rel → 404, never SPA HTML", async () => {
    for (const path of [
      "/%2fapi/missing",
      "/%2fv1/chat/completions",
      "/%2fwebhooks/x",
      "/%252fapi/missing",
      "/%5capi/missing",
      "/%2fapiary",
    ]) {
      const res = await req(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
      expect(await res.text()).not.toContain("<html>");
    }
  });

  test("segment-aware: nonreserved lookalikes still SPA-fallback", async () => {
    for (const path of ["/apiary", "/v12"]) {
      const res = await req(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<!doctype html><html>SPA</html>");
    }
  });
});
