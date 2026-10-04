// Single source of truth for the password policy. Applies ONLY when a
// password is SET (signup, change password, admin create/reset); existing
// users with older passwords keep signing in.

export interface PasswordRule {
  key: "min" | "max" | "lower" | "upper" | "digit" | "special";
  label: string;
  test: (pw: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { key: "min", label: "At least 8 characters", test: (pw) => pw.length >= 8 },
  { key: "max", label: "At most 200 characters", test: (pw) => pw.length <= 200 },
  { key: "lower", label: "One lowercase letter", test: (pw) => /[a-z]/.test(pw) },
  { key: "upper", label: "One uppercase letter", test: (pw) => /[A-Z]/.test(pw) },
  { key: "digit", label: "One digit", test: (pw) => /\d/.test(pw) },
  { key: "special", label: "One special character", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

/** Unmet rule labels, in PASSWORD_RULES order; empty array means the password passes. */
export const checkPassword = (pw: string): string[] =>
  PASSWORD_RULES.filter((rule) => !rule.test(pw)).map((rule) => rule.label);
