// Admin catalog i18n contract (jsdom, real React, mocked fetch only):
// the admin models and admin bundles pages render their visible copy
// (headings, actions, form labels, help, validation errors) in the active
// locale, EN by default and VI after the persisted locale store flips.
// Model IDs, provider names, currency codes and numbers are never translated.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "DocumentFragment",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
// Realm + page modules are installed in beforeAll (like page-body-i18n) so the
// globals of earlier files in the same worker are captured/restored around
// this file only, and Radix never imports without a document.
let W: {
  Event: new (type: string, init?: EventInit) => Event;
  MouseEvent: new (type: string, init?: MouseEventInit) => MouseEvent;
  document: Document;
  Node: typeof Node;
  NodeFilter: typeof NodeFilter;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLFormElement: typeof HTMLFormElement;
  DocumentFragment: typeof DocumentFragment;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
  CustomEvent: new (type: string, init?: CustomEventInit) => CustomEvent;
  localStorage: Storage;
  close: () => void;
};
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let AdminModelsPage: React.ComponentType;
let AdminBundlesPage: React.ComponentType;
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let realFetch: typeof fetch | undefined;

beforeAll(async () => {
  // Drain macrotasks from earlier jsdom files in this worker (their RAF shims
  // use setTimeout) so stragglers cannot fire inside this file's first act().
  await new Promise((r) => setTimeout(r, 60));
  W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as typeof W;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const [k, v] of Object.entries({
    window: W,
    document: W.document,
    Node: W.Node,
    NodeFilter: W.NodeFilter,
    Element: W.Element,
    HTMLElement: W.HTMLElement,
    HTMLInputElement: W.HTMLInputElement,
    HTMLFormElement: W.HTMLFormElement,
    DocumentFragment: W.DocumentFragment,
    getComputedStyle: W.getComputedStyle.bind(W),
    MutationObserver: W.MutationObserver,
    CustomEvent: W.CustomEvent,
    localStorage: W.localStorage,
  })) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  // Radix use-size observes rendered elements; jsdom has no ResizeObserver.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow = W;

  // @ts-expect-error relative specifier has no declaration file under tests tsconfig
  createRoot = (await import("../apps/web/node_modules/react-dom/client")).createRoot;
  AdminModelsPage = (await import("../apps/web/src/pages/admin/models")).default;
  AdminBundlesPage = (await import("../apps/web/src/pages/admin/bundles")).default;
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
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

// --- fixtures -------------------------------------------------------------

const MODEL = {
  id: "m1",
  public_id: "fake/test-model",
  slug: "test-model",
  display_name: "Fake Test",
  provider: "fake",
  description: null,
  capabilities: '["chat"]',
  context_window: 4096,
  enabled: true,
  published: true,
  auto_eligible: false,
  prompt_caching: "inherit",
  has_price: true,
  has_mapping: false,
  created_at: 1,
  updated_at: 1,
  listed: true,
  hidden_reason: null,
  current_price: {
    input_usd_micro_per_1m: 1500,
    output_usd_micro_per_1m: 6000,
    cached_input_usd_micro_per_1m: 0,
    reasoning_usd_micro_per_1m: 0,
    markup_ppm: 250000,
    effective_at: 1,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function serve(handler: (url: string) => Response) {
  realFetch = realFetch ?? globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => handler(String(url))) as typeof fetch;
}

function mountPage(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  const settle = async () => {
    await act(async () => {
      // A single microtask tick is not always enough for the query to land;
      // poll a few macrotask rounds so the ready state is deterministic.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    });
  };
  const bodyText = () => document.body.textContent ?? "";
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { container, settle, bodyText, unmount };
}

function clickButtonWithText(container: HTMLElement, label: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const button = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!button) throw new Error(`button "${label}" not found`);
  act(() => {
    button.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new W.Event("input", { bubbles: true }));
}

// --- models page ----------------------------------------------------------

test("capability input offers known suggestions (datalist) and stays freeform", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((url) => {
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, [MODEL]);
    if (url.includes("/admin/cpa/models")) return jsonResponse(200, { data: [{ id: "cpa-a" }] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminModelsPage />);
  await page.settle();
  try {
    clickButtonWithText(page.container, "Create model");
    await page.settle();
    const input = document.getElementById("capabilities") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const listId = input!.getAttribute("list");
    expect(listId).toBeTruthy();
    // Suggestions cover exactly the canonical known keys; free text stays valid.
    const options = [...document.querySelectorAll(`datalist[id="${listId}"] option`)].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["chat", "vision", "tools", "reasoning"]);
    setInputValue(input!, "chat, image-gen");
    expect(input!.value).toBe("chat, image-gen");
    // No backend restriction: the form schema keeps capabilities optional.
    expect(page.bodyText()).not.toContain("Must be one of");
  } finally {
    page.unmount();
  }
});

test("edit sheet capability input offers the same known suggestions", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((url) => {
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, [MODEL]);
    if (url.includes("/admin/cpa/models")) return jsonResponse(200, { data: [{ id: "cpa-a" }] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminModelsPage />);
  await page.settle();
  try {
    clickButtonWithText(page.container, "Open");
    await page.settle();
    const input = document.getElementById("capabilities") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const listId = input!.getAttribute("list");
    expect(listId).toBeTruthy();
    const options = [...document.querySelectorAll(`datalist[id="${listId}"] option`)].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["chat", "vision", "tools", "reasoning"]);
    // Existing stored value loads verbatim (not rewritten to labels).
    expect(input!.value).toBe("chat");
  } finally {
    page.unmount();
  }
});

test("admin models page flips EN → VI and keeps model IDs untranslated", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((url) => {
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, [MODEL]);
    if (url.includes("/admin/cpa/models")) return jsonResponse(200, { data: [{ id: "cpa-a" }] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminModelsPage />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Catalog models for this instance.");
    expect(page.bodyText()).toContain("Create model");
    expect(page.bodyText()).toContain("Routes to");
    expect(page.bodyText()).toContain("Price (in / out per 1M)");
    expect(page.bodyText()).toContain("Listed");
    expect(page.bodyText()).toContain("Open");

    act(() => useLocaleStore.getState().setLocale("vi"));
    expect(page.bodyText()).toContain("Các mô hình catalog của instance này.");
    expect(page.bodyText()).toContain("Tạo mô hình");
    expect(page.bodyText()).toContain("Định tuyến tới");
    expect(page.bodyText()).toContain("Giá (vào / ra mỗi 1M)");
    expect(page.bodyText()).toContain("Đã niêm yết");
    expect(page.bodyText()).toContain("Mở");
    expect(page.bodyText()).not.toContain("Create model");
    // Model IDs and provider names stay as-is.
    expect(page.bodyText()).toContain("fake/test-model");
    expect(page.bodyText()).toContain("Fake Test");
  } finally {
    page.unmount();
  }
});

test("create-model dialog opens with translated labels in VI", async () => {
  useLocaleStore.getState().setLocale("vi");
  serve((url) => {
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, [MODEL]);
    if (url.includes("/admin/cpa/models")) return jsonResponse(200, { data: [{ id: "cpa-a" }] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminModelsPage />);
  await page.settle();
  try {
    clickButtonWithText(page.container, "Tạo mô hình");
    await page.settle();
    expect(page.bodyText()).toContain("Tên hiển thị");
    expect(page.bodyText()).toContain("Xuất bản");
    expect(page.bodyText()).toContain("Tạo");
    // The example model ID placeholder stays untranslated.
    expect(page.bodyText()).not.toContain("Display name");
  } finally {
    page.unmount();
  }
});

// --- bundles page ---------------------------------------------------------

test("admin bundles page flips EN → VI including amount validation errors", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((url) => {
    if (url.includes("/admin/bundles")) return jsonResponse(200, { data: [] });
    if (url.includes("/admin/subscription-plans")) return jsonResponse(200, { data: [] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminBundlesPage />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Bundles & plans");
    expect(page.bodyText()).toContain("Credit bundles");
    expect(page.bodyText()).toContain("Subscription plans");
    expect(page.bodyText()).toContain("Create bundle");

    const priceUsd = document.getElementById("bundle-price-usd") as HTMLInputElement | null;
    expect(priceUsd).not.toBeNull();
    act(() => {
      setInputValue(priceUsd!, "abc");
    });
    expect(page.bodyText()).toContain("Enter a USD amount like 9.99");

    act(() => useLocaleStore.getState().setLocale("vi"));
    expect(page.bodyText()).toContain("Gói credit");
    expect(page.bodyText()).toContain("Gói đăng ký");
    expect(page.bodyText()).toContain("Tạo gói");
    expect(page.bodyText()).toContain("Nhập số USD dạng 9.99");
    expect(page.bodyText()).not.toContain("Enter a USD amount like 9.99");
    expect(page.bodyText()).not.toContain("Create bundle");
  } finally {
    page.unmount();
  }
});

test("plans scroll region label and credit/period column header flip EN → VI", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((url) => {
    if (url.includes("/admin/bundles")) return jsonResponse(200, { data: [] });
    if (url.includes("/admin/subscription-plans")) return jsonResponse(200, { data: [] });
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminBundlesPage />);
  await page.settle();
  try {
    // ScrollPanel renders an accessible labelled region per catalog table.
    const plansRegion = page.container.querySelector('[aria-label="Subscription plans"]');
    expect(plansRegion).not.toBeNull();
    expect(page.bodyText()).toContain("Credit/period");
    expect(page.bodyText()).toContain("No credit/period yet");

    act(() => useLocaleStore.getState().setLocale("vi"));
    expect(page.container.querySelector('[aria-label="Gói đăng ký"]')).not.toBeNull();
    expect(page.container.querySelector('[aria-label="Subscription plans"]')).toBeNull();
    expect(page.bodyText()).toContain("Tín dụng/kỳ");
    expect(page.bodyText()).toContain("Chưa có tín dụng/kỳ nào");
    expect(page.bodyText()).not.toContain("Credit/period");
  } finally {
    page.unmount();
  }
});
