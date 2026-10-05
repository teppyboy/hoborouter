// Public BMC pages (landing / pricing / quickstart / public layout /
// support links), SSR-contract style: presentational components receive real
// data as props (the same shapes GET /api/v1/public/* return), so tests
// exercise real rendering, not source greps or hardcoded page mocks.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { PublicLayout } = await import("../apps/web/src/components/public-layout");
const { SupportLinks, supportLinks } = await import("../apps/web/src/components/support-links");
const { Landing } = await import("../apps/web/src/pages/public/landing");
const { Pricing } = await import("../apps/web/src/pages/public/pricing");
const { Quickstart, buildSnippets } = await import("../apps/web/src/pages/public/quickstart");

const instance = {
  name: "Hoborouter",
  api_base_url: "https://hoborouter.example",
  support: {
    email: "support@example.com",
    telegram: "@hoborouter_support",
    facebook: "https://facebook.com/hoborouter",
    threads: null,
  },
};

const model = {
  public_id: "openai/gpt-4o-mini",
  display_name: "GPT-4o mini",
  provider: "openai",
  description: "Small fast chat model.",
  capabilities: ["chat", "tools"],
  context_window: 128000,
  // $0.15 input / 1M at 26000 VND/USD = 3900 VND (server-converted).
  price_vnd_per_1m: { input: 3900, output: 15600, cached_input: 975, reasoning: 0 },
};

const plan = {
  id: "p1",
  name: "Group Pro",
  price_vnd: 200000,
  credit_per_period_vnd: 250000,
  period_days: 30,
  rate_limit_per_minute: 15,
};

test("landing renders hero, nav and honest value props", () => {
  const html = renderToStaticMarkup(<Landing instance={instance} />);
  expect(html).toContain("OpenAI-compatible");
  expect(html).toContain("QR");
  // Nav + auth CTAs.
  expect(html).toContain('href="/pricing"');
  expect(html).toContain('href="/docs/quickstart"');
  expect(html).toContain('href="/login"');
  expect(html).toContain('href="/signup"');
  // Legal footer stays.
  expect(html).toContain('href="/terms"');
  expect(html).toContain('href="/privacy"');
});

test("landing makes no unprovable claims", () => {
  const html = renderToStaticMarkup(<Landing instance={instance} />);
  const lower = html.toLowerCase();
  expect(lower).not.toContain("cheapest");
  expect(lower).not.toContain("% off");
  expect(lower).not.toContain("30x");
  expect(lower).not.toContain("visa");
});

test("landing renders without instance data (placeholder brand only)", () => {
  const html = renderToStaticMarkup(<Landing instance={null} />);
  expect(html).toContain("Hoborouter");
});

test("pricing shows live VND prices, context window, capabilities and plans", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={instance}
      models={[model]}
      modelsState="ready"
      plans={[plan]}
      plansState="ready"
    />,
  );
  expect(html).toContain("openai/gpt-4o-mini");
  expect(html).toContain("GPT-4o mini");
  expect(html).toContain("3.900 ₫"); // input per 1M
  expect(html).toContain("15.600 ₫"); // output per 1M
  expect(html).toContain("975 ₫"); // cached input per 1M
  expect(html).toContain("128.0K token context");
  expect(html).toContain("chat"); // capability badge
  expect(html).toContain("Group Pro");
  expect(html).toContain("200.000 ₫");
  expect(html).toContain("250.000 ₫ credit / 30 days");
  expect(html).toContain("15 requests per minute");
});

test("pricing loading / error / empty states", () => {
  const loading = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={null}
      modelsState="loading"
      plans={null}
      plansState="loading"
    />,
  );
  expect(loading).toContain("aria-busy");
  const error = renderToStaticMarkup(
    <Pricing instance={null} models={null} modelsState="error" plans={null} plansState="error" />,
  );
  expect(error).toContain("Could not load the model catalog");
  expect(error).toContain("Could not load subscription plans");
  const empty = renderToStaticMarkup(
    <Pricing instance={null} models={[]} modelsState="ready" plans={[]} plansState="ready" />,
  );
  expect(empty).toContain("No models published yet.");
  expect(empty).toContain("No subscription plans available");
  // No invented prices in any state.
  expect(empty).not.toContain("₫");
});

test("buildSnippets: curl/python/js hit the gateway with key + model placeholders", () => {
  const s = buildSnippets("https://hoborouter.example", "openai/gpt-4o-mini");
  // curl: URL argument and JSON body.
  expect(s.curl).toContain('curl "https://hoborouter.example/v1/chat/completions" \\');
  expect(s.curl).toContain("Authorization: Bearer YOUR_API_KEY");
  expect(s.curl).toContain('"model": "openai/gpt-4o-mini"');
  // Python / JS: OpenAI SDK with base_url override.
  expect(s.python).toContain("from openai import OpenAI");
  expect(s.python).toContain('base_url="https://hoborouter.example/v1"');
  expect(s.python).toContain('model="openai/gpt-4o-mini"');
  expect(s.js).toContain('import OpenAI from "openai";');
  expect(s.js).toContain('baseURL: "https://hoborouter.example/v1"');
  // The only key material ever shown is the YOUR_API_KEY placeholder.
  for (const snippet of [s.curl, s.python, s.js]) {
    expect(snippet).toContain("YOUR_API_KEY");
    expect(snippet).not.toContain("sk-");
  }
});

test("buildSnippets: placeholders without config/catalog", () => {
  const s = buildSnippets("YOUR_BASE_URL", "YOUR_MODEL_ID");
  expect(s.curl).toContain("YOUR_MODEL_ID");
  expect(s.python).toContain("YOUR_BASE_URL");
});

test("buildSnippets escapes hostile values: no shell/JS breakout, no newline injection", () => {
  const s = buildSnippets('https://x"; rm -rf /; echo "$(danger)`t', 'm"\\model\nNEXT');
  // Quotes, dollars and backticks are escaped inside the shell double-quoted
  // URL argument; the newline in the model id is stripped, not interpolated.
  expect(s.curl).toContain('"https://x\\"; rm -rf /; echo \\"\\$(danger)\\`t/v1/chat/completions"');
  expect(s.curl).toContain('"model": "m\\"\\\\model NEXT"');
  // Python/JS literals keep escaped quotes and no raw newline inside a string.
  expect(s.python).toContain('base_url="https://x\\"; rm -rf /; echo \\"$(danger)`t/v1"');
  expect(s.python).toContain('model="m\\"\\\\model NEXT"');
  expect(s.js).toContain('baseURL: "https://x\\"; rm -rf /; echo \\"$(danger)`t/v1"');
  expect(s.js).toContain('model: "m\\"\\\\model NEXT"');
});

test("quickstart renders real snippets with configured base url and published model", () => {
  const html = renderToStaticMarkup(
    <Quickstart instance={instance} exampleModelId={model.public_id} />,
  );
  expect(html).toContain("/v1/chat/completions");
  expect(html).toContain("https://hoborouter.example/v1/chat/completions");
  expect(html).toContain("openai/gpt-4o-mini");
  expect(html).toContain("Authorization: Bearer YOUR_API_KEY");
  // Radix Tabs renders only the active (curl) tab in SSR; the Python/JS
  // snippet bodies are asserted on buildSnippets directly (see above).
  expect(html).toContain('aria-label="curl example"');
});

test("quickstart falls back to placeholders without config/catalog", () => {
  const html = renderToStaticMarkup(<Quickstart instance={null} exampleModelId={null} />);
  expect(html).toContain("YOUR_BASE_URL");
  expect(html).toContain("YOUR_MODEL_ID");
});

test("quickstart renders hostile base url as inert text (SSR)", () => {
  const hostile = { ...instance, api_base_url: 'https://x"process.exit(1)"y' };
  const html = renderToStaticMarkup(<Quickstart instance={hostile} />);
  // Rendered as escaped text, never breaks out of the text context.
  expect(html).toContain("&quot;process.exit(1)&quot;");
});

test("support links render only configured, valid channels", () => {
  const html = renderToStaticMarkup(<SupportLinks support={instance.support} />);
  expect(html).toContain('href="mailto:support@example.com"');
  expect(html).toContain('href="https://t.me/hoborouter_support"');
  expect(html).toContain('href="https://facebook.com/hoborouter"');
  expect(html).not.toContain("Threads"); // null -> not fabricated
});

test("support links reject invalid values instead of rendering them", () => {
  const links = supportLinks({
    email: "not-an-email",
    telegram: "javascript:alert(1)",
    facebook: "http://facebook.com/hoborouter", // http, not https
    threads: "https://evil.example/threads",
  });
  expect(links).toEqual([]);
  expect(renderToStaticMarkup(<SupportLinks support={null} />)).toBe("");
});

test("public layout shows support section and brand from instance", () => {
  const html = renderToStaticMarkup(
    <PublicLayout instance={instance}>
      <p>body</p>
    </PublicLayout>,
  );
  expect(html).toContain('id="support"');
  expect(html).toContain("Hoborouter");
  expect(html).toContain("body");
});

test("public layout header mounts the language toggle beside the theme toggle", () => {
  const html = renderToStaticMarkup(
    <PublicLayout instance={instance}>
      <p>body</p>
    </PublicLayout>,
  );
  expect(html).toContain('aria-label="Switch to Vietnamese"');
  expect(html).toContain(">VI<");
  expect(html.indexOf('aria-label="Switch to Vietnamese"')).toBeLessThan(
    html.indexOf('aria-label="Switch to dark mode"'),
  );
});
