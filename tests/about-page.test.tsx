// Public About page + public-nav navigation. SSR-contract style (same
// approach as tests/public-pages.test.tsx): render real components with the
// prop shapes GET /api/v1/public/* returns and assert on output markup.
// The EN↔VI flip is proven with a real jsdom mount because zustand serves
// its INITIAL state as the SSR snapshot (same convention as
// tests/page-body-i18n.test.tsx), so a store change can never show in
// renderToStaticMarkup output.
import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { About } = await import("../apps/web/src/pages/public/about");
const { PublicLayout } = await import("../apps/web/src/components/public-layout");
const { useLocaleStore } = await import("../apps/web/src/lib/i18n/locale");

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

// Full 40-hex commit SHA used across the revision assertions.
const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
});

test("about shows version, revision, contact link and nav entry to /about", () => {
  const html = renderToStaticMarkup(<About instance={instance} version="0.0.0" revision={SHA} />);
  // Version row carries the build-injected package version as verbatim text
  // (break-all keeps long values wrapable in the wide content column).
  expect(html).toContain('<span class="break-all font-mono text-foreground">0.0.0</span>');
  // Revision row shows the full commit SHA verbatim (nothing truncated).
  expect(html).toContain("Revision");
  expect(html).toContain(SHA);
  // Contact: the configured, validated value is shown as selectable text
  // (About opts into SupportLinks showValues), not just a label link.
  expect(html).toContain(">support@example.com</span>");
  expect(html).toContain("select-all");
  // Contact: only the configured, validated channel; nothing invented.
  expect(html).toContain('href="mailto:support@example.com"');
  expect(html).not.toContain("t.me");
  // Reachable from the shared public nav.
  expect(html).toContain('href="/about"');
  // Sections are labelled for a11y (section id + heading id pairing).
  expect(html).toContain('aria-labelledby="about-version-heading"');
  expect(html).toContain('id="about-version-heading"');
  expect(html).toContain('aria-labelledby="about-contact-heading"');
});

test("about falls back honestly: placeholder brand, no version or revision literal, project contact fallback", () => {
  const html = renderToStaticMarkup(<About instance={null} version={null} revision={null} />);
  expect(html).toContain("Hoborouter"); // PublicLayout brand fallback
  expect(html).toContain("Version: —");
  expect(html).toContain("Revision: —");
  expect(html).not.toMatch(/Version:\s*\d/);
  expect(html).not.toContain(SHA);
  // No usable configured contact: the project fallback email stays reachable
  // and visible as text (showValues strips the mailto: prefix).
  expect(html).toContain("mailto:contact@hoborouter.tretrauit.me");
  expect(html).toContain(">contact@hoborouter.tretrauit.me</span>");
  expect(html).not.toContain("No contact channels are configured");
});

test("gitRevision is null outside a Vite build (no injected build constant)", async () => {
  const { appVersion: pkgVersion, gitRevision } = await import("../apps/web/src/lib/version");
  expect(gitRevision()).toBeNull();
  expect(pkgVersion()).toBeNull();
});

test("public nav links to the about route", () => {
  const html = renderToStaticMarkup(
    <PublicLayout instance={instance}>
      <p>body</p>
    </PublicLayout>,
  );
  expect(html).toContain('href="/about"');
  expect(html).toContain(">About<");
});

// --- EN → VI flip (real DOM mount; SSR snapshot always shows EN) ------------

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

test("about labels flip EN → VI with the language toggle", async () => {
  // jsdom globals must exist before the locale store is imported so zustand
  // persist binds to a real localStorage (same setup as tests/i18n.test.tsx).
  const { JSDOM } = await import("jsdom");
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: Document;
    localStorage: Storage;
    location: unknown;
    matchMedia: unknown;
    close: () => void;
  };
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  });
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
  }
  jsdomWindow = win;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  };
  const { LanguageToggle } = await import("../apps/web/src/components/language-toggle");
  const { act } = await import("react");

  useLocaleStore.getState().setLocale("en");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <>
        <LanguageToggle />
        <About instance={instance} version="0.0.0" revision={SHA} />
      </>,
    ),
  );
  const text = () => container.textContent ?? "";
  try {
    expect(text()).toContain("Version: 0.0.0");
    expect(text()).toContain("Revision: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Switch to Vietnamese"]',
      );
      if (!button) throw new Error("language toggle button not found");
      button.dispatchEvent(
        new (win as unknown as typeof window).MouseEvent("click", { bubbles: true }),
      );
    });
    expect(useLocaleStore.getState().locale).toBe("vi");
    expect(text()).toContain("Phiên bản: 0.0.0");
    expect(text()).toContain("Bản dựng: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
    expect(text()).toContain("Giới thiệu");
    expect(text()).toContain("Liên hệ");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
