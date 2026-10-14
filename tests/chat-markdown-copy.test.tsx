// Per-code-block copy affordance (React-owned controls over sanitized DOM):
// every fenced block gets a language label and an accessible copy button that
// writes the EXACT decoded code text to the clipboard, shows localized
// success/failure feedback (including a missing clipboard API), and never
// weakens the sanitizer (hostile fenced HTML is copied literally but never
// rendered). jsdom + real React root, same setup as chat-markdown-engine.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { mock } from "bun:test";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "DOMParser",
  "navigator",
  "localStorage",
  "location",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let clipboardWrites: string[] = [];
let clipboardReject = false;
let clipboardPresent = true;

beforeAll(() => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: Document;
    localStorage: Storage;
    location: unknown;
    navigator: Navigator;
    Event: unknown;
    MouseEvent: unknown;
    close: () => void;
  };
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
  }
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    get() {
      if (!clipboardPresent) return undefined;
      return {
        writeText: mock((text: string) => {
          if (clipboardReject) return Promise.reject(new Error("denied"));
          clipboardWrites.push(text);
          return Promise.resolve();
        }),
      };
    },
  });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow = win;
});

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const { ChatMarkdown } = await import("../apps/web/src/components/chat-markdown");
const { createRoot } = (await import(
  Bun.resolveSync("react-dom/client", new URL("../apps/web/src/", import.meta.url).pathname)
)) as unknown as {
  createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
};
const { act } = await import("react");
const { useLocaleStore } = await import("../apps/web/src/lib/i18n/locale");

const CODE_MD = "Before\n```typescript\nconst a = 1;\nif (a) {\n  console.log(a);\n}\n```\nAfter";

function mount(md: string) {
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ChatMarkdown content={md} />));
  const click = async (selector: string) => {
    const btn = container.querySelector<HTMLButtonElement>(selector);
    if (!btn) throw new Error(`button not found: ${selector}`);
    await act(async () => {
      btn.dispatchEvent(
        new (win as unknown as typeof window).MouseEvent("click", { bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  return {
    container,
    click,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("each fenced block gets a language label and an accessible copy button", () => {
  const h = mount(CODE_MD);
  try {
    expect(h.container.querySelectorAll("[data-code-block]").length).toBe(1);
    expect(h.container.querySelector("[data-code-lang]")?.textContent).toBe("typescript");
    const btn = h.container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
    expect(btn).not.toBeNull();
  } finally {
    h.cleanup();
  }
});

test("copy writes the exact decoded code text (no fence newline, no entities)", async () => {
  clipboardWrites = [];
  clipboardReject = false;
  const h = mount(CODE_MD);
  try {
    await h.click('button[aria-label="Copy code"]');
    expect(clipboardWrites).toEqual(["const a = 1;\nif (a) {\n  console.log(a);\n}"]);
  } finally {
    h.cleanup();
  }
});

test("hostile fenced HTML copies the literal text but is never rendered", async () => {
  clipboardWrites = [];
  clipboardReject = false;
  const h = mount("```\n<script>alert(1)</script>\n```");
  try {
    await h.click('button[aria-label="Copy code"]');
    expect(clipboardWrites).toEqual(["<script>alert(1)</script>"]);
    expect(h.container.querySelector("script")).toBeNull();
    expect(h.container.querySelector("img")).toBeNull();
  } finally {
    h.cleanup();
  }
});

test("successful copy shows localized feedback (EN and VI)", async () => {
  clipboardWrites = [];
  clipboardReject = false;
  useLocaleStore.getState().setLocale("en");
  const h = mount(CODE_MD);
  try {
    await h.click('button[aria-label="Copy code"]');
    expect(h.container.textContent).toContain("Copied");
    useLocaleStore.getState().setLocale("vi");
    await h.click('button[aria-label="Copy code"]');
    expect(h.container.textContent).toContain("Đã sao chép");
  } finally {
    h.cleanup();
    useLocaleStore.getState().setLocale("en");
  }
});

test("clipboard rejection shows failure feedback", async () => {
  clipboardReject = true;
  const h = mount(CODE_MD);
  try {
    await h.click('button[aria-label="Copy code"]');
    expect(h.container.textContent).toContain("Copy failed");
  } finally {
    h.cleanup();
    clipboardReject = false;
  }
});

test("missing clipboard API shows failure feedback, never throws", async () => {
  clipboardPresent = false;
  const h = mount(CODE_MD);
  try {
    await h.click('button[aria-label="Copy code"]');
    expect(h.container.textContent).toContain("Copy failed");
  } finally {
    h.cleanup();
    clipboardPresent = true;
  }
});

test("inline code gets no copy button; unlabeled blocks still copy exactly", async () => {
  clipboardWrites = [];
  clipboardReject = false;
  const h = mount("run `x=1` now\n\n```\nplain block\n```");
  try {
    expect(h.container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    expect(h.container.querySelector("[data-code-lang]")?.textContent).toBe("");
    await h.click('button[aria-label="Copy code"]');
    expect(clipboardWrites).toEqual(["plain block"]);
  } finally {
    h.cleanup();
  }
});
