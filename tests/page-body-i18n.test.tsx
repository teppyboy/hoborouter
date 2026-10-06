// Page-body i18n contract: the toggle must translate the VISIBLE bodies of
// the landing, pricing, dashboard overview and settings pages EN ↔ VI, not
// just chrome. English is the default locale; Vietnamese arrives via the
// persisted hbr-locale store and is reactive per render. Money values and
// API-derived data are never translated — only the words around them.
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let originalFetch: typeof fetch | undefined;
let jsdomWindow: { close: () => void } | null = null;

let Landing: (typeof import("../apps/web/src/pages/public/landing"))["Landing"];
let Pricing: (typeof import("../apps/web/src/pages/public/pricing"))["Pricing"];
let OverviewPage: (typeof import("../apps/web/src/pages/overview/index"))["default"];
let SettingsPage: (typeof import("../apps/web/src/pages/settings/index"))["default"];
let LanguageToggle: (typeof import("../apps/web/src/components/language-toggle"))["LanguageToggle"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let useWorkspaceStore: (typeof import("../apps/web/src/lib/workspace"))["useWorkspaceStore"];

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    matchMedia: unknown;
    getComputedStyle: (element: Element) => CSSStyleDeclaration;
    close: () => void;
  };
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  // Radix Tabs (react-presence) needs getComputedStyle + requestAnimationFrame.
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
  // Page data queries must never hit the network: all fixtures are seeded
  // into the QueryClient and any stray fetch never resolves.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  ({ Landing } = await import("../apps/web/src/pages/public/landing"));
  ({ Pricing } = await import("../apps/web/src/pages/public/pricing"));
  ({ default: OverviewPage } = await import("../apps/web/src/pages/overview/index"));
  ({ default: SettingsPage } = await import("../apps/web/src/pages/settings/index"));
  ({ LanguageToggle } = await import("../apps/web/src/components/language-toggle"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  ({ useWorkspaceStore } = await import("../apps/web/src/lib/workspace"));
  // OverviewPage derives its workspace from useCurrentWorkspaceId, which
  // requires a validated workspaces list (better-auth session). Mock the
  // resolver so the seeded workspace id flows through; restored in afterAll.
  mock.module("../apps/web/src/lib/workspace-queries", () => ({
    useCurrentWorkspaceId: () => "ws-test",
    useWorkspaces: () => ({ data: [], isSuccess: false }),
  }));
});

afterAll(() => {
  mock.restore();
  useLocaleStore.getState().setLocale("en");
  useWorkspaceStore.setState({ workspaceId: null });
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom/client is only resolvable through the web app's own node_modules.
const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
  createRoot: (c: HTMLElement) => {
    render: (n: unknown) => void;
    unmount: () => void;
  };
};

function mount(
  node: React.ReactNode,
  seed?: (qc: QueryClient) => void,
): {
  root: { unmount: () => void };
  container: HTMLElement;
  text: () => string;
} {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  // Seeded fixtures are served from the cache even with queries disabled, so
  // page bodies render their ready states without any network.
  if (seed) seed(qc);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  act(() => reactRoot.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>));
  return { root: reactRoot, container, text: () => container.textContent ?? "" };
}

function unmount(mounted: ReturnType<typeof mount>) {
  // Real act(unmount): leaving the root mounted keeps scheduler callbacks
  // alive that later fire after the jsdom globals are restored and crash.
  act(() => mounted.root.unmount());
  mounted.container.remove();
}

async function clickToggle(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Switch to Vietnamese"], button[aria-label="Chuyển sang tiếng Anh"]',
  );
  if (!button) throw new Error("language toggle button not found");
  act(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  await Promise.resolve();
}

test("the landing hero and feature cards flip EN → VI with the toggle", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = mount(
    <>
      <LanguageToggle />
      <Landing instance={null} />
    </>,
  );
  try {
    expect(mounted.text()).toContain("Use AI models through one API, pay in VND");
    expect(mounted.text()).toContain("Create an account");
    expect(mounted.text()).toContain("Multiple AI providers");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Dùng các mô hình AI qua một API, thanh toán bằng VND");
    expect(mounted.text()).toContain("Tạo tài khoản");
    expect(mounted.text()).toContain("Nhiều nhà cung cấp AI");
    expect(mounted.text()).toContain("Bắt đầu");
    expect(mounted.text()).not.toContain("Use AI models through one API");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Use AI models through one API, pay in VND");
  } finally {
    unmount(mounted);
  }
});

test("the pricing body (headings and empty states) flips EN → VI with the toggle", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = mount(
    <>
      <LanguageToggle />
      <Pricing instance={null} models={[]} modelsState="ready" plans={[]} plansState="ready" />
    </>,
  );
  try {
    expect(mounted.text()).toContain("Pricing");
    expect(mounted.text()).toContain("Subscription plans");
    expect(mounted.text()).toContain("No models published yet.");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Bảng giá");
    expect(mounted.text()).toContain("Gói đăng ký");
    expect(mounted.text()).toContain("Chưa có mô hình nào được xuất bản.");
    expect(mounted.text()).not.toContain("No models published yet.");
  } finally {
    unmount(mounted);
  }
});

test("the dashboard overview (header, stat tiles, recent-requests table) flips EN → VI", async () => {
  useLocaleStore.getState().setLocale("en");
  useWorkspaceStore.setState({ workspaceId: "ws-test" });
  const mounted = mount(
    <>
      <LanguageToggle />
      <OverviewPage />
    </>,
    (qc) => {
      qc.setQueryData(["usage-summary", "ws-test", 30, null], {
        totals: {
          requests: 12,
          spend_vnd: 480000,
          input_tokens: 150000,
          output_tokens: 30000,
          errors: 1,
          visible_requests: 12,
          visible_errors: 1,
        },
        daily: [],
        by_model: [],
      });
      qc.setQueryData(
        ["usage-logs", "ws-test", 10],
        [
          {
            id: "log-1",
            request_id: "req_1",
            created_at: Date.now() - 60_000,
            public_model: "fake/test-model",
            provider: "fake",
            status: "ok",
            failure: null,
            input_tokens: 1200,
            output_tokens: 300,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
            charged_vnd: 4200,
            latency_ms: 120,
            ttft_ms: 40,
            key_prefix: "sk-hbr-abcd",
          },
        ],
      );
      qc.setQueryData(["wallet", "ws-test", "rate"], { usd_vnd_rate: 26000 });
    },
  );
  try {
    expect(mounted.text()).toContain("Overview");
    expect(mounted.text()).toContain("Success rate");
    expect(mounted.text()).toContain("Recent requests");
    expect(mounted.text()).toContain("Spend per day (USD)");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Tổng quan");
    expect(mounted.text()).toContain("Tỷ lệ thành công");
    expect(mounted.text()).toContain("Request gần đây");
    expect(mounted.text()).toContain("Chi tiêu mỗi ngày (USD)");
    expect(mounted.text()).not.toContain("Success rate");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Success rate");
  } finally {
    unmount(mounted);
  }
});

test("the settings page (header and tab labels) flips EN → VI with the toggle", async () => {
  useLocaleStore.getState().setLocale("en");
  useWorkspaceStore.setState({ workspaceId: "ws-test" });
  const mounted = mount(
    <>
      <LanguageToggle />
      <SettingsPage />
    </>,
  );
  try {
    expect(mounted.text()).toContain("Settings");
    expect(mounted.text()).toContain("Workspace, members and account.");
    expect(mounted.text()).toContain("General");
    expect(mounted.text()).toContain("Members");
    expect(mounted.text()).toContain("Account");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Cài đặt");
    expect(mounted.text()).toContain("Workspace, thành viên và tài khoản.");
    expect(mounted.text()).toContain("Chung");
    expect(mounted.text()).toContain("Thành viên");
    expect(mounted.text()).toContain("Tài khoản");
    expect(mounted.text()).not.toContain("Workspace, members and account.");
  } finally {
    unmount(mounted);
  }
});
