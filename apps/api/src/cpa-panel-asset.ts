import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import manifest from "../assets/cpa-panel/manifest.json";

const root = new URL("../assets/cpa-panel/", import.meta.url);
const digest = (value: string | Buffer, encoding: "hex" | "base64" = "hex") =>
  createHash("sha256").update(value).digest(encoding);
function verified(name: keyof typeof manifest.files): string {
  const bytes = readFileSync(new URL(name, root));
  if (digest(bytes) !== manifest.files[name])
    throw new Error("Pinned CPA panel asset hash mismatch");
  return bytes.toString("utf8");
}
const source = verified("management-v1.22.18.html");
const bootstrap = verified("bootstrap.js");
verified("LICENSE");

export function panelAsset(origin: string): Response {
  if (new URL(origin).origin !== origin) throw new Error("Invalid panel admin origin");
  // JSON escapes prevent an origin from terminating this classic script.
  const script = bootstrap.replace(
    "__HBR_ADMIN_ORIGIN__",
    JSON.stringify(origin).replaceAll("<", "\\u003c"),
  );
  const html = source.replace("<head>", `<head><script>${script}</script>`);
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${digest(match[1]!, "base64")}'`,
  );
  if (hashes.length !== 2) throw new Error("Unexpected pinned CPA executable blocks");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `sandbox allow-scripts; default-src 'none'; connect-src 'none'; script-src ${hashes.join(" ")}; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
      "x-hbr-panel-sha256": digest(html),
    },
  });
}
