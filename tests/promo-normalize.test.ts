// Canonical promo-code normalization + hashing (unified-promos spec §3).
// Unit tests over the pure helper contract: outer-trim + whole-string
// Unicode uppercase + interior verbatim + \p{C} rejection + bounds AFTER
// uppercase (1-64 codepoints, <=128 UTF-8 bytes) + verbatim hashing whose
// output for legacy 32-hex codes is byte-identical to the old
// sha256(trim().toUpperCase()) pipeline (no migration of existing rows).
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  hashPromoCode,
  normalizePromoCode,
  normalizePromoCodeWithReason,
} from "../apps/api/src/promo-code";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE = "0123456789ABCDEF0123456789ABCDEF"; // legacy 32-hex shape

describe("legacy 32-hex compatibility", () => {
  test("normalized 32-hex value hashes identically to the old pipeline", () => {
    // Old: sha256(code.trim().toUpperCase()). For hex codes trim+uppercase is
    // the identity on the normalized value, so hashes must be byte-identical.
    expect(hashPromoCode(normalizePromoCode(CODE)!)).toBe(sha256(CODE));
    expect(hashPromoCode(normalizePromoCode(`  ${CODE.toLowerCase()}  `)!)).toBe(sha256(CODE));
  });

  test("case/outer-whitespace variants share ONE hash", () => {
    const h = hashPromoCode(normalizePromoCode(` abCd1234Ef567890abCd1234Ef567890 `)!);
    expect(h).toBe(hashPromoCode(normalizePromoCode("ABCD1234EF567890ABCD1234EF567890")!));
    expect(h).toBe(sha256("ABCD1234EF567890ABCD1234EF567890"));
  });
});

describe("normalization rules", () => {
  test("outer trim only; interior space/punctuation preserved verbatim", () => {
    expect(normalizePromoCode("  AB CD-EF_01  ")).toBe("AB CD-EF_01");
    expect(normalizePromoCode("AB CD!EF.GH")).toBe("AB CD!EF.GH");
  });

  test("whole-string Unicode uppercase, no ASCII-only exception", () => {
    expect(normalizePromoCode("abc")).toBe("ABC");
    expect(normalizePromoCode("straße")).toBe("STRASSE"); // ß -> SS, deterministic
    expect(normalizePromoCode("éàü")).toBe("ÉÀÜ");
  });

  test("empty and whitespace-only rejected", () => {
    expect(normalizePromoCode("")).toBeNull();
    expect(normalizePromoCode("   ")).toBeNull();
    expect(normalizePromoCode("\t\n")).toBeNull();
  });

  test("control/format characters (\\p{C}) rejected, incl. ZWSP/ZWNJ/ZWJ/bidi/U+0000", () => {
    expect(normalizePromoCode("AB\u0000CD")).toBeNull(); // Cc
    expect(normalizePromoCode("AB\u200BCD")).toBeNull(); // Cf ZWSP
    expect(normalizePromoCode("AB\u200BCD")).toBeNull(); // ZWSP
    expect(normalizePromoCode("AB\u200CCD")).toBeNull(); // ZWNJ
    expect(normalizePromoCode("AB\u200DCD")).toBeNull(); // ZWJ
    expect(normalizePromoCode("AB\u202ECD")).toBeNull(); // bidi override (Cf)
    expect(normalizePromoCode("AB\uFFF9CD")).toBeNull(); // Cf interlinear
    // interior space and visible punctuation are NOT \p{C} and survive
    expect(normalizePromoCode("AB\u00A0CD")).toBe("AB\u00A0CD"); // NBSP is whitespace, not C
  });

  test("bounds enforced AFTER uppercase: 64 codepoints / 128 UTF-8 bytes accepted", () => {
    expect(normalizePromoCode("A".repeat(64))).toBe("A".repeat(64)); // 64 cp, 64 bytes
    expect(normalizePromoCode("Ā".repeat(64))).toBe("Ā".repeat(64)); // 64 cp, 128 bytes
    expect(normalizePromoCode("ß".repeat(32))).toBe("S".repeat(64)); // 32 cp -> 64 cp after uppercase
  });

  test("bounds enforced AFTER uppercase: 65 codepoints / 129 bytes rejected", () => {
    expect(normalizePromoCode("A".repeat(65))).toBeNull();
    expect(normalizePromoCode("Ā".repeat(65))).toBeNull(); // 65 cp, 130 bytes
    expect(normalizePromoCode("ß".repeat(33))).toBeNull(); // fine before uppercase (33 cp), 66 after
  });
});

describe("normalizePromoCodeWithReason (admin error text)", () => {
  test("reasons: empty | invalid_characters | too_long", () => {
    expect(normalizePromoCodeWithReason("   ")).toEqual({ reason: "empty" });
    expect(normalizePromoCodeWithReason("AB\u200BCD")).toEqual({ reason: "invalid_characters" });
    expect(normalizePromoCodeWithReason("A".repeat(65))).toEqual({ reason: "too_long" });
    expect(normalizePromoCodeWithReason(" ok ")).toEqual({ code: "OK" });
  });
});

describe("hashPromoCode hashes its argument verbatim", () => {
  test("no internal re-normalization", () => {
    // The helper hashes EXACTLY the string it receives: callers pass the
    // normalized value; hashing must not trim/uppercase again (spec §3).
    expect(hashPromoCode("ab cd")).toBe(sha256("ab cd"));
    expect(hashPromoCode(" ab cd ")).toBe(sha256(" ab cd ")); // NOT sha256("AB CD")
    expect(hashPromoCode(CODE)).toBe(sha256(CODE));
  });
});
