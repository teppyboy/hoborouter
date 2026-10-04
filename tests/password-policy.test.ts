// Pure password-policy tests: checkPassword + PASSWORD_RULES are the single
// source of truth shared by API (auth hooks, admin routes) and web forms.
import { describe, expect, test } from "bun:test";
import { PASSWORD_RULES, checkPassword } from "../packages/shared/src/password-policy";

describe("checkPassword", () => {
  test("compliant password passes (empty list)", () => {
    expect(checkPassword("Correct-Horse-1")).toEqual([]);
    expect(checkPassword("aA1!aA1!")).toEqual([]);
  });

  test("each weak password reports exactly its unmet rules", () => {
    // too short but otherwise compliant
    expect(checkPassword("aA1!")).toEqual(["At least 8 characters"]);
    // lowercase only
    expect(checkPassword("abcdefgh")).toEqual([
      "One uppercase letter",
      "One digit",
      "One special character",
    ]);
    // no digit
    expect(checkPassword("Abcdefgh!")).toEqual(["One digit"]);
    // no uppercase
    expect(checkPassword("abcdefgh1!")).toEqual(["One uppercase letter"]);
    // no special
    expect(checkPassword("Abcdefg1")).toEqual(["One special character"]);
    // too long
    expect(checkPassword("aA1!" + "x".repeat(197))).toEqual(["At most 200 characters"]);
  });

  test("empty password fails min but not max", () => {
    const unmet = checkPassword("");
    expect(unmet).toContain("At least 8 characters");
    expect(unmet).not.toContain("At most 200 characters");
    // every character-class rule is unmet on the empty string
    expect(unmet).toContain("One lowercase letter");
    expect(unmet).toContain("One special character");
  });

  test("boundary lengths: 8 passes, 7 fails, 200 passes, 201 fails", () => {
    expect(checkPassword("aA1!aA1!")).toEqual([]);
    expect(checkPassword("aA1!aA1")).toEqual(["At least 8 characters"]);
    expect(checkPassword("aA1!" + "a".repeat(196))).toEqual([]);
    expect(checkPassword("aA1!" + "a".repeat(197))).toEqual(["At most 200 characters"]);
  });

  test("rules list is exactly the policy's six rules", () => {
    expect(PASSWORD_RULES.map((r) => r.key)).toEqual([
      "min",
      "max",
      "lower",
      "upper",
      "digit",
      "special",
    ]);
  });

  test("special character means non-alphanumeric (unicode counts)", () => {
    expect(checkPassword("Abcdefg1é")).toEqual([]);
    expect(checkPassword("Abcdefg1 ")).toEqual([]);
  });
});
