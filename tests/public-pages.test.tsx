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
const { Quickstart, buildSnippets, buildAgentConfigSnippets } =
  await import("../apps/web/src/pages/public/quickstart");

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
  capabilities: ["chat", "tools", "ocr"],
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
  expect(html).toContain("Chat"); // capability badge (canonical label, not raw "chat")
  expect(html).toContain("Tools");
  expect(html).toContain("ocr"); // unknown capability stays verbatim
  expect(html).not.toContain(">chat<");
  expect(html).toContain("Group Pro");
  expect(html).toContain("200.000 ₫");
  expect(html).toContain("250.000 ₫ credit / 30 days");
  expect(html).toContain("15 requests per minute");
});

test("pricing keeps absent capabilities unknown: no invented Vision/chat claims", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={instance}
      models={[{ ...model, capabilities: [] }]}
      modelsState="ready"
      plans={[]}
      plansState="ready"
    />,
  );
  expect(html).toContain("openai/gpt-4o-mini");
  // Null/empty capabilities must not imply any capability (chat is a gateway
  // convention, not a stored claim; vision is never inferred). Assertions are
  // element-bounded badge text (">Vision<"), so the legitimate
  // "Reasoning / 1M tokens" price row cannot false-positive.
  expect(html).not.toContain(">Vision<");
  expect(html).not.toContain(">Nhận diện ảnh<");
  expect(html).not.toContain(">Chat<");
  expect(html).not.toContain(">Suy luận<");
  expect(html).not.toContain(">Công cụ<");
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

test("buildAgentConfigSnippets: codex/opencode/pi target the gateway base url, model and env key", () => {
  const s = buildAgentConfigSnippets("https://hoborouter.example", "openai/gpt-4o-mini");
  // Same base URL (with /v1), same published model id, same env var name in
  // every client; only the HBR_API_KEY env reference is ever shown.
  for (const snippet of [s.codex, s.opencode, s.pi]) {
    expect(snippet).toContain("https://hoborouter.example/v1");
    expect(snippet).toContain("openai/gpt-4o-mini");
    expect(snippet).toContain("HBR_API_KEY");
    expect(snippet).not.toContain("sk-");
  }
  // Codex: user-level config.toml, custom provider, Responses wire (default).
  expect(s.codex).toContain('model = "openai/gpt-4o-mini"');
  expect(s.codex).toContain('model_provider = "hoborouter"');
  expect(s.codex).toContain('base_url = "https://hoborouter.example/v1"');
  expect(s.codex).toContain('env_key = "HBR_API_KEY"');
  // OpenCode: OpenAI-compatible provider with env-var interpolation.
  const oc = JSON.parse(s.opencode) as {
    provider?: Record<
      string,
      { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
    >;
  };
  expect(oc.provider?.hoborouter?.options.baseURL).toBe("https://hoborouter.example/v1");
  expect(oc.provider?.hoborouter?.options.apiKey).toBe("{env:HBR_API_KEY}");
  expect(Object.keys(oc.provider?.hoborouter?.models ?? {})).toEqual(["openai/gpt-4o-mini"]);
  // pi: models.json compatible endpoint, env-interpolated key.
  const piCfg = JSON.parse(s.pi) as {
    providers?: Record<string, { baseUrl: string; apiKey: string; models: { id: string }[] }>;
  };
  expect(piCfg.providers?.hoborouter?.baseUrl).toBe("https://hoborouter.example/v1");
  expect(piCfg.providers?.hoborouter?.apiKey).toBe("$HBR_API_KEY");
  expect(piCfg.providers?.hoborouter?.models[0]?.id).toBe("openai/gpt-4o-mini");
});

test("buildAgentConfigSnippets: placeholders without config/catalog", () => {
  const s = buildAgentConfigSnippets("YOUR_BASE_URL", "YOUR_MODEL_ID");
  expect(s.codex).toContain('base_url = "YOUR_BASE_URL/v1"');
  expect(s.codex).toContain('model = "YOUR_MODEL_ID"');
  expect(s.opencode).toContain("YOUR_MODEL_ID");
  expect(s.pi).toContain("YOUR_MODEL_ID");
});

test("buildAgentConfigSnippets escapes hostile values: JSON parses, TOML values stay single-line", () => {
  const s = buildAgentConfigSnippets('https://x"y\nz', 'm"\\model\nNEXT');
  // Newlines are stripped (never interpolated) and quotes never terminate a
  // string early: both JSON snippets still parse with the full value intact.
  const oc = JSON.parse(s.opencode) as {
    provider?: Record<string, { options: { baseURL: string } }>;
  };
  expect(oc.provider?.hoborouter?.options.baseURL).toBe('https://x"y z/v1');
  const piCfg = JSON.parse(s.pi) as {
    providers?: Record<string, { baseUrl: string; models: { id: string }[] }>;
  };
  expect(piCfg.providers?.hoborouter?.baseUrl).toBe('https://x"y z/v1');
  expect(piCfg.providers?.hoborouter?.models[0]?.id).toBe('m"\\model NEXT');
  // TOML: quotes escaped; every line keeps balanced double quotes once
  // escaped quotes (\") are excluded from the count.
  expect(s.codex).toContain('model = "m\\"\\\\model NEXT"');
  for (const line of s.codex.split("\n")) {
    expect((line.replace(/\\"/g, "").match(/"/g) ?? []).length % 2).toBe(0);
  }
});

test("base url is normalized so /v1 is appended exactly once (host, slash, /v1, /v1/)", () => {
  const variants = [
    "https://hoborouter.example",
    "https://hoborouter.example/",
    "https://hoborouter.example/v1",
    "https://hoborouter.example/v1/",
  ];
  for (const base of variants) {
    const s = buildSnippets(base, "openai/gpt-4o-mini");
    expect(s.curl).toContain('curl "https://hoborouter.example/v1/chat/completions" \\');
    expect(s.python).toContain('base_url="https://hoborouter.example/v1"');
    expect(s.js).toContain('baseURL: "https://hoborouter.example/v1"');
    // Exactly one /v1 per SDK snippet: never doubled (/v1/v1) or //v1.
    for (const snippet of [s.curl, s.python, s.js]) {
      expect(snippet.split("/v1").length - 1).toBe(1);
      expect(snippet).not.toContain("/v1/v1");
      expect(snippet).not.toContain("//v1");
    }
    const a = buildAgentConfigSnippets(base, "openai/gpt-4o-mini");
    expect(a.codex).toContain('base_url = "https://hoborouter.example/v1"');
    for (const snippet of [a.codex, a.opencode, a.pi]) {
      expect(snippet.split("/v1").length - 1).toBe(1);
      expect(snippet).not.toContain("/v1/v1");
      expect(snippet).not.toContain("//v1");
    }
    // JSON snippets still parse with the normalized URL.
    const oc = JSON.parse(a.opencode) as {
      provider?: Record<string, { options?: { baseURL?: string } }>;
    };
    expect(oc.provider?.hoborouter?.options?.baseURL).toBe("https://hoborouter.example/v1");
    const piCfg = JSON.parse(a.pi) as {
      providers?: Record<string, { baseUrl?: string }>;
    };
    expect(piCfg.providers?.hoborouter?.baseUrl).toBe("https://hoborouter.example/v1");
  }
});

test("both tablists are named for assistive technology (bilingual aria-labels)", () => {
  const html = renderToStaticMarkup(
    <Quickstart instance={instance} exampleModelId={model.public_id} />,
  );
  expect(html).toContain('aria-label="Request examples"');
  expect(html).toContain('aria-label="Coding agent clients"');
});

test("quickstart renders the agent tabs card with configured base url", () => {
  const html = renderToStaticMarkup(
    <Quickstart instance={instance} exampleModelId={model.public_id} />,
  );
  expect(html).toContain("Connect your coding agent");
  // The active agent tab (Codex) renders the real configured base URL;
  // SSR escapes the TOML quotes inside the code block.
  expect(html).toContain("base_url = &quot;https://hoborouter.example/v1&quot;");
  expect(html).toContain('aria-label="Codex config example"');
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
  // A valid configured email wins: no fallback link beside it.
  expect((html.match(/mailto:/g) ?? []).length).toBe(1);
});

test("support email falls back to the project contact only when no usable email is configured", () => {
  const fallback = { label: "Email", href: "mailto:contact@hoborouter.tretrauit.me" };
  // Missing entirely (also the loading/error state where support is absent).
  expect(supportLinks(null)[0]).toEqual(fallback);
  expect(supportLinks(undefined)[0]).toEqual(fallback);
  expect(supportLinks({ email: null, telegram: null, facebook: null, threads: null })[0]).toEqual(
    fallback,
  );
  // Empty/whitespace is treated as missing.
  expect(
    supportLinks({ email: "   ", telegram: "@ok_handle", facebook: null, threads: null })[0],
  ).toEqual(fallback);
  // Other channels stay even when the email falls back.
  expect(
    supportLinks({ email: "   ", telegram: "@ok_handle", facebook: null, threads: null })[1],
  ).toEqual({ label: "Telegram", href: "https://t.me/ok_handle" });
  // A valid configured DB email always wins (never overridden).
  expect(supportLinks(instance.support)[0]).toEqual({
    label: "Email",
    href: "mailto:support@example.com",
  });
  // Exactly one email link with the fallback in place.
  const withFallback = supportLinks({
    email: "   ",
    telegram: null,
    facebook: null,
    threads: null,
  });
  expect(withFallback.filter((l) => l.label === "Email")).toHaveLength(1);
});

test("support links reject invalid values and fall back on the email channel", () => {
  const links = supportLinks({
    email: "not-an-email",
    telegram: "javascript:alert(1)",
    facebook: "http://facebook.com/hoborouter", // http, not https
    threads: "https://evil.example/threads",
  });
  // Invalid channels render nothing; the email channel falls back to the
  // project contact so support stays reachable.
  expect(links).toEqual([{ label: "Email", href: "mailto:contact@hoborouter.tretrauit.me" }]);
  expect(renderToStaticMarkup(<SupportLinks support={null} />)).toContain(
    "mailto:contact@hoborouter.tretrauit.me",
  );
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
  expect(html).toContain(">EN<");
  expect(html.indexOf('aria-label="Switch to Vietnamese"')).toBeLessThan(
    html.indexOf('aria-label="Switch to dark mode"'),
  );
});
