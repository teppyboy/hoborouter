// Canonical promo-code normalization + hashing (unified-promos spec §3).
// Single shared module, one spelling everywhere: admin create, preview,
// redeem, and payment creation all import from here so a variant of a code
// (case / outer whitespace) can only ever resolve to ONE promo hash.
//
// Contract:
//  - outer Unicode trim only; interior characters preserved verbatim
//  - whole-string locale-independent uppercase (no ASCII-only exception)
//  - any \p{C} codepoint (controls, Cf format chars like ZWSP/bidi, Cs, Co,
//    Cn) rejected — interior spaces and visible punctuation are allowed
//  - bounds checked AFTER uppercase (ß->SS expansion counts): 1-64
//    codepoints AND <= 128 UTF-8 bytes; same input always => same verdict
//  - hashPromoCode hashes its argument VERBATIM (never re-normalizes
//    internally); callers hash the normalized value exactly once. For legacy
//    32-hex codes the normalized value equals trim().toUpperCase(), so
//    SHA-256 output is byte-identical to the pre-helper pipeline — no
//    migration of existing rows.
export type InvalidPromoReason = "empty" | "invalid_characters" | "too_long";

const CONTROL = /[\p{C}]/u;
const encoder = new TextEncoder();

export function normalizePromoCodeWithReason(
  raw: string,
): { code: string } | { reason: InvalidPromoReason } {
  const code = raw.trim().toUpperCase();
  if (code.length === 0) return { reason: "empty" };
  if (CONTROL.test(code)) return { reason: "invalid_characters" };
  if ([...code].length > 64 || encoder.encode(code).byteLength > 128) return { reason: "too_long" };
  return { code };
}

export function normalizePromoCode(raw: string): string | null {
  const r = normalizePromoCodeWithReason(raw);
  return "code" in r ? r.code : null;
}

export function hashPromoCode(code: string): string {
  return new Bun.CryptoHasher("sha256").update(code).digest("hex");
}
