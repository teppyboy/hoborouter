// Admin support-settings custom links UI contract (jsdom, real React hooks,
// mocked fetch only): the "Support & contact" card gains an admin-curated
// custom-links editor backed by the structured `support_custom` PUT key
// (null clears, up to 10 { label, url } entries). The server is the validation
// authority: client checks only mirror it for feedback, a 400 is displayed
// inline with no false success and no local-state reset.
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
  "HTMLButtonElement",
  "DocumentFragment",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
let W: {
  document: Document;
  Node: typeof Node;
  NodeFilter: typeof NodeFilter;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLFormElement: typeof HTMLFormElement;
  HTMLButtonElement: typeof HTMLButtonElement;
  DocumentFragment: typeof DocumentFragment;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
  CustomEvent: new (type: string, init?: CustomEventInit) => CustomEvent;
  Event: new (type: string, init?: EventInit) => Event;
  MouseEvent: new (type: string, init?: MouseEventInit) => MouseEvent;
  localStorage: Storage;
  close: () => void;
};
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let SupportSettingsCard: (typeof import("../apps/web/src/pages/admin/settings"))["SupportSettingsCard"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let realFetch: typeof fetch | undefined;

beforeAll(async () => {
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
    HTMLButtonElement: W.HTMLButtonElement,
    DocumentFragment: W.DocumentFragment,
    getComputedStyle: W.getComputedStyle.bind(W),
    MutationObserver: W.MutationObserver,
    CustomEvent: W.CustomEvent,
    Event: W.Event,
    MouseEvent: W.MouseEvent,
    localStorage: W.localStorage,
  })) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow = W;

  // @ts-expect-error relative specifier has no declaration file under tests tsconfig
  createRoot = (await import("../apps/web/node_modules/react-dom/client")).createRoot;
  const mod = await import("../apps/web/src/pages/admin/settings");
  SupportSettingsCard = mod.SupportSettingsCard;
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
});

afterAll(async () => {
  useLocaleStore.getState().setLocale("en");
  if (realFetch) globalThis.fetch = realFetch;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise<void>((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        r();
      };
      ch.port2.postMessage(0);
    });
  }
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

interface SupportShape {
  display_name: string | null;
  support: {
    email: string | null;
    telegram: string | null;
    facebook: string | null;
    threads: string | null;
    custom: { label: string; url: string }[];
  };
}

const SUPPORTED: SupportShape = {
  display_name: "Hoborouter",
  support: {
    email: "support@example.com",
    telegram: null,
    facebook: null,
    threads: null,
    custom: [{ label: "Docs", url: "https://docs.example.com/" }],
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

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

function serve(handler: (call: FetchCall) => Response) {
  realFetch = realFetch ?? globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    return handler(call);
  }) as typeof fetch;
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
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    });
  };
  const bodyText = () => document.body.textContent ?? "";
  const input = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    act(() => {
      el.dispatchEvent(new W.Event("input", { bubbles: true }));
    });
  };
  const clickButton = (label: string, index = 0) => {
    const button = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === label,
    )[index];
    if (!button) throw new Error(`button "${label}" not found`);
    act(() => {
      button.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
    });
  };
  const button = (label: string) => {
    const b = Array.from(container.querySelectorAll("button")).find(
      (x) => (x.textContent ?? "").trim() === label,
    );
    if (!b) throw new Error(`button "${label}" not found`);
    return b;
  };
  const unmount = async () => {
    await act(async () => {
      await qc.cancelQueries();
    });
    act(() => root.unmount());
    qc.clear();
    container.remove();
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { container, settle, bodyText, input, setInput, clickButton, button, unmount };
}

// --- rendering ------------------------------------------------------------

test("configured custom links render with remove + add controls", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) =>
    call.url.includes("/admin/support-settings")
      ? jsonResponse(200, SUPPORTED)
      : jsonResponse(200, {}),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Custom links");
    expect(page.input("custom_label_0")!.value).toBe("Docs");
    expect(page.input("custom_url_0")!.value).toBe("https://docs.example.com/");
    expect(page.button("Remove")).toBeDefined();
    const add = page.button("Add link");
    expect(add.disabled).toBe(false);
  } finally {
    await page.unmount();
  }
});

// --- save: exact support_custom PUT key ------------------------------------

test("added links land in the PUT body; removing one sends the rest", async () => {
  useLocaleStore.getState().setLocale("en");
  const puts: Record<string, unknown>[] = [];
  serve((call) => {
    if (!call.url.includes("/admin/support-settings")) return jsonResponse(200, {});
    if (call.method === "PUT") {
      const body = JSON.parse(call.body!) as Record<string, unknown>;
      puts.push(body);
      return jsonResponse(200, {
        ...SUPPORTED,
        support: {
          ...SUPPORTED.support,
          custom: body.support_custom as { label: string; url: string }[],
        },
      });
    }
    // Before the first successful save the configured rows come from the
    // fixture; afterwards the last saved payload (server is authority).
    const custom =
      puts.length === 0
        ? SUPPORTED.support.custom
        : (puts.at(-1)!.support_custom as { label: string; url: string }[]);
    return jsonResponse(200, {
      ...SUPPORTED,
      support: { ...SUPPORTED.support, custom },
    });
  });
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    page.clickButton("Add link");
    page.setInput(page.input("custom_label_1")!, " Status ");
    page.setInput(page.input("custom_url_1")!, "https://status.example.com");
    page.setInput(page.input("support_email")!, "probe@example.com");
    page.clickButton("Save");
    await page.settle();
    expect(puts).toHaveLength(1);
    // Labels/URLs are trimmed; the fixed five keys ride along with the edit.
    expect(puts[0]).toEqual({
      display_name: "Hoborouter",
      support_email: "probe@example.com",
      support_telegram: null,
      support_facebook: null,
      support_threads: null,
      support_custom: [
        { label: "Docs", url: "https://docs.example.com/" },
        { label: "Status", url: "https://status.example.com" },
      ],
    });
    // Save refetches the saved payload and renders the new row.
    expect(page.input("custom_label_1")!.value).toBe("Status");

    // Removing the added row PUTs the remaining configured link.
    page.clickButton("Remove", 1);
    page.clickButton("Save");
    await page.settle();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.support_custom).toEqual([{ label: "Docs", url: "https://docs.example.com/" }]);
  } finally {
    await page.unmount();
  }
});

test("fully-empty rows are dropped; half-filled rows are sent for the server to reject", async () => {
  useLocaleStore.getState().setLocale("en");
  const puts: Record<string, unknown>[] = [];
  serve((call) => {
    if (!call.url.includes("/admin/support-settings")) return jsonResponse(200, {});
    if (call.method === "PUT") {
      puts.push(JSON.parse(call.body!) as Record<string, unknown>);
      return jsonResponse(400, {
        error: {
          code: "INVALID",
          message: "support_custom must be an array of at most 10 { label, url } objects",
        },
      });
    }
    return jsonResponse(200, SUPPORTED);
  });
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    page.clickButton("Add link");
    page.setInput(page.input("custom_label_0")!, "");
    page.clickButton("Add link");
    page.clickButton("Add link");
    page.setInput(page.input("custom_label_2")!, "Only label");
    page.clickButton("Save");
    await page.settle();
    expect(puts).toHaveLength(1);
    // The fully-empty added row is dropped; the cleared-label Docs row (half
    // filled: URL remains) and the label-only row are sent for the server.
    expect(puts[0]!.support_custom).toEqual([
      { label: "", url: "https://docs.example.com/" },
      { label: "Only label", url: "" },
    ]);
    // Server 400 displayed inline; edits preserved.
    expect(page.bodyText()).toContain("support_custom must be an array");
    expect(page.input("custom_label_2")!.value).toBe("Only label");
  } finally {
    await page.unmount();
  }
});

// --- client mirrors server validation (feedback only) ----------------------

test("client validation mirrors server: bad URL and long label flagged", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) =>
    call.url.includes("/admin/support-settings")
      ? jsonResponse(200, SUPPORTED)
      : jsonResponse(200, {}),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    page.clickButton("Add link");
    const url = page.input("custom_url_1")!;
    page.setInput(url, "http://insecure.example");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    page.setInput(url, "https://user:pass@evil.example");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    page.setInput(url, "https://ok.example");
    expect(url.getAttribute("aria-invalid")).not.toBe("true");

    const label = page.input("custom_label_1")!;
    page.setInput(label, "x".repeat(31));
    expect(label.getAttribute("aria-invalid")).toBe("true");
    page.setInput(label, "Fine");
    expect(label.getAttribute("aria-invalid")).not.toBe("true");
  } finally {
    await page.unmount();
  }
});

// --- bounds -----------------------------------------------------------------

test("Add link disables at the 10-row server bound", async () => {
  useLocaleStore.getState().setLocale("en");
  const custom = Array.from({ length: 10 }, (_, i) => ({
    label: `L${i}`,
    url: `https://l${i}.example/`,
  }));
  serve((call) =>
    call.url.includes("/admin/support-settings")
      ? jsonResponse(200, { ...SUPPORTED, support: { ...SUPPORTED.support, custom } })
      : jsonResponse(200, {}),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    const add = page.button("Add link");
    expect(add.disabled).toBe(true);
    expect(page.input("custom_label_9")!.value).toBe("L9");
  } finally {
    await page.unmount();
  }
});
