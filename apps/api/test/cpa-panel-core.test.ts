import { expect, test } from "bun:test";
import { CpaPanelService, panelMutationSchema, projectPanelRead } from "../src/cpa-panel-core";

const actor = { userId: "admin", sessionId: "session" };
const proposal = {
  operation: "setAuthFileStatus",
  args: { name: "fake.json", disabled: true },
} as const;

test("panel strict schema rejects traversal, unknown channels, duplicate names and extra fields", () => {
  for (const value of [
    { ...proposal, args: { ...proposal.args, name: "../fake.json" } },
    { ...proposal, confirm: true },
    { operation: "deleteAuthFiles", args: { names: ["fake.json", "fake.json"] } },
    { operation: "replaceModelAliases", args: { channel: "unknown", aliases: [] } },
  ])
    expect(panelMutationSchema.safeParse(value).success).toBe(false);
});

test("safe projection preserves OAuth shape; rejects known quote/backslash secrets", () => {
  const secret = 'sentinel"\\secret';
  expect(
    projectPanelRead(
      "readModelAliases",
      { "oauth-model-alias": { codex: [{ name: "model", alias: "alias" }] } },
      [secret],
    ),
  ).toEqual({ "oauth-model-alias": { codex: [{ name: "model", alias: "alias" }] } });
  expect(() =>
    projectPanelRead(
      "readModelAliases",
      { "oauth-model-alias": { codex: [{ name: secret, alias: "alias" }] } },
      [secret],
    ),
  ).toThrow();
  expect(
    projectPanelRead(
      "readConfig",
      { debug: true, "api-keys": [secret], routing: { strategy: "round-robin", password: secret } },
      [secret],
    ),
  ).toEqual({ debug: true, routing: { strategy: "round-robin" } });
});

test("prepare executes nothing; concurrent replay dispatches once with canonical arguments", async () => {
  const hits: Request[] = [];
  const service = new CpaPanelService(
    { CPA_MANAGEMENT_KEY: "sentinel", CPA_BASE_URL: "https://fake.invalid" },
    async (input, init) => {
      const request = new Request(input, init);
      hits.push(request);
      return Response.json(
        request.method === "GET"
          ? {
              files: [
                {
                  name: "fake.json",
                  type: "codex",
                  provider: "codex",
                  disabled: false,
                  status: "active",
                },
              ],
            }
          : { ok: true, secret: "sentinel" },
      );
    },
  );
  const prepared = service.prepare(actor, proposal);
  expect(hits).toHaveLength(0);
  const results = await Promise.allSettled([
    service.execute(actor, prepared.approval_id),
    service.execute(actor, prepared.approval_id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(hits.filter((r) => r.method === "PATCH")).toHaveLength(1);
  expect(await hits.find((r) => r.method === "PATCH")!.json()).toEqual(proposal.args);
  expect(hits.every((r) => r.redirect === "error")).toBe(true);
});

test("approval expiry, session mismatch, missing key cannot dispatch", async () => {
  let time = 0;
  let calls = 0;
  const service = new CpaPanelService(
    {},
    async () => {
      calls++;
      return Response.json({});
    },
    () => time,
  );
  const prepared = service.prepare(actor, proposal);
  await expect(
    service.execute({ ...actor, sessionId: "other" }, prepared.approval_id),
  ).rejects.toThrow();
  time = 60_001;
  await expect(service.execute(actor, prepared.approval_id)).rejects.toThrow();
  await expect(service.read("readConfig")).rejects.toThrow();
  expect(calls).toBe(0);
});

test("response overflow, non-JSON, redirect, raw upstream errors return safe failures", async () => {
  const sentinel = 'secret"\\value';
  for (const reply of [
    () => new Response("x".repeat(65537), { headers: { "content-type": "application/json" } }),
    () => new Response(sentinel, { headers: { "content-type": "text/plain" } }),
    () => new Response(sentinel, { status: 302, headers: { location: "https://evil.test" } }),
    () => Response.json({ error: sentinel }, { status: 500 }),
    () => Response.json({ debug: sentinel }),
  ]) {
    const service = new CpaPanelService({ CPA_MANAGEMENT_KEY: sentinel }, async () => reply());
    try {
      await service.read("readConfig");
      throw Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  }
});

test("all fixed mutations reconstruct bodies; failed execution never replays", async () => {
  const hits: { path: string; method: string; body: unknown }[] = [];
  const service = new CpaPanelService({ CPA_MANAGEMENT_KEY: "secret" }, async (input, init) => {
    const request = new Request(input, init);
    hits.push({
      path: new URL(request.url).pathname,
      method: request.method,
      body: request.method === "GET" ? null : await request.json(),
    });
    return Response.json(
      request.method === "GET"
        ? {
            files: [
              {
                name: "fake.json",
                type: "codex",
                provider: "codex",
                disabled: false,
                status: "active",
              },
            ],
          }
        : { status: "ok" },
    );
  });
  for (const input of [
    { operation: "deleteAuthFiles", args: { names: ["fake.json"] } },
    {
      operation: "replaceModelAliases",
      args: {
        channel: "codex",
        aliases: [{ name: "upstream", alias: "public", force_mapping: true }],
      },
    },
    { operation: "replaceModelExclusions", args: { provider: "codex", models: [] } },
  ]) {
    const prepared = service.prepare(actor, input);
    await service.execute(actor, prepared.approval_id);
  }
  expect(hits.filter((h) => h.method !== "GET")).toEqual([
    { path: "/v0/management/auth-files", method: "DELETE", body: { names: ["fake.json"] } },
    {
      path: "/v0/management/oauth-model-alias",
      method: "PATCH",
      body: {
        channel: "codex",
        aliases: [{ name: "upstream", alias: "public", "force-mapping": true }],
      },
    },
    {
      path: "/v0/management/oauth-excluded-models",
      method: "PATCH",
      body: { provider: "codex", models: [] },
    },
  ]);
  let count = 0;
  const broken = new CpaPanelService({ CPA_MANAGEMENT_KEY: "secret" }, async () => {
    count++;
    throw new DOMException("private secret", "TimeoutError");
  });
  const prepared = broken.prepare(actor, {
    operation: "replaceModelExclusions",
    args: { provider: "codex", models: [] },
  });
  await expect(broken.execute(actor, prepared.approval_id)).rejects.toThrow("result unknown");
  await expect(broken.execute(actor, prepared.approval_id)).rejects.toThrow("Approval");
  expect(count).toBe(1);
});

test("HTTP success carrying partial deletion or error is not fabricated success", async () => {
  const service = new CpaPanelService({ CPA_MANAGEMENT_KEY: "secret" }, async (_input, init) =>
    Response.json(
      init?.method === "GET"
        ? {
            files: [
              {
                name: "fake.json",
                type: "codex",
                provider: "codex",
                disabled: false,
                status: "active",
              },
            ],
          }
        : { status: "ok", deleted: 0, failed: ["fake.json"] },
    ),
  );
  const prepared = service.prepare(actor, {
    operation: "deleteAuthFiles",
    args: { names: ["fake.json"] },
  });
  await expect(service.execute(actor, prepared.approval_id)).rejects.toThrow();
});
