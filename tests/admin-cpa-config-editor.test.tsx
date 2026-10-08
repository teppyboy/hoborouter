// Dedicated UI contract for the CPA ConfigCard editor (apps/web/src/pages/admin/cpa.tsx).
// Approved design: ONE editable replacement-YAML textarea that starts empty
// (write-only — never seeded from the redacted read), the redacted current
// config shown as a collapsible read-only non-textarea preview, a fullscreen
// edit mode in the existing Dialog primitive, and the unchanged dangerous save
// flow: explicit confirm → PUT /api/v1/admin/cpa/config {config_yaml,
// confirm:true} → clear on success; errors keep the draft; cancel sends nothing.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
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
  "InputEvent",
  "PointerEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "DocumentFragment",
  "SVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

beforeAll(async () => {
  const win = new JSDOM("", {
    url: "http://localhost:5173",
    pretendToBeVisual: true,
  }).window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    FocusEvent: win.FocusEvent,
    InputEvent: win.InputEvent,
    PointerEvent: win.PointerEvent,
    NodeFilter: win.NodeFilter,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLSelectElement: win.HTMLSelectElement,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  ({ createRoot } = await import("react-dom/client"));
  ({ ConfigCard } = await import("../apps/web/src/pages/admin/cpa"));
  globalThis.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

let ConfigCard: (typeof import("../apps/web/src/pages/admin/cpa"))["ConfigCard"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;

const realFetch = globalThis.fetch;
interface FetchCall {
  path: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  return responder(call);
};

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  await flush();
  document.body.innerHTML = "";
  calls = [];
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await flush();
  }
}

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const winEvents = () => window as unknown as { Event: EventCtor; MouseEvent: EventCtor };

const click = (el: Element) =>
  el.dispatchEvent(new (winEvents().MouseEvent)("click", { bubbles: true, cancelable: true }));

const setInput = (el: Element, value: string) => {
  const area = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value")!.set!;
  setter.call(area, value);
  area.dispatchEvent(new (winEvents().Event)("input", { bubbles: true }));
};

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label.replace(/"/g, '\\"')}"]`);

const bodyText = () => document.body.textContent ?? "";

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Redacted read payload mirrors the management proxy: field-name redaction and
// literal scrubs produce "[REDACTED]" placeholders in a JSON document.
const redactedConfig = {
  port: 8317,
  "api-keys": ["[REDACTED]"],
  "request-retry": 3,
};

/** Mount ConfigCard alone; the redacted config read succeeds. */
async function mountCard() {
  responder = async (call) => {
    if (
      call.path === "/api/v1/admin/cpa/management/config" &&
      (call.init?.method ?? "GET") === "GET"
    )
      return jsonRes(200, redactedConfig);
    return jsonRes(200, { ok: true });
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <ConfigCard />
    </QueryClientProvider>,
  );
  await waitFor(() => buttonByText("Save config") != null, "card rendered");
}

const editor = () => document.getElementById("cpa-config-yaml") as HTMLTextAreaElement | null;
const allEditors = () => document.querySelectorAll("#cpa-config-yaml");
const putCalls = () =>
  calls.filter((c) => c.init?.method === "PUT" && c.path === "/api/v1/admin/cpa/config");

const openConfirm = async (label: string) => {
  const trigger = buttonByLabel(label) ?? buttonByText(label);
  if (!trigger) throw new Error(`trigger not found: ${label}`);
  click(trigger);
  await waitFor(() => bodyText().includes("Confirm action"), "confirm dialog open");
};

// --- single write-only editor ------------------------------------------------

test("exactly one editable textarea, starts empty, never seeded from redacted config", async () => {
  await mountCard();
  expect(allEditors().length).toBe(1);
  expect(editor()!.tagName).toBe("TEXTAREA");
  expect(editor()!.value).toBe("");
  // Redacted content is never placed into the editable value.
  expect(editor()!.value).not.toContain("[REDACTED]");
  expect(bodyText()).not.toContain("[REDACTED]");
});

test("redacted current config is a collapsible read-only non-textarea preview", async () => {
  await mountCard();
  await waitFor(() => buttonByLabel("View current config") != null, "preview toggle rendered");
  // Collapsed by default; the redacted JSON is not rendered at all.
  expect(document.getElementById("cpa-config-current")).toBeNull();
  const toggle = buttonByLabel("View current config") ?? buttonByText("View current config");
  expect(toggle).not.toBeNull();
  click(toggle!);
  await flush();
  const preview = document.getElementById("cpa-config-current");
  expect(preview).not.toBeNull();
  expect(preview!.tagName).not.toBe("TEXTAREA");
  expect(preview!.textContent).toContain("[REDACTED]");
  expect(preview!.textContent).toContain("request-retry");
  expect(allEditors().length).toBe(1);
  // Toggle back hides it.
  const hideToggle = buttonByLabel("Hide current config") ?? buttonByText("Hide current config");
  click(hideToggle!);
  await flush();
  expect(document.getElementById("cpa-config-current")).toBeNull();
});

// --- fullscreen editor -------------------------------------------------------

test("fullscreen mode moves the single editor into a dialog; inline copy is gone", async () => {
  await mountCard();
  const fsButton = buttonByLabel("Fullscreen edit") ?? buttonByText("Fullscreen edit");
  expect(fsButton).not.toBeNull();
  click(fsButton!);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null, "fullscreen dialog open");
  expect(allEditors().length).toBe(1);
  const dialogEditor = document.querySelector<HTMLTextAreaElement>(
    '[role="dialog"] textarea#cpa-config-yaml',
  );
  expect(dialogEditor).not.toBeNull();
  // Draft typed before entering fullscreen survives the move.
  setInput(editor()!, "port: 8317\n");
  await flush();
  expect(editor()!.value).toBe("port: 8317\n");
});

test("save from fullscreen confirms, PUTs {config_yaml, confirm:true}, clears and closes", async () => {
  await mountCard();
  click(buttonByLabel("Fullscreen edit") ?? buttonByText("Fullscreen edit")!);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null, "fullscreen dialog open");
  setInput(editor()!, "port: 8317\nrequest-log: true\n");
  await openConfirm("Save config");
  click(buttonByText("Confirm")!);
  await waitFor(() => putCalls().length === 1, "put sent");
  expect(JSON.parse(String(putCalls()[0]!.init?.body))).toEqual({
    config_yaml: "port: 8317\nrequest-log: true\n",
    confirm: true,
  });
  // Success clears the draft and leaves the fullscreen dialog closed.
  await waitFor(() => editor()!.value === "", "editor cleared after save");
  await waitFor(
    () => document.querySelector('[role="dialog"]') === null,
    "fullscreen dialog closed",
  );
});

test("cancel in confirm sends nothing and keeps the draft", async () => {
  await mountCard();
  setInput(editor()!, "port: 8317\n");
  await openConfirm("Save config");
  click(buttonByText("Cancel")!);
  await flush();
  expect(putCalls()).toHaveLength(0);
  expect(editor()!.value).toBe("port: 8317\n");
});

test("mutation error keeps the draft and the fullscreen dialog open", async () => {
  await mountCard();
  click(buttonByLabel("Fullscreen edit") ?? buttonByText("Fullscreen edit")!);
  await waitFor(() => document.querySelector('[role="dialog"]') !== null, "fullscreen dialog open");
  setInput(editor()!, "port: 8317\n");
  responder = async (call) => {
    if (call.init?.method === "PUT")
      return jsonRes(502, {
        error: { code: "CPA_UNREACHABLE", message: "CPA did not respond" },
      });
    if (call.path === "/api/v1/admin/cpa/management/config") return jsonRes(200, redactedConfig);
    return jsonRes(200, { ok: true });
  };
  await openConfirm("Save config");
  click(buttonByText("Confirm")!);
  await waitFor(() => putCalls().length === 1, "put attempted");
  // Confirm dialog closes, error toast surfaces, draft intact, editor still open.
  await waitFor(() => !bodyText().includes("Confirm action"), "confirm dialog closed");
  await waitFor(() => document.querySelector('[role="dialog"]') !== null, "editor still open");
  expect(editor()!.value).toBe("port: 8317\n");
});
