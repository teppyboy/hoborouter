// Workspace query contract (lib/workspace-queries.ts):
// - keyed by session identity: switching user gets a fresh cache entry, never
//   the previous user's workspace list
// - the fetch signal is forwarded to api(): unmounting actually aborts
// Behavior rendered through React (useQuery), not asserted from source.
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "Event",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
] as const;

const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], unknown>> = {};
let jsdomWindow: { close: () => void } | null = null;
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

const sessionRef: { current: { user?: { id: string } } | undefined } = { current: undefined };
const apiCalls: { path: string; signal: AbortSignal | null | undefined }[] = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<unknown> = async () => [];

mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({ data: sessionRef.current }),
}));
mock.module("../apps/web/src/lib/api", () => ({
  api: (path: string, init?: RequestInit) => {
    apiCalls.push({ path, signal: init?.signal });
    return apiImpl(path, init);
  },
}));
mock.module("../apps/web/src/lib/workspace", () => ({
  useWorkspaceStore: (
    selector: (s: { workspaceId: string | null; setWorkspaceId: (id: string) => void }) => unknown,
  ) => selector({ workspaceId: null, setWorkspaceId: () => {} }),
}));

beforeAll(async () => {
  const win = new JSDOM("<!doctype html><html><body></body></html>").window;
  const raf = (id: number) => setTimeout(id as unknown as () => void, 0);
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
  };
  for (const k of GLOBAL_KEYS) originals[k] = (globalThis as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(values)) (globalThis as Record<string, unknown>)[k] = v;
  jsdomWindow = win as unknown as { close: () => void };
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
  ({ useWorkspaces } = await import("../apps/web/src/lib/workspace-queries"));
});

afterAll(() => {
  mock.restore();
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useWorkspaces: any;

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 0)); // react scheduler ticks on macrotasks
  }
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient();
  let result: { data?: unknown; isSuccess: boolean; isPending: boolean };
  function Probe() {
    result = useWorkspaces();
    return null;
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  const tree = (
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>
  );
  return {
    qc,
    get result() {
      return result;
    },
    // Re-render the tree so the hook re-reads the (externally mutated) session.
    rerender: async () => {
      await act(async () => {
        root.render(tree);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("useWorkspaces keys by session identity: user switch refetches, never serves old list", async () => {
  apiCalls.length = 0;
  sessionRef.current = { user: { id: "user-1" } };
  apiImpl = async () => [{ id: "ws-a", name: "A" }];

  const h = await mount();
  for (let i = 0; i < 20 && !h.result.isSuccess; i++) await flush();
  expect(h.result.isSuccess).toBe(true);
  expect(h.result.data).toEqual([{ id: "ws-a", name: "A" }]);
  expect(apiCalls.length).toBe(1);

  // Identity switch: new user id must force a fresh fetch and serve its data.
  apiImpl = async () => [{ id: "ws-b", name: "B" }];
  sessionRef.current = { user: { id: "user-2" } };
  await h.rerender();
  for (
    let i = 0;
    i < 20 && (h.result.data as { id: string }[] | undefined)?.[0]?.id !== "ws-b";
    i++
  ) {
    await flush();
  }
  expect(apiCalls.length).toBe(2);
  expect(h.result.data).toEqual([{ id: "ws-b", name: "B" }]);
  // The old identity's cache entry is not the one being observed.
  expect(h.qc.getQueryData(["workspaces", "user-1"]) as unknown).toEqual([
    { id: "ws-a", name: "A" },
  ]);
  expect(h.qc.getQueryData(["workspaces", "user-2"]) as unknown).toEqual([
    { id: "ws-b", name: "B" },
  ]);
  await h.unmount();
});

test("useWorkspaces forwards the signal: unmount aborts the in-flight request", async () => {
  apiCalls.length = 0;
  sessionRef.current = { user: { id: "abort-user" } };
  apiImpl = () => new Promise(() => {}); // never resolves

  const h = await mount();
  await flush();
  expect(apiCalls.length).toBe(1);
  const signal = apiCalls[0]?.signal;
  expect(signal).toBeDefined();
  await h.unmount();
  await flush();
  expect(signal?.aborted).toBe(true);
});
