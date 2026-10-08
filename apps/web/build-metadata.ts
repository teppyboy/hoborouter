// Build metadata resolution for the web bundle. Imported only by
// vite.config.ts (config time) — never shipped to the client. Pure so
// tests/build-metadata.test.ts can cover tag / dev / unknown / malformed
// inputs; the git probes are injected by the caller and run once at build
// config time only: no git is invoked at runtime and no .git ships in the
// image (the Docker build context excludes it).
export interface BuildMetadata {
  /** Release version (e.g. "v0.5.9"), or null when the build has none. */
  version: string | null;
  /** Full 40-hex commit SHA, or null when unavailable. */
  revision: string | null;
}

/** Result of the dev-only git probe, injected so this module stays pure. */
export interface DevGitProbeResult {
  /** `git describe --tags --long` output, or null when git is unavailable. */
  describe: string | null;
  /** `git rev-parse HEAD` output, or null when git is unavailable. */
  sha: string | null;
}

export interface BuildMetadataInput {
  /** HBR_APP_VERSION build arg (CI passes the tag name or nearest tag). */
  hbrAppVersion?: string | null;
  /** HBR_GIT_SHA build arg (CI passes the full commit SHA). */
  hbrGitSha?: string | null;
  /** package.json version — "0.0.0" is a placeholder and never claims a release. */
  packageVersion?: string | null;
  /** Dev-only git probe, called lazily and at most once, only when needed. */
  devProbe?: (() => DevGitProbeResult | null) | null;
}

// Upper bound keeps untrusted env/arg strings out of the bundle.
const MAX_LENGTH = 64;
// Release tags and semver-looking versions (with or without the "v" tag
// prefix) only; branch names like "main" must never be presented as a version.
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// `git describe --tags --long` output anchored on a release tag. The
// `-<N>-g<sha>` suffix is a separate mandatory group so the captured prefix is
// the plain tag name even when the tag itself contains dashes.
const DESCRIBE_LONG = /^(v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-\d+-g[0-9a-f]+$/;
// Full commit SHA only — short SHAs are ambiguous, not a revision label.
const FULL_SHA = /^[0-9a-f]{40}$/;

function bounded(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LENGTH ? trimmed : null;
}

function tagFromDescribe(describe: string): string | null {
  const long = describe.match(DESCRIBE_LONG);
  const tag = long?.[1];
  if (tag) return tag;
  // `--abbrev=0` style: the describe output is exactly the nearest tag.
  return RELEASE_TAG.test(describe) ? describe : null;
}

export function resolveBuildMetadata(input: BuildMetadataInput): BuildMetadata {
  // Version precedence: explicit CI build arg → non-placeholder package
  // version → nearest tag from git describe → explicit unknown (the About
  // page renders its "—" fallback).
  let version: string | null = null;
  const argVersion = bounded(input.hbrAppVersion);
  if (argVersion && RELEASE_TAG.test(argVersion)) {
    version = argVersion;
  } else {
    const pkgVersion = bounded(input.packageVersion);
    if (pkgVersion && pkgVersion !== "0.0.0" && RELEASE_TAG.test(pkgVersion)) {
      version = pkgVersion;
    }
  }

  // Revision precedence: explicit CI build arg → dev git rev-parse.
  let revision: string | null = null;
  const argSha = bounded(input.hbrGitSha)?.toLowerCase() ?? null;
  if (argSha && FULL_SHA.test(argSha)) {
    revision = argSha;
  }

  // Probe git only when something is still missing; the probe is cheap but
  // must not run inside Docker builds where .git is absent anyway.
  if (!version || !revision) {
    const probed = input.devProbe?.() ?? null;
    if (probed) {
      if (!version) {
        const describe = bounded(probed.describe);
        const tag = describe ? tagFromDescribe(describe) : null;
        if (tag) version = tag;
      }
      if (!revision) {
        const sha = bounded(probed.sha)?.toLowerCase() ?? null;
        if (sha && FULL_SHA.test(sha)) revision = sha;
      }
    }
  }

  return { version, revision };
}
