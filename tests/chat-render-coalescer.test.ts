// Render coalescer (apps/web/src/pages/chat/turn.ts): pure flush queue for the
// chat send loop. Behavioral contract:
// - 1000 pushed chunks cause at most one flush per injected scheduler tick,
//   and the flushed batch preserves stream order exactly.
// - end() is the exact-final contract: on done/abort/error everything queued
//   flushes synchronously, the pending tick is cancelled, and nothing is
//   dropped or duplicated.
// - The default scheduler is injectable — no invented rAF/fps dependency.
import { describe, test, expect } from "bun:test";
import { createRenderCoalescer } from "../apps/web/src/pages/chat/turn";
import type { StreamDelta } from "../apps/web/src/pages/chat/sse";

const delta = (content: string): StreamDelta => ({ content, reasoning: "" });

/** Manual scheduler: flushes run only when ticks are drained in the test. */
function manualScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule(cb: () => void): () => void {
      pending.push(cb);
      return () => {
        const i = pending.indexOf(cb);
        if (i !== -1) pending.splice(i, 1);
      };
    },
    tick() {
      const cbs = pending.splice(0);
      for (const cb of cbs) cb();
    },
    get scheduledCount() {
      return pending.length;
    },
  };
}

describe("createRenderCoalescer", () => {
  test("1000 chunks flush as ONE ordered batch per scheduled tick", () => {
    const sched = manualScheduler();
    const flushes: StreamDelta[][] = [];
    const c = createRenderCoalescer({
      flush: (batch) => flushes.push(batch),
      schedule: sched.schedule,
    });
    for (let i = 0; i < 1000; i++) c.push(delta(`chunk-${i}`));
    expect(flushes.length).toBe(0); // nothing flushes before the tick
    expect(sched.scheduledCount).toBe(1); // exactly one scheduled tick
    sched.tick();
    expect(flushes.length).toBe(1);
    const batch = flushes[0]!;
    expect(batch.length).toBe(1000);
    expect(batch[0]!.content).toBe("chunk-0");
    expect(batch[999]!.content).toBe("chunk-999");
    expect(batch[500]!.content).toBe("chunk-500");
  });

  test("coalesces across ticks: bounded flush count, order preserved", () => {
    const sched = manualScheduler();
    const flushes: StreamDelta[][] = [];
    const c = createRenderCoalescer({
      flush: (batch) => flushes.push(batch),
      schedule: sched.schedule,
    });
    for (let i = 0; i < 40; i++) c.push(delta(`a${i}`));
    sched.tick();
    for (let i = 0; i < 40; i++) c.push(delta(`b${i}`));
    sched.tick();
    expect(flushes.length).toBe(2);
    expect(flushes[1]![39]!.content).toBe("b39");
  });

  test("end() flushes the exact final batch synchronously on abort/done", () => {
    const sched = manualScheduler();
    const flushes: StreamDelta[][] = [];
    const c = createRenderCoalescer({
      flush: (batch) => flushes.push(batch),
      schedule: sched.schedule,
    });
    for (let i = 0; i < 7; i++) c.push(delta(`t${i}`));
    expect(c.pending).toBe(true);
    c.end(); // terminal: done/abort/error
    expect(sched.scheduledCount).toBe(0); // pending tick cancelled
    expect(flushes.length).toBe(1);
    expect(flushes[0]!.length).toBe(7);
    expect(flushes[0]![6]!.content).toBe("t6");
    expect(c.pending).toBe(false);
  });

  test("end() with nothing queued never flushes; push after end schedules again", () => {
    const sched = manualScheduler();
    const flushes: StreamDelta[][] = [];
    const c = createRenderCoalescer({
      flush: (batch) => flushes.push(batch),
      schedule: sched.schedule,
    });
    c.end();
    expect(flushes.length).toBe(0);
    c.push(delta("after-end"));
    expect(sched.scheduledCount).toBe(1);
    sched.tick();
    expect(flushes.length).toBe(1);
    expect(flushes[0]![0]!.content).toBe("after-end");
  });
});
