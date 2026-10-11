// FAQ page (public, EN/VI): rendered inside PublicLayout when anonymous and
// bare when embedded in the app shell (same contract as About). Asserts the
// honest MCP boundary copy, native <details> accordion contract, and the nav
// entry from the shared public chrome. SSR-contract style (renderToStaticMarkup
// with the prop shapes GET /api/v1/public/* returns), like about-page.test.
import { test, expect, afterAll, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { Faq } = await import("../apps/web/src/pages/public/faq");
const { PublicLayout } = await import("../apps/web/src/components/public-layout");
const { useLocaleStore } = await import("../apps/web/src/lib/i18n/locale");

// Minimal jsdom for the EN↔VI flip: zustand serves its INITIAL state as the
// SSR snapshot, so a store flip only shows in a real React mount (same
// convention as about-page.test.tsx).
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let jsdomWindow: { close: () => void } | null = null;
let createRoot: (typeof import("react-dom/client"))["createRoot"] | null = null;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  // jsdom does not implement matchMedia; the theme toggle reads it during
  // render (same stub as tests/about-page.test.tsx and tests/help-context).
  (win as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  });
  (globalThis as Record<string, unknown>).window = win.window;
  (globalThis as Record<string, unknown>).document = win.document;
  jsdomWindow = win as unknown as { close: () => void };
  createRoot = (await import("react-dom/client")).createRoot;
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete (globalThis as Record<string, unknown>).window;
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete (globalThis as Record<string, unknown>).document;
  jsdomWindow?.close();
  jsdomWindow = null;
});

const instance = {
  name: "Hoborouter",
  api_base_url: "https://hoborouter.example",
  support: {
    email: "support@example.com",
    telegram: null,
    facebook: null,
    threads: null,
  },
};

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
});

test("faq renders EN questions with a native details accordion and quickstart link", () => {
  const html = renderToStaticMarkup(<Faq instance={instance} />);
  expect(html).toContain("Frequently asked questions");
  // Native <details> accordion: keyboard/screen-reader contract for free.
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  // Billed-in-VND answer stays truthful about the money model.
  expect(html).toContain("VND");
  // Cross-links to the quickstart tutorial.
  expect(html).toContain('href="/docs/quickstart"');
  // Contact section renders the validated, configured channel.
  expect(html).toContain("mailto:support@example.com");
  // Public chrome (PublicLayout) wraps the anonymous page.
  expect(html).toContain('href="/about"');
});

test("public nav links to the FAQ route", () => {
  const html = renderToStaticMarkup(
    <PublicLayout instance={instance}>
      <p>body</p>
    </PublicLayout>,
  );
  expect(html).toContain('href="/faq"');
  expect(html).toContain(">FAQ<");
});

test("faq states the MCP boundary honestly (no invented protocol support)", () => {
  const html = renderToStaticMarkup(<Faq instance={instance} />);
  // The gateway is an OpenAI-compatible passthrough: no MCP client, no MCP
  // server, and no invented local MCP seam. Standard OpenAI tool fields pass
  // through when the upstream provider supports them.
  expect(html).toContain("MCP");
  expect(html).toMatch(/does not (act as|include) an? MCP (client|server)/);
});

test("faq flips to Vietnamese with the locale store (real mount)", async () => {
  useLocaleStore.getState().setLocale("vi");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot!(container);
  const { act } = await import("react");
  await act(async () => {
    root.render(<Faq instance={instance} embedded />);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(document.body.textContent).toContain("Câu hỏi thường gặp");
  expect(document.body.textContent).toContain("Hoborouter có hỗ trợ MCP");
  await act(async () => {
    root.unmount();
  });
  container.remove();
  useLocaleStore.getState().setLocale("en");
});

test("faq embedded (signed-in shell) skips the PublicLayout chrome", () => {
  const html = renderToStaticMarkup(<Faq instance={instance} embedded />);
  expect(html).toContain("Frequently asked questions");
  // No public nav/sign-in chrome when embedded in the AppShell.
  expect(html).not.toContain('href="/login"');
  expect(html).not.toContain('href="/signup"');
});
