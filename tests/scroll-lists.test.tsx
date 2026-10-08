// Scroll containment for bounded list panels: DataTable's scroll option and
// ScrollPanel must expose a labelled, keyboard-scrollable region (WCAG 2.1.1)
// wrapping the table, while the DataTable search input stays outside the
// scroll region. Asserts ARIA roles/props, not CSS text.
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
  const doc = domWindow.document;
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

  container = doc.createElement("div");
  doc.body.appendChild(container);
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
  // Async act drains the microtask TanStack uses to sync table state, keeping
  // the run warning-free.
  await act(async () => {
    root.render(node);
  });
}

test("DataTable with scroll prop wraps the table in a labelled keyboard-scrollable region", async () => {
  await render(
    <DataTable
      columns={columns}
      data={[{ name: "alpha" }, { name: "beta" }]}
      scroll={{ label: "Keys list" }}
    />,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("aria-label")).toBe("Keys list");
  expect(region?.getAttribute("tabindex")).toBe("0");
  expect(region?.querySelector("thead")).not.toBeNull();
  expect(region?.textContent).toContain("alpha");
  expect(region?.textContent).toContain("beta");
});

test("DataTable without scroll prop renders no scroll region", async () => {
  await render(<DataTable columns={columns} data={[{ name: "alpha" }]} />);
  expect(container.querySelector('[role="region"]')).toBeNull();
  expect(container.querySelector("thead")).not.toBeNull();
});

test("DataTable scroll region keeps table interactive and search outside", async () => {
  await render(
    <DataTable
      columns={columns}
      data={[{ name: "alpha" }, { name: "beta" }]}
      scroll={{ label: "Payments list" }}
    />,
  );
  const region = container.querySelector<HTMLElement>('[role="region"]');
  expect(region).not.toBeNull();
  const search = container.querySelector<HTMLInputElement>('input[placeholder="Search…"]');
  expect(search).toBeNull();
  expect(region?.contains(container.querySelector("thead")!)).toBe(true);
  // Region children stay interactive: sorting via the header button works.
  const headerButton = () =>
    container.querySelector<HTMLButtonElement>('[role="region"] thead button');
  await act(async () => {
    headerButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const cells = region?.querySelectorAll("tbody td");
  expect(cells?.length).toBe(2);
  // First click sorts ascending: alpha before beta.
  expect(cells?.[0]?.textContent).toBe("alpha");
  await act(async () => {
    headerButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // Second click toggles to descending: beta first.
  const after = region?.querySelectorAll("tbody td");
  expect(after?.[0]?.textContent).toBe("beta");
});

test("ScrollPanel exposes a labelled keyboard-scrollable region", async () => {
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
  expect(region?.querySelector("thead")).not.toBeNull();
});
