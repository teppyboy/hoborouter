// Member chat key purpose + storage rules (apps/web/src/pages/chat/
// managed-key.ts): the server picks the purpose (chat_member for members in
// workspaces with an enabled chat policy — server-canonical, the client never
// sends a purpose), member plaintext lives in session storage ONLY (never
// localStorage, never restored from it), and legacy generic/chat records are
// untouched. No quota logic exists client-side; the gateway is the authority.
import { test, expect } from "bun:test";
import {
  clearManagedChatKey,
  startManagedChatKey,
  deviceChatName,
  type KeyStorage,
  type ManagedKey,
} from "../apps/web/src/pages/chat/managed-key";

const U1 = "user-1";
const W1 = "ws-1";

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
  dump(): Map<string, string> {
    return this.map;
  }
}

const mintResponse = (purpose: string) =>
  new Response(
    JSON.stringify({ id: "key-1", plaintext: "sk-hbr-membersecret123456", purpose }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function fetchReturning(res: Response): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body !== undefined) bodies.push(init.body);
    return res.clone();
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}

test("mints a member key when the server says chat_member (client sends no purpose)", async () => {
  clearManagedChatKey();
  const { fetch, bodies } = fetchReturning(mintResponse("chat_member"));
  const key = await startManagedChatKey({ userId: U1, workspaceId: W1, fetch });
  expect(key.purpose).toBe("chat_member");
  const body = JSON.parse(String(bodies[0])) as { purpose?: unknown; name?: string };
  expect(body.purpose).toBeUndefined(); // server-canonical, never client-declared
  expect(body.name).toBe(deviceChatName());
});

test("a chat_member key persists ONLY to the session slot, never the persistent slot", async () => {
  clearManagedChatKey();
  const persistent = new MapStorage(); // stands in for localStorage
  const session = new MapStorage(); // stands in for sessionStorage
  const { fetch } = fetchReturning(mintResponse("chat_member"));
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: [persistent, session],
    fetch,
  });
  expect(key.purpose).toBe("chat_member");
  expect(persistent.dump().size).toBe(0);
  expect(session.dump().size).toBe(1);
});

test("a chat_member key found in the persistent slot is dropped, never restored", async () => {
  clearManagedChatKey();
  const persistent = new MapStorage();
  const session = new MapStorage();
  const record = JSON.stringify({
    id: "stale-member-key",
    plaintext: "sk-hbr-membersecret123456",
    purpose: "chat_member",
  });
  persistent.setItem("hbr-managed-key:" + U1 + ":" + W1, record);
  const { fetch } = fetchReturning(
    mintResponse("chat_member"),
  );
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: [persistent, session],
    fetch,
  });
  // Did NOT restore the persistent-slot member key: minted a fresh one.
  expect(key.id).toBe("key-1");
  expect(persistent.dump().size).toBe(0); // the illegal entry was dropped
  expect(session.dump().size).toBe(1);
});

test("legacy records without purpose still restore as generic (single-store seam unchanged)", async () => {
  clearManagedChatKey();
  const legacy = new MapStorage();
  legacy.setItem(
    "hbr-managed-key:" + U1 + ":" + W1,
    JSON.stringify({ id: "old-key", plaintext: "sk-hbr-legacysecret12345" }),
  );
  const key: ManagedKey = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: legacy,
    fetch: (() => {
      throw new Error("must not mint — restored instead");
    }) as unknown as typeof fetch,
  });
  expect(key.purpose).toBe("generic");
  expect(key.id).toBe("old-key");
});

test("chat-purpose keys keep their legacy persistence (persistent slot allowed)", async () => {
  clearManagedChatKey();
  const persistent = new MapStorage();
  const session = new MapStorage();
  const { fetch } = fetchReturning(mintResponse("chat"));
  const key = await startManagedChatKey({
    userId: U1,
    workspaceId: W1,
    storage: [persistent, session],
    fetch,
  });
  expect(key.purpose).toBe("chat");
  expect(persistent.dump().size).toBe(1); // chat keys still use the persistent slot
});

test("a mint response with a foreign purpose is never trusted", async () => {
  clearManagedChatKey();
  const { fetch } = fetchReturning(mintResponse("generic"));
  let caught: unknown;
  try {
    await startManagedChatKey({ userId: U1, workspaceId: W1, fetch });
  } catch (e) {
    caught = e;
  }
  expect((caught as Error).message).toContain("unexpected response");
});
