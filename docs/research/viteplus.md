# Research: Vite+ (`vp`) official docs

## What investigated

Official docs (viteplus.dev guides), GitHub repo (voidzero-dev/vite-plus), npm registry metadata. No installs, no code changes; only this file.

## Verified current facts (primary sources)

- **Installable, yes.** Two CLIs:
  - Global: `curl -fsSL https://vite.plus | bash` (Windows: `irm https://vite.plus/ps1 | iex`, or `vp-setup.exe`, or Homebrew). Standalone binary, no Node required first. https://viteplus.dev/guide/global-cli
  - Project-local: npm package `vite-plus`; scaffold via `pnpm dlx --package=vite-plus vp create` / `npx --package=vite-plus vp create` / `yarn dlx --package vite-plus vp create` / `bunx --package vite-plus vp create`. https://viteplus.dev/guide/local-cli
- **Latest version: `vite-plus@1.0.0`** (npm registry, verified live JSON). MIT, VoidZero Inc. Repo: https://github.com/voidzero-dev/vite-plus. Engines: node `^22.18.0 || ^24.11.0 || >=26.0.0`. NAPI targets include darwin/linux(gnu+musl)/win, x64+arm64.
- **Toolchain bundled:** Vite (aliased `@voidzero-dev/vite-plus-core@1.0.0`), Vitest `5.0.1`, Oxlint `=1.85.0`, Oxfmt `=0.70.0`, tsdown ^0.23, Vite Task.
- **Bun:** supported as a package manager — `VP_BUN_MANAGER` installer var, `VP_PACKAGE_MANAGER=bun@<version>`, `bunx --package vite-plus vp create`, Bun overrides supported in package.json. Bun is NOT a managed runtime (Node only for `vp env node`). Interpretation from env/install docs.
- **Workspace/monorepo:** root `vite.config.ts` with `lint`/`fmt` blocks + `overrides`; `vp run -r`, `-t`, `--filter` (pnpm syntax), `-w`, `@pkg#task`, `-C <dir>` targeting, `defaultPackage` config. Local `vite-plus` can be installed once at workspace root. https://viteplus.dev/guide/monorepo, /guide/run
- **Commands (verified):**
  - `vp create` (scaffold), `vp migrate` (from Vite/Vitest/ESLint etc.), `vp dev`, `vp build` (apps, Vite+Rolldown), `vp preview`, `vp pack` (libraries via tsdown), `vp test` (Vitest; NOT watch by default — `vp test watch` for watch), `vp lint [--fix] [--type-aware]` (Oxlint; type-aware via tsgolint/TS-Go), `vp fmt` (Oxfmt), `vp check` (fmt+lint+typecheck), `vp run`/`vpr` (task runner, caching, `--cache`, `--parallel`, `--concurrency-limit`, `dependsOn`), `vp install`/`vp add`/`vp remove`, `vp env` (Node/pm pinning, `vp env pin lts`, `vp env off`), `vp toolchain`, `vp upgrade`, `vp implode`.
  - Built-ins vs scripts: `vp test` = built-in Vitest; `vp run test` = your package.json script.
- **Static React build:** scaffold via `vp create` (React template available — interpretation from create guide description); production build = `vp build` (Vite+Rolldown) producing static output for apps. React-specific template list not fetched — see Missing evidence.
- **Config:** everything in `vite.config.ts` (`defineConfig` from `vite-plus`; `lint`, `fmt`, `test`, `run` blocks). Tests import from `vite-plus/test` (no direct vitest dep needed).
- **Manual-install caveats:** must add overrides: `vite: npm:@voidzero-dev/vite-plus-core@latest` and exact `vitest` pin matching bundled version; otherwise duplicate Vite/Vitest instances break (issues #1391, #2356, PR #2365). https://viteplus.dev/guide/local-cli
- **Version caveats:** 0.2.x and earlier lack split-directory layout (installer notice). Migration requires Vite 8+ / Vitest 4.1+ upstream. Preview builds: `VP_PR_VERSION` / `--registry=https://registry-bridge.viteplus.dev`. Global vs project toolchain versions can differ; `vp dev/build/test` delegate to project-local version; `vp toolchain` to inspect.

## Files changed

- Only: `~/.pi/agent/sessions/.../outputs/6fd19879.../viteplus.md` (this file). No files in `/Users/tretrauit/Documents/code/hoborouter` touched.

## Decisions

- None required; research-only task. No tooling installed per instructions.

## Tests performed

- None runnable (no install allowed). Verified version by live npm registry fetch; commands cross-checked against official guide pages.

## Problems / risks

- All docs evidence fetched 1.0.0-era; Vite+ is fresh (1.0.0) — command surface may shift in patch releases.
- React template names and Bun-as-runtime for `vp test`/`vp build` execution not directly verified.
- Installer `vite.plus` pipe-to-bash runs remote script — review before executing.

## Suggested next steps

1. Run `vp create` in `hoborouter` (React template) and inspect generated `vite.config.ts`.
2. Fetch https://viteplus.dev/guide/create for exact React template flags if static-React scaffold details needed.

## Sources (kept)

- https://viteplus.dev/guide/global-cli — install, env vars, version caveats
- https://viteplus.dev/guide/local-cli — npm package, overrides, Bun scaffold
- https://viteplus.dev/guide/run — task runner, filters, caching
- https://viteplus.dev/guide/monorepo — workspace, `-C`, `defaultPackage`
- https://viteplus.dev/guide/test — Vitest 5.0.1, node engines
- https://viteplus.dev/guide/lint — Oxlint, type-aware
- https://registry.npmjs.org/vite-plus/latest — version 1.0.0, deps, engines
- https://github.com/voidzero-dev/vite-plus — repo

## Rejected

- registry.npmjs.org/vite-plus-cli page — appears to be a different/older package name; primary is `vite-plus`.
