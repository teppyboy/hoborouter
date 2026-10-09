// BarSeries (shared SVG bar chart) behavior contract:
// - honest zero baseline: a zero day renders NO bar (no 2px stub, no fake track)
// - bar heights are proportional to values; formatter receives raw values
// - one metric per chart, sr-only summary + data table parity with the points
// - keyboard roving (Arrow/Home/End) and pointer/touch selection drive one
//   persistent, visible date+value detail
// - narrow containers get a per-bar minimum hit width (horizontal inspection),
//   never sub-pixel compressed bars
import { test, expect, beforeAll, afterAll } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let BarSeries: (typeof import("../apps/web/src/components/chart/bar-series"))["BarSeries"];
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    PointerEvent: win.PointerEvent,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    SVGElement: win.SVGElement,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  ({ BarSeries } = await import("../apps/web/src/components/chart/bar-series"));
  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Point = import("../apps/web/src/components/chart/bar-series").BarSeriesPoint;

const fmt = (v: number) => `F(${v})`;
const baseProps = {
  formatValue: fmt,
  ariaLabel: "Daily requests over the last N days",
  dateHeader: "Date",
  valueHeader: "Value",
};

function mount(points: Point[], extra: Partial<typeof baseProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <BarSeries
        points={points}
        {...baseProps}
        {...extra}
        ariaLabel={extra.ariaLabel ?? baseProps.ariaLabel}
      />,
    ),
  );
  return {
    root,
    container,
    detail: () => container.querySelector("[data-slot='bar-series-detail']")?.textContent ?? "",
    bars: () => [...container.querySelectorAll("rect.chart-bar")],
    table: () => container.querySelector("[data-slot='bar-series-table']")?.textContent ?? "",
    group: () => container.querySelector<HTMLElement>("[data-slot='bar-series-group']")!,
  };
}

function unmount(m: ReturnType<typeof mount>) {
  act(() => m.root.unmount());
  m.container.remove();
}

function key(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

test("honest zero: zero days render no bar, nonzero days render exactly one", () => {
  const m = mount([
    { label: "2025-01-01", value: 0 },
    { label: "2025-01-02", value: 5 },
    { label: "2025-01-03", value: 0 },
  ]);
  try {
    expect(m.bars()).toHaveLength(1);
    // Baseline axis stays visible so zero days read as zero, not missing chart.
    expect(m.container.querySelector("[data-slot='bar-series-baseline']")).not.toBeNull();
  } finally {
    unmount(m);
  }
});

test("all-zero series shows no bars and detail reads zero (no fake activity)", () => {
  const m = mount([
    { label: "2025-01-01", value: 0 },
    { label: "2025-01-02", value: 0 },
  ]);
  try {
    expect(m.bars()).toHaveLength(0);
    expect(m.detail()).toContain("2025-01-02");
    expect(m.detail()).toContain("F(0)");
  } finally {
    unmount(m);
  }
});

test("bar heights are proportional to values", () => {
  const m = mount([
    { label: "2025-01-01", value: 5 },
    { label: "2025-01-02", value: 10 },
  ]);
  try {
    const bars = m.bars();
    expect(bars).toHaveLength(2);
    const heights = bars.map((r) => Number(r.getAttribute("height")));
    const small = heights[0]!;
    const big = heights[1]!;
    expect(big).toBeGreaterThan(small);
    expect(big / small).toBeCloseTo(2, 5);
  } finally {
    unmount(m);
  }
});

test("single-point series renders one bar with axis", () => {
  const m = mount([{ label: "2025-01-01", value: 3 }]);
  try {
    expect(m.bars()).toHaveLength(1);
  } finally {
    unmount(m);
  }
});

test("formatter receives raw point values unchanged (passthrough)", () => {
  const seen: number[] = [];
  const m = mount(
    [
      { label: "2025-01-01", value: 0 },
      { label: "2025-01-02", value: 1234.5 },
    ],
    { formatValue: (v) => (seen.push(v), `F(${v})`) },
  );
  try {
    expect(seen).toContain(0);
    expect(seen).toContain(1234.5);
    expect(m.detail()).toContain("F(1234.5)");
  } finally {
    unmount(m);
  }
});

test("keyboard roving: Arrow/Home/End move the persistent detail", () => {
  const m = mount([
    { label: "2025-01-01", value: 1 },
    { label: "2025-01-02", value: 2 },
    { label: "2025-01-03", value: 3 },
  ]);
  try {
    const g = m.group();
    // Default selection is the most recent day.
    expect(m.detail()).toContain("2025-01-03");
    key(g, "ArrowLeft");
    expect(m.detail()).toContain("2025-01-02");
    key(g, "ArrowLeft");
    key(g, "ArrowLeft");
    expect(m.detail()).toContain("2025-01-01");
    // Clamps at the start.
    key(g, "ArrowLeft");
    expect(m.detail()).toContain("2025-01-01");
    key(g, "End");
    expect(m.detail()).toContain("2025-01-03");
    key(g, "Home");
    expect(m.detail()).toContain("2025-01-01");
    key(g, "ArrowRight");
    expect(m.detail()).toContain("2025-01-02");
  } finally {
    unmount(m);
  }
});

test("pointer/touch select picks the tapped point", () => {
  const m = mount([
    { label: "2025-01-01", value: 1 },
    { label: "2025-01-02", value: 2 },
  ]);
  try {
    const first = m.container.querySelector<SVGElement>("[data-hit-index='0']")!;
    expect(first).not.toBeNull();
    act(() => {
      first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(m.detail()).toContain("2025-01-01");
  } finally {
    unmount(m);
  }
});

test("90 narrow points keep a minimum per-bar hit width (horizontal inspection)", () => {
  const points: Point[] = Array.from({ length: 90 }, (_, i) => ({
    label: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
    value: i % 3,
  }));
  const m = mount(points);
  try {
    const svg = m.container.querySelector("svg")!;
    const width = Number(svg.getAttribute("width"));
    expect(width).toBeGreaterThanOrEqual(90 * 8);
    // The scroll wrapper allows horizontal inspection instead of compression.
    const wrapper = m.container.querySelector("[data-slot='bar-series-scroll']")!;
    expect(wrapper.className).toContain("overflow-x-auto");
  } finally {
    unmount(m);
  }
});

test("sr-only data table has one row per point (parity with the plot)", () => {
  const points: Point[] = [
    { label: "2025-01-01", value: 0 },
    { label: "2025-01-02", value: 7 },
  ];
  const m = mount(points);
  try {
    const table = m.container.querySelector("[data-slot='bar-series-table']")!;
    expect(table.tagName).toBe("TABLE");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(points.length);
    expect(m.table()).toContain("2025-01-02");
    expect(m.table()).toContain("F(7)");
    expect(m.table()).toContain("F(0)");
  } finally {
    unmount(m);
  }
});

test("persistent detail is visible text (not hover-only), defaulting to the last day", () => {
  const m = mount([
    { label: "2025-01-01", value: 1 },
    { label: "2025-01-02", value: 4 },
  ]);
  try {
    const detail = m.container.querySelector("[data-slot='bar-series-detail']")!;
    expect(detail.className).not.toContain("sr-only");
    expect(m.detail()).toContain("2025-01-02");
    expect(m.detail()).toContain("F(4)");
  } finally {
    unmount(m);
  }
});
