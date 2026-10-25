import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRouter, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";

const g = globalThis as { window?: unknown };
const previousWindow = Object.getOwnPropertyDescriptor(g, "window");
g.window ??= {
  location: { origin: "http://localhost" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
afterAll(() => {
  if (previousWindow) Object.defineProperty(g, "window", previousWindow);
  else delete g.window;
});
const { AppShell } = await import("../apps/web/src/components/app-shell");

function renderShell(path: string): string {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return renderToStaticMarkup(
    <routerContext.Provider value={router}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}
      >
        <AppShell variant={path === "/chat" ? "chat" : "default"}>Workspace</AppShell>
      </QueryClientProvider>
    </routerContext.Provider>,
  );
}

test("Chat shell swaps route sidebar for destinations and preserves account, locale and theme", () => {
  const html = renderShell("/chat");
  expect(html).not.toMatch(/<aside[^>]*md:flex/);
  expect(html).toContain('aria-label="App destinations"');
  expect(html).toContain('aria-label="Account menu"');
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain('aria-label="Theme:');
});

test("default shell keeps the existing section navigation and global controls", () => {
  const html = renderShell("/models");
  expect(html).toMatch(/<aside[^>]*md:flex/);
  expect(html).not.toContain('aria-label="App destinations"');
  expect(html).toContain('aria-label="Account menu"');
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain('aria-label="Theme:');
});
