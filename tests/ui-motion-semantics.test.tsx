// Motion-change regression contract for the shared Radix primitives the web
// motion policy touches (dialog, sheet, dropdown-menu). The motion classes are
// CSS-only, so the behavior that must never break is Radix's own open/close
// contract: real open via trigger, data-state transitions, initial focus lands
// inside the dialog surface, Escape closes, and the surface unmounts again.
// jsdom computes no styles: animation durations and the reduced-motion guard
// are NOT verified here (browser gate).
import { test, expect, afterAll, beforeAll } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MouseEvent",
  "MutationObserver",
  "Element",
  "HTMLElement",
  "Node",
  "ShadowRoot",
  "SVGElement",
  "Text",
  "Comment",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "PointerEvent",
  "NodeFilter",
  "TreeWalker",
  "DocumentFragment",
  "DOMParser",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLLabelElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLFormElement",
  "CSSStyleDeclaration",
  "DOMTokenList",
  "NodeList",
  "HTMLCollection",
  "ResizeObserver",
] as const;

const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let Dialog: (typeof import("../apps/web/src/components/ui/dialog"))["Dialog"];
let DialogTrigger: (typeof import("../apps/web/src/components/ui/dialog"))["DialogTrigger"];
let DialogContent: (typeof import("../apps/web/src/components/ui/dialog"))["DialogContent"];
let DialogTitle: (typeof import("../apps/web/src/components/ui/dialog"))["DialogTitle"];
let Sheet: (typeof import("../apps/web/src/components/ui/sheet"))["Sheet"];
let SheetTrigger: (typeof import("../apps/web/src/components/ui/sheet"))["SheetTrigger"];
let SheetContent: (typeof import("../apps/web/src/components/ui/sheet"))["SheetContent"];
let SheetTitle: (typeof import("../apps/web/src/components/ui/sheet"))["SheetTitle"];
let DropdownMenu: (typeof import("../apps/web/src/components/ui/dropdown-menu"))["DropdownMenu"];
let DropdownMenuTrigger: (typeof import("../apps/web/src/components/ui/dropdown-menu"))["DropdownMenuTrigger"];
let DropdownMenuContent: (typeof import("../apps/web/src/components/ui/dropdown-menu"))["DropdownMenuContent"];
let DropdownMenuItem: (typeof import("../apps/web/src/components/ui/dropdown-menu"))["DropdownMenuItem"];

beforeAll(async () => {
  for (const key of GLOBAL_KEYS) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  // Radix internals need these; jsdom has neither.
  (win.Element as typeof Element).prototype.hasPointerCapture = () => false;
  (win.Element as typeof Element).prototype.releasePointerCapture = () => {};
  (win.HTMLElement as typeof HTMLElement).prototype.scrollIntoView = () => {};
  // Radix popper measures the anchor/content while positioning.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  win.ResizeObserver = ResizeObserverStub;
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    MouseEvent: win.MouseEvent,
    MutationObserver: win.MutationObserver,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    ShadowRoot: win.ShadowRoot,
    SVGElement: win.SVGElement,
    Text: win.Text,
    Comment: win.Comment,
    CustomEvent: win.CustomEvent,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    PointerEvent: win.PointerEvent ?? win.MouseEvent,
    NodeFilter: win.NodeFilter,
    TreeWalker: win.TreeWalker,
    DocumentFragment: win.DocumentFragment,
    DOMParser: win.DOMParser,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLDivElement: win.HTMLDivElement,
    HTMLSpanElement: win.HTMLSpanElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLFormElement: win.HTMLFormElement,
    CSSStyleDeclaration: win.CSSStyleDeclaration,
    DOMTokenList: win.DOMTokenList,
    NodeList: win.NodeList,
    HTMLCollection: win.HTMLCollection,
    ResizeObserver: ResizeObserverStub,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  ({ createRoot } = (await import(
    Bun.resolveSync("react-dom/client", new URL("../apps/web/src/", import.meta.url).pathname)
  )) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
  ({ Dialog, DialogTrigger, DialogContent, DialogTitle } =
    await import("../apps/web/src/components/ui/dialog"));
  ({ Sheet, SheetTrigger, SheetContent, SheetTitle } =
    await import("../apps/web/src/components/ui/sheet"));
  ({ DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } =
    await import("../apps/web/src/components/ui/dropdown-menu"));
});

afterAll(async () => {
  // Radix observers can fire briefly after unmount; drain one macrotask.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const key of GLOBAL_KEYS) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Radix settles deferred state (open timers, focus moves, exit unmount) across
// timers; poll with real timers until the expected state is observable.
async function waitFor(label: string, probe: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met: ${label}`);
}

function pressEscape(target: Element) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

test("dialog opens on trigger click, takes focus inside, and Escape closes it", async () => {
  const mounted = await mount(
    <Dialog>
      <DialogTrigger>Open settings</DialogTrigger>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <button type="button">Save</button>
      </DialogContent>
    </Dialog>,
  );
  try {
    const trigger = document.body.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      trigger.click();
    });
    const content = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
    await waitFor("dialog content mounts open", () => content()?.dataset.state === "open");
    expect(content()!.querySelector("h2")?.textContent).toBe("Settings");
    // Initial focus must live inside the dialog surface (focus trap active),
    // never on the page behind it.
    expect(content()!.contains(document.activeElement)).toBe(true);
    pressEscape(document.activeElement!);
    await waitFor("dialog unmounts after Escape", () => content() === null);
  } finally {
    mounted.unmount();
  }
});

test("sheet opens from its trigger and Escape closes it (both sides mount with a title)", async () => {
  for (const side of ["right", "left"] as const) {
    const mounted = await mount(
      <Sheet>
        <SheetTrigger>Open menu</SheetTrigger>
        <SheetContent side={side}>
          <SheetTitle>Navigation</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    try {
      const trigger = document.body.querySelector<HTMLButtonElement>("button")!;
      await act(async () => {
        trigger.click();
      });
      const content = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
      await waitFor(`sheet (${side}) mounts open`, () => content()?.dataset.state === "open");
      expect(content()!.textContent).toContain("Navigation");
      // Both sheet sides carry an accessible close control.
      expect(content()!.textContent).toContain("Close");
      pressEscape(document.activeElement!);
      await waitFor(`sheet (${side}) unmounts after Escape`, () => content() === null);
    } finally {
      mounted.unmount();
    }
  }
});

test("dropdown menu opens on trigger Enter, items are focusable, Escape closes it", async () => {
  const mounted = await mount(
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  try {
    const trigger = document.body.querySelector<HTMLButtonElement>("button")!;
    // Radix menus open from the trigger keyboard contract (Enter/Space/ArrowDown);
    // jsdom click() carries no pointerType, so the pointer path is unobservable.
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
    await waitFor("dropdown content mounts open", () => menu()?.dataset.state === "open");
    expect(
      [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.textContent),
    ).toEqual(["Rename", "Delete"]);
    pressEscape(document.activeElement!);
    await waitFor("dropdown unmounts after Escape", () => menu() === null);
  } finally {
    mounted.unmount();
  }
});
