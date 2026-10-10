// Remaining-pages i18n contract (jsdom, real React, mocked network only):
// the billing bundles page, the admin CPA page and the admin system card
// render their visible copy (headers, descriptions, tabs, labels, empty
// states, error fallbacks, dialog copy, validation toasts) in the active
// locale — EN by default and VI after the persisted locale store flips.
// Raw model IDs, provider names, config keys, currency codes and DB values
// are never translated, and known purchase API codes map to friendly
// localized copy instead of hiding the failure.
import { test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
import { JSDOM } from "jsdom";
import { registerFaithfulApiMock } from "./helpers/faithful-api-mock";

// Shared faithful lib/api mock registered BEFORE any page module import (see
// tests/helpers/faithful-api-mock.ts): stable ApiError identity and an api()
// that reads globalThis.fetch live.
registerFaithfulApiMock();
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws-test",
  useWorkspaces: () => ({ data: [], isSuccess: false }),
}));

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "DocumentFragment",
  "SVGElement",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let SystemCard: React.ComponentType;
let AdminCpaPage: React.ComponentType;
let BillingBundlesPage: React.ComponentType;
let mountRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let Toaster: React.ComponentType;
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let realFetch: typeof fetch | undefined;

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (e: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as number),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    FocusEvent: win.FocusEvent,
    PointerEvent: win.PointerEvent,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLButtonElement: win.HTMLButtonElement,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  // jsdom has no ResizeObserver; some Radix internals observe elements.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  jsdomWindow = win as unknown as { close: () => void };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  realFetch = realFetch ?? globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  const webDir = new URL("../apps/web/src/pages/billing/", import.meta.url).pathname;
  const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  };
  mountRoot = createRoot;
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  ({ SystemCard } = await import("../apps/web/src/pages/admin/system"));
  ({ default: AdminCpaPage } = await import("../apps/web/src/pages/admin/cpa"));
  ({ default: BillingBundlesPage } = await import("../apps/web/src/pages/billing/bundles"));
  // sonner has no declaration visible from the tests tsconfig; resolve the
  // real module from the web workspace instead of a dependency here.
  const sonner = (await import(Bun.resolveSync("sonner", webDir))) as unknown as {
    Toaster: React.ComponentType;
  };
  Toaster = sonner.Toaster;
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  if (realFetch) globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete (globalThis as Record<string, unknown>).ResizeObserver;
  if (jsdomWindow) jsdomWindow.close();
  jsdomWindow = null;
});

// --- network harness --------------------------------------------------------

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Responder = (path: string) => Response;
let responder: Responder = () => jsonRes(200, {});
// Optional gate for POSTs: lets a test hold a purchase in flight across a
// selection change and release it deterministically afterwards.
let gatePost: ((call: { path: string; init?: RequestInit }) => Promise<Response>) | null = null;

const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call = { path: String(input), init };
  if ((init?.method ?? "GET") === "POST" && gatePost) return gatePost(call);
  return Promise.resolve(responder(call.path));
};

const HEALTH = {
  status: "ok",
  proxy_endpoint: { healthy: true, http_status: 200 },
  management_api: { healthy: true, http_status: 200 },
  latency_ms: 12,
  cpa_host: "cpa.internal:8317",
  checked_at: "2026-01-01T00:00:00Z",
};

const serveSystem = () => {
  responder = (_p) =>
    jsonRes(200, {
      gateway_enabled: true,
      usd_vnd_rate: 26_000,
      payos_configured: false,
      manual_payments: true,
      db: { wal: "wal" },
      counts: { users: 3, workspaces: 1, models: 5, requests: 42 },
    });
};

// --- shared mount helpers ---------------------------------------------------

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `waitFor timeout: ${label} | body=${(document.body.textContent ?? "").slice(0, 600)}`,
      );
    await flush();
  }
}

const bodyText = () => document.body.textContent ?? "";

let roots: { unmount: () => void }[] = [];

function mount(node: React.ReactNode, withRouter = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = mountRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      withRouter ? (
        <routerContext.Provider
          value={createRouter({
            routeTree: createRootRoute({ component: () => null }),
            history: createMemoryHistory({ initialEntries: ["/billing/bundles"] }),
          })}
        >
          <QueryClientProvider client={qc}>
            {node}
            <Toaster />
          </QueryClientProvider>
        </routerContext.Provider>
      ) : (
        <QueryClientProvider client={qc}>
          {node}
          <Toaster />
        </QueryClientProvider>
      ),
    );
  });
  return container;
}

// Deferred cleanup: every root unmounts inside act() in afterEach so late
// query/mutation settles cannot update an unmounted tree.
afterEach(async () => {
  gatePost = null;
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  await flush();
  document.body.innerHTML = "";
});

async function click(el: Element) {
  await act(async () => {
    // Radix TabsTrigger activates on mousedown; plain Buttons on click.
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  });
}

// Native value set + input event via the jsdom-realm prototypes, so React's
// controlled onChange fires exactly like a user edit.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === text,
    ) ?? null
  );
}

// --- system page ------------------------------------------------------------

test("system page flips EN → VI and keeps DB values verbatim", async () => {
  useLocaleStore.getState().setLocale("en");
  serveSystem();
  mount(<SystemCard />);
  await waitFor(() => bodyText().includes("USD/VND rate"), "system rendered");
  expect(bodyText()).toContain("Instance health and status.");
  expect(bodyText()).toContain("Gateway");
  expect(bodyText()).toContain("Manual payments");
  expect(bodyText()).toContain("users 3 · workspaces 1 · models 5 · requests 42");
  // DB values and currency codes stay verbatim.
  expect(bodyText()).toContain("wal");
  expect(bodyText()).toContain("26.000");

  act(() => useLocaleStore.getState().setLocale("vi"));
  expect(bodyText()).toContain("Tỷ giá USD/VND");
  expect(bodyText()).toContain("Thanh toán thủ công");
  expect(bodyText()).toContain("Tình trạng và trạng thái instance.");
  expect(bodyText()).toContain("người dùng 3 · workspace 1 · mô hình 5 · yêu cầu 42");
  expect(bodyText()).not.toContain("USD/VND rate");
  expect(bodyText()).not.toContain("users 3");
  // DB journal value is never translated.
  expect(bodyText()).toContain("wal");
});

// --- cpa page ---------------------------------------------------------------

test("cpa page flips EN → VI across tabs and localizes the alias validation error", async () => {
  useLocaleStore.getState().setLocale("en");
  responder = (p) => {
    if (p.includes("/admin/cpa/health")) return jsonRes(200, HEALTH);
    if (p.includes("/admin/cpa/models"))
      return jsonRes(200, {
        data: [{ id: "xiaomi/mimo-v2.5", owned_by: "xiaomi", mapped: false }],
      });
    return jsonRes(200, {});
  };
  const container = mount(<AdminCpaPage />);
  await waitFor(() => bodyText().includes("CPA health"), "cpa health rendered");
  expect(bodyText()).toContain(
    "CLIProxyAPI health, config, routing, keys, credentials and model mappings.",
  );
  expect(bodyText()).toContain("Management API");
  expect(bodyText()).toContain("Healthy (200)");

  act(() => useLocaleStore.getState().setLocale("vi"));
  expect(bodyText()).toContain("Sức khỏe CPA");
  expect(bodyText()).toContain("Hoạt động (200)");
  expect(bodyText()).not.toContain("Healthy (200)");

  // Routing tab in VI.
  const routingTab = buttonByText(container, "Định tuyến");
  expect(routingTab).not.toBeNull();
  await click(routingTab!);
  expect(bodyText()).toContain("Chiến lược định tuyến credential");
  expect(bodyText()).toContain("Cờ cấu hình boolean");
  expect(bodyText()).not.toContain("Credential routing strategy");

  // Models tab in VI: table headers localized, model IDs verbatim, and the
  // known alias validation errors toast in VI.
  const modelsTab = buttonByText(container, "Mô hình");
  await click(modelsTab!);
  await waitFor(() => bodyText().includes("Kênh alias"), "models tab rendered");
  // Wait for the upstream model list to land before asserting verbatim IDs.
  await waitFor(() => bodyText().includes("xiaomi/mimo-v2.5"), "cpa models loaded");
  expect(bodyText()).toContain("xiaomi/mimo-v2.5");
  expect(bodyText()).toContain("chưa ánh xạ");
  expect(bodyText()).not.toContain("unmapped");

  // Empty channel: known validation toast localized.
  await click(buttonByText(container, "Lưu alias")!);
  await waitFor(() => bodyText().includes("Nhập kênh trước"), "empty-channel toast");
  expect(bodyText()).not.toContain("Enter the channel first");

  // Invalid JSON: known validation toast localized.
  const aliasJson = document.getElementById("cpa-alias-json") as HTMLTextAreaElement | null;
  const channelInput = document.getElementById("cpa-alias-channel") as HTMLInputElement | null;
  expect(aliasJson).not.toBeNull();
  expect(channelInput).not.toBeNull();
  act(() => {
    setNativeValue(channelInput!, "gemini");
    setNativeValue(aliasJson!, "not json");
  });
  await click(buttonByText(container, "Lưu alias")!);
  await waitFor(() => bodyText().includes("JSON không hợp lệ"), "invalid-json toast");

  // Valid JSON opens the localized confirm dialog.
  act(() => {
    setNativeValue(aliasJson!, '[{"name":"gemini-2.5-pro","alias":"pro"}]');
  });
  await click(buttonByText(container, "Lưu alias")!);
  await waitFor(() => bodyText().includes("Xác nhận thao tác"), "confirm dialog");
  expect(bodyText()).toContain("Thay thế toàn bộ alias của kênh");
  expect(bodyText()).toContain("không thể hoàn tác trên trang này");
  expect(bodyText()).not.toContain("Confirm action");
});

// --- billing bundles page ---------------------------------------------------

const BUNDLE = { id: "b1", name: "Starter", price_vnd: 50_000, credit_vnd: 50_000, bonus_vnd: 0 };
const PRODUCT = {
  id: "tp1",
  name: "Turbo 30",
  price_vnd: 150_000,
  requests_per_minute: 30,
  duration_days: 7,
};

test("billing bundles page flips EN → VI including the checkout dialog copy", async () => {
  useLocaleStore.getState().setLocale("en");
  responder = (p) => {
    if (p.endsWith("/bundles")) return jsonRes(200, { data: [BUNDLE] });
    if (p.endsWith("/subscription-plans")) return jsonRes(200, { data: [] });
    if (p.endsWith("/throughput-products")) return jsonRes(200, { data: [PRODUCT] });
    if (p.endsWith("/payment-methods")) return jsonRes(200, { manual: true, payos: true });
    return jsonRes(200, {});
  };
  const container = mount(<BillingBundlesPage />, true);
  await waitFor(() => bodyText().includes("Credit bundles"), "bundles rendered");
  // Wait for the catalog query to land before asserting the cards.
  await waitFor(() => bodyText().includes("Starter"), "bundle cards loaded");
  expect(bodyText()).toContain("Buy credit in fixed bundles");

  // Plans tab EN: localized empty state (Radix unmounts inactive panels).
  await click(buttonByText(container, "Subscription plans")!);
  await waitFor(() => bodyText().includes("No plans available"), "plans empty state");
  expect(bodyText()).toContain("No subscription plans are on sale right now");
  await click(buttonByText(container, "Credit bundles")!);

  // Throughput tab EN: admission cap wording and disclaimer.
  await click(buttonByText(container, "Prepaid throughput")!);
  await waitFor(() => bodyText().includes("Turbo 30"), "throughput cards loaded");
  expect(bodyText()).toContain("30 requests/minute");
  expect(bodyText()).toContain("Active for 7 days");
  expect(bodyText()).toContain("gateway admission limit");

  act(() => useLocaleStore.getState().setLocale("vi"));
  expect(bodyText()).toContain("Khoản thông lượng trả trước");
  expect(bodyText()).toContain("Hoạt động trong 7 ngày");
  expect(bodyText()).toContain("giới hạn tiếp nhận của gateway");
  expect(bodyText()).not.toContain("Active for 7 days");

  // Select opens the localized checkout dialog (no purchase fired).
  await click(buttonByText(container, "Chọn")!);
  await waitFor(() => bodyText().includes("Phương thức thanh toán"), "checkout dialog ready");
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog!.textContent).toContain("Thanh toán");
  expect(dialog!.textContent).toContain("Giá");
  expect(dialog!.textContent).toContain("150.000 ₫");
  expect(dialog!.textContent).toContain("Phương thức thanh toán");
  expect(dialog!.textContent).toContain("Chuyển khoản thủ công");
  expect(dialog!.textContent).toContain("Xác nhận mua");
  expect(dialog!.textContent).not.toContain("Checkout");
  expect(dialog!.textContent).not.toContain("Select");
});

test("unknown network errors fall back to friendly localized copy", async () => {
  useLocaleStore.getState().setLocale("vi");
  responder = () => {
    throw new TypeError("Failed to fetch");
  };
  mount(<BillingBundlesPage />, true);
  await waitFor(() => bodyText().includes("Không tải được mục này"), "vi load fallback");
  expect(bodyText()).not.toContain("Failed to fetch");
});

test("stale checkout error after a selection change surfaces no toast", async () => {
  useLocaleStore.getState().setLocale("en");
  responder = (p) => {
    if (p.endsWith("/bundles")) return jsonRes(200, { data: [BUNDLE] });
    if (p.endsWith("/subscription-plans")) return jsonRes(200, { data: [] });
    if (p.endsWith("/throughput-products")) return jsonRes(200, { data: [PRODUCT] });
    if (p.endsWith("/payment-methods")) return jsonRes(200, { manual: true, payos: true });
    return jsonRes(200, {});
  };
  const container = mount(<BillingBundlesPage />, true);
  await waitFor(() => bodyText().includes("Starter"), "bundles rendered");

  // Select a bundle and confirm the purchase; the POST is held in flight.
  await click(buttonByText(container, "Select")!);
  await waitFor(() => bodyText().includes("Payment method"), "checkout ready");
  let releasePost: ((r: Response) => void) | null = null;
  gatePost = () =>
    new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
  // Dialog content portals to document.body, outside the page container.
  await click(buttonByText(document.documentElement, "Confirm purchase")!);

  // Switching tabs supersedes the selection generation and closes the dialog.
  await click(buttonByText(container, "Subscription plans")!);
  await waitFor(() => !document.querySelector('[role="dialog"]'), "dialog closed");

  // The late 500 lands after the generation change: no error toast, no crash.
  await act(async () => {
    releasePost!(jsonRes(500, { error: { code: "INACTIVE", message: "Bundle is not available" } }));
    await flush();
  });
  expect(bodyText()).not.toContain("Purchase failed");
  expect(bodyText()).not.toContain("Bundle is not available");
});

test("server ApiError details still surface instead of being hidden", async () => {
  useLocaleStore.getState().setLocale("en");
  responder = (p) => {
    if (p.endsWith("/bundles"))
      return jsonRes(500, { error: { code: "UNKNOWN", message: "catalog exploded" } });
    return jsonRes(200, { data: [] });
  };
  mount(<BillingBundlesPage />, true);
  await waitFor(() => bodyText().includes("catalog exploded"), "server detail surfaced");
});
