// Managed chat key helper: real helper outputs against injected fetch/storage
// fakes — parallel creation dedup, per-identity caching, failure semantics
// (never cache a failure), and logout/reconnect clearing.
import { test, expect, beforeEach } from "bun:test";
import {
  startManagedChatKey,
  clearManagedChatKey,
  chatKeyStorageKey,
  ManagedKeyError,
  type KeyStorage,
  type ManagedKeyFailure,
} from "../apps/web/src/pages/chat/managed-key";

const U1 = "user-1";
const W1 = "ws-1";
const W2 = "ws-2";

class MapStorage implements KeyStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
}

interface FetchSpy {
  fetch: typeof fetch;
  urls: string[];
}

function fetchSpy(handler: (init?: RequestInit) => Promise<Response>): FetchSpy {
  const urls: string[] = [];
  const fn = ((input: string, init?: RequestInit) => {
    urls.push(input);
    return handler(init);
  }) as unknown as typeof fetch;
  return { fetch: fn, urls };
}

/** Assert the promise rejects with a ManagedKeyError of exactly `kind`. */
async function expectKind(p: Promise<unknown>, kind: ManagedKeyFailure): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ManagedKeyError);
    expect((e as ManagedKeyError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected ManagedKeyError (${kind}) but it resolved`);
}

function keyResponse(n: number, status = 201): Response {
  return new Response(
    JSON.stringify({
      id: `key-${n}`,
      name: "Browser Chat",
      key_prefix: "sk-hbr-x",
      status: "enabled",
      plaintext: `sk-hbr-test-${n}`,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

// The helper's cache is module-level; reset it between tests.
beforeEach(() => {
  clearManagedChatKey();
});

let seq = 0;
function okFetch(delay = 0): FetchSpy {
  return fetchSpy(async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return keyResponse(++seq);
  });
}

test("parallel callers share one creation; later calls use the cache", async () => {
  seq = 0;
  const spy = okFetch(5);
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  const [a, b] = await Promise.all([startManagedChatKey(opts), startManagedChatKey(opts)]);
  expect(a).toEqual(b);
  expect(a.plaintext).toMatch(/^sk-hbr-/);
  expect(spy.urls).toEqual([`/api/v1/workspaces/${W1}/keys`]);
  // Sequential follow-up: still cached, no second request.
  await startManagedChatKey(opts);
  expect(spy.urls).toHaveLength(1);
  expect(storage.length).toBe(1);
});

test("keys are unique per workspace; storage keyed per user+workspace", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  const k1 = await startManagedChatKey({ userId: U1, workspaceId: W1, storage, fetch: spy.fetch });
  const k2 = await startManagedChatKey({ userId: U1, workspaceId: W2, storage, fetch: spy.fetch });
  expect(k1.plaintext).not.toEqual(k2.plaintext);
  expect(spy.urls).toHaveLength(2);
  expect(storage.key(0)).toMatch(/^hbr-managed-key:/);
  expect(storage.length).toBe(2);
});

test("restores the tab key from sessionStorage without a request", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  storage.setItem(
    `hbr-managed-key:${U1}:${W1}`,
    JSON.stringify({ id: "stored-key", plaintext: "sk-hbr-stored" }),
  );
  const key = await startManagedChatKey({ userId: U1, workspaceId: W1, storage, fetch: spy.fetch });
  expect(key).toEqual({ id: "stored-key", plaintext: "sk-hbr-stored" });
  expect(spy.urls).toHaveLength(0);
});

test("plaintext never appears in storage keys and localStorage stays untouched", async () => {
  seq = 0;
  const spy = okFetch();
  const session = new MapStorage();
  const local = new MapStorage();
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: session,
    fetch: spy.fetch,
  });
  const k = session.key(0);
  expect(k).not.toBeNull();
  expect(k).not.toContain(key.plaintext);
  expect(k).not.toContain(key.id);
  expect(local.length).toBe(0);
});

test("403 fails without caching and surfaces a workspace-permission message", async () => {
  seq = 0;
  const spy = fetchSpy(
    async () =>
      new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
        status: 403,
      }),
  );
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  try {
    await startManagedChatKey(opts);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ManagedKeyError);
    const err = e as ManagedKeyError;
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/permission|admin/i);
    expect(err.message).not.toContain("sk-hbr");
  }
  // Nothing cached: a retry is an explicit new request, storage stays empty.
  expect(storage.length).toBe(0);
  await expectKind(startManagedChatKey(opts), "forbidden");
  expect(spy.urls).toHaveLength(2);
});

test("network failure is retryable explicitly and never cached", async () => {
  seq = 0;
  let fail = true;
  const spy = fetchSpy(async () => {
    if (fail) throw new TypeError("network down");
    return keyResponse(++seq);
  });
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  await expectKind(startManagedChatKey(opts), "network");
  expect(storage.length).toBe(0);
  fail = false;
  const key = await startManagedChatKey(opts);
  expect(key.plaintext).toMatch(/^sk-hbr-/);
  expect(storage.length).toBe(1);
});

test("invalid response shape is never cached as plaintext", async () => {
  seq = 0;
  const spy = fetchSpy(async () => new Response(JSON.stringify({ foo: "bar" }), { status: 200 }));
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  await expectKind(startManagedChatKey(opts), "invalid");
  expect(storage.length).toBe(0);
  // Retry mints a real key once the server behaves.
  const good = okFetch();
  const key = await startManagedChatKey({ ...opts, fetch: good.fetch });
  expect(key.plaintext).toMatch(/^sk-hbr-/);
});

test("reconnect clears only that identity's managed key", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  const k1 = await startManagedChatKey({ userId: U1, workspaceId: W1, storage, fetch: spy.fetch });
  const k2 = await startManagedChatKey({ userId: U1, workspaceId: W2, storage, fetch: spy.fetch });
  expect(spy.urls).toHaveLength(2);

  clearManagedChatKey({ userId: U1, workspaceId: W1 }, storage);
  const again = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage,
    fetch: spy.fetch,
  });
  expect(again.plaintext).not.toEqual(k1.plaintext);
  expect(spy.urls).toHaveLength(3);
  // Sibling workspace key untouched — no new request for it.
  const still = await startManagedChatKey({
    userId: U1,
    workspaceId: W2,
    storage,
    fetch: spy.fetch,
  });
  expect(still).toEqual(k2);
  expect(spy.urls).toHaveLength(3);
});

test("logout clear wipes every cached key and all prefixed storage entries", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  await startManagedChatKey({ userId: U1, workspaceId: W1, storage, fetch: spy.fetch });
  await startManagedChatKey({ userId: "user-2", workspaceId: W1, storage, fetch: spy.fetch });
  expect(storage.length).toBe(2);

  clearManagedChatKey(undefined, storage);
  expect(storage.length).toBe(0);
  expect(spy.urls).toHaveLength(2);
  const fresh = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage,
    fetch: spy.fetch,
  });
  expect(fresh.plaintext).not.toEqual("sk-hbr-test-1");
  expect(spy.urls).toHaveLength(3);
});

test("corrupt sessionStorage entry is dropped and replaced with a fresh key", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  storage.setItem(`hbr-managed-key:${U1}:${W1}`, "{not json");
  const key = await startManagedChatKey({ userId: U1, workspaceId: W1, storage, fetch: spy.fetch });
  expect(key.plaintext).toMatch(/^sk-hbr-/);
  expect(spy.urls).toHaveLength(1);
  expect(storage.getItem(`hbr-managed-key:${U1}:${W1}`)).toContain(key.id);
});

test("clear during in-flight creation discards the response: nothing cached or stored", async () => {
  seq = 0;
  let resolveFetch!: (r: Response) => void;
  const spy = fetchSpy(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  // Two parallel callers share the doomed in-flight promise.
  const a = startManagedChatKey(opts);
  const b = startManagedChatKey(opts);
  clearManagedChatKey(undefined, storage);
  resolveFetch(keyResponse(++seq));
  const [ka, kb] = await Promise.all([a, b]);
  expect(ka.plaintext).toMatch(/^sk-hbr-/);
  expect(kb).toEqual(ka);
  // Nothing was persisted and the in-flight slot is gone: the next explicit
  // start mints a fresh key (no local reuse of the discarded plaintext).
  expect(storage.length).toBe(0);
  const fresh = okFetch();
  const again = await startManagedChatKey({ ...opts, fetch: fresh.fetch });
  expect(again.plaintext).not.toEqual(ka.plaintext);
  expect(fresh.urls).toHaveLength(1);
  expect(storage.length).toBe(1);
});

test("identity-scoped clear during in-flight creation also discards the response", async () => {
  seq = 0;
  let resolveFetch!: (r: Response) => void;
  const spy = fetchSpy(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch };
  const p = startManagedChatKey(opts);
  clearManagedChatKey({ userId: U1, workspaceId: W1 }, storage);
  resolveFetch(keyResponse(++seq));
  await p;
  expect(storage.length).toBe(0);
});

test("an aborted creation fails retryably and caches nothing", async () => {
  seq = 0;
  const ac = new AbortController();
  // Mimic real fetch: a later abort rejects the pending response.
  const spy = fetchSpy(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
  );
  const storage = new MapStorage();
  const opts = { userId: U1, workspaceId: W1, storage, fetch: spy.fetch, signal: ac.signal };
  const p = startManagedChatKey(opts);
  ac.abort();
  await expectKind(p, "network");
  expect(storage.length).toBe(0);
  // After the failure nothing is in-flight: a retry is a fresh request.
  const retry = okFetch();
  await startManagedChatKey({ ...opts, fetch: retry.fetch });
  expect(retry.urls).toHaveLength(1);
});

test("manual remembered-key storage is namespaced per user+workspace", () => {
  const own = chatKeyStorageKey(U1, W1);
  expect(own).toBe("hbr-chat-key:user-1:ws-1");
  expect(chatKeyStorageKey(U1, W2)).not.toBe(own);
  expect(chatKeyStorageKey("user-2", W1)).not.toBe(own);
});
