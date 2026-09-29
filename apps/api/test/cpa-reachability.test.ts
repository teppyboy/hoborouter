// Task 5: CPA health route (admin-only, single-attempt) + gated Docker
// integration for network isolation. Integration section SKIPS honestly when
// the Docker daemon is unavailable — deployment/isolation stays UNVERIFIED.
import { describe, expect, test } from "bun:test";
import { makeApp, signUp, req, createWorkspace, makeInstanceAdmin, userIdByEmail } from "./helpers";

// ---------- unit: /api/admin/cpa/health ----------

test("cpa health: member and workspace admin get 403", async () => {
  const { db, app } = await makeApp();
  const memberCookie = await signUp(app, "m@example.com");
  createWorkspace(db, "ws1", userIdByEmail(db, "m@example.com"));
  // non-admin (no membership at all)
  expect((await req(app, "/api/admin/cpa/health", { cookie: memberCookie })).status).toBe(403);

  const wsAdminCookie = await signUp(app, "wsadmin@example.com");
  const { addMember } = await import("./helpers");
  addMember(db, "ws1", userIdByEmail(db, "wsadmin@example.com"), "admin");
  expect((await req(app, "/api/admin/cpa/health", { cookie: wsAdminCookie })).status).toBe(403);
});

test("cpa health: instance admin ok; each upstream hit exactly once; no auth retry", async () => {
  let healthzHits = 0;
  let mgmtHits = 0;
  const seenAuth: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/healthz") {
        healthzHits++;
        return Response.json({ status: "ok" });
      }
      if (u.pathname === "/v0/management/credentials/status") {
        mgmtHits++;
        seenAuth.push(req.headers.get("authorization") ?? "");
        // always 401: gateway must NOT retry management auth
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.CPA_MANAGEMENT_KEY = "test-only-not-a-real-secret";
  try {
    const { db, app } = await makeApp();
    const adminCookie = await signUp(app, "admin@example.com");
    makeInstanceAdmin(db, userIdByEmail(db, "admin@example.com"));
    const res = await req(app, "/api/admin/cpa/health", { cookie: adminCookie });
    expect(res.status).toBe(502); // management 401 surfaces, no retry loop
    expect(healthzHits).toBe(1);
    expect(mgmtHits).toBe(1);
    expect(seenAuth).toEqual([`Bearer ${process.env.CPA_MANAGEMENT_KEY}`]);
    const text = await res.text();
    const body = JSON.parse(text) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CPA_MANAGEMENT_UNAVAILABLE");
    expect(text).not.toContain(process.env.CPA_MANAGEMENT_KEY!);
  } finally {
    server.stop(true);
    delete process.env.CPA_BASE_URL;
    delete process.env.CPA_MANAGEMENT_KEY;
  }
});

test("cpa health: unreachable CPA → 502", async () => {
  process.env.CPA_BASE_URL = "http://127.0.0.1:1"; // nothing listens
  process.env.CPA_MANAGEMENT_KEY = "test-only-not-a-real-secret";
  try {
    const { db, app } = await makeApp();
    const adminCookie = await signUp(app, "admin2@example.com");
    makeInstanceAdmin(db, userIdByEmail(db, "admin2@example.com"));
    const res = await req(app, "/api/admin/cpa/health", { cookie: adminCookie });
    expect(res.status).toBe(502);
  } finally {
    delete process.env.CPA_BASE_URL;
    delete process.env.CPA_MANAGEMENT_KEY;
  }
});

// ---------- secret hygiene (host-side, no Docker needed) ----------

test("deploy/: no committed secrets, rendered config untracked", async () => {
  // rendered config must be gitignored
  const ignored = Bun.spawnSync(["git", "check-ignore", "deploy/cpa/config.yaml", "deploy/.env"]);
  expect(ignored.exitCode).toBe(0);
  // tracked files under deploy/ contain no placeholder destined for CPA config parsing
  const tracked = Bun.spawnSync(["git", "ls-files", "deploy/"])
    .stdout.toString()
    .trim()
    .split("\n");
  for (const f of tracked.filter(Boolean)) {
    // pinned snapshot (upstream's own example keys) and render script (placeholder replacement logic) contain placeholders by design, not secrets
    if (f === "deploy/cpa/config.example.yaml" || f === "deploy/cpa/render-config.sh") continue;
    const text = await Bun.file(f).text();
    expect(text).not.toContain("your-api-key");
    expect(text).not.toMatch(/\$\{CPA_/); // CPA config values are substituted pre-parse, never templated into CPA files
  }
  // if secrets exist locally, they never appear in tracked files (compared without printing)
  const envFile = Bun.file("deploy/.env");
  if (await envFile.exists()) {
    const secrets = (await envFile.text())
      .split("\n")
      .map((l) => l.split("=")[1]?.trim())
      .filter(Boolean) as string[];
    for (const f of tracked.filter(Boolean)) {
      const text = await Bun.file(f).text();
      for (const s of secrets) expect(text).not.toContain(s);
    }
  }
});

// ---------- Docker integration (skips honestly without daemon) ----------

const dockerOk = (() => {
  try {
    return Bun.spawnSync(["docker", "info"]).exitCode === 0;
  } catch {
    return false;
  }
})();

const describeDocker = dockerOk ? describe : describe.skip;

// Direct ungated `docker compose up` of CPA is NOT allowed in the default
// suite. Stack-starting tests run only when CPA_PF_INSTALLED=1 (the user has
// installed the PF isolation rule; the rule itself is the control, the
// preflight script is the per-start verification). Default: skip visibly.
const pfInstalled = Bun.env.CPA_PF_INSTALLED === "1";
const describeStack = pfInstalled ? describeDocker : describeDocker.skip;

describeStack("cpa compose stack (requires Docker daemon + CPA_PF_INSTALLED=1)", () => {
  const COMPOSE = ["docker", "compose", "-f", "deploy/docker-compose.yml"];

  const sh = (cmd: string[], timeout = 15000) => {
    const p = Bun.spawnSync(cmd, { timeout });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("stack up + peer reachability + no published ports", () => {
    expect(sh([...COMPOSE, "up", "-d", "--wait", "--wait-timeout", "60"]).code).toBe(0);
    try {
      // peer (gateway service) can reach CPA on cpa-net
      const peer = sh([
        ...COMPOSE,
        "exec",
        "-T",
        "gateway",
        "curl",
        "-s",
        "-m",
        "5",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "http://cpa:8317/healthz",
      ]);
      expect(peer.out.trim()).toBe("200");

      // no published ports — definitive inspect-based check only.
      // Do NOT use `docker compose port` exit code: it returned 0 with
      // `invalid IP:0` on this Compose version despite no published port.
      const cid = sh([...COMPOSE, "ps", "-q", "cpa"]);
      expect(cid.out.trim()).not.toBe("");
      expect(sh(["docker", "port", cid.out.trim()]).out.trim()).toBe("");
      const portsJson = sh([
        "docker",
        "inspect",
        "-f",
        "{{json .NetworkSettings.Ports}}",
        cid.out.trim(),
      ]).out.trim();
      const ports = JSON.parse(portsJson) as Record<string, unknown>;
      expect(Object.keys(ports).filter((k) => ports[k] !== null)).toEqual([]);

      // host-namespace container cannot reach published port
      const hostNet = sh(
        [
          "docker",
          "run",
          "--rm",
          "--network",
          "host",
          "curlimages/curl:8.12.1",
          "-s",
          "-m",
          "2",
          "-o",
          "/dev/null",
          "http://127.0.0.1:8317/healthz",
        ],
        30000,
      );
      expect(hostNet.code).not.toBe(0);
    } finally {
      sh([...COMPOSE, "down", "-v"]);
    }
  }, 120000);

  // Mandatory host → fixed CPA bridge-IP gate. Runs as a NORMAL test only
  // when CPA_PF_INSTALLED=1 (PF rule installed); then host reachability is a
  // hard failure. When unset the whole stack block skips visibly — no
  // test.failing masking, default suite never starts CPA ungated.
  test("host CANNOT reach CPA bridge IP (isolation verified live)", () => {
    expect(sh([...COMPOSE, "up", "-d", "--wait", "--wait-timeout", "60"]).code).toBe(0);
    try {
      const cid = sh([...COMPOSE, "ps", "-q", "cpa"]);
      const ip = sh([
        "docker",
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        cid.out.trim(),
      ]).out.trim();
      expect(ip).toBe("192.168.231.3");
      // probe output discarded: never print CPA responses (may echo secrets)
      const probe = sh(["curl", "-s", "-m", "2", "-o", "/dev/null", `http://${ip}:8317/healthz`]);
      expect(probe.code).not.toBe(0); // throws (red) while host can connect
    } finally {
      sh([...COMPOSE, "down", "-v"]);
    }
  }, 120000);
});
