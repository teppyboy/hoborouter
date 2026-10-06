import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, lazyPlugins } from "vite-plus";

// Single source of truth for the app version: this package's own package.json.
// Injected as a build-time global (see src/lib/version.ts) so UI code never
// hardcodes a version literal that could drift.
const { version: appVersion } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
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
