// Alert component behavior: role="alert", variants render text, manual
// dismissal, auto-dismiss timer firing (transient attachment notices ONLY in
// page wiring), and timer cleanup on unmount. Observable behavior only — no
// CSS/class-string assertions.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "InputEvent",
  "PointerEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLSelectElement",
  "HTMLLabelElement",
  "DocumentFragment",
  "DOMParser",
  "SVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let React: typeof import("react");
let createRoot: (typeof import("react-dom/client"))["createRoot"];
let Alert: (typeof import("../apps/web/src/components/ui/alert"))["Alert"];

type Root = import("react-dom/client").Root;
const roots: Root[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  jsdomWindow = win as unknown as { close: () => void };
  ({ createRoot } = await import("react-dom/client"));
  React = await import("react");
  ({ Alert } = await import("../apps/web/src/components/ui/alert"));
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
});

function mount(ui: React.ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(ui);
}

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const click = (el: Element) =>
  el.dispatchEvent(
    new (window as unknown as { MouseEvent: EventCtor }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );

test("destructive alert renders role=alert with title, body and a manual dismiss button", async () => {
  const dismissed: string[] = [];
  mount(
    React.createElement(
      Alert,
      {
        variant: "destructive",
        title: "This chat key has a 1 MB request limit.",
        onDismiss: () => dismissed.push("x"),
        dismissLabel: "Dismiss",
      },
      "Attachments this large need a new chat key.",
    ),
  );
  await flush();
  const alert = document.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toContain("1 MB request limit");
  expect(alert!.textContent).toContain("Attachments this large need a new chat key.");
  const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
  expect(btn).not.toBeNull();
  expect(dismissed).toHaveLength(0);
  click(btn!);
  await flush();
  expect(dismissed).toEqual(["x"]);
});

test("without onDismiss no dismiss button renders", async () => {
  mount(React.createElement(Alert, { variant: "default" }, "plain notice"));
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("plain notice");
  expect(document.querySelectorAll("button")).toHaveLength(0);
});

test("autoDismissMs fires the dismiss callback after the timer", async () => {
  const dismissed: string[] = [];
  mount(
    React.createElement(Alert, {
      variant: "destructive",
      children: "oversized file",
      autoDismissMs: 25,
      onDismiss: () => dismissed.push("auto"),
      dismissLabel: "Dismiss",
    }),
  );
  expect(dismissed).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 80));
  expect(dismissed).toEqual(["auto"]);
});

test("unmount clears the auto-dismiss timer: no dismiss after unmount", async () => {
  const dismissed: string[] = [];
  mount(
    React.createElement(Alert, {
      variant: "destructive",
      children: "transient",
      autoDismissMs: 30,
      onDismiss: () => dismissed.push("auto"),
      dismissLabel: "Dismiss",
    }),
  );
  // Unmount before the timer fires; wait past the deadline.
  const root = roots[roots.length - 1]!;
  root.unmount();
  roots.pop();
  await new Promise((r) => setTimeout(r, 90));
  expect(dismissed).toHaveLength(0);
});

test("parent re-renders with a changed onDismiss before the deadline: the latest handler fires at the original deadline", async () => {
  const calls: string[] = [];
  const first = () => calls.push("first");
  const second = () => calls.push("second");
  // A parent whose inline onDismiss closure changes identity every render —
  // the regression: the old effect re-armed on identity and never fired.
  function Host(props: { label: string; onDismiss: () => void }) {
    return React.createElement(Alert, {
      variant: "destructive",
      children: props.label,
      autoDismissMs: 30,
      onDismiss: props.onDismiss,
      dismissLabel: "Dismiss",
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(React.createElement(Host, { label: "v1", onDismiss: first }));
  // Re-render with a NEW callback before the 30 ms deadline (well inside it).
  await new Promise((r) => setTimeout(r, 8));
  root.render(React.createElement(Host, { label: "v2", onDismiss: second }));
  // Re-render again, still before the deadline.
  await new Promise((r) => setTimeout(r, 8));
  root.render(React.createElement(Host, { label: "v3", onDismiss: second }));
  await new Promise((r) => setTimeout(r, 90));
  // The ORIGINAL deadline fired, calling the LATEST handler — not the first.
  expect(calls).toEqual(["second"]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("v3");
});

test("a persistent alert without autoDismissMs never auto-dismisses across re-renders", async () => {
  const dismissed: string[] = [];
  const onDismiss = () => dismissed.push("x");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const el = (n: number) =>
    React.createElement(Alert, {
      variant: "destructive",
      children: `persistent ${n}`,
      onDismiss,
      dismissLabel: "Dismiss",
    });
  root.render(el(1));
  for (let n = 2; n <= 5; n++) {
    await new Promise((r) => setTimeout(r, 15));
    root.render(el(n));
  }
  await new Promise((r) => setTimeout(r, 80));
  expect(dismissed).toHaveLength(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("persistent 5");
});
