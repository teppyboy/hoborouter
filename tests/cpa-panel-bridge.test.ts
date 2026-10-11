import { expect, jest, test } from "bun:test";
import { CpaPanelBridge, type PanelFetch } from "../apps/web/src/lib/cpa-panel-bridge";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness(fetcher?: PanelFetch) {
  const messages: unknown[] = [];
  const calls: { path: string; body: unknown; csrf: string | null }[] = [];
  const frame = { postMessage: (message: unknown) => messages.push(message) };
  let confirmation:
    | Parameters<NonNullable<ConstructorParameters<typeof CpaPanelBridge>[0]["onProposal"]>>[0]
    | undefined;
  const bridge = new CpaPanelBridge({
    frame,
    channel: "generation",
    csrf: "parent-csrf-secret",
    onProposal: (value) => {
      confirmation = value;
    },
    fetcher:
      fetcher ??
      (async (path, init) => {
        calls.push({
          path: String(path),
          body: JSON.parse(String(init?.body)),
          csrf: new Headers(init?.headers).get("x-hbr-panel-csrf"),
        });
        return Response.json(
          String(path).endsWith("prepare")
            ? {
                approval_id: "parent-approval-secret",
                expires_at: Date.now() + 60000,
                proposal: {
                  operation: "setAuthFileStatus",
                  args: { name: "canonical.json", disabled: true },
                },
              }
            : { data: { files: [] } },
        );
      }),
  });
  const send = (
    id = 1,
    extra: Record<string, unknown> = {},
    source: unknown = frame,
    origin = "null",
  ) =>
    bridge.handle({
      source,
      origin,
      data: {
        type: "hbr-cpa-panel:request",
        version: 1,
        channel: "generation",
        id,
        operation: "listAuthFiles",
        ...extra,
      },
    });
  return { bridge, messages, calls, send, confirmation: () => confirmation };
}

test("current opaque frame only; strict schema rejects forged URL/header/args/operations and stale channels", async () => {
  const h = harness();
  h.send(1, {}, {}, "null");
  h.send(1, {}, undefined, "https://admin.invalid");
  for (const extra of [
    { channel: "stale" },
    { version: 2 },
    { id: -1 },
    { id: 2147483648 },
    { url: "/config.yaml" },
    { headers: {} },
    { args: {} },
    { operation: "execute", approval_id: "forged" },
  ])
    h.send(1, extra);
  await tick();
  expect(h.calls).toHaveLength(0);
  h.send();
  await tick();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.csrf).toBe("parent-csrf-secret");
  expect(JSON.stringify(h.messages)).not.toContain("parent-csrf-secret");
  h.bridge.dispose();
});

test("duplicates never dispatch twice; pending flood bounded at 32; disposed generation denied", async () => {
  const h = harness(() => new Promise<Response>(() => {}));
  h.send();
  h.send();
  for (let id = 2; id <= 40; id++) h.send(id);
  expect(h.bridge.pendingCount).toBe(32);
  expect(JSON.stringify(h.messages)).toContain("HBR_PANEL_BUSY");
  h.bridge.dispose();
  expect(h.bridge.pendingCount).toBe(0);
  h.send(41);
  expect(h.bridge.pendingCount).toBe(0);
});

test("prepare shows canonical proposal; Cancel performs zero execute; approval never reaches frame", async () => {
  const h = harness();
  h.send(1, { operation: "setAuthFileStatus", args: { name: "child.json", disabled: false } });
  await tick();
  expect(h.confirmation()?.proposal.args).toEqual({ name: "canonical.json", disabled: true });
  expect(h.calls.map((c) => c.path)).toEqual(["/api/v1/admin/cpa/panel/prepare"]);
  h.confirmation()?.cancel();
  await tick();
  expect(h.calls).toHaveLength(1);
  expect(JSON.stringify(h.messages)).toContain("HBR_PANEL_CANCELLED");
  expect(JSON.stringify(h.messages)).not.toContain("parent-approval-secret");
  h.bridge.dispose();
});

test("Confirm executes stored ID only once, not child or displayed args; concurrent mutations denied", async () => {
  const h = harness();
  h.send(1, { operation: "setAuthFileStatus", args: { name: "child.json", disabled: false } });
  h.send(2, { operation: "deleteAuthFiles", args: { names: ["another.json"] } });
  await tick();
  const confirmation = h.confirmation()!;
  confirmation.proposal.args = { name: "tampered.json", disabled: false };
  confirmation.confirm();
  confirmation.confirm();
  await tick();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.body).toEqual({ approval_id: "parent-approval-secret" });
  expect(JSON.stringify(h.messages)).not.toContain("parent-approval-secret");
  h.bridge.dispose();
});

test("oversized envelopes and unsupported mutation arguments denied before API", async () => {
  const h = harness();
  for (const args of [
    { name: "../secret", disabled: true },
    { name: "a.json", disabled: true, confirm: true },
  ])
    h.send(1, { operation: "setAuthFileStatus", args });
  h.send(2, { operation: "replaceModelAliases", args: { channel: "unknown", aliases: [] } });
  h.send(3, {
    operation: "replaceModelExclusions",
    args: { provider: "codex", models: Array.from({ length: 500 }, () => "x".repeat(256)) },
  });
  await tick();
  expect(h.calls).toHaveLength(0);
  h.bridge.dispose();
});

test("generation dedup storage bounded at 4096; completed duplicate remains denied", async () => {
  const h = harness();
  h.send();
  await tick();
  h.send();
  await tick();
  expect(h.calls).toHaveLength(1);
  for (let id = 2; id <= 4097; id++) h.send(id);
  expect(h.bridge.pendingCount).toBe(0);
  h.send(4098);
  expect(h.bridge.pendingCount).toBe(0);
});

test("read timeout aborts pending work; no late result delivered", async () => {
  jest.useFakeTimers();
  try {
    let signal: AbortSignal | null | undefined;
    const h = harness((_path, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    h.send();
    jest.advanceTimersByTime(30001);
    expect(signal?.aborted).toBe(true);
    expect(h.bridge.pendingCount).toBe(0);
    expect(JSON.stringify(h.messages)).toContain("HBR_PANEL_TIMEOUT");
    h.bridge.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test("approval expiry invalidates Confirm; session revocation clears generation", async () => {
  const h = harness(async () =>
    Response.json({
      approval_id: "secret",
      expires_at: Date.now() + 25,
      proposal: { operation: "deleteAuthFiles", args: { names: ["a.json"] } },
    }),
  );
  h.send(1, { operation: "deleteAuthFiles", args: { names: ["a.json"] } });
  await tick();
  const confirmation = h.confirmation()!;
  expect(confirmation).toBeDefined();
  await new Promise((resolve) => setTimeout(resolve, 35));
  confirmation.confirm();
  expect(h.bridge.pendingCount).toBe(0);
  expect(JSON.stringify(h.messages)).toContain("HBR_PANEL_TIMEOUT");
  h.bridge.dispose();
  const revoked = harness(async () => new Response("raw-secret-error", { status: 403 }));
  revoked.send();
  await tick();
  expect(revoked.bridge.pendingCount).toBe(0);
  revoked.send(2);
  expect(revoked.bridge.pendingCount).toBe(0);
  expect(JSON.stringify(revoked.messages)).not.toContain("raw-secret-error");
});

test("invalid or oversized API response rejected without raw content", async () => {
  const h = harness(async () => Response.json({ data: "upstream-secret".repeat(10000) }));
  h.send();
  await tick();
  expect(JSON.stringify(h.messages)).toContain("HBR_PANEL_INVALID_RESPONSE");
  expect(JSON.stringify(h.messages)).not.toContain("upstream-secret");
  h.bridge.dispose();
});

test("unmount/navigation aborts requests, clears confirmation, invalidates old confirm", async () => {
  const h = harness();
  h.send(1, { operation: "deleteAuthFiles", args: { names: ["a.json"] } });
  await tick();
  const confirmation = h.confirmation()!;
  h.bridge.dispose();
  confirmation.confirm();
  await tick();
  expect(h.calls).toHaveLength(1);
});
