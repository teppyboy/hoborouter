// Build metadata resolution (vite.config.ts input): pure unit tests covering
// the tag build, the workflow_dispatch fallback, the dev fallback and
// malformed/untrusted input. No source/config text assertions — behavior only.
import { describe, test, expect } from "bun:test";
import { resolveBuildMetadata } from "../apps/web/build-metadata.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

describe("resolveBuildMetadata", () => {
  test("tag workflow: ref name is the version, github.sha the revision", () => {
    expect(
      resolveBuildMetadata({
        hbrAppVersion: "v0.5.9",
        hbrGitSha: SHA,
        packageVersion: "0.0.0",
      }),
    ).toEqual({ version: "v0.5.9", revision: SHA });
  });

  test("placeholder 0.0.0 package version never claims a release", () => {
    expect(resolveBuildMetadata({ packageVersion: "0.0.0" })).toEqual({
      version: null,
      revision: null,
    });
  });

  test("non-placeholder package version is used when no build arg", () => {
    expect(resolveBuildMetadata({ packageVersion: "1.2.3" })).toEqual({
      version: "1.2.3",
      revision: null,
    });
  });

  test("workflow_dispatch on main: branch name is not shown as a semver version", () => {
    // devProbe stands in for the CI git-describe fallback.
    expect(
      resolveBuildMetadata({
        hbrAppVersion: "main",
        hbrGitSha: SHA,
        devProbe: () => ({ describe: "v0.5.9-0-g9aaecfb", sha: "deadbeef" }),
      }),
    ).toEqual({ version: "v0.5.9", revision: SHA });
  });

  test("dev fallback: git describe tag + full rev-parse sha (no env build args)", () => {
    const devSha = "9aaecfbc12af8d45e8ebf73e2a19c15f03b8a4cd";
    expect(
      resolveBuildMetadata({
        packageVersion: "0.0.0",
        devProbe: () => ({ describe: "v0.5.9-0-g9aaecfb", sha: devSha }),
      }),
    ).toEqual({ version: "v0.5.9", revision: devSha });
  });

  test("describe output without a valid tag contributes no version", () => {
    expect(
      resolveBuildMetadata({
        packageVersion: "0.0.0",
        devProbe: () => ({ describe: "9aaecfb", sha: null }),
      }),
    ).toEqual({ version: null, revision: null });
  });

  test("tagless dev clone keeps the rev-parse SHA (probe fields independent)", () => {
    expect(
      resolveBuildMetadata({
        packageVersion: "0.0.0",
        devProbe: () => ({ describe: null, sha: SHA }),
      }),
    ).toEqual({ version: null, revision: SHA });
  });

  test("unknown fallback is explicit null when no probe and no args", () => {
    expect(resolveBuildMetadata({ hbrAppVersion: "", hbrGitSha: "" })).toEqual({
      version: null,
      revision: null,
    });
  });

  test("malformed and oversized build args are rejected", () => {
    expect(
      resolveBuildMetadata({
        hbrAppVersion: "v9.9.9 <script>alert(1)</script>",
        hbrGitSha: "not-a-sha",
        packageVersion: "0.0.0",
      }),
    ).toEqual({ version: null, revision: null });
    expect(resolveBuildMetadata({ hbrAppVersion: "v".repeat(80) })).toEqual({
      version: null,
      revision: null,
    });
  });

  test("only a full 40-hex commit SHA counts as the revision", () => {
    expect(resolveBuildMetadata({ hbrGitSha: SHA.slice(0, 7) })).toEqual({
      version: null,
      revision: null,
    });
    expect(resolveBuildMetadata({ hbrGitSha: SHA.toUpperCase() })).toEqual({
      version: null,
      revision: SHA,
    });
  });

  test("tag-prefixed version must still look like a release", () => {
    expect(resolveBuildMetadata({ hbrAppVersion: "release-candidate" })).toEqual({
      version: null,
      revision: null,
    });
  });
});
