import { existsSync } from "node:fs";
import { test, expect } from "vite-plus/test";
import { VND_CURRENCY, type EpochMs } from "@hoborouter/shared";

// Compile-only: proves EpochMs is exported and usable as a type.
const asEpochMs = (n: number): EpochMs => n;

test("workspace layout exists", () => {
  expect(VND_CURRENCY).toBe("VND");
  expect(asEpochMs(0)).toBe(0);
  for (const dir of ["apps/web", "apps/api", "packages/shared"])
    expect(existsSync(dir), dir).toBe(true);
  expect(existsSync("apps/api/src/index.ts")).toBe(true);
  expect(existsSync("apps/web/src/App.tsx")).toBe(true);
});
