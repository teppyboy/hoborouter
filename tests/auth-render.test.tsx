// Auth redesign regression: AuthLayout must SSR without the legacy glow/mask
// treatment (mask-image on .auth-bg faded the whole container's content, and
// .auth-card animated pulsing shadows). Flat monochrome bg, crisp card only.
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthLayout } from "../apps/web/src/components/auth-layout";
function render(): string {
  return renderToStaticMarkup(
    <AuthLayout>
      <h1>Sign in</h1>
    </AuthLayout>,
  );
}

test("AuthLayout renders SSR without legacy mask/glow classes", () => {
  const html = render();
  expect(html).toContain("Hoborouter");
  expect(html).toContain("Sign in");
  // No glow/pulse/mask classes on the rendered markup.
  expect(html).not.toContain("auth-card");
  expect(html).not.toContain("backdrop-blur");
  expect(html).not.toContain("shadow-lg");
});

test("index.css drops auth mask and shine animation", () => {
  const css = readFileSync(new URL("../apps/web/src/index.css", import.meta.url), "utf8");
  expect(css).not.toContain("mask-image");
  expect(css).not.toContain("auth-shine");
  expect(css).not.toContain(".auth-card");
  expect(css).not.toContain(".auth-bg");
});
