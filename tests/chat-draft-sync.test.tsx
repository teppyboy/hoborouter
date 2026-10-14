// useChatDraftSync behavior (jsdom + real React root): debounced write,
// scope-switch flush-before-hydrate (no context leak), pagehide/unmount
// flush, send-path clearCurrent, and the hydration echo never wiping the
// stored draft. Observable behavior only.
import { test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "DocumentFragment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let React: typeof import("react");
let createRoot: (typeof import("react-dom/client"))["createRoot"];
let useChatDraftSync: (typeof import("../apps/web/src/pages/chat/use-chat-drafts"))["useChatDraftSync"];
let chatDraftKey: (typeof import("../apps/web/src/pages/chat/draft"))["chatDraftKey"];

type Root = import("react-dom/client").Root;
const roots: Root[] = [];
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  jsdomWindow = win as unknown as { close: () => void };
  ({ createRoot } = await import("react-dom/client"));
  React = await import("react");
  ({ useChatDraftSync } = await import("../apps/web/src/pages/chat/use-chat-drafts"));
  ({ chatDraftKey } = await import("../apps/web/src/pages/chat/draft"));
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

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount();
  await flush();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

beforeEach(() => {
  hydrations = [];
  api = null;
});

type Scope = { userId: string; workspaceId: string; chatId: string | null };
const scopeA: Scope = { userId: "u1", workspaceId: "w1", chatId: null };
const scopeB: Scope = { userId: "u1", workspaceId: "w1", chatId: "c1" };

let hydrations: string[] = [];
let api: { flushNow(): void; clearCurrent(): void } | null = null;

function Probe(props: { scope: Scope | null; text: string }) {
  api = useChatDraftSync({
    scope: props.scope,
    text: props.text,
    getText: () => props.text,
    setText: (t) => hydrations.push(t),
  });
  return null;
}

function mount(props: { scope: Scope | null; text: string }): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(React.createElement(Probe, props));
}

function rerender(props: { scope: Scope | null; text: string }): void {
  const root = roots[roots.length - 1];
  if (!root) throw new Error("rerender before mount");
  root.render(React.createElement(Probe, props));
}

const storedA = () => sessionStorage.getItem(chatDraftKey(scopeA));
const storedB = () => sessionStorage.getItem(chatDraftKey(scopeB));

test("typing persists debounced (not immediately, not lost)", async () => {
  mount({ scope: scopeA, text: "" });
  await flush();
  rerender({ scope: scopeA, text: "hello" });
  expect(storedA()).toBe(null); // inside the 200ms debounce window
  await flush(350);
  expect(storedA()).toBe("hello");
});

test("scope switch flushes the previous scope before hydrating the new one", async () => {
  mount({ scope: scopeA, text: "" });
  await flush();
  rerender({ scope: scopeA, text: "draft for A" });
  // Switch BEFORE the debounce fires: the explicit context switch flushes A.
  sessionStorage.setItem(chatDraftKey(scopeB), "draft for B");
  rerender({ scope: scopeB, text: "draft for A" });
  await flush();
  expect(storedA()).toBe("draft for A"); // previous context landed under its own key
  // Mount hydrated the empty scope-A draft ("") first, then scope B's.
  expect(hydrations).toEqual(["", "draft for B"]); // new context hydrates ONLY its own draft
  expect(storedB()).toBe("draft for B"); // A's text never wrote into B
  // The page applies the hydration (setText -> new text prop); the echo must
  // not wipe the stored draft, and no stale write may land under B.
  rerender({ scope: scopeB, text: "draft for B" });
  await flush(350);
  expect(storedB()).toBe("draft for B");
});

test("hydration echo does not wipe or rewrite the stored draft", async () => {
  sessionStorage.setItem(chatDraftKey(scopeA), "kept draft");
  mount({ scope: scopeA, text: "" });
  await flush();
  expect(hydrations).toEqual(["kept draft"]);
  await flush(350); // debounce window passes on the echoed text
  expect(storedA()).toBe("kept draft");
});

test("pagehide flushes immediately, inside the debounce window", async () => {
  mount({ scope: scopeA, text: "" });
  await flush();
  rerender({ scope: scopeA, text: "unsent words" });
  await flush();
  expect(storedA()).toBe(null);
  window.dispatchEvent(new Event("pagehide"));
  expect(storedA()).toBe("unsent words");
});

test("unmount flushes the current text", async () => {
  mount({ scope: scopeA, text: "" });
  await flush();
  rerender({ scope: scopeA, text: "before unmount" });
  await flush();
  const root = roots.pop();
  root?.unmount();
  expect(storedA()).toBe("before unmount");
});

test("clearCurrent (send path) erases the stored draft and blocks the pending write", async () => {
  mount({ scope: scopeA, text: "" });
  await flush();
  rerender({ scope: scopeA, text: "about to send" });
  await flush();
  api?.clearCurrent();
  expect(storedA()).toBe(null);
  await flush(350); // the pending debounce must not resurrect the draft
  expect(storedA()).toBe(null);
});
