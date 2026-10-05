import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behavior tests for scripts/wait-postgres.sh, the readiness gate used by
 * the StartPostgres step in .github/workflows/release.yml. The actual script
 * is spawned under a stub `docker`/`sleep` on PATH; no workflow source is
 * parsed or duplicated here.
 *
 * Regression: v0.4.0 CI failed because `pg_isready -U postgres` probes the
 * unix socket and succeeds against the init-phase temporary server, so the
 * step passed before the final TCP server existed.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// Override exists only for mutation verification (prove the assertions fail
// when the script drops the TCP flag); normal runs always use the real script.
const SCRIPT =
  process.env.HBR_WAIT_POSTGRES_SCRIPT_OVERRIDE ??
  join(import.meta.dir, "..", "scripts", "wait-postgres.sh");
const CONTAINER = "hbr-ci-pg";

/** Exact psql argv the script must issue, without the leading `psql`. */
const EXPECTED_PSQL_ARGV = [
  "-h",
  "127.0.0.1",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-tAc",
  "select 1",
];

/** Portable counter update (POSIX grep/printf; no BSD-incompatible sed -i). */
const BUMP = `
bump() {
  f="$1"; k="$2"
  c=$(grep "^$k=" "$f" | cut -d= -f2)
  c=$((c + 1))
  grep -v "^$k=" "$f" > "$f.tmp" || true
  printf '%s=%d\\n' "$k" "$c" >> "$f.tmp"
  mv "$f.tmp" "$f"
  echo "$c"
}
`;

function runWaitPostgres(dockerShim: string): {
  code: number;
  out: string;
  state: Record<string, number>;
  /** One entry per psql invocation, the raw argv after the leading `psql`. */
  psqlArgv: string[][];
} {
  const dir = mkdtempSync(join(tmpdir(), "hbr-wait-pg-"));
  tempDirs.push(dir);
  const stateFile = join(dir, "state");
  const argvFile = join(dir, "psql-argv");
  writeFileSync(stateFile, "psql=0\npg_isready=0\nlogs=0\ntarget=0\n");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash\nS=${JSON.stringify(stateFile)}\nA=${JSON.stringify(argvFile)}\n${BUMP}\n${dockerShim.replaceAll("__STATE__", "$S")}`,
    { mode: 0o755 },
  );
  // sleep is mocked so the 60-attempt bound runs in milliseconds.
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawnSync(["bash", SCRIPT, CONTAINER], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const state: Record<string, number> = {};
  for (const pair of readFileSync(stateFile, "utf8").trim().split(/\s+/)) {
    const [k, v] = pair.split("=");
    if (k !== undefined && v !== undefined) state[k] = Number(v);
  }
  const rawArgv = readFileSync(argvFile, "utf8");
  const psqlArgv =
    rawArgv.length === 0
      ? []
      : rawArgv
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) =>
            // Each shim line is tab-terminated; drop the trailing empty field.
            (line.endsWith("\t") ? line.slice(0, -1) : line).split("\t"),
          );
  return {
    code: proc.exitCode ?? -1,
    out: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
    state,
    psqlArgv,
  };
}

describe("scripts/wait-postgres.sh", () => {
  it("passes bash -n syntax check", () => {
    const check = Bun.spawnSync(["bash", "-n", SCRIPT]);
    expect(check.exitCode).toBe(0);
  });

  it("succeeds via TCP psql after init-style failures, without socket probes", () => {
    // Mocked lifecycle: TCP psql fails 3 times (init phase), then the final
    // server accepts. The script must not call pg_isready at all and must
    // exec into the requested container. The shim records the raw psql argv
    // (one invocation per line, tab-separated) so the assertions cover the
    // actual arguments, not just the command name.
    const shim = `
if [ "$1" = "exec" ] && [ "$2" = "${CONTAINER}" ]; then
  bump "$S" target >/dev/null
  case "$3" in
    pg_isready)
      bump "$S" pg_isready >/dev/null
      exit 2;;
    psql)
      bump "$S" psql >/dev/null
      shift 3
      for a in "$@"; do printf '%s\\t' "$a" >> "$A"; done
      printf '\\n' >> "$A"
      [ "$(grep '^psql=' "$S" | cut -d= -f2)" -le 3 ] && exit 1
      exit 0;;
  esac
fi
exit 1
`;
    const r = runWaitPostgres(shim);
    expect(r.code).toBe(0);
    expect(r.state.psql).toBe(4); // 3 failures, then first TCP success
    expect(r.psqlArgv.length).toBe(4);
    for (const argv of r.psqlArgv) {
      // Every invocation (success and failure) must probe over TCP with the
      // full argument set; a socket-based or query-less psql must fail here.
      expect(argv).toEqual(EXPECTED_PSQL_ARGV);
    }
    expect(r.state.pg_isready).toBe(0); // no unix-socket probe
    expect(r.state.logs).toBe(0); // no log dump on success
    expect(r.state.target).toBe(r.state.psql); // every exec targeted hbr-ci-pg
  });

  it("fails after exactly 60 bounded attempts and dumps docker logs only then", () => {
    const shim = `
if [ "$1" = "exec" ] && [ "$2" = "${CONTAINER}" ]; then
  case "$3" in
    psql)
      bump "$S" psql >/dev/null
      shift 3
      for a in "$@"; do printf '%s\\t' "$a" >> "$A"; done
      printf '\\n' >> "$A"
      exit 1;;
  esac
fi
if [ "$1" = "logs" ]; then
  bump "$S" logs >/dev/null
  echo "container logs"
  exit 0
fi
exit 1
`;
    const r = runWaitPostgres(shim);
    expect(r.code).toBe(1);
    expect(r.state.psql).toBe(60);
    expect(r.psqlArgv.length).toBe(60);
    for (const argv of r.psqlArgv) {
      expect(argv).toEqual(EXPECTED_PSQL_ARGV); // failing invocations too
    }
    expect(r.state.logs).toBe(1);
    expect(r.out).toContain(`${CONTAINER} not ready after 60 attempts`);
    expect(r.out).toContain("container logs");
  });
});
