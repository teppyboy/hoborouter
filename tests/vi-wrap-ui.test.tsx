// Observable-DOM behavior contract for shared chrome under long EN/VI labels.
// These tests pin the behavior the responsive-wrap change must never break:
// every VI/EN label and the full email stay in the accessible DOM, Radix tab
// keyboard selection keeps working (automatic activation, arrow movement),
// the active panel is the visible one, and PageHeader/banner/menu controls
// stay reachable by focus.
// jsdom computes no layout: these tests do NOT prove overflow geometry. The
// 375px scrollWidth/visual sweep is the parent's browser gate.
import { test, expect, afterAll, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
import { act } from "react";
import { JSDOM } from "jsdom";
import { registerFaithfulApiMock } from "./helpers/faithful-api-mock";
import { mock } from "bun:test";

// --- jsdom realm pieces (mirrors tests/keys-page-remove-ui.test.tsx). The
// realm is installed and every component import happens inside beforeAll:
// bun loads test files alphabetically, so react-dom and better-auth's client
// may otherwise first bind a bare stub window from an earlier file (same
// hazard documented in tests/keys-page-remove-ui.test.tsx).
const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MouseEvent",
  "MutationObserver",
  "Element",
  "HTMLElement",
  "Node",
  "ShadowRoot",
  "SVGElement",
  "Text",
  "Comment",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "PointerEvent",
  "NodeFilter",
  "TreeWalker",
  "DocumentFragment",
  "DOMParser",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLLabelElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLFormElement",
  "HTMLTableElement",
  "HTMLTableRowElement",
  "HTMLTableCellElement",
  "HTMLTableSectionElement",
  "HTMLHeadingElement",
  "HTMLParagraphElement",
  "HTMLUListElement",
  "HTMLLIElement",
  "HTMLHtmlElement",
  "HTMLBodyElement",
  "HTMLHeadElement",
  "HTMLStyleElement",
  "HTMLDialogElement",
  "CSSStyleDeclaration",
  "DOMTokenList",
  "NodeList",
  "HTMLCollection",
] as const;

const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

const LONG_EMAIL = "nguoi-dung.rat-dai.ky-tu-dac-biet@cong-ty-vi-thong-viet-nam.com.vn";
const realFetch = globalThis.fetch;
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  // Session comes from the lib/auth mock in beforeAll; everything else
  // answers 200 so stray queries never reject.
  return Promise.resolve(jsonRes(200, {}));
};

let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let Tabs: (typeof import("../apps/web/src/components/ui/tabs"))["Tabs"];
let TabsList: (typeof import("../apps/web/src/components/ui/tabs"))["TabsList"];
let TabsTrigger: (typeof import("../apps/web/src/components/ui/tabs"))["TabsTrigger"];
let TabsContent: (typeof import("../apps/web/src/components/ui/tabs"))["TabsContent"];
let PageHeader: (typeof import("../apps/web/src/components/page"))["PageHeader"];
let AppShell: (typeof import("../apps/web/src/components/app-shell"))["AppShell"];
let UnverifiedEmailBanner: (typeof import("../apps/web/src/components/app-shell"))["UnverifiedEmailBanner"];
type SessionUser = import("../apps/web/src/lib/auth").SessionUser;

beforeAll(async () => {
  for (const key of GLOBAL_KEYS) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
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
  // Radix dropdown internals need these; jsdom has neither.
  (win.Element as typeof Element).prototype.hasPointerCapture = () => false;
  (win.Element as typeof Element).prototype.releasePointerCapture = () => {};
  (win.HTMLElement as typeof HTMLElement).prototype.scrollIntoView = () => {};
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    MouseEvent: win.MouseEvent,
    MutationObserver: win.MutationObserver,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    ShadowRoot: win.ShadowRoot,
    SVGElement: win.SVGElement,
    Text: win.Text,
    Comment: win.Comment,
    CustomEvent: win.CustomEvent,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    PointerEvent: win.PointerEvent ?? win.MouseEvent,
    NodeFilter: win.NodeFilter,
    TreeWalker: win.TreeWalker,
    DocumentFragment: win.DocumentFragment,
    DOMParser: win.DOMParser,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLDivElement: win.HTMLDivElement,
    HTMLSpanElement: win.HTMLSpanElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLTableElement: win.HTMLTableElement,
    HTMLTableRowElement: win.HTMLTableRowElement,
    HTMLTableCellElement: win.HTMLTableCellElement,
    HTMLTableSectionElement: win.HTMLTableSectionElement,
    HTMLHeadingElement: win.HTMLHeadingElement,
    HTMLParagraphElement: win.HTMLParagraphElement,
    HTMLUListElement: win.HTMLUListElement,
    HTMLLIElement: win.HTMLLIElement,
    HTMLHtmlElement: win.HTMLHtmlElement,
    HTMLBodyElement: win.HTMLBodyElement,
    HTMLHeadElement: win.HTMLHeadElement,
    HTMLStyleElement: win.HTMLStyleElement,
    HTMLDialogElement: win.HTMLDialogElement,
    CSSStyleDeclaration: win.CSSStyleDeclaration,
    DOMTokenList: win.DOMTokenList,
    NodeList: win.NodeList,
    HTMLCollection: win.HTMLCollection,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = mockFetch as typeof fetch;

  registerFaithfulApiMock();
  mock.module("../apps/web/src/lib/workspace-queries", () => ({
    useCurrentWorkspaceId: () => "ws-test",
    useWorkspaces: () => ({ data: [], isSuccess: false }),
  }));
  // better-auth's client binds a fetch when app-shell first loads, which may
  // have already happened in an earlier-loaded file. Keep lib/auth genuine
  // except useSession, which returns the fixture session synchronously.
  // mock.module is process-global in bun and outlives mock.restore() (same
  // caveat as tests/helpers/faithful-api-mock.ts): files loading after this
  // one in the same worker would see this session fixture — the rest of the
  // namespace is the real module.
  const realAuthModule = await import("../apps/web/src/lib/auth");
  const authSessionFixture = {
    user: { id: "u_1", name: "Test User", email: LONG_EMAIL, emailVerified: true, image: null },
    session: {
      id: "s_1",
      userId: "u_1",
      token: "t",
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
    },
  };
  mock.module("../apps/web/src/lib/auth", () => ({
    ...realAuthModule,
    useSession: () => ({
      data: authSessionFixture,
      isPending: false,
      error: null,
      isRefetching: false,
      refetch: async () => ({ data: authSessionFixture, error: null }),
    }),
  }));

  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
  ({ Tabs, TabsList, TabsTrigger, TabsContent } =
    await import("../apps/web/src/components/ui/tabs"));
  ({ PageHeader } = await import("../apps/web/src/components/page"));
  ({ UnverifiedEmailBanner, AppShell } = await import("../apps/web/src/components/app-shell"));
});

afterAll(async () => {
  // Radix observers can fire briefly after unmount; drain one macrotask.
  await new Promise((resolve) => setTimeout(resolve, 50));
  mock.restore();
  for (const key of GLOBAL_KEYS) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  globalThis.fetch = realFetch;
  jsdomWindow?.close();
  jsdomWindow = null;
});

async function withProviders(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["public-config"], {
    turnstileSiteKey: null,
    emailVerification: { enabled: false, required: false },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Async act: Radix collection registration (passive effects) must flush
  // before keyboard events are dispatched.
  await act(async () => {
    root.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </routerContext.Provider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function tabs(role: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
}

function selectedTab(): string | null {
  return tabs("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? null;
}

// Radix settles roving-focus moves and deferred menu state across timers;
// poll (real timers, outside act) until the expected state is observable.
async function waitFor(label: string, probe: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met: ${label}`);
}

const VI_LABELS = ["Gói tín dụng", "Gói đăng ký", "Thông lượng trả trước"];

// ---------- Tabs: full VI labels, keyboard selection, panel visibility ----------

test("tabs expose every full VI label and keyboard selection moves the active tab", async () => {
  const mounted = await withProviders(
    <Tabs defaultValue="credit" aria-label="Gói dịch vụ">
      <TabsList aria-label="Gói dịch vụ">
        <TabsTrigger value="credit">{VI_LABELS[0]!}</TabsTrigger>
        <TabsTrigger value="subscription">{VI_LABELS[1]!}</TabsTrigger>
        <TabsTrigger value="throughput">{VI_LABELS[2]!}</TabsTrigger>
      </TabsList>
      <TabsContent value="credit">Nội dung tín dụng</TabsContent>
      <TabsContent value="subscription">Nội dung đăng ký</TabsContent>
      <TabsContent value="throughput">Nội dung thông lượng</TabsContent>
    </Tabs>,
  );
  try {
    // Every full label is an accessible tab name — nothing shortened or clipped.
    expect(tabs("tab").map((t) => t.textContent)).toEqual(VI_LABELS);
    expect(selectedTab()).toBe(VI_LABELS[0]!);
    // Only the active panel is visible; inactive ones are hidden.
    const panelVisibility = () => tabs("tabpanel").map((p) => p.getAttribute("hidden") === null);
    expect(panelVisibility()).toEqual([true, false, false]);
    // Keyboard: focus the second tab stop; automatic activation selects it.
    await act(async () => {
      tabs("tab")[1]!.focus();
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(document.activeElement).toBe(tabs("tab")[1]!);
    expect(selectedTab()).toBe(VI_LABELS[1]!);
    // ArrowRight selects the third; ArrowLeft moves back. Radix applies the
    // focus move in a setTimeout(0), so wait for the observable selection.
    tabs("tab")[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    await waitFor("ArrowRight selects the third tab", () => selectedTab() === VI_LABELS[2]);
    expect(document.activeElement).toBe(tabs("tab")[2]!);
    tabs("tab")[2]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    await waitFor("ArrowLeft selects the second tab", () => selectedTab() === VI_LABELS[1]);
    expect(panelVisibility()).toEqual([false, true, false]);
  } finally {
    mounted.unmount();
  }
});

test("vertical tabs keep the vertical ARIA orientation and keyboard selection", async () => {
  const mounted = await withProviders(
    <Tabs defaultValue="a" orientation="vertical" aria-label="Danh mục">
      <TabsList aria-label="Danh mục">
        <TabsTrigger value="a">Mục A</TabsTrigger>
        <TabsTrigger value="b">Mục B</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Nội dung A</TabsContent>
      <TabsContent value="b">Nội dung B</TabsContent>
    </Tabs>,
  );
  try {
    const list = document.body.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-orientation")).toBe("vertical");
    expect(tabs("tab").map((t) => t.textContent)).toEqual(["Mục A", "Mục B"]);
    await act(async () => {
      tabs("tab")[0]!.focus();
      await new Promise((r) => setTimeout(r, 25));
    });
    // Vertical lists select with ArrowDown, not ArrowRight.
    tabs("tab")[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await waitFor("ArrowDown selects the second tab", () => selectedTab() === "Mục B");
  } finally {
    mounted.unmount();
  }
});

// ---------- PageHeader: full VI title, action buttons reachable by focus ----------

test("PageHeader renders the full VI title and its action buttons take focus", async () => {
  const mounted = await withProviders(
    <PageHeader
      title="Thanh toán và lịch sử giao dịch ví điện tử"
      description="Lịch sử nạp và chi tiêu"
      actions={
        <>
          <button type="button">Gửi lại email xác thực</button>
          <button type="button">Tạo khoá API mới</button>
        </>
      }
    />,
  );
  try {
    expect(mounted.container.querySelector("h1")?.textContent).toBe(
      "Thanh toán và lịch sử giao dịch ví điện tử",
    );
    const buttons = [...mounted.container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Gửi lại email xác thực",
      "Tạo khoá API mới",
    ]);
    // Reachable: neither hidden nor disabled, and each actually takes focus.
    for (const b of buttons) {
      expect(b.hasAttribute("disabled")).toBe(false);
      expect(b.getAttribute("aria-hidden")).toBe(null);
      b.focus();
      expect(document.activeElement).toBe(b);
    }
  } finally {
    mounted.unmount();
  }
});

// ---------- UnverifiedEmailBanner: full email in accessible text ----------

test("banner keeps the full long email as visible text; its buttons take focus", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  qc.setQueryData(["public-config"], {
    turnstileSiteKey: null,
    emailVerification: { enabled: true, required: false },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const user: SessionUser = { email: LONG_EMAIL, emailVerified: false };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          <UnverifiedEmailBanner user={user} />
        </QueryClientProvider>
      </routerContext.Provider>,
    ),
  );
  try {
    // The whole 66-char email is present as one accessible string — no
    // masking, shortening or placeholder substitution.
    expect(container.textContent).toContain(`Please verify your email address (${LONG_EMAIL}).`);
    // The status region itself is rendered and not hidden from AT.
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-hidden")).toBe(null);
    for (const label of ["Resend", "Dismiss"]) {
      const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(btn).toBeDefined();
      btn!.focus();
      expect(document.activeElement).toBe(btn!);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

// ---------- UserMenu: the full email is reachable when the menu opens ----------

test("account menu shows the complete email text (nothing masked or shortened)", async () => {
  const mounted = await withProviders(
    <AppShell>
      <p>page body</p>
    </AppShell>,
  );
  try {
    // Radix defers some menu state (typeahead/observers) past the open event;
    // the session fixture is synchronous but let mount effects settle.
    for (let i = 0; i < 6; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Account menu"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    // Radix menu items are focusable; the label email is rendered in full.
    let emailEl: HTMLParagraphElement | undefined;
    await waitFor("account menu opens with the full email", () => {
      emailEl = [...document.body.querySelectorAll("p")].find((p) => p.textContent === LONG_EMAIL);
      return emailEl != null;
    });
    expect(emailEl!.closest('[role="dialog"], [role="menu"]')).not.toBeNull();
    const menu = emailEl!.closest('[role="menu"]') as HTMLElement;
    // The menu is keyboard-reachable: focusing a menu item works from the label.
    const item = menu.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    item!.focus();
    await waitFor("menu item takes focus", () => menu.contains(document.activeElement));
  } finally {
    mounted.unmount();
  }
});

// ---------- SSR spot-check: full VI copy renders without any session ----------

test("tab VI labels render in full on the server snapshot", () => {
  const html = renderToStaticMarkup(
    <Tabs defaultValue="credit" aria-label="Gói dịch vụ">
      <TabsList aria-label="Gói dịch vụ">
        <TabsTrigger value="credit">{VI_LABELS[0]!}</TabsTrigger>
        <TabsTrigger value="subscription">{VI_LABELS[1]!}</TabsTrigger>
        <TabsTrigger value="throughput">{VI_LABELS[2]!}</TabsTrigger>
      </TabsList>
      <TabsContent value="credit">Nội dung</TabsContent>
    </Tabs>,
  );
  for (const label of VI_LABELS) expect(html).toContain(label);
  expect(html).toContain('role="tab"');
  expect(html).toContain('aria-selected="true"');
});
