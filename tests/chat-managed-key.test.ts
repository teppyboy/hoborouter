// Managed chat key helper: real helper outputs against injected fetch/storage
// fakes — parallel creation dedup, per-identity caching, failure semantics
// (never cache a failure), and logout/reconnect clearing.
import { test, expect, beforeEach } from "bun:test";
import {
  startManagedChatKey,
  clearManagedChatKey,
  deviceChatName,
  deviceLabel,
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

class UnavailableStorage implements KeyStorage {
  get length(): number {
    return 0;
  }
  key(): string | null {
    return null;
  }
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error("storage unavailable");
  }
  removeItem(): void {
    throw new Error("storage unavailable");
  }
}

interface FetchSpy {
  fetch: typeof fetch;
  urls: string[];
  bodies: unknown[];
}

function fetchSpy(handler: (init?: RequestInit) => Promise<Response>): FetchSpy {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fn = ((input: string, init?: RequestInit) => {
    urls.push(input);
    bodies.push(init?.body);
    return handler(init);
  }) as unknown as typeof fetch;
  return { fetch: fn, urls, bodies };
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
      purpose: "chat",
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

test("persists the browser key and reuses it in a new browser session without minting", async () => {
  seq = 0;
  const spy = okFetch();
  const local = new MapStorage(); // stands in for localStorage
  const opts = { userId: U1, workspaceId: W1, storage: local, fetch: spy.fetch };
  const first = await startManagedChatKey(opts);
  expect(spy.urls).toHaveLength(1);
  expect(local.getItem(`hbr-managed-key:${U1}:${W1}`)).toContain(first.id);
  // New browser session: memory cache cleared (clearManagedChatKey() touches
  // only globals, not the injected store), storage survives — the stored key
  // is reused, never a second POST.
  clearManagedChatKey();
  const again = await startManagedChatKey(opts);
  expect(again).toEqual(first);
  expect(spy.urls).toHaveLength(1);
});

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
  expect(spy.urls).toEqual([`/api/v1/workspaces/${W1}/chat-key`]);
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
  // Legacy persisted record (no purpose metadata) restores as generic.
  expect(key).toEqual({ id: "stored-key", plaintext: "sk-hbr-stored", purpose: "generic" });
  expect(spy.urls).toHaveLength(0);
});

test("legacy stored key without purpose restores as generic; stored chat purpose is kept", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  storage.setItem(
    `hbr-managed-key:${U1}:${W1}`,
    JSON.stringify({ id: "legacy", plaintext: "sk-hbr-legacy" }),
  );
  storage.setItem(
    `hbr-managed-key:${U1}:${W2}`,
    JSON.stringify({ id: "chatkey", plaintext: "sk-hbr-chat", purpose: "chat" }),
  );
  const legacy = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage,
    fetch: spy.fetch,
  });
  expect(legacy.purpose).toBe("generic");
  clearManagedChatKey();
  const chat = await startManagedChatKey({
    userId: U1,
    workspaceId: W2,
    storage,
    fetch: spy.fetch,
  });
  expect(chat.purpose).toBe("chat");
  expect(spy.urls).toHaveLength(0); // neither restore mints
});

test("a /chat-key response without purpose:'chat' is never trusted (invalid)", async () => {
  seq = 0;
  for (const purpose of [undefined, "generic", "admin", 42]) {
    const spy = fetchSpy(
      async () =>
        new Response(
          JSON.stringify({
            id: "k",
            plaintext: "sk-hbr-x",
            ...(purpose === undefined ? {} : { purpose }),
          }),
          { status: 200 },
        ),
    );
    await expectKind(
      startManagedChatKey({
        userId: U1,
        workspaceId: W1,
        storage: new MapStorage(),
        fetch: spy.fetch,
      }),
      "invalid",
    );
  }
});

test("plaintext never appears in storage key names; only the target store is written", async () => {
  seq = 0;
  const spy = okFetch();
  const session = new MapStorage();
  const local = new MapStorage();
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: local,
    fetch: spy.fetch,
  });
  const k = local.key(0);
  expect(k).toBe(`hbr-managed-key:${U1}:${W1}`);
  expect(k).not.toContain(key.plaintext);
  expect(k).not.toContain(key.id);
  expect(local.length).toBe(1);
  expect(session.length).toBe(0);
});

test("stored browser keys are scoped per identity: another user never reuses one", async () => {
  seq = 0;
  const spy = okFetch();
  const storage = new MapStorage();
  const u1 = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage,
    fetch: spy.fetch,
  });
  expect(spy.urls).toHaveLength(1);
  clearManagedChatKey(); // fresh memory, storage intact
  const u2 = await startManagedChatKey({
    userId: "user-2",
    workspaceId: W1,
    storage,
    fetch: spy.fetch,
  });
  // A different user gets its own key (own POST), never user-1's stored copy.
  expect(spy.urls).toHaveLength(2);
  expect(u2.plaintext).not.toEqual(u1.plaintext);
  expect(storage.getItem(`hbr-managed-key:user-2:${W1}`)).toContain(u2.id);
});

test("storage unavailable: in-memory key serves this tab without persistence", async () => {
  seq = 0;
  const spy = okFetch();
  const opts = {
    userId: U1,
    workspaceId: W1,
    storage: new UnavailableStorage(),
    fetch: spy.fetch,
  };
  const key = await startManagedChatKey(opts);
  expect(key.plaintext).toMatch(/^sk-hbr-/);
  expect(spy.urls).toHaveLength(1);
  // Same tab: memory cache serves without a second POST despite no storage.
  const again = await startManagedChatKey(opts);
  expect(again).toEqual(key);
  expect(spy.urls).toHaveLength(1);
});

test("unwritable primary store falls back to the next store and restores from it", async () => {
  seq = 0;
  const spy = okFetch();
  const fallback = new MapStorage();
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: [new UnavailableStorage(), fallback],
    fetch: spy.fetch,
  });
  expect(fallback.length).toBe(1);
  clearManagedChatKey(); // fresh memory
  const again = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: [new UnavailableStorage(), fallback],
    fetch: spy.fetch,
  });
  expect(again).toEqual(key);
  expect(spy.urls).toHaveLength(1);
});

test("minted key uses the caller-provided device name in the POST body", async () => {
  seq = 0;
  const spy = okFetch();
  await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: new MapStorage(),
    fetch: spy.fetch,
    name: "Chat - iPhone 13",
  });
  expect(spy.bodies).toHaveLength(1);
  expect(JSON.parse(String(spy.bodies[0]))).toEqual({ name: "Chat - iPhone 13" });
});

test("deviceLabel derives a safe display label from the User-Agent alone", () => {
  expect(
    deviceLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    ),
  ).toBe("iPhone");
  expect(
    deviceLabel(
      "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ),
  ).toBe("Android SM-G991B");
  expect(
    deviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
  ).toBe("Windows");
  expect(
    deviceLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
  ).toBe("Mac");
  expect(deviceLabel("")).toBe("Browser");
  expect(deviceChatName("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)")).toBe(
    "Chat - iPhone",
  );
  // Allowlist sanitization: hostile UA text cannot inject markup into a name.
  expect(deviceLabel("Mozilla/5.0 (Linux; Android 13; <script>x</script>) Chrome/120")).toBe(
    "Android scriptxscript",
  );
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
