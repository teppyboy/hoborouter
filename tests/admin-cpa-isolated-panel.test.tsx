import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const keys = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "DocumentFragment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let createRoot: typeof import("react-dom/client").createRoot;
let Panel: typeof import("../apps/web/src/components/admin/cpa-isolated-panel").CpaIsolatedPanel;
let root: import("react-dom/client").Root | undefined;
const realFetch = globalThis.fetch;
const calls: { path: string; body: unknown }[] = [];
const messages: unknown[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("UI wait timed out");
}
beforeAll(async () => {
  dom = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true });
  for (const key of keys) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, {
      value:
        typeof value === "function" &&
        ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
          ? value.bind(dom.window)
          : value,
      configurable: true,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
  ({ CpaIsolatedPanel: Panel } =
    await import("../apps/web/src/components/admin/cpa-isolated-panel"));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("session")) return Response.json({ csrf_token: "secret-csrf" });
    if (path.endsWith("prepare"))
      return Response.json({
        approval_id: "secret-approval",
        expires_at: Date.now() + 60000,
        proposal: { operation: "deleteAuthFiles", args: { names: ["canonical<script>.json"] } },
      });
    return Response.json({ data: { ok: true } });
  }) as typeof fetch;
});
afterEach(async () => {
  root?.unmount();
  root = undefined;
  await tick();
  document.body.innerHTML = "";
  calls.length = 0;
  messages.length = 0;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  dom.window.close();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(<Panel />);
  await waitFor(() => document.querySelector("iframe") !== null);
  const frame = document.querySelector("iframe")!;
  frame.contentWindow!.postMessage = (message: unknown) => {
    messages.push(message);
  };
  frame.dispatchEvent(new dom.window.Event("load"));
  await tick();
  return frame;
}
function send(
  frame: HTMLIFrameElement,
  id: number,
  extra: Record<string, unknown> = {},
  source: Window | null = frame.contentWindow,
  channel?: string,
) {
  const init = messages.find(
    (message) => (message as { type: string }).type === "hbr-cpa-panel:init",
  ) as { channel: string };
  window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      origin: "null",
      source,
      data: {
        type: "hbr-cpa-panel:request",
        version: 1,
        channel: channel ?? init.channel,
        id,
        operation: "deleteAuthFiles",
        args: { names: ["child.json"] },
        ...extra,
      },
    }),
  );
}
function click(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  )!;
  button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

test("actual HTTP upstream asset uses opaque sandbox and no-referrer; boundary copy permanent; init no secrets", async () => {
  const frame = await mount();
  expect(frame.getAttribute("src")).toBe("/api/v1/admin/cpa/panel/management.html#/auth-files");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(document.body.textContent).toContain("YAML");
  expect(document.body.textContent).toContain("quota");
  expect(messages[0]).toEqual({
    type: "hbr-cpa-panel:init",
    version: 1,
    channel: expect.any(String),
  });
  expect(JSON.stringify(messages)).not.toContain("secret-csrf");
});

test("trusted outer dialog shows canonical escaped names; Cancel sends zero execute", async () => {
  const frame = await mount();
  send(frame, 1);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
    "canonical<script>.json",
  );
  expect(document.querySelector('[role="dialog"] script')).toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(calls.filter((call) => call.path.endsWith("execute"))).toHaveLength(0);
  click("Cancel");
  await tick();
  expect(calls.filter((call) => call.path.endsWith("execute"))).toHaveLength(0);
  expect(JSON.stringify(messages)).not.toContain("secret-approval");
});

test("explicit Confirm sends stored approval ID only; reload invalidates stale messages", async () => {
  const frame = await mount();
  const old = (messages[0] as { channel: string }).channel;
  send(frame, 1);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null);
  click("Confirm");
  await waitFor(() => calls.some((call) => call.path.endsWith("execute")));
  expect(calls.find((call) => call.path.endsWith("execute"))!.body).toEqual({
    approval_id: "secret-approval",
  });
  expect(JSON.stringify(messages)).not.toContain("secret-approval");
  frame.dispatchEvent(new dom.window.Event("load"));
  await tick();
  send(frame, 2, {}, frame.contentWindow, old);
  await tick();
  expect(calls.filter((call) => call.path.endsWith("prepare"))).toHaveLength(1);
});

test("wrong source and unmount deny confirmation without execute", async () => {
  const frame = await mount();
  send(frame, 1, {}, window);
  await tick();
  expect(calls.filter((call) => call.path.endsWith("prepare"))).toHaveLength(0);
  send(frame, 2);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null);
  root!.unmount();
  root = undefined;
  await tick();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(calls.filter((call) => call.path.endsWith("execute"))).toHaveLength(0);
});
