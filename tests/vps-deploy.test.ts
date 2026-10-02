import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "deploy", "vps-deploy.sh");

let tmp = "";

// The shim models real docker semantics:
// - `compose pull` updates the TAG's image only (from $STATE/new-image, if present)
// - `inspect hoborouter --format {{.Image}}` reads the CONTAINER's image, which
//   changes only when `compose up` recreates it
// - `image inspect <tag>` (cmd "image") reads the tag's image ID
// - `tag <id> <dst>` retags; if dst is the deploy IMAGE, the tag now points there
// - `compose exec db pg_dump` writes a non-empty dump unless $STATE/no-backup
const DOCKER_SHIM = `#!/usr/bin/env bash
STATE="$HBR_TEST_STATE"
LOG="$STATE/docker.log"
echo "$*" >> "$LOG"
cmd="$1"; shift || true
case "$cmd" in
  compose)
    sub="$1"
    case "$sub" in
      pull) [ -f "$STATE/new-image" ] && cp "$STATE/new-image" "$STATE/tag-image" ;;
      up)
        # recreate container from the tag (possibly retagged for rollback)
        cp "$STATE/tag-image" "$STATE/container-image" ;;
      exec)
        [ -f "$STATE/no-backup" ] || echo "pgdump-bytes" ;;
    esac
    exit 0 ;;
  image)
    cat "$STATE/tag-image" ;;
  inspect)
    cat "$STATE/container-image" ;;
  tag)
    echo "$1" > "$STATE/tag-image" ;;
esac
exit 0
`;

function shims(): void {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), DOCKER_SHIM);
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
if [ -f "$HBR_TEST_STATE/health-fail" ]; then exit 22; fi
exit 0
`,
  );
  for (const f of ["docker", "curl"]) Bun.spawnSync(["chmod", "+x", join(bin, f)]);
}

function setup(
  opts: { newImage: boolean; healthFail: boolean; noBackup?: boolean },
): void {
  tmp = join("/tmp", `vps-deploy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, "bin"), { recursive: true });
  mkdirSync(join(tmp, "compose"), { recursive: true });
  mkdirSync(join(tmp, "state"), { recursive: true });
  // Real box: tag and container point at the same (old) image before deploy.
  writeFileSync(join(tmp, "state", "container-image"), "sha256:oldimage\n");
  writeFileSync(join(tmp, "state", "tag-image"), "sha256:oldimage\n");
  if (opts.newImage) writeFileSync(join(tmp, "state", "new-image"), "sha256:newimage\n");
  if (opts.healthFail) writeFileSync(join(tmp, "state", "health-fail"), "1");
  if (opts.noBackup) writeFileSync(join(tmp, "state", "no-backup"), "1");
  shims();
}

function cleanup(): void {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
}

function run(): ReturnType<typeof spawnSync>["status"] | number {
  const env = {
    ...process.env,
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    COMPOSE_DIR: join(tmp, "compose"),
    BACKUP_DIR: join(tmp, "backups"),
    LOCK_FILE: join(tmp, "deploy.lock"),
    STATE_DIR: join(tmp, "state"),
    HBR_TEST_STATE: join(tmp, "state"),
    HEALTH_TIMEOUT: "1",
  };
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 60_000 });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(join(tmp, "output.txt"), output);
  return r.status ?? 1;
}

function log(): string {
  return readFileSync(join(tmp, "state", "docker.log"), "utf8");
}

function output(): string {
  return readFileSync(join(tmp, "output.txt"), "utf8");
}

afterAll(cleanup);

describe("vps-deploy.sh", () => {
  test("syntax check", () => {
    const r = Bun.spawnSync(["bash", "-n", SCRIPT]);
    expect(r.exitCode).toBe(0);
  });

  test("image unchanged: no restart, exit 0", () => {
    setup({ newImage: false, healthFail: false });
    const code = run();
    expect(code).toBe(0);
    const l = log();
    expect(l).toContain("pull hoborouter");
    expect(l).not.toContain("up -d");
    cleanup();
  });

  // Regression: pull changes the tag's image but NOT the running container's.
  // The pre-fix script re-inspected the container after pull, saw no change,
  // and exited 0 without deploying — this test failed before the fix.
  test("pulled tag differs from container: deploy proceeds", () => {
    setup({ newImage: true, healthFail: false });
    const code = run();
    expect(code).toBe(0);
    const l = log();
    expect(l).toContain("image inspect ghcr.io/teppyboy/hoborouter:");
    const pullIdx = l.indexOf("compose pull");
    const backupIdx = l.indexOf("pg_dump");
    const upIdx = l.indexOf("up -d hoborouter");
    expect(backupIdx).toBeGreaterThan(pullIdx);
    expect(upIdx).toBeGreaterThan(backupIdx);
    const backups = readdirSync(join(tmp, "backups")).filter((f) => f.endsWith(".dump"));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^hoborouter-\d+\.dump$/);
    cleanup();
  });

  test("new image + health fails: rollback retags previous image, non-zero exit", () => {
    setup({ newImage: true, healthFail: true });
    const code = run();
    expect(code).not.toBe(0);
    const l = log();
    expect(l).toContain("tag sha256:oldimage ghcr.io/teppyboy/hoborouter:");
    const lastUp = l.lastIndexOf("up -d --no-deps hoborouter");
    expect(lastUp).toBeGreaterThan(l.indexOf("up -d hoborouter"));
    expect(output()).toContain("pg_restore");
    cleanup();
  });

  test("empty backup: abort before restart, non-zero exit", () => {
    setup({ newImage: true, healthFail: false, noBackup: true });
    const code = run();
    expect(code).not.toBe(0);
    const l = log();
    expect(l).not.toContain("up -d");
    expect(output()).toContain("backup missing/empty");
    cleanup();
  });

  test("cpa never pulled or restarted", () => {
    setup({ newImage: true, healthFail: false });
    run();
    expect(log()).not.toMatch(/cpa/);
    cleanup();
  });
});
