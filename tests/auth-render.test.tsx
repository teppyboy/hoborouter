// Auth redesign regression: AuthLayout must SSR without the legacy glow/mask
// treatment (mask-image on .auth-bg faded the whole container's content, and
// .auth-card animated pulsing shadows). Flat monochrome bg, crisp card only.
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

test("AuthLayout mounts the language toggle beside the theme toggle", () => {
  const html = render();
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain(">EN<");
  expect(html.indexOf('aria-label="Switch to Vietnamese"')).toBeLessThan(
    html.indexOf('aria-label="Switch to dark mode"'),
  );
});
