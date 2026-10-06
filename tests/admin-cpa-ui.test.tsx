// Admin CPA UI contract (pure form state + interaction over a mocked fetch):
// - Endpoint contracts mirror apps/api/src/routes/admin-cpa-mutations.ts exactly:
//   PUT /api/v1/admin/cpa/config {config_yaml, confirm:true},
//   PATCH /api/v1/admin/cpa/config/flags {flag, value},
//   PUT/DELETE /api/v1/admin/cpa/config/proxy-url {confirm:true},
//   PUT /api/v1/admin/cpa/config/retry (omitted fields absent),
//   PATCH /api/v1/admin/cpa/api-keys ({old,new} add/rotate; {index,value}),
//   DELETE /api/v1/admin/cpa/api-keys {key, confirm:true},
//   PATCH /api/v1/admin/cpa/auth-files/status | /fields,
//   DELETE /api/v1/admin/cpa/auth-files {names, confirm:true},
//   POST /api/v1/admin/cpa/auth-files/refresh,
//   PUT /api/v1/admin/cpa/routing/strategy {strategy},
//   PUT /api/v1/admin/cpa/model-alias {channel, aliases},
//   PUT /api/v1/admin/cpa/model-exclusions {channel, models}.
// - Reads are only the ones that exist: GET /api/v1/admin/cpa/health and
//   GET /api/v1/admin/cpa/management/config (redacted proxy). No invented lists
//   for api keys / auth files / aliases — those sections are write-only forms.
// - Every mutation is gated by an explicit confirm dialog; cancel sends nothing.
// - Secret inputs are write-only (type=password): values render but never echo.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
    // Radix Tabs calls requestAnimationFrame in a mount effect; jsdom only
    // provides it with pretendToBeVisual.
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
  ({
    parseAliasesJson,
    parseExclusionModels,
    retryBody,
    apiKeyBody,
    CPA_BOOL_FLAGS,
    CPA_ROUTING_STRATEGIES,
  } = await import("../apps/web/src/pages/admin/cpa"));
  ({ createRoot } = await import("react-dom/client"));
  ({ default: AdminCpaPage } = await import("../apps/web/src/pages/admin/cpa"));
  ({ CpaHealthCard, ApiKeysCard } = await import("../apps/web/src/pages/admin/cpa"));

  // Network boundary: the page's real api() talks to this mock fetch.
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

let parseAliasesJson: (typeof import("../apps/web/src/pages/admin/cpa"))["parseAliasesJson"];
let parseExclusionModels: (typeof import("../apps/web/src/pages/admin/cpa"))["parseExclusionModels"];
let retryBody: (typeof import("../apps/web/src/pages/admin/cpa"))["retryBody"];
let apiKeyBody: (typeof import("../apps/web/src/pages/admin/cpa"))["apiKeyBody"];
let CPA_BOOL_FLAGS: readonly string[];
let CPA_ROUTING_STRATEGIES: readonly string[];
let CpaHealthCard: (typeof import("../apps/web/src/pages/admin/cpa"))["CpaHealthCard"];
let ApiKeysCard: (typeof import("../apps/web/src/pages/admin/cpa"))["ApiKeysCard"];
let AdminCpaPage: (typeof import("../apps/web/src/pages/admin/cpa"))["default"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;

// --- interaction harness ---------------------------------------------------

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
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new (winEvents().Event)("input", { bubbles: true }));
};

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

const cpaTabs = () => Array.from(document.querySelectorAll('[role="tab"]'));

/** Radix Tabs activate on mousedown; click too so both activation paths fire. */
const openTab = async (name: string) => {
  const tab = cpaTabs().find((t) => t.textContent?.trim() === name);
  if (!tab) throw new Error(`tab not found: ${name}`);
  const MouseEvent = winEvents().MouseEvent;
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  click(tab);
  await flush();
};

const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label.replace(/"/g, '\\"')}"]`);

const bodyText = () => document.body.textContent ?? "";

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const healthPayload = {
  status: "ok",
  proxy_endpoint: { healthy: true, http_status: 200 },
  management_api: { healthy: true, http_status: 200 },
  latency_ms: 12,
  cpa_host: "127.0.0.1:8317",
  checked_at: new Date(2026, 0, 10, 12, 0, 0, 0).toISOString(),
};

/** Mount the real page; health + config reads succeed. */
async function mountPage() {
  responder = async (call) => {
    if (call.path === "/api/v1/admin/cpa/health" && (call.init?.method ?? "GET") === "GET")
      return jsonRes(200, healthPayload);
    if (
      call.path === "/api/v1/admin/cpa/management/config" &&
      (call.init?.method ?? "GET") === "GET"
    )
      return jsonRes(200, { "request-retry": 3, "routing-strategy": "round-robin" });
    if (call.path === "/api/v1/admin/cpa/models") return jsonRes(200, { data: [] });
    return jsonRes(200, { ok: true });
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <AdminCpaPage />
    </QueryClientProvider>,
  );
  await waitFor(
    () =>
      document.querySelector('[role="tablist"]') !== null && bodyText().includes("Healthy (200)"),
    "page rendered",
  );
  return qc;
}

const callsFor = (method: string, path: string) =>
  calls.filter((c) => c.init?.method === method && c.path === path);

/** Open a mutation's confirm dialog, then confirm it. Returns dialog text check. */
async function confirmAction(label: string) {
  const trigger = buttonByLabel(label) ?? buttonByText(label);
  if (!trigger) throw new Error(`trigger not found: ${label}`);
  click(trigger);
  await waitFor(() => bodyText().includes("Confirm action"), "confirm dialog open");
  click(buttonByText("Confirm")!);
  await flush();
}

// --- tabbed page structure -------------------------------------------------

test("cpa page renders a labelled tablist; only the active tab's content mounts", async () => {
  await mountPage();
  expect(document.querySelector('[role="tablist"]')).not.toBeNull();
  expect(cpaTabs().map((t) => t.textContent?.trim())).toEqual([
    "Health",
    "Config",
    "Routing",
    "Access keys",
    "Auth files",
    "Models",
  ]);
  // Default tab: Health selected; other panels are unmounted by Radix.
  expect(
    cpaTabs()
      .filter((t) => t.getAttribute("aria-selected") === "true")
      .map((t) => t.textContent?.trim()),
  ).toEqual(["Health"]);
  expect(document.getElementById("cpa-key-new")).toBeNull();
  expect(bodyText()).toContain("CPA health");
});

test("each tab panel is a bounded internal scroll container", async () => {
  await mountPage();
  const panels = document.querySelectorAll('[role="tabpanel"]');
  expect(panels.length).toBeGreaterThan(0);
  for (const panel of panels) {
    expect(panel.className).toContain("overflow-y-auto");
    expect(panel.className).toContain("max-h-");
  }
});

test("tab switching shows the right section and unmounts the others", async () => {
  await mountPage();
  await openTab("Access keys");
  expect(document.getElementById("cpa-key-new")).not.toBeNull();
  expect(bodyText()).not.toContain("CPA health");
  await openTab("Models");
  expect(document.getElementById("cpa-alias-channel")).not.toBeNull();
  expect(bodyText()).toContain("CPA models");
  expect(bodyText()).toContain("CPA upstream models");
  await openTab("Config");
  expect(document.getElementById("cpa-config-yaml")).not.toBeNull();
  expect(document.getElementById("cpa-key-new")).toBeNull();
});

// --- pure form state -------------------------------------------------------

test("bool flags and strategies match the backend union exactly", () => {
  expect(CPA_BOOL_FLAGS).toEqual([
    "debug",
    "usage-statistics-enabled",
    "request-log",
    "ws-auth",
    "logging-to-file",
    "force-model-prefix",
    "quota-exceeded/switch-project",
    "quota-exceeded/switch-preview-model",
  ]);
  expect(CPA_ROUTING_STRATEGIES).toEqual(["round-robin", "weighted-round-robin", "fill-first"]);
});

test("retryBody sends only filled integer fields (0..1000)", () => {
  expect(retryBody({ request_retry: "5" })).toEqual({ request_retry: 5 });
  expect(retryBody({})).toEqual({});
  expect(retryBody({ request_retry: "0", max_retry_interval: "10" })).toEqual({
    request_retry: 0,
    max_retry_interval: 10,
  });
  // Out-of-range / non-integers are rejected entirely (no partial body).
  expect(retryBody({ request_retry: "-1" })).toBeNull();
  expect(retryBody({ request_retry: "2.5" })).toBeNull();
  expect(retryBody({ request_retry: "1001" })).toBeNull();
  expect(retryBody({ request_retry: "abc" })).toBeNull();
  expect(retryBody({ max_retry_credentials: "" })).toEqual({});
});

test("apiKeyBody follows the backend PATCH api-keys semantics", () => {
  // Add = old == new == key (append when absent).
  expect(apiKeyBody({ mode: "add", key: "k1" })).toEqual({ old: "k1", new: "k1" });
  expect(apiKeyBody({ mode: "rotate", key: "k2", oldKey: "k1" })).toEqual({
    old: "k1",
    new: "k2",
  });
  expect(apiKeyBody({ mode: "set-index", key: "k3", index: "2" })).toEqual({
    index: 2,
    value: "k3",
  });
  // Invalid: empty key, empty old for rotate, non-integer index.
  expect(apiKeyBody({ mode: "add", key: " " })).toBeNull();
  expect(apiKeyBody({ mode: "rotate", key: "k2" })).toBeNull();
  expect(apiKeyBody({ mode: "set-index", key: "k3", index: "-1" })).toBeNull();
  expect(apiKeyBody({ mode: "set-index", key: "k3", index: "x" })).toBeNull();
});

test("parseAliasesJson validates the alias entry shape", () => {
  const ok = parseAliasesJson('[{"name":"gemini-2.5-pro","alias":"pro"}]');
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.aliases).toEqual([{ name: "gemini-2.5-pro", alias: "pro" }]);
  const full = parseAliasesJson(
    '[{"name":"m","alias":"a","fork":true,"display_name":"M","force_mapping":false}]',
  );
  expect(full.ok).toBe(true);
  // Empty array clears the channel's mappings — allowed.
  expect(parseAliasesJson("[]")).toEqual({ ok: true, aliases: [] });
  // Rejected shapes.
  expect(parseAliasesJson("not json").ok).toBe(false);
  expect(parseAliasesJson("[] {}").ok).toBe(false);
  expect(parseAliasesJson('[{"name":"m"}]').ok).toBe(false);
  expect(parseAliasesJson('[{"name":"m","alias":"a","bogus":1}]').ok).toBe(false);
  expect(parseAliasesJson('{"name":"m"}').ok).toBe(false);
  expect(parseAliasesJson('[{"name":"","alias":"a"}]').ok).toBe(false);
});

test("parseExclusionModels splits lines, trims, dedupes, caps at 500", () => {
  expect(parseExclusionModels("m1\n  m2 \n\nm1")).toEqual(["m1", "m2"]);
  expect(parseExclusionModels("   ")).toEqual([]);
  expect(
    parseExclusionModels("m1\nm2\n" + Array.from({ length: 600 }, (_, i) => `x${i}`).join("\n")),
  ).toBeNull();
});

// --- semantic SSR render ---------------------------------------------------

test("health card renders health facts, no secrets", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <CpaHealthCard />
    </QueryClientProvider>,
  );
  expect(html).toContain("CPA health");
  // SSR intentionally shows the loading state; live health facts render after
  // the admin query resolves in the browser.
  expect(html).toContain("Checking…");
  // Secret management key must never appear anywhere.
  expect(html).not.toContain("sk-");
});

test("secret inputs are password fields (write-only, never echoed)", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ApiKeysCard />
    </QueryClientProvider>,
  );
  for (const id of ["cpa-key-new", "cpa-key-old", "cpa-key-value", "cpa-key-delete"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const passwordCount = (html.match(/type="password"/g) ?? []).length;
  expect(passwordCount).toBeGreaterThanOrEqual(4);
});

// --- interaction: exact endpoint contracts ---------------------------------

test("config save PUTs {config_yaml, confirm:true} after explicit confirm", async () => {
  await mountPage();
  await openTab("Config");
  responder = async () => jsonRes(200, { ok: true });
  setInput(document.getElementById("cpa-config-yaml")!, "port: 8317\n");
  await confirmAction("Save config");
  const put = callsFor("PUT", "/api/v1/admin/cpa/config")[0]!;
  expect(put).toBeDefined();
  expect(JSON.parse(String(put.init?.body))).toEqual({
    config_yaml: "port: 8317\n",
    confirm: true,
  });
});

test("config save cancel sends nothing", async () => {
  await mountPage();
  await openTab("Config");
  setInput(document.getElementById("cpa-config-yaml")!, "port: 8317\n");
  click(buttonByText("Save config")!);
  await waitFor(() => bodyText().includes("Confirm action"), "confirm dialog open");
  click(buttonByText("Cancel")!);
  await flush();
  expect(callsFor("PUT", "/api/v1/admin/cpa/config")).toHaveLength(0);
});

test("flag toggle PATCHes {flag, value}", async () => {
  await mountPage();
  await openTab("Routing");
  await confirmAction("Set debug on");
  const patch = callsFor("PATCH", "/api/v1/admin/cpa/config/flags")[0]!;
  expect(patch).toBeDefined();
  expect(JSON.parse(String(patch.init?.body))).toEqual({ flag: "debug", value: true });
});

test("routing strategy PUTs {strategy}", async () => {
  await mountPage();
  await openTab("Routing");
  await confirmAction("Use fill-first");
  const put = callsFor("PUT", "/api/v1/admin/cpa/routing/strategy")[0]!;
  expect(put).toBeDefined();
  expect(JSON.parse(String(put.init?.body))).toEqual({ strategy: "fill-first" });
});

test("retry PUT sends only filled fields", async () => {
  await mountPage();
  await openTab("Routing");
  setInput(document.getElementById("cpa-retry-request")!, "4");
  setInput(document.getElementById("cpa-retry-interval")!, "30");
  await confirmAction("Apply retry tuning");
  const put = callsFor("PUT", "/api/v1/admin/cpa/config/retry")[0]!;
  expect(put).toBeDefined();
  expect(JSON.parse(String(put.init?.body))).toEqual({ request_retry: 4, max_retry_interval: 30 });
});

test("proxy URL set and clear hit the exact dangerous contracts", async () => {
  await mountPage();
  await openTab("Routing");
  setInput(document.getElementById("cpa-proxy-url")!, "http://proxy.internal:8080");
  await confirmAction("Set proxy URL");
  const put = callsFor("PUT", "/api/v1/admin/cpa/config/proxy-url")[0]!;
  expect(put).toBeDefined();
  expect(JSON.parse(String(put.init?.body))).toEqual({
    value: "http://proxy.internal:8080",
    confirm: true,
  });
  await confirmAction("Clear proxy URL");
  const del = callsFor("DELETE", "/api/v1/admin/cpa/config/proxy-url")[0]!;
  expect(del).toBeDefined();
  expect(JSON.parse(String(del.init?.body))).toEqual({ confirm: true });
});

test("api key add PATCHes {old,new} with the same secret value", async () => {
  await mountPage();
  await openTab("Access keys");
  setInput(document.getElementById("cpa-key-new")!, "new-secret");
  await confirmAction("Add key");
  const patch = callsFor("PATCH", "/api/v1/admin/cpa/api-keys")[0]!;
  expect(patch).toBeDefined();
  expect(JSON.parse(String(patch.init?.body))).toEqual({ old: "new-secret", new: "new-secret" });
});

test("api key delete DELETEs {key, confirm:true}", async () => {
  await mountPage();
  await openTab("Access keys");
  setInput(document.getElementById("cpa-key-delete")!, "old-secret");
  await confirmAction("Delete key");
  const del = callsFor("DELETE", "/api/v1/admin/cpa/api-keys")[0]!;
  expect(del).toBeDefined();
  expect(JSON.parse(String(del.init?.body))).toEqual({ key: "old-secret", confirm: true });
});

test("auth file disable PATCHes status; delete DELETEs {names, confirm:true}; refresh POSTs", async () => {
  await mountPage();
  await openTab("Auth files");
  setInput(document.getElementById("cpa-auth-name")!, "cred.json");
  await confirmAction("Disable auth file");
  const patch = callsFor("PATCH", "/api/v1/admin/cpa/auth-files/status")[0]!;
  expect(patch).toBeDefined();
  expect(JSON.parse(String(patch.init?.body))).toEqual({ name: "cred.json", disabled: true });

  setInput(document.getElementById("cpa-auth-delete")!, "a.json\nb.json");
  await confirmAction("Delete auth files");
  const del = callsFor("DELETE", "/api/v1/admin/cpa/auth-files")[0]!;
  expect(del).toBeDefined();
  expect(JSON.parse(String(del.init?.body))).toEqual({
    names: ["a.json", "b.json"],
    confirm: true,
  });

  await confirmAction("Refresh auth files");
  expect(callsFor("POST", "/api/v1/admin/cpa/auth-files/refresh")).toHaveLength(1);
});

test("model alias PUT sends {channel, aliases}; exclusions PUT sends {channel, models}", async () => {
  await mountPage();
  await openTab("Models");
  setInput(document.getElementById("cpa-alias-channel")!, "gemini");
  setInput(document.getElementById("cpa-alias-json")!, '[{"name":"gemini-2.5-pro","alias":"pro"}]');
  await confirmAction("Save aliases");
  const put = callsFor("PUT", "/api/v1/admin/cpa/model-alias")[0]!;
  expect(put).toBeDefined();
  expect(JSON.parse(String(put.init?.body))).toEqual({
    channel: "gemini",
    aliases: [{ name: "gemini-2.5-pro", alias: "pro" }],
  });

  setInput(document.getElementById("cpa-excl-channel")!, "codex");
  setInput(document.getElementById("cpa-excl-models")!, "m1\nm2");
  await confirmAction("Save exclusions");
  const put2 = callsFor("PUT", "/api/v1/admin/cpa/model-exclusions")[0]!;
  expect(put2).toBeDefined();
  expect(JSON.parse(String(put2.init?.body))).toEqual({ channel: "codex", models: ["m1", "m2"] });
});

test("mutation failure closes the confirm dialog and re-enables the trigger", async () => {
  await mountPage();
  await openTab("Routing");
  responder = async (call) => {
    if (call.init?.method === "PATCH")
      return jsonRes(502, {
        error: { code: "CPA_UNREACHABLE", message: "CPA at 127.0.0.1:8317 did not respond" },
      });
    if (call.path === "/api/v1/admin/cpa/health") return jsonRes(200, healthPayload);
    return jsonRes(200, {});
  };
  const trigger = buttonByLabel("Set debug on")!;
  click(trigger);
  await waitFor(() => bodyText().includes("Confirm action"), "confirm dialog open");
  click(buttonByText("Confirm")!);
  await waitFor(
    () => callsFor("PATCH", "/api/v1/admin/cpa/config/flags").length === 1,
    "patch sent",
  );
  // Server error surfaced (toast) — dialog must be closed and trigger usable again.
  await waitFor(() => !bodyText().includes("Confirm action"), "confirm dialog closed");
  click(trigger);
  await waitFor(() => bodyText().includes("Confirm action"), "dialog reopens after failure");
  click(buttonByText("Cancel")!);
  await flush();
  expect(callsFor("PATCH", "/api/v1/admin/cpa/config/flags")).toHaveLength(1);
});
