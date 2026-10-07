import { useT, type LocaleEntry } from "../../lib/i18n/t";

/** Reactive translator over the auth copy; stable per locale. */
export function useAuthT() {
  return useT(authCopy);
}

/**
 * Auth page-group copy: login, signup, verify-email. Keys name UI meaning
 * (not the English sentence) so Vietnamese can follow its own syntax.
 * English strings are frozen by existing auth regression tests; only the
 * Vietnamese strings are free to move. Password-checklist rule labels live in
 * @hoborouter/shared (out of scope here) and stay English for now.
 */
export const authCopy = {
  // Shared between login and signup forms.
  signIn: { en: "Sign in", vi: "Đăng nhập" },
  signUp: { en: "Sign up", vi: "Đăng ký" },
  emailLabel: { en: "Email", vi: "Email" },
  passwordLabel: { en: "Password", vi: "Mật khẩu" },
  checkingSecurity: { en: "Checking security options…", vi: "Đang kiểm tra tuỳ chọn bảo mật…" },
  securityLoadFailed: {
    en: "Could not load security options.",
    vi: "Không tải được tuỳ chọn bảo mật.",
  },
  captchaLoadFailed: {
    en: "Could not load the captcha check.",
    vi: "Không tải được kiểm tra captcha.",
  },
  retry: { en: "Retry", vi: "Thử lại" },

  // Validation messages.
  emailInvalid: { en: "Enter a valid email address", vi: "Nhập địa chỉ email hợp lệ" },
  passwordMin: {
    en: "Password must be at least 8 characters",
    vi: "Mật khẩu phải có ít nhất 8 ký tự",
  },
  nameRequired: { en: "Name is required", vi: "Vui lòng nhập tên" },
  confirmRequired: { en: "Confirm your password", vi: "Vui lòng xác nhận mật khẩu" },
  passwordRuleFailed: {
    en: "Does not meet the password requirements below",
    vi: "Mật khẩu chưa đạt các yêu cầu bên dưới",
  },
  passwordMismatch: { en: "Passwords do not match", vi: "Mật khẩu không khớp" },

  // Login page.
  signInTitle: { en: "Sign in", vi: "Đăng nhập" },
  signInPrompt: { en: "Welcome back. No account?", vi: "Chào mừng trở lại. Chưa có tài khoản?" },
  signInFailed: { en: "Sign in failed", vi: "Đăng nhập thất bại" },
  signedInToast: { en: "Signed in", vi: "Đã đăng nhập" },
  termsLink: { en: "Terms", vi: "Điều khoản" },
  privacyLink: { en: "Privacy", vi: "Quyền riêng tư" },

  // Signup page.
  signUpTitle: { en: "Create account", vi: "Tạo tài khoản" },
  signUpPrompt: { en: "Already have an account?", vi: "Đã có tài khoản?" },
  nameLabel: { en: "Name", vi: "Tên" },
  confirmPasswordLabel: { en: "Confirm password", vi: "Xác nhận mật khẩu" },
  signUpFailed: { en: "Sign up failed", vi: "Đăng ký thất bại" },
  accountCreatedToast: { en: "Account created", vi: "Đã tạo tài khoản" },
  verificationEmailToast: {
    en: "Verification email sent — check your inbox",
    vi: "Đã gửi email xác thực — hãy kiểm tra hộp thư",
  },
  agreePrefix: {
    en: "By creating an account you agree to the",
    vi: "Khi tạo tài khoản, bạn đồng ý với",
  },
  termsOfServiceLink: { en: "Terms of Service", vi: "Điều khoản dịch vụ" },
  and: { en: "and", vi: "và" },
  privacyPolicyLink: { en: "Privacy Policy", vi: "Chính sách quyền riêng tư" },

  // Verify-email page.
  verifyLoading: {
    en: "Checking your sign-in status…",
    vi: "Đang kiểm tra trạng thái đăng nhập của bạn…",
  },
  verifiedTitle: { en: "Email verified", vi: "Đã xác thực email" },
  verifiedBody: {
    en: "Your email address is confirmed. Everything is ready to go.",
    vi: "Địa chỉ email của bạn đã được xác nhận. Mọi thứ đã sẵn sàng.",
  },
  goHome: { en: "Go to Hoborouter", vi: "Đến Hoborouter" },
  unverifiedTitle: { en: "Email not verified yet", vi: "Email chưa được xác thực" },
  unverifiedBodyNoEmail: {
    en: "The verification link may have expired or already been used. You can keep using Hoborouter either way.",
    vi: "Liên kết xác thực có thể đã hết hạn hoặc đã được dùng. Dù vậy bạn vẫn có thể tiếp tục dùng Hoborouter.",
  },
  unverifiedBodyWithEmail: {
    en: "The verification link may have expired or already been used. You can keep using Hoborouter either way — a new link can be sent to {email}.",
    vi: "Liên kết xác thực có thể đã hết hạn hoặc đã được dùng. Dù vậy bạn vẫn có thể tiếp tục dùng Hoborouter — có thể gửi liên kết mới tới {email}.",
  },
  resendVerificationEmail: { en: "Resend verification email", vi: "Gửi lại email xác thực" },
  passwordRequirements: {
    en: "Password requirements",
    vi: "Yêu cầu mật khẩu",
  },
  ruleMet: { en: "(met)", vi: "(đạt)" },
  ruleNotMet: { en: "(not yet met)", vi: "(chưa đạt)" },
  backHome: { en: "Back to Hoborouter", vi: "Về Hoborouter" },
  processedTitle: { en: "Verification link processed", vi: "Đã xử lý liên kết xác thực" },
  processedBody: {
    en: "Verification link processed; sign in to check your email status.",
    vi: "Đã xử lý liên kết xác thực; hãy đăng nhập để xem trạng thái email.",
  },
} as const satisfies Record<string, LocaleEntry>;

export type AuthT = ReturnType<typeof useAuthT>;
