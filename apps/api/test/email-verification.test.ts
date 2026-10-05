// OPTIONAL email verification end-to-end over the real Better Auth instance:
// signup/resend mail via the configured SMTP module (local fake server, no
// live mail), signed /api/auth/verify-email links, unverified sign-in stays
// allowed (requireEmailVerification false), email-change notification to the
// new address, public-config flags, resend rate limit + enumeration safety.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { startFakeSmtp } from "./smtp-helper";
import type { FakeSmtpState } from "./smtp-helper";
import { makeApp, makeInstanceAdmin, q, req, signUp, userIdByEmail } from "./helpers";

// Ambient-env proofing: pin EVERY env var this suite reads (including ambient
// SMTP_USER/PASSWORD/NODE_ENV/BETTER_AUTH_URL) and restore the original values
// after each test / at suite end.
const SMTP_KEYS = [
  "SMTP_HOST",
  "HBR_EMAIL_FROM",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "HBR_SMTP_SECURE",
  "NODE_ENV",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
] as const;
const saved = new Map<string, string | undefined>();

const pinEnv = (values: Partial<Record<(typeof SMTP_KEYS)[number], string | undefined>>) => {
  for (const k of SMTP_KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const restoreEnv = () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
};

/** SMTP-configured app backed by a local fake SMTP server. */
async function makeEmailApp() {
  const fake = startFakeSmtp();
  pinEnv({
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(fake.port),
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    HBR_EMAIL_FROM: "noreply@hbr.test",
    HBR_SMTP_SECURE: "none",
    NODE_ENV: "test",
    BETTER_AUTH_URL: undefined,
    BETTER_AUTH_SECRET: "x".repeat(32),
  });
  const made = await makeApp();
  return { fake, ...made };
}

/** signUp with a distinct client IP: the Better Auth in-memory rate-limit
 *  store is process-global, so per-test IPs keep the 3/10s sign-up rule from
 *  bleeding across tests. One IP per test, sign-ups stay under the rule. */
let ipSeq = 0;
async function signUpAs(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  email: string,
  name = "U",
): Promise<string> {
  const ip = `10.1.${++ipSeq}.${ipSeq}`;
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: "Correct-Horse-Battery-Staple-1", name }),
    }),
  );
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Latest verification link captured by the fake SMTP server. Never echoes
 *  the raw message: it carries the signed verification token. */
function capturedVerifyUrl(fake: FakeSmtpState, index = fake.messages.length - 1): string {
  const data = fake.messages[index]!.data;
  const m = /(https?:\/\/[^\s<"]+\/api\/auth\/verify-email\?token=[^\s<"]+)/.exec(data);
  if (!m) {
    throw new Error(
      `no verify-email link in captured message (recipient=${fake.messages[index]!.rcptTo}, ${data.length} bytes)`,
    );
  }
  return m[1]!;
}

const emailVerifiedOf = async (db: Awaited<ReturnType<typeof makeApp>>["db"], email: string) => {
  const rows = await q<{ email_verified: boolean }>(
    db,
    "select email_verified from users where email = ?",
    email,
  );
  return rows[0]?.email_verified;
};

afterEach(restoreEnv);

describe("email verification (SMTP configured)", () => {
  test("signup mails a Better Auth verify link; verifying sets email_verified", async () => {
    const { fake, db, app } = await makeEmailApp();
    try {
      const email = `u-${crypto.randomUUID()}@e2e.test`;
      const res = await signUpAs(app, email, "V");
      expect(res).toBeTruthy();
      expect(fake.messages.length).toBe(1);
      expect(fake.messages[0]!.rcptTo).toBe(`RCPT TO:<${email}>`);

      const url = capturedVerifyUrl(fake);
      expect(url).toContain("/api/auth/verify-email?token=");
      // Default post-verification redirect is the public SPA page.
      expect(url).toContain("callbackURL=%2Fverify-email");

      const verify = await app.handle(new Request(url));
      // callbackURL present: Better Auth redirects to the SPA page after
      // marking the address verified.
      expect(verify.status).toBe(302);
      expect(verify.headers.get("location")).toBe("/verify-email");
      expect(await emailVerifiedOf(db, email)).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("invalid token is rejected and never verifies", async () => {
    const { fake, db, app } = await makeEmailApp();
    try {
      const email = `u-${crypto.randomUUID()}@e2e.test`;
      await signUpAs(app, email);
      const res = await app.handle(
        new Request("http://localhost/api/auth/verify-email?token=not-a-jwt"),
      );
      expect(res.status).toBe(401);
      // buildApp wraps Better Auth errors in { error: { code, message } }.
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_TOKEN");
      expect(await emailVerifiedOf(db, email)).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("expired token is rejected (TOKEN_EXPIRED) and never verifies", async () => {
    const { fake, db, app } = await makeEmailApp();
    try {
      const email = `u-${crypto.randomUUID()}@e2e.test`;
      await signUpAs(app, email);
      // Same secret createAuth pinned via env; exp 10s in the past.
      const { signJWT } = await import("better-auth/crypto");
      const expired = await signJWT({ email }, "x".repeat(32), -10);
      const res = await app.handle(
        new Request(`http://localhost/api/auth/verify-email?token=${encodeURIComponent(expired)}`),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("TOKEN_EXPIRED");
      expect(await emailVerifiedOf(db, email)).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("unverified sign-in still succeeds (verification is never a gate)", async () => {
    const { fake, app } = await makeEmailApp();
    try {
      const email = `u-${crypto.randomUUID()}@e2e.test`;
      await signUpAs(app, email);
      expect(fake.messages.length).toBe(1);
      const res = await req(app, "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "x-forwarded-for": "10.2.0.1" },
        body: { email, password: "Correct-Horse-Battery-Staple-1" },
      });
      expect(res.status).toBe(200);
    } finally {
      fake.stop();
    }
  });

  test("resend endpoint: enumeration-safe and rate-limited by Better Auth rules", async () => {
    const { fake, app } = await makeEmailApp();
    try {
      const ghost = `ghost-${crypto.randomUUID()}@e2e.test`;
      // Unknown address: same 200 {status:true} as a real one (no enumeration),
      // and nothing is delivered.
      for (let i = 0; i < 3; i++) {
        const res = await req(app, "/api/auth/send-verification-email", {
          method: "POST",
          headers: { "x-forwarded-for": "10.3.0.1" },
          body: { email: ghost },
        });
        expect(res.status).toBe(200);
      }
      expect(fake.messages.length).toBe(0);
      // Built-in Better Auth special rule: 3 per 60s per IP+path.
      const fourth = await req(app, "/api/auth/send-verification-email", {
        method: "POST",
        headers: { "x-forwarded-for": "10.3.0.1" },
        body: { email: ghost },
      });
      expect(fourth.status).toBe(429);
    } finally {
      fake.stop();
    }
  });

  test("account email change: mail targets the new address, verified flag resets", async () => {
    const { fake, db, app } = await makeEmailApp();
    try {
      const email = `u-${crypto.randomUUID()}@e2e.test`;
      const cookie = await signUpAs(app, email);
      fake.messages.length = 0;
      const next = `changed-${crypto.randomUUID()}@e2e.test`;
      const res = await req(app, "/api/v1/account/email", {
        method: "POST",
        cookie,
        body: { email: next, currentPassword: "Correct-Horse-Battery-Staple-1" },
      });
      expect(res.status).toBe(200);
      expect(fake.messages.length).toBe(1);
      expect(fake.messages[0]!.rcptTo).toBe(`RCPT TO:<${next}>`);
      expect(await emailVerifiedOf(db, next)).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("admin email edit mails the new address; name-only edit mails nothing", async () => {
    const { fake, db, app } = await makeEmailApp();
    try {
      const adminEmail = `admin-${crypto.randomUUID()}@e2e.test`;
      const cookie = await signUpAs(app, adminEmail, "Admin");
      await makeInstanceAdmin(db, await userIdByEmail(db, adminEmail));
      const target = `target-${crypto.randomUUID()}@e2e.test`;
      await signUpAs(app, target);
      const id = await userIdByEmail(db, target);
      fake.messages.length = 0;

      // Name-only: no mail.
      const nameRes = await req(app, `/api/v1/admin/users/${id}`, {
        method: "PATCH",
        cookie,
        body: { name: "Renamed" },
      });
      expect(nameRes.status).toBe(200);
      expect(fake.messages.length).toBe(0);

      // Email edit: one mail to the new address.
      const next = `adminedit-${crypto.randomUUID()}@e2e.test`;
      const emailRes = await req(app, `/api/v1/admin/users/${id}`, {
        method: "PATCH",
        cookie,
        body: { email: next },
      });
      expect(emailRes.status).toBe(200);
      expect(fake.messages.length).toBe(1);
      expect(fake.messages[0]!.rcptTo).toBe(`RCPT TO:<${next}>`);
      expect(await emailVerifiedOf(db, next)).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("SMTP delivery failure does not crash signup and logs without tokens", async () => {
    // Point SMTP_HOST at a dead port: delivery fails, signup still 200.
    const fake = startFakeSmtp();
    pinEnv({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(fake.port),
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      HBR_EMAIL_FROM: "noreply@hbr.test",
      HBR_SMTP_SECURE: "none",
      NODE_ENV: "test",
      BETTER_AUTH_URL: undefined,
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    fake.stop(); // nothing listens on this port anymore
    const { app } = await makeApp();
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const res = await signUpAs(app, `u-${crypto.randomUUID()}@e2e.test`);
      expect(res).toBeTruthy();
      const joined = logs.join("\n");
      expect(joined).toContain("verification email not delivered");
      // No JWT/token-shaped blob may reach the log.
      expect(joined).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    } finally {
      console.error = origError;
    }
  });

  test("public-config: emailVerification enabled=true required=false, no SMTP secrets", async () => {
    const { fake, app } = await makeEmailApp();
    try {
      const res = await req(app, "/api/v1/public-config");
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as {
        emailVerification: { enabled: boolean; required: boolean };
      };
      expect(body.emailVerification).toEqual({ enabled: true, required: false });
      expect(raw).not.toContain("hbr.test-from-secret");
      expect(raw).not.toContain("SMTP_HOST");
      expect(raw).not.toContain("noreply@hbr.test");
    } finally {
      fake.stop();
    }
  });
});

describe("email verification (SMTP off)", () => {
  test("existing flow unchanged: signup + sign-in work, resend is disabled, flags off", async () => {
    pinEnv({
      SMTP_HOST: undefined,
      HBR_EMAIL_FROM: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      HBR_SMTP_SECURE: undefined,
      NODE_ENV: "test",
      BETTER_AUTH_URL: undefined,
    });
    const { app } = await makeApp();
    const email = `u-${crypto.randomUUID()}@e2e.test`;
    const res = await signUp(app, email);
    expect(res).toBeTruthy();
    const signin = await req(app, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: "Correct-Horse-Battery-Staple-1" },
    });
    expect(signin.status).toBe(200);
    const resend = await req(app, "/api/auth/send-verification-email", {
      method: "POST",
      body: { email },
    });
    expect(resend.status).toBe(400);
    // buildApp wraps Better Auth errors in { error: { code, message } }.
    const resendBody = (await resend.json()) as { error?: { code?: string; message?: string } };
    expect(resendBody.error?.code).toBe("VERIFICATION_EMAIL_NOT_ENABLED");
    expect(resendBody.error?.message).toBe("Verification email isn't enabled");
    const cfg = await req(app, "/api/v1/public-config");
    expect((await cfg.json()).emailVerification).toEqual({ enabled: false, required: false });
  });
});

afterAll(async () => {
  restoreEnv();
});
