// Task 9: HMAC-SHA256 signature for the guarded mock payment provider.
// Canonical form: recursively key-sorted compact JSON (separators , and :),
// UTF-8, no whitespace. Signature travels as the `signature` field and is
// verified over the payload WITHOUT that field. Comparison is timing-safe.
// Empty key is a config error rejected before any crypto runs.
import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();

export class MockSignatureConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function requireKey(key: string): Uint8Array<ArrayBuffer> {
  if (typeof key !== "string" || key.length === 0) {
    throw new MockSignatureConfigError("webhook key must be a nonempty string");
  }
  // Copy into a plain ArrayBuffer-backed view so importKey's BufferSource
  // overload accepts it (no SharedArrayBuffer possibility by construction).
  const bytes = encoder.encode(key);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/** Recursively key-sorted compact JSON. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

function hmacHex(payload: string, keyBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const msg = new Uint8Array(new ArrayBuffer(encoder.encode(payload).byteLength));
  msg.set(encoder.encode(payload));
  return crypto.subtle
    .importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((k) => crypto.subtle.sign("HMAC", k, msg))
    .then((mac) =>
      Array.from(new Uint8Array(mac))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
}

/** HMAC-SHA256 hex over the canonical JSON of `payload`. */
export async function signMockPayload(
  payload: Record<string, unknown>,
  key: string,
): Promise<string> {
  return hmacHex(canonicalJson(payload), requireKey(key));
}

/**
 * Verify a raw webhook body. Extracts the `signature` field, recomputes the
 * HMAC over the canonical JSON of the remaining fields, compares timing-safe.
 * Never throws on bad bodies — returns false (config errors still throw).
 */
export async function verifyMockSignature(raw: string, key: string): Promise<boolean> {
  const keyBytes = requireKey(key);
  let parsed: { signature?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.signature !== "string") {
    return false;
  }
  const { signature, ...rest } = parsed;
  const expected = await hmacHex(canonicalJson(rest), keyBytes);
  // Timing-safe comparison of hex digests; unequal length bails early (length
  // is not secret for a fixed-size HMAC output).
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}
