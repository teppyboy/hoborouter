import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production compose must only pull the published image: with a build: block
// present, `docker compose up` on a VPS holding only deploy/ falls back to
// building and fails ("failed to read dockerfile").
const compose = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "..", "deploy", "docker-compose.yml"), "utf8"),
) as { services: Record<string, Record<string, unknown>> };

const svc = compose.services.hoborouter as Record<string, unknown>;

describe("deploy/docker-compose.yml", () => {
  it("hoborouter pulls a published image and has no build block", () => {
    expect(typeof svc.image).toBe("string");
    expect(svc.image).toStartWith("ghcr.io/teppyboy/hoborouter:");
    expect(svc.build).toBeUndefined();
  });

  it("binds published ports to 127.0.0.1 only", () => {
    for (const name of ["hoborouter", "cpa"] as const) {
      const ports = (compose.services[name] as { ports: string[] }).ports;
      for (const p of ports) expect(p.startsWith("127.0.0.1:")).toBeTrue();
    }
  });

  it("hoborouter points CPA_BASE_URL at the compose cpa service", () => {
    const env = (svc as { environment: Record<string, string> }).environment;
    expect(env.CPA_BASE_URL).toBe("http://cpa:8317");
  });

  it("hoborouter mounts ./config.yaml read-only at /app/config.yaml", () => {
    // Loader resolves the default config.yaml relative to the image WORKDIR
    // (/app); the bind mount must land there and stay read-only.
    const volumes = (svc as { volumes: string[] }).volumes;
    expect(volumes).toContain("./config.yaml:/app/config.yaml:ro");
  });

  it("db requires POSTGRES_PASSWORD", () => {
    const env = (compose.services.db as { environment: Record<string, string> }).environment;
    expect(env.POSTGRES_PASSWORD).toContain("?POSTGRES_PASSWORD");
  });
});
