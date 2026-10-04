// Subscription-funded gateway rate limiting (O3): fixed 60-second window per
// workspace, counted only for requests actually funded by the subscription
// wallet. Top-up-funded traffic is never limited.
// ponytail: in-memory Map — must move to shared storage (e.g. a Postgres
// counter table) when a second API instance exists, or each instance limits
// independently and the effective cap multiplies.
const WINDOW_MS = 60_000;

type Window = { windowStart: number; count: number };
const windows = new Map<string, Window>();

// Test seam: the gateway asks this for "now" so rollover can be exercised
// without sleeping 60s.
let clock: () => number = Date.now;
export const rateLimitNow = (): number => clock();
export function setRateLimitClock(fn: () => number): void {
  clock = fn;
}

export function resetSubscriptionRateLimits(): void {
  windows.clear();
}

const windowStartOf = (now: number) => Math.floor(now / WINDOW_MS) * WINDOW_MS;

/**
 * Returns underLimit=true (and counts the tentative slot) while the
 * workspace has made fewer than limitPerMinute requests in the current
 * window. Over the limit it does NOT count; the caller funds from topup or
 * returns 429 with retryAfterSec until the window ends. The returned
 * windowStart is the ticket: pass it to uncountSubscriptionRateLimit so a
 * late undo can never touch a newer window's count.
 */
export function checkSubscriptionRateLimit(
  workspaceId: string,
  limitPerMinute: number,
  now: number,
): { underLimit: boolean; retryAfterSec: number; windowStart: number } {
  const windowStart = windowStartOf(now);
  let w = windows.get(workspaceId);
  if (!w || w.windowStart !== windowStart) {
    w = { windowStart, count: 0 };
    windows.set(workspaceId, w);
  }
  if (w.count >= limitPerMinute) {
    return {
      underLimit: false,
      retryAfterSec: Math.max(1, Math.ceil((w.windowStart + WINDOW_MS - now) / 1000)),
      windowStart,
    };
  }
  w.count += 1;
  return { underLimit: true, retryAfterSec: 0, windowStart };
}

/**
 * Return a tentative slot: the reservation ended up NOT funded by the
 * subscription wallet (topup fallback or failed reserve) even though the
 * caller DID count it (underLimit was true). Callers must pass the ticket's
 * windowStart; a mismatch (window already rolled over) is a no-op so a stale
 * undo can never subtract a newer window's requests.
 */
export function uncountSubscriptionRateLimit(workspaceId: string, windowStart: number): void {
  const w = windows.get(workspaceId);
  if (w && w.windowStart === windowStart && w.count > 0) w.count -= 1;
}
