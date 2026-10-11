// Claude Code quickstart tab contract:
// - The agent tabs include a "Claude Code" tab.
// - Its content is REAL setup: the gateway serves Anthropic Messages at
//   /v1/messages natively, so the tab renders env-var setup (ANTHROPIC_BASE_URL
//   / ANTHROPIC_AUTH_TOKEN) plus a curl example. Keys are only ever referenced
//   via the HBR_API_KEY environment variable (or the explicit YOUR_API_KEY
//   curl placeholder) — never a rendered key value.
import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "getComputedStyle",
  // Radix Tabs schedules its mount-animation guard with rAF; without these
  // globals installed before the Radix import, useEffect throws.
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
const W = new JSDOM("", {
  url: "http://localhost:5173",
  // pretendToBeVisual gives the window real rAF/cAF implementations.
  pretendToBeVisual: true,
}).window as unknown as {
  close: () => void;
  document: Document;
  requestAnimationFrame: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  Event: typeof Event;
  MouseEvent: typeof MouseEvent;
  localStorage: Storage;
};

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  getComputedStyle: (W as unknown as { getComputedStyle: typeof getComputedStyle })
    .getComputedStyle,
  requestAnimationFrame: W.requestAnimationFrame,
  cancelAnimationFrame: W.cancelAnimationFrame,
  Node: W.Node,
  Element: W.Element,
  HTMLElement: W.HTMLElement,
  Event: W.Event,
  MouseEvent: W.MouseEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const matchMediaStub = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
(W as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
(globalThis as { matchMedia?: unknown }).matchMedia = matchMediaStub;
jsdomWindow = W;

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { Quickstart } = await import("../apps/web/src/pages/public/quickstart");

const instance = {
  name: "Hoborouter",
  api_base_url: "https://hoborouter.example",
  support: { email: null, telegram: null, facebook: null, threads: null },
};

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

test("agent tabs include a Claude Code tab (SSR)", () => {
  const html = renderToStaticMarkup(
    <Quickstart instance={instance} exampleModelId="openai/gpt-4o-mini" />,
  );
  expect(html).toContain("Claude Code");
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

test("the Claude Code tab shows real /v1/messages setup, key only via HBR_API_KEY", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<Quickstart instance={instance} exampleModelId="openai/gpt-4o-mini" />);
  });
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
    t.textContent?.includes("Claude Code"),
  );
  expect(tab).not.toBeUndefined();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    tab!.click();
  });
  await act(async () => {});
  // The trigger must actually activate before the panel content is asserted.
  expect(tab!.getAttribute("aria-selected")).toBe("true");
  const panel = document.querySelector(`#${tab!.getAttribute("aria-controls") ?? ""}`);
  expect(panel).not.toBeNull();
  const text = panel!.textContent ?? "";
  // Real setup: native Anthropic Messages endpoint and the env-var wiring.
  expect(text).toContain("/v1/messages");
  expect(text).toContain("ANTHROPIC_BASE_URL");
  expect(text).toContain("ANTHROPIC_AUTH_TOKEN");
  // Config snippets are rendered (env block + curl example).
  expect(panel!.querySelector("pre, code")).not.toBeNull();
  // Key material: only the HBR_API_KEY indirection and the explicit curl
  // placeholder; the instance base URL is used without a rendered key.
  expect(text).toContain("$HBR_API_KEY");
  expect(text).toContain("YOUR_API_KEY");
  expect(text).toContain("https://hoborouter.example");
  expect(text).not.toContain("sk-hbr-");
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
