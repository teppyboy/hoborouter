// Task: SMTP verification-email transport (apps/api/src/email.ts).
// Tests run against a local fake SMTP server (Bun.listen, plaintext dev mode
// or a throwaway self-signed TLS cert) — no live mail, no external services.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVerificationMessage,
  emailVerificationEnabled,
  sendVerificationEmail,
} from "../src/email";
// Fake SMTP server lives in smtp-helper.ts so other suites can reuse it
// without re-running this transport suite; re-exported for compatibility.
import { startFakeSmtp } from "./smtp-helper";
export { startFakeSmtp } from "./smtp-helper";
export type { FakeSmtpOptions, FakeSmtpState } from "./smtp-helper";

const GOOD_ENV = {
  SMTP_HOST: "127.0.0.1",
  HBR_EMAIL_FROM: "noreply@hbr.test",
};

// --- TLS fixture (test-only; generated at runtime, never committed) ---
const haveOpenssl = Bun.which("openssl") !== null;
let certDir: string | null = null;
if (haveOpenssl) {
  certDir = mkdtempSync(join(tmpdir(), "hbr-smtp-test-cert-"));
  const proc = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { cwd: certDir, stdout: "ignore", stderr: "ignore" },
  );
  if (proc.exitCode !== 0) {
    rmSync(certDir, { recursive: true, force: true });
    certDir = null;
  }
}
const tlsFixtureReady = certDir !== null;

afterAll(() => {
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

describe("emailVerificationEnabled", () => {
  test("off without SMTP_HOST / HBR_EMAIL_FROM", () => {
    expect(emailVerificationEnabled({})).toBe(false);
    expect(emailVerificationEnabled({ SMTP_HOST: "smtp.test" })).toBe(false);
    expect(emailVerificationEnabled({ HBR_EMAIL_FROM: "noreply@hbr.test" })).toBe(false);
  });

  test("on with both SMTP_HOST and HBR_EMAIL_FROM", () => {
    expect(emailVerificationEnabled({ ...GOOD_ENV })).toBe(true);
  });
});

describe("buildVerificationMessage", () => {
  test("safe headers, dot-stuffing, html escaping, CRLF framing", () => {
    const msg = buildVerificationMessage(
      "Hoborouter <noreply@hbr.test>",
      "user@example.com",
      "http://hbr.test/verify?token=1&x=<a>..hidden",
      { date: "Mon, 01 Jan 2026 00:00:00 GMT", messageId: "<fixed@hbr.local>" },
    );
    expect(msg.startsWith("From: Hoborouter <noreply@hbr.test>\r\nTo: user@example.com\r\n")).toBe(true);
    expect(msg.includes("Date: Mon, 01 Jan 2026 00:00:00 GMT\r\n")).toBe(true);
    expect(msg.includes("Message-ID: <fixed@hbr.local>\r\n")).toBe(true);
    expect(msg.includes("text/plain")).toBe(true);
    expect(msg.includes("text/html")).toBe(true);
    // Raw url appears verbatim in the text part; HTML part escapes & < >.
    expect(msg.includes("http://hbr.test/verify?token=1&x=<a>")).toBe(true);
    expect(msg.includes("&amp;x=&lt;a&gt;")).toBe(true);
    // Mid-line dots stay untouched; line-leading dots are stuffed ("..hidden"
    // here sits mid-line, the e2e test covers a line-leading dot).
    expect(msg.includes("x=<a>..hidden\r\n")).toBe(true);
    // No bare LF or CR outside CRLF pairs.
    expect(/(?<!\r)\n/.test(msg)).toBe(false);
    expect(/\r(?!\n)/.test(msg)).toBe(false);
    expect(msg.endsWith(`--hbr-verify-alt--\r\n`)).toBe(true);
  });

  test("rejects CRLF injection in from/to/url", () => {
    expect(() => buildVerificationMessage("a@b.test\r\nBcc: x@y.test", "t@t.test", "u")).toThrow();
    expect(() => buildVerificationMessage("a@b.test", "t@t.test\nBcc: x@y.test", "u")).toThrow();
    expect(() => buildVerificationMessage("a@b.test", "t@t.test", "u\r\n.")).toThrow();
  });

  test("from header must contain a parseable envelope mailbox", () => {
    expect(() => buildVerificationMessage("Hoborouter", "t@t.test", "u")).toThrow(/HBR_EMAIL_FROM/);
    expect(() => buildVerificationMessage("a@b.test@c.test", "t@t.test", "u")).toThrow(/HBR_EMAIL_FROM/);
  });
});

describe("sendVerificationEmail", () => {
  test("config validation", async () => {
    await expect(sendVerificationEmail({ to: "a@b.test", url: "u" }, {})).rejects.toThrow(
      /not configured/,
    );
    await expect(
      sendVerificationEmail(
        { to: "a@b.test", url: "u" },
        { SMTP_HOST: "h", HBR_EMAIL_FROM: "f@f.test", SMTP_PORT: "x" },
      ),
    ).rejects.toThrow(/SMTP_PORT/);
    await expect(
      sendVerificationEmail(
        { to: "a@b.test", url: "u" },
        { SMTP_HOST: "h", HBR_EMAIL_FROM: "f@f.test", HBR_SMTP_SECURE: "maybe" },
      ),
    ).rejects.toThrow(/HBR_SMTP_SECURE/);
    await expect(
      sendVerificationEmail(
        { to: "a@b.test", url: "u" },
        { SMTP_HOST: "h", HBR_EMAIL_FROM: "u" },
      ),
    ).rejects.toThrow(/HBR_EMAIL_FROM/);
    await expect(
      sendVerificationEmail(
        { to: "a@b.test", url: "u" },
        { SMTP_HOST: "h", HBR_EMAIL_FROM: "f@f.test", SMTP_USER: "u" },
      ),
    ).rejects.toThrow(/together/);
  });

  test("non-220 greeting fails fast before EHLO", async () => {
    const fake = startFakeSmtp({ greetingCode: 554 });
    try {
      await expect(
        sendVerificationEmail(
          { to: "a@b.test", url: "http://hbr.test/v" },
          { ...GOOD_ENV, HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
        ),
      ).rejects.toThrow(/554/);
      expect(fake.ehloCount).toBe(0);
      expect(fake.messages.length).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("display-name From: envelope parsed, header kept, Date/Message-ID added", async () => {
    const fake = startFakeSmtp();
    try {
      await sendVerificationEmail(
        { to: "user@example.com", url: "http://hbr.test/v" },
        {
          SMTP_HOST: "127.0.0.1",
          HBR_EMAIL_FROM: "Hoborouter <no-reply@example.com>",
          HBR_SMTP_SECURE: "none",
          SMTP_PORT: String(fake.port),
        },
      );
      expect(fake.messages.length).toBe(1);
      const msg = fake.messages[0]!;
      expect(msg.mailFrom).toBe("MAIL FROM:<no-reply@example.com>");
      expect(msg.data).toContain("From: Hoborouter <no-reply@example.com>");
      expect(msg.data).toContain("Date: ");
      expect(msg.data).toMatch(/Message-ID: <[0-9a-f-]+@hbr\.local>/);
    } finally {
      fake.stop();
    }
  });

  test("production refuses HBR_SMTP_SECURE=none before connecting", async () => {
    const fake = startFakeSmtp();
    try {
      await expect(
        sendVerificationEmail(
          { to: "a@b.test", url: "http://hbr.test/v" },
          { ...GOOD_ENV, NODE_ENV: "production", HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
        ),
      ).rejects.toThrow(/production/);
      expect(fake.connections).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("cleartext delivery in dev mode: full dialogue, message content, QUIT", async () => {
    const fake = startFakeSmtp();
    try {
      await sendVerificationEmail(
        { to: "user@example.com", url: "http://hbr.test/verify?token=secret-token-1" },
        { ...GOOD_ENV, HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
      );
      expect(fake.connections).toBe(1);
      expect(fake.quitCount).toBe(1);
      expect(fake.messages.length).toBe(1);
      const msg = fake.messages[0]!;
      expect(msg.mailFrom).toBe("MAIL FROM:<noreply@hbr.test>");
      expect(msg.rcptTo).toBe("RCPT TO:<user@example.com>");
      expect(msg.data).toContain("From: noreply@hbr.test");
      expect(msg.data).toContain("To: user@example.com");
      expect(msg.data).toContain("http://hbr.test/verify?token=secret-token-1");
    // Dots mid-line are never stuffed; only line-leading dots are (see the
    // dot-stuffed e2e test below). Quotes around href are template literals;
    // the URL itself is escaped.
    expect(msg.data).toContain('href="http://hbr.test/verify?token=secret-token-1"');
    } finally {
      fake.stop();
    }
  });

  test("auth: PLAIN preferred, credentials sent base64-encoded", async () => {
    const fake = startFakeSmtp({ requireAuth: true });
    try {
      await sendVerificationEmail(
        { to: "user@example.com", url: "http://hbr.test/v" },
        {
          ...GOOD_ENV,
          HBR_SMTP_SECURE: "none",
          SMTP_PORT: String(fake.port),
          SMTP_USER: "smtpuser",
          SMTP_PASSWORD: "smtppass",
        },
      );
      expect(fake.authAttempts).toBe(1);
      expect(fake.authPlainDecoded).toBe("\0smtpuser\0smtppass");
      expect(fake.messages.length).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("auth: LOGIN fallback when PLAIN is not advertised", async () => {
    const fake = startFakeSmtp({ ehloLines: ["hbr-fake ready", "AUTH LOGIN"] });
    try {
      await sendVerificationEmail(
        { to: "user@example.com", url: "http://hbr.test/v" },
        {
          ...GOOD_ENV,
          HBR_SMTP_SECURE: "none",
          SMTP_PORT: String(fake.port),
          SMTP_USER: "smtpuser",
          SMTP_PASSWORD: "smtppass",
        },
      );
      expect(fake.authAttempts).toBe(1);
      expect(fake.authLoginUser).toBe("smtpuser");
      expect(fake.messages.length).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("server rejects auth with 535", async () => {
    const fake = startFakeSmtp({ authAccept: false });
    try {
      await expect(
        sendVerificationEmail(
          { to: "user@example.com", url: "http://hbr.test/v" },
          {
            ...GOOD_ENV,
            HBR_SMTP_SECURE: "none",
            SMTP_PORT: String(fake.port),
            SMTP_USER: "u",
            SMTP_PASSWORD: "p",
          },
        ),
      ).rejects.toThrow(/535/);
      expect(fake.messages.length).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("server rejects recipient with 550", async () => {
    const fake = startFakeSmtp({ rcptAccept: false });
    try {
      await expect(
        sendVerificationEmail(
          { to: "user@example.com", url: "http://hbr.test/v" },
          { ...GOOD_ENV, HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
        ),
      ).rejects.toThrow(/550/);
      expect(fake.messages.length).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("missing STARTTLS fails before AUTH (cleartext AUTH refused)", async () => {
    const fake = startFakeSmtp({ ehloLines: ["hbr-fake ready", "SIZE 10485760"] });
    try {
      await expect(
        sendVerificationEmail(
          { to: "user@example.com", url: "http://hbr.test/v" },
          {
            ...GOOD_ENV,
            NODE_ENV: "production",
            SMTP_PORT: String(fake.port),
            SMTP_USER: "u",
            SMTP_PASSWORD: "p",
          },
        ),
      ).rejects.toThrow(/STARTTLS/);
      expect(fake.authAttempts).toBe(0);
      expect(fake.starttlsAttempts).toBe(0);
      expect(fake.messages.length).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("multiline + fragmented server responses are parsed", async () => {
    const fake = startFakeSmtp({ fragmentGreeting: true, fragmentEhlo: true });
    try {
      await sendVerificationEmail(
        { to: "user@example.com", url: "http://hbr.test/v" },
        { ...GOOD_ENV, HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
      );
      expect(fake.messages.length).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("dot-stuffed DATA payload preserves lines starting with '.'", async () => {
    const fake = startFakeSmtp();
    try {
      // Dot-leading url is CRLF-free (the injection guard stays intact); the
      // text-part line therefore legitimately starts with '.' on the wire.
      await sendVerificationEmail(
        { to: "user@example.com", url: "..dots-at-line-start" },
        { ...GOOD_ENV, HBR_SMTP_SECURE: "none", SMTP_PORT: String(fake.port) },
      );
      const data = fake.messages[0]!.data;
      // "..dots-at-line-start" was sent as "...dots-at-line-start".
      expect(data.includes("\r\n...dots-at-line-start")).toBe(true);
      // Terminator: empty line + "." ends DATA, so the stored payload keeps
      // the trailing blank line before the terminator.
      expect(data.endsWith("--hbr-verify-alt--\r\n\r\n")).toBe(true);
    } finally {
      fake.stop();
    }
  });

  (tlsFixtureReady ? test : test.skip)("ssl mode: self-signed cert rejected (TLS verification on)", async () => {
    const cert = Bun.file(join(certDir!, "cert.pem"));
    const key = Bun.file(join(certDir!, "key.pem"));
    const [certText, keyText] = await Promise.all([cert.text(), key.text()]);
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: certText, key: keyText },
      socket: {
        open(sock) {
          sock.write("220 hbr-fake-tls ready\r\n");
        },
        data() {},
      },
    });
    try {
      await expect(
        sendVerificationEmail(
          { to: "user@example.com", url: "http://hbr.test/v" },
          { ...GOOD_ENV, HBR_SMTP_SECURE: "ssl", SMTP_PORT: String(server.port) },
        ),
      ).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });
});
