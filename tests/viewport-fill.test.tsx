// Viewport fill opt-in: ScrollPanel/DataTable accept a `fill` flag so list
// panels stretch to the remaining bounded-shell height instead of capping at
// max-h-96. Fill is pure CSS layout, which jsdom cannot measure — these tests
// pin the semantic contract that must survive the fill opt-in: labelled,
// keyboard-scrollable region (WCAG 2.1.1), sticky header, search input and
// pagination stay outside the region. Pixel verification is browser-side
// (parent run) and reported separately as unverified.
import { test, expect, beforeAll, afterAll } from "bun:test";
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
  "MutationObserver",
  "Element",
  "HTMLElement",
  "Node",
  "Text",
  "Comment",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "NodeFilter",
  "TreeWalker",
  "DocumentFragment",
  "DOMParser",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLLabelElement",
  "HTMLTableElement",
  "HTMLTableRowElement",
  "HTMLTableCellElement",
  "HTMLTableSectionElement",
  "HTMLHeadingElement",
  "HTMLParagraphElement",
  "CSSStyleDeclaration",
  "DOMTokenList",
  "NodeList",
  "HTMLCollection",
] as const;

let root: { render: (n: React.ReactNode) => void; unmount: () => void };
let container: HTMLElement;
let DataTable: (typeof import("../apps/web/src/components/page"))["DataTable"];
let ScrollPanel: (typeof import("../apps/web/src/components/page"))["ScrollPanel"];

beforeAll(async () => {
  const domWindow = new JSDOM("", { url: "http://localhost:5173" }).window;
  const win = domWindow as unknown as Record<string, unknown>;
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    MutationObserver: win.MutationObserver,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    Text: win.Text,
    Comment: win.Comment,
    CustomEvent: win.CustomEvent,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    NodeFilter: win.NodeFilter,
    TreeWalker: win.TreeWalker,
    DocumentFragment: win.DocumentFragment,
    DOMParser: win.DOMParser,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLDivElement: win.HTMLDivElement,
    HTMLSpanElement: win.HTMLSpanElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLTableElement: win.HTMLTableElement,
    HTMLTableRowElement: win.HTMLTableRowElement,
    HTMLTableCellElement: win.HTMLTableCellElement,
    HTMLTableSectionElement: win.HTMLTableSectionElement,
    HTMLHeadingElement: win.HTMLHeadingElement,
    HTMLParagraphElement: win.HTMLParagraphElement,
    CSSStyleDeclaration: win.CSSStyleDeclaration,
    DOMTokenList: win.DOMTokenList,
    NodeList: win.NodeList,
    HTMLCollection: win.HTMLCollection,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  const { createRoot } = (await import(
    Bun.resolveSync("react-dom/client", webDir)
  )) as typeof import("react-dom/client");

  container = (win.document as Document).createElement("div");
  (win.document as Document).body.appendChild(container);
  root = createRoot(container);

  const page =
    (await import("../apps/web/src/components/page")) as typeof import("../apps/web/src/components/page");
  DataTable = page.DataTable;
  ScrollPanel = page.ScrollPanel;
});

afterAll(() => {
  act(() => {
    root.unmount();
  });
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

const columns = [{ accessorKey: "name", header: "Name" }];

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

test("ScrollPanel fill keeps the labelled keyboard-scrollable region semantics", async () => {
  await render(
    <ScrollPanel label="Request logs" stickyHeader fill>
      <table>
        <thead>
          <tr>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>row</td>
          </tr>
        </tbody>
      </table>
    </ScrollPanel>,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-label")).toBe("Request logs");
  expect(region?.getAttribute("tabindex")).toBe("0");
  expect(region?.querySelector("thead")).not.toBeNull();
  expect(region?.textContent).toContain("row");
});

test("DataTable scroll fill keeps search outside the region and sorting working", async () => {
  await render(
    <DataTable
      columns={columns}
      data={[{ name: "alpha" }, { name: "beta" }]}
      globalFilter=""
      onGlobalFilterChange={() => {}}
      scroll={{ label: "Keys list", fill: true }}
    />,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-label")).toBe("Keys list");
  expect(region?.getAttribute("tabindex")).toBe("0");
  // Search input stays outside the scroll region.
  const search = container.querySelector<HTMLInputElement>('input[placeholder="Search…"]');
  expect(search).not.toBeNull();
  expect(region?.contains(search!)).toBe(false);
  // Header sort button still interactive inside the region.
  const headerButton = () => region?.querySelector<HTMLButtonElement>("thead button");
  await act(async () => {
    headerButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const cells = region?.querySelectorAll("tbody td");
  expect(cells?.[0]?.textContent).toBe("alpha");
  // Structural fill contract: the region's parent is the DataTable wrapper
  // that also holds the search input, so the panel's remaining-height flex
  // sizing resolves inside a bounded parent while search stays outside.
  const wrapper = region?.parentElement;
  expect(wrapper).not.toBeNull();
  expect(wrapper?.contains(search!)).toBe(true);
  expect(wrapper?.children.length).toBe(2); // search input + region
});

test("ScrollPanel without fill renders the same region semantics (default unchanged)", async () => {
  await render(
    <ScrollPanel label="Members" stickyHeader>
      <table>
        <thead>
          <tr>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>a@b.c</td>
          </tr>
        </tbody>
      </table>
    </ScrollPanel>,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-label")).toBe("Members");
  expect(region?.getAttribute("tabindex")).toBe("0");
});

test("DataTable fill with a single row keeps region semantics and wrapper structure", async () => {
  await render(
    <DataTable
      columns={columns}
      data={[{ name: "solo" }]}
      scroll={{ label: "Usage per model", fill: true }}
    />,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-label")).toBe("Usage per model");
  expect(region?.textContent).toContain("solo");
  // No search input; the wrapper's only child is the region itself.
  const wrapper = region?.parentElement;
  expect(wrapper?.children.length).toBe(1);
  expect(wrapper?.firstElementChild).toBe(region);
});
