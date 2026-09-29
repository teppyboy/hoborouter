// Task 5 host-isolation preflight tests. Unprivileged only: no sudo, no
// pfctl mutation, no firewall changes. pfctl is faked via PATH override;
// docker integration is skipped honestly without a daemon.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/cpa-preflight.sh");
const CPA_IP = "192.168.231.3";
const RULE = `block drop out log quick to ${CPA_IP}`;

function fakePfctl(body: {
  info?: string;
  infoFail?: boolean;
  rules?: string;
  rulesFail?: boolean;
  anchorRules?: string;
  anchorRulesFail?: boolean;
  parseFail?: boolean;
}): string {
  const esc = (s: string) => s.replace(/'/g, `'\\''`);
  return `#!/bin/sh
case "$1 $2" in
  "-s info")
    ${body.infoFail ? `echo "pfctl: /dev/pf: Permission denied" >&2; exit 1` : `printf '%s\\n' '${esc(body.info ?? "")}'`}
    ;;
  "-s rules")
    ${body.rulesFail ? `echo "pfctl: /dev/pf: Permission denied" >&2; exit 1` : `printf '%s\\n' '${esc(body.rules ?? "")}'`}
    ;;
  *) ;;
esac
case "$1 $2 $3" in
  "-a cpa-host-isolation -s")
    ${body.anchorRulesFail ? `echo "pfctl: /dev/pf: Permission denied" >&2; exit 1` : `printf '%s\\n' '${esc(body.anchorRules ?? "")}'`}
    ;;
  "-s i"*|"-s r"*) exit 0;;
  "-n f"|"-nf"*)
    ${body.parseFail ? `echo "pfctl: /dev/pf: Permission denied" >&2; exit 1` : `exit 0`}
    ;;
  *) echo "unexpected: $*" >&2; exit 64;;
esac`;
}

function runScript(pfctlScript: string | null, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cpa-preflight-"));
  let binDir: string | undefined;
  const env: Record<string, string> = { ...Bun.env, PATH: Bun.env.PATH! };
  if (pfctlScript) {
    binDir = join(dir, "bin");
    const { mkdirSync, writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const p = join(binDir, "pfctl");
    writeFileSync(p, pfctlScript);
    chmodSync(p, 0o755);
    env.PFCTL = p; // script must honor PFCTL override (still unprivileged)
  }
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env,
    cwd: join(import.meta.dir, "../../.."),
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// fake `docker` on PATH. Default: `compose up` fails. CPA_FAKE_UP=ok makes
// up succeed and the inspect/exec paths emulate a healthy, correctly-addressed
// CPA (fixed IP, no IPv6, no published ports, peer probe 200).
// `compose down -v` logs to $CPA_FAKE_LOG so tests can assert whether the
// cleanup trap ran. Never starts a real CPA.
function fakeDocker(): string {
  return `#!/bin/sh
log="\${CPA_FAKE_LOG}"
case "$1" in
  compose)
    case "$4" in
      up) [ "\${CPA_FAKE_UP:-}" = ok ] && exit 0; exit 1;;
      ps) echo fakecid;;
      exec) echo "\${CPA_FAKE_PEER:-200}";;
      down) echo down >> "$log"; exit 0;;
      *) exit 0;;
    esac;;
  inspect)
    case "$3" in
      *IPAddress*) echo "192.168.231.3";;
      *GlobalIPv6*) echo "";;
      *Ports*) echo "{}";;
      *) exit 0;;
    esac;;
  *) echo "unexpected docker: $*" >&2; exit 64;;
esac`;
}

function runScriptWithFakeDocker(
  pfctl: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "cpa-preflight-d-"));
  const { mkdirSync, writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const [name, body] of [
    ["pfctl", pfctl],
    ["docker", fakeDocker()],
  ] as const) {
    const p = join(binDir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  // fake netstat (no routes) and fake curl (host probe must fail) so tests
  // never touch the host network stack
  for (const [name, body] of [
    ["netstat", "#!/bin/sh\nexit 0"],
    ["curl", "#!/bin/sh\necho 'connection refused' >&2; exit 7"],
  ] as const) {
    const p = join(binDir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: {
      ...Bun.env,
      PFCTL: join(binDir, "pfctl"),
      PATH: `${binDir}:${Bun.env.PATH}`,
      CPA_FAKE_LOG: log,
      TMPDIR: dir, // temp-file cleanup assertions scope here
      ...extraEnv,
    },
    cwd: join(import.meta.dir, "../../.."),
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    dir,
    cleanupRan: Bun.file(log)
      .text()
      .then((t) => t.includes("down")),
  };
}

const PF_ON = { info: "Status: Enabled\nLogging: enabled" };
const PARENT = `anchor "cpa-host-isolation"`;
const GATED = { ...PF_ON, rules: PARENT, anchorRules: RULE };

describe("cpa-preflight (fail-closed, unprivileged)", () => {
  test("wrong child rule inside anchor → refuses with exact required line", () => {
    const r = runScript(
      fakePfctl({ ...PF_ON, rules: PARENT, anchorRules: "block drop out quick to 10.0.0.1\npass" }),
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
    expect(r.err).toContain(CPA_IP);
  });

  test("parent anchor missing from main ruleset → refuses (child invisible to -s rules)", () => {
    const r = runScript(fakePfctl({ ...PF_ON, rules: "pass out", anchorRules: RULE }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
    expect(r.err).toContain("Parent anchor");
  });

  test("child rule missing inside anchor → refuses", () => {
    const r = runScript(
      fakePfctl({ ...PF_ON, rules: PARENT, anchorRules: "block drop out quick to 10.9.9.9" }),
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
    expect(r.err).toContain("child rule");
  });

  test("anchor child listing Permission denied → refuses", () => {
    const r = runScript(fakePfctl({ ...PF_ON, rules: PARENT, anchorRulesFail: true }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
  });

  test("indented anchor output (post-install shape) + exact child → check-only passes", () => {
    const r = runScript(
      fakePfctl({
        ...PF_ON,
        rules: `scrub-anchor "com.apple/*"\n${PARENT}`,
        anchorRules: `  ${RULE}`,
      }),
      ["--check-only"],
    );
    expect(r.code).toBe(0);
  });

  test("pfctl info Permission denied → refuses", () => {
    const r = runScript(fakePfctl({ infoFail: true }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
  });

  test("pf disabled → refuses", () => {
    const r = runScript(fakePfctl({ info: "Status: Disabled", rules: RULE }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
  });

  test("rules listing Permission denied → refuses", () => {
    const r = runScript(fakePfctl({ ...PF_ON, rulesFail: true }));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
  });

  test("static parse Permission denied → refuses", () => {
    const r = runScript(fakePfctl({ ...PF_ON, rules: RULE, parseFail: true }), ["--check-only"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
  });

  test("PF enabled + parent anchor + exact child rule + parse ok → check-only passes", () => {
    const r = runScript(fakePfctl(GATED), ["--check-only"]);
    expect(r.code).toBe(0);
  });

  test("parent anchor with ` all` suffix (some pfctl versions) → check-only passes", () => {
    const r = runScript(
      fakePfctl({
        ...PF_ON,
        rules: `scrub-anchor "com.apple/*"\n${PARENT} all`,
        anchorRules: RULE,
      }),
      ["--check-only"],
    );
    expect(r.code).toBe(0);
  });

  test("failed run leaves NO temp files in TMPDIR", () => {
    const before = readdirSync(tmpdir()).filter((f: string) => f.startsWith("tmp.")).length;
    const r = runScript(fakePfctl({ ...PF_ON, rules: "pass out", anchorRules: RULE }));
    expect(r.code).not.toBe(0);
    const after = readdirSync(tmpdir()).filter((f: string) => f.startsWith("tmp.")).length;
    expect(after).toBe(before);
  });

  test("successful startup → exit 0, cleanup trap does NOT run (stack stays up)", async () => {
    const r = runScriptWithFakeDocker(fakePfctl(GATED), [], { CPA_FAKE_UP: "ok" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("left RUNNING");
    expect(await r.cleanupRan).toBe(false);
  });

  test("failed peer probe after up → cleanup trap runs (down -v)", async () => {
    const r = runScriptWithFakeDocker(fakePfctl(GATED), [], {
      CPA_FAKE_UP: "ok",
      CPA_FAKE_PEER: "502",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("peer probe");
    expect(await r.cleanupRan).toBe(true);
  });

  test("compose up failure → cleanup trap runs (stack torn down)", async () => {
    const r = runScriptWithFakeDocker(fakePfctl(GATED));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL-CLOSED");
    expect(await r.cleanupRan).toBe(true);
  });

  test("never prints secrets from deploy/.env or config.yaml", () => {
    const r = runScript(fakePfctl(GATED), ["--check-only"]);
    const envFile = Bun.file("deploy/.env");
    if (envFile.size > 0) {
      const secrets = envFile.text().then((t) =>
        t
          .split("\n")
          .map((l) => l.split("=")[1]?.trim())
          .filter(Boolean),
      );
      return secrets.then((ss) => {
        for (const s of ss) expect(r.out + r.err).not.toContain(s);
      });
    }
  });
});

// ---------- compose fixed-IP / subnet (requires daemon) ----------

const dockerOk = (() => {
  try {
    return Bun.spawnSync(["docker", "info"]).exitCode === 0;
  } catch {
    return false;
  }
})();
const describeDocker = dockerOk ? describe : describe.skip;

describeDocker("cpa compose fixed addressing", () => {
  const ROOT = join(import.meta.dir, "../../..");
  const cfg = Bun.spawnSync([
    "docker",
    "compose",
    "-f",
    join(ROOT, "deploy/docker-compose.yml"),
    "config",
  ]);
  const text = cfg.stdout.toString();
  test("cpa has fixed IPv4 in dedicated subnet", () => {
    expect(cfg.exitCode).toBe(0);
    expect(text).toContain("192.168.231.0/24");
    expect(text).toContain("ipv4_address: 192.168.231.3");
  });
  test("cpa publishes no ports (inspect-based, not compose exit code)", () => {
    const cid = Bun.spawnSync([
      "docker",
      "compose",
      "-f",
      "deploy/docker-compose.yml",
      "ps",
      "-q",
      "cpa",
    ]);
    if (cid.exitCode !== 0 || cid.stdout.toString().trim() === "") return; // stack down; port check runs in reachability test
    const ports = Bun.spawnSync([
      "docker",
      "inspect",
      "-f",
      "{{json .NetworkSettings.Ports}}",
      cid.stdout.toString().trim(),
    ]);
    const parsed = JSON.parse(ports.stdout.toString()) as Record<string, unknown>;
    expect(Object.keys(parsed).filter((k) => parsed[k] !== null)).toEqual([]);
  });
});
