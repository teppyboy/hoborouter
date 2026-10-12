// Subscription-funded gateway rate limiting (O3): fixed 60-second window per
// workspace, counted only for requests actually funded by the subscription
// wallet. Top-up-funded traffic is never limited.
// ponytail: in-memory Map — must move to shared storage (e.g. a Postgres
// counter table) when a second API instance exists, or each instance limits
// independently and the effective cap multiplies.
export const RATE_LIMIT_WINDOW_MS = 60_000;

type Window = { windowStart: number; count: number };

export type RateLimitSlot = {
  underLimit: boolean;
  retryAfterSec: number;
  windowStart: number;
  /** Quota left AFTER this check counted its slot; 0 when over the limit. */
  remaining: number;
};

// Fixed-window limiter factory: one counter space per instance so two limit
// policies on the same workspace (subscription-funded vs ALL traffic under a
// prepaid throughput allowance) never erode each other's counts.
function makeWindowLimiter() {
  const windows = new Map<string, Window>();
  return {
    check(workspaceId: string, limitPerMinute: number, now: number): RateLimitSlot {
      const windowStart = windowStartOf(now);
      let w = windows.get(workspaceId);
      if (!w || w.windowStart !== windowStart) {
        w = { windowStart, count: 0 };
        windows.set(workspaceId, w);
      }
      if (w.count >= limitPerMinute) {
        return {
          underLimit: false,
          retryAfterSec: Math.max(
            1,
            Math.ceil((w.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
          ),
          windowStart,
          remaining: 0,
        };
      }
      w.count += 1;
      return {
        underLimit: true,
        retryAfterSec: 0,
        windowStart,
        remaining: Math.max(0, limitPerMinute - w.count),
      };
    },
    uncount(workspaceId: string, windowStart: number): void {
      const w = windows.get(workspaceId);
      if (w && w.windowStart === windowStart && w.count > 0) w.count -= 1;
    },
    reset(): void {
      windows.clear();
    },
  };
}

const subscriptionLimiter = makeWindowLimiter();
const allowanceLimiter = makeWindowLimiter();

// Test seam: the gateway asks this for "now" so rollover can be exercised
// without sleeping 60s.
let clock: () => number = Date.now;
export const rateLimitNow = (): number => clock();
export function setRateLimitClock(fn: () => number): void {
  clock = fn;
}

export function resetSubscriptionRateLimits(): void {
  subscriptionLimiter.reset();
}

export function resetThroughputAllowanceLimits(): void {
  allowanceLimiter.reset();
}

const windowStartOf = (now: number) =>
  Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

export function checkSubscriptionRateLimit(
  workspaceId: string,
  limitPerMinute: number,
  now: number,
): RateLimitSlot {
  return subscriptionLimiter.check(workspaceId, limitPerMinute, now);
}

/**
 * Return a tentative slot: the reservation ended up NOT funded by the
 * subscription wallet (topup fallback or failed reserve) even though the
 * caller DID count it (underLimit was true). Callers must pass the ticket's
 * windowStart; a mismatch (window already rolled over) is a no-op so a stale
 * undo can never subtract a newer window's requests.
 */
export function uncountSubscriptionRateLimit(workspaceId: string, windowStart: number): void {
  subscriptionLimiter.uncount(workspaceId, windowStart);
}

// Prepaid throughput allowance limiter: same fixed-window algorithm, separate
// counter space. An active allowance caps ALL workspace traffic regardless of
// funding source; the gateway returns the tentative slot on reserve failure
// exactly like the subscription limiter.
export function checkThroughputAllowanceLimit(
  workspaceId: string,
  limitPerMinute: number,
  now: number,
): RateLimitSlot {
  return allowanceLimiter.check(workspaceId, limitPerMinute, now);
}

export function uncountThroughputAllowanceLimit(workspaceId: string, windowStart: number): void {
  allowanceLimiter.uncount(workspaceId, windowStart);
}
