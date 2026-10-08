import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, lazyPlugins } from "vite-plus";
import { resolveBuildMetadata } from "./build-metadata.js";

// Fallback version source: this package's own package.json ("0.0.0" is a
// placeholder and is rejected by resolveBuildMetadata — it must never claim a
// release). Injected as build-time globals (see src/lib/version.ts) so UI code
// never hardcodes a version literal that could drift.
const { version: appVersion } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// Dev fallback only: read git once, lazily, at build-config time. CI injects
// HBR_APP_VERSION/HBR_GIT_SHA instead (Docker contexts have no .git), and no
// git is invoked or shipped at runtime.
let devGitProbeResult: { describe: string | null; sha: string | null } | null | undefined;
function devGitProbe() {
  if (devGitProbeResult !== undefined) return devGitProbeResult;
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: __dirname, encoding: "utf8" }).trim();
  // Per-field failure: in a clone with no tags `git describe --tags --long`
  // throws, but `git rev-parse HEAD` still yields a valid revision — nulling
  // the whole probe would discard an available full SHA (Revision: —).
  const safe = (args: string[]): string | null => {
    try {
      return run(args);
    } catch {
      return null;
    }
  };
  devGitProbeResult = {
    describe: safe(["describe", "--tags", "--long"]),
    sha: safe(["rev-parse", "HEAD"]),
  };
  return devGitProbeResult;
}

const { version, revision } = resolveBuildMetadata({
  hbrAppVersion: process.env.HBR_APP_VERSION ?? null,
  hbrGitSha: process.env.HBR_GIT_SHA ?? null,
  packageVersion: appVersion,
  devProbe: devGitProbe,
});

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    // JSON.stringify escapes every injected value; resolveBuildMetadata has
    // already rejected untrusted shapes (branch names, non-hex SHAs, oversize
    // strings) so neither the bundle nor the page can be injected into.
    __APP_VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(revision),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    proxy: {
      // Isolated E2E stacks override with HBR_API_URL (e.g. :3099).
      "/api": process.env.HBR_API_URL ?? "http://localhost:3000",
      "/v1": process.env.HBR_API_URL ?? "http://localhost:3000",
      "/webhooks": process.env.HBR_API_URL ?? "http://localhost:3000",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
}));
