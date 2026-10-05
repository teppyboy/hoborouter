// Shell responsive contract (semantic SSR render):
// - Desktop aside is hidden below md (no w-52 overflow at 390px).
// - A hamburger trigger opens the mobile left sheet; the sheet carries an
//   accessible title/description (Radix dialog semantics).
// - Header keeps the account menu trigger reachable with only the avatar on
//   the narrowest viewports (username hidden below sm).
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";

(globalThis as { window?: unknown }).window ??= {
  location: { origin: "http://localhost" },
  matchMedia: () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
};
const { AppShell } = await import("../apps/web/src/components/app-shell");

function renderShell(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  const rootRoute = createRootRoute({ component: () => null });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>
        <AppShell>
          <p>page body</p>
        </AppShell>
      </QueryClientProvider>
    </routerContext.Provider>,
  );
}

test("aside is hidden below md and mobile hamburger trigger is present", () => {
  const html = renderShell();
  // The aside itself carries the responsive visibility classes.
  expect(html).toMatch(/<aside[^>]*class="[^"]*hidden[^"]*md:flex/);
  expect(html).toContain('aria-label="Open navigation"');
});

test("mobile sheet trigger exposes dialog semantics; nav body renders in aside", () => {
  const html = renderShell();
  expect(html).toContain('aria-label="Open navigation"');
  // Closed Radix dialog content is not in static markup; the trigger still
  // declares the popup it opens (Escape/focus-return are Radix-managed).
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain("Overview");
});

test("account menu keeps avatar trigger; username hidden below sm", () => {
  const html = renderShell();
  expect(html).toContain('aria-label="Account menu"');
  expect(html).toMatch(/class="[^"]*hidden[^"]*sm:inline/);
});

test("header mounts the language toggle beside the theme toggle", () => {
  const html = renderShell();
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain(">VI<");
  // Language toggle renders before the theme toggle in the header controls.
  expect(html.indexOf('aria-label="Switch to Vietnamese"')).toBeLessThan(
    html.indexOf('aria-label="Theme:'),
  );
});
