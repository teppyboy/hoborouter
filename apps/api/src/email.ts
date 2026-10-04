// Minimal SMTP client for verification emails. Standard platform only
// (node:net / node:tls, both supported by Bun) — no new dependencies.
// One command dialogue per send; if SMTP needs outgrow this (pipelining,
// OAuth XOAUTH2), revisit rather than extend here.
//
// Security notes: server replies are never echoed into errors (reply text
// could reflect credentials/tokens); AUTH credentials are never logged;
// TLS certificate verification is always on; cleartext transport is refused
// in production.
import { randomUUID } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type SmtpEnv = Record<string, string | undefined>;

const CONNECT_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;
// Constant boundary is safe: every interpolated value (from/to/url) is
// CRLF-guarded and the surrounding MIME text is fixed, so a body can never
// forge a "--hbr-verify-alt" line.
const BOUNDARY = "hbr-verify-alt";

/** SMTP delivery is enabled when a host and a From address are configured. */
export function emailVerificationEnabled(env: SmtpEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.HBR_EMAIL_FROM);
}

export class SmtpError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

interface SmtpReply {
  code: number;
  /** Reply lines with the "NNN " / "NNN-" prefix stripped (internal use only). */
  lines: string[];
}

// A reply is complete when a full "NNN<space>" line has been received
// (terminated by CRLF). "NNN-" lines continue. Only complete lines are
// consumed; anything after the final CRLF (partial line or the next reply)
// is returned as `rest` and kept in the session buffer.
function parseReply(buffer: string): { reply: SmtpReply; rest: string } | null {
  const lines: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf("\r\n", start);
    if (idx === -1) return null; // still waiting for a complete line
    const line = buffer.slice(start, idx);
    start = idx + 2;
    if (line.length < 4) return null; // malformed reply line
    const code = Number(line.slice(0, 3));
    const sep = line[3];
    if (!Number.isInteger(code) || (sep !== " " && sep !== "-")) return null;
    lines.push(line.slice(4));
    if (sep === " ") {
      return { reply: { code, lines }, rest: buffer.slice(start) };
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function dotStuff(payload: string): string {
  return payload
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? "." + l : l))
    .join("\r\n");
}

/**
 * Envelope mailbox from a header value. HBR_EMAIL_FROM may be a display form
 * like `Hoborouter <no-reply@example.com>`; the envelope address is what goes
 * into MAIL FROM, while the header keeps the original display form.
 */
function envelopeMailbox(headerValue: string, field: "HBR_EMAIL_FROM" | "recipient"): string {
  if (/[\r\n]/.test(headerValue)) {
    // Value intentionally not echoed: it contains control characters.
    throw new SmtpError(null, `Refusing ${field}: newline characters are not allowed`);
  }
  const angle = /<([^<>]*)>/.exec(headerValue);
  const addr = (angle?.[1] ?? headerValue).trim();
  // Printable ASCII, no angle-bracket/quote/space tricks, exactly one @.
  const at = addr.split("@");
  if (
    at.length !== 2 ||
    at.some((part) => part.length === 0 || !/^[\x21-\x7E]+$/.test(part) || /[\s<>"@]/.test(part))
  ) {
    throw new SmtpError(null, `Invalid ${field}: no parseable ASCII envelope mailbox`);
  }
  return addr;
}

/** Wire-format message builder; exported so tests can pin headers/escaping. */
export function buildVerificationMessage(
  fromHeader: string,
  toHeader: string,
  url: string,
  headers?: { date?: string; messageId?: string },
): string {
  envelopeMailbox(fromHeader, "HBR_EMAIL_FROM");
  envelopeMailbox(toHeader, "recipient");
  if (/[\r\n]/.test(url)) {
    throw new SmtpError(null, "Refusing url: newline characters are not allowed");
  }
  const date = headers?.date ?? new Date().toUTCString();
  const messageId = headers?.messageId ?? `<${randomUUID()}@hbr.local>`;
  const text = `Verify your email address:\r\n${url}\r\n`;
  const html =
    `<p>Verify your email address:</p>\r\n` +
    `<p><a href="${escapeHtml(url)}">Verify email address</a></p>\r\n`;
  const payload =
    `From: ${fromHeader}\r\n` +
    `To: ${toHeader}\r\n` +
    `Subject: Verify your email address\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${BOUNDARY}"\r\n` +
    `\r\n` +
    `--${BOUNDARY}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    text +
    `--${BOUNDARY}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n` +
    `\r\n` +
    html +
    `--${BOUNDARY}--\r\n`;
  return dotStuff(payload);
}

class SmtpSession {
  private socket: Socket;
  private buffer = "";
  private pending: SmtpReply | null = null;
  private waiter: {
    resolve: (r: SmtpReply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this.fail(new SmtpError(null, "SMTP reply exceeded size limit"));
      return;
    }
    const parsed = parseReply(this.buffer);
    if (!parsed) return;
    this.buffer = parsed.rest; // keep any leftover (partial line / next reply)
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(parsed.reply);
    } else {
      // Reply raced ahead of readReply (e.g. server greeting during connect).
      this.pending = parsed.reply;
    }
  };

  private readonly onError = (err: Error): void => {
    this.fail(err);
  };

  private readonly onClose = (): void => {
    this.fail(new SmtpError(null, "SMTP connection closed before the command completed"));
  };

  private attach(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private detach(socket: Socket): void {
    socket.removeListener("data", this.onData);
    socket.removeListener("error", this.onError);
    socket.removeListener("close", this.onClose);
  }

  // Always clears the pending timer/reader and tears the socket down; errors
  // never leave a half-open connection behind.
  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    if (w) clearTimeout(w.timer);
    this.socket.destroy();
    if (w) w.reject(err);
  }

  private accept(reply: SmtpReply, expect: number[], label: string): SmtpReply {
    if (!expect.includes(reply.code)) {
      // Generic numeric error only: never echo server reply text here.
      throw new SmtpError(reply.code, `Unexpected SMTP response ${reply.code} for ${label}`);
    }
    return reply;
  }

  async readReply(deadlineMs: number, expect: number[], label: string): Promise<SmtpReply> {
    let reply: SmtpReply;
    if (this.pending) {
      const r = this.pending;
      this.pending = null;
      reply = r;
    } else if (this.closed) {
      throw new SmtpError(null, "SMTP connection is closed");
    } else {
      reply = await new Promise<SmtpReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fail(new SmtpError(null, `SMTP response timed out for ${label}`));
        }, deadlineMs);
        this.waiter = { resolve, reject, timer };
      });
    }
    return this.accept(reply, expect, label);
  }

  async command(text: string, deadlineMs: number, expect: number[], label: string): Promise<SmtpReply> {
    this.socket.write(text + "\r\n");
    const reply = await this.readReply(deadlineMs, expect, label);
    return this.accept(reply, expect, label);
  }

  writeData(payload: string): void {
    this.socket.write(payload);
  }

  /** Upgrade the live connection to TLS; certificate verification is always on. */
  async starttls(servername: string, deadlineMs: number): Promise<void> {
    const plain = this.socket;
    this.detach(plain);
    const secure = tlsConnect({ socket: plain, servername, rejectUnauthorized: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          secure.destroy();
          reject(new SmtpError(null, "STARTTLS handshake timed out"));
        }, deadlineMs);
        secure.once("secureConnect", () => {
          clearTimeout(timer);
          resolve();
        });
        secure.once("error", (err: Error) => {
          clearTimeout(timer);
          reject(new SmtpError(null, `TLS connection failed: ${err.message}`));
        });
      });
    } catch (err) {
      plain.destroy();
      this.closed = true;
      throw err;
    }
    this.socket = secure;
    this.attach(secure);
  }

  end(): void {
    this.closed = true;
    this.waiter = null;
    this.socket.destroy();
  }
}

function connectSocket(
  host: string,
  port: number,
  mode: "ssl" | "starttls" | "none",
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      mode === "ssl"
        ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true })
        : netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(null, `SMTP connect to ${host}:${port} timed out`));
    }, CONNECT_TIMEOUT_MS);
    const onUp = (): void => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (err: Error): void => {
      clearTimeout(timer);
      reject(new SmtpError(null, `SMTP connect failed: ${err.message}`));
    };
    socket.once(mode === "ssl" ? "secureConnect" : "connect", onUp);
    socket.once("error", onError);
  });
}

interface EhloCaps {
  starttls: boolean;
  authMechs: string[];
}

function parseEhlo(reply: SmtpReply): EhloCaps {
  let starttls = false;
  let authMechs: string[] = [];
  for (const line of reply.lines) {
    if (line.toUpperCase() === "STARTTLS") starttls = true;
    const m = /^AUTH[= ](.+)$/i.exec(line);
    const mechList = m?.[1];
    if (mechList) {
      authMechs = mechList
        .trim()
        .toUpperCase()
        .split(/\s+/)
        .filter((x) => x.length > 0 && x !== "*");
    }
  }
  return { starttls, authMechs };
}

/**
 * Send the verification email over SMTP.
 *
 * Env: SMTP_HOST, SMTP_PORT (default 587, or 465 → ssl), SMTP_USER +
 * SMTP_PASSWORD (optional, must be paired), HBR_SMTP_SECURE
 * (`starttls` default | `ssl` | `none` — cleartext, local dev ONLY, refused
 * in production), HBR_EMAIL_FROM (bare address or `Name <addr>` display form).
 *
 * STARTTLS is mandatory in the default mode (fails before AUTH if the server
 * does not offer it). Exact response codes are enforced per command; the DATA
 * payload is only sent after a 354.
 */
export async function sendVerificationEmail(
  { to, url }: { to: string; url: string },
  env: SmtpEnv = process.env,
): Promise<void> {
  const fromHeader = env.HBR_EMAIL_FROM;
  const host = env.SMTP_HOST;
  if (!host || !fromHeader) {
    throw new SmtpError(null, "SMTP is not configured: SMTP_HOST and HBR_EMAIL_FROM are required");
  }
  const port = env.SMTP_PORT === undefined ? undefined : Number(env.SMTP_PORT);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new SmtpError(null, "Invalid SMTP_PORT");
  }
  const secureRaw = env.HBR_SMTP_SECURE ?? (port === 465 ? "ssl" : "starttls");
  if (secureRaw !== "starttls" && secureRaw !== "ssl" && secureRaw !== "none") {
    throw new SmtpError(null, "Invalid HBR_SMTP_SECURE: expected starttls, ssl, or none");
  }
  const mode = secureRaw;
  if (mode === "none" && env.NODE_ENV === "production") {
    throw new SmtpError(null, "HBR_SMTP_SECURE=none is refused in production (cleartext transport)");
  }
  const user = env.SMTP_USER;
  const password = env.SMTP_PASSWORD;
  if ((user === undefined) !== (password === undefined)) {
    throw new SmtpError(null, "SMTP_USER and SMTP_PASSWORD must be configured together");
  }
  // Envelope addresses (MAIL FROM / RCPT TO) — headers keep the display form.
  const from = envelopeMailbox(fromHeader, "HBR_EMAIL_FROM");
  const rcpt = envelopeMailbox(to, "recipient");

  const deadlineAt = Date.now() + TOTAL_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadlineAt - Date.now());

  let session: SmtpSession | null = null;
  try {
    session = new SmtpSession(
      await connectSocket(host, port ?? (mode === "ssl" ? 465 : 587), mode),
    );
    await session.readReply(remaining(), [220], "GREETING");
    const runEhlo = async (s: SmtpSession): Promise<EhloCaps> =>
      parseEhlo(await s.command(`EHLO localhost`, remaining(), [250], "EHLO"));
    let caps = await runEhlo(session);

    if (mode === "starttls") {
      if (!caps.starttls) {
        throw new SmtpError(
          null,
          "SMTP server does not offer STARTTLS; refusing to authenticate or send without TLS",
        );
      }
      await session.command("STARTTLS", remaining(), [220], "STARTTLS");
      await session.starttls(host, remaining());
      caps = await runEhlo(session); // capabilities change after upgrade
    }

    if (user !== undefined && password !== undefined) {
      const mechs = caps.authMechs;
      if (mechs.includes("PLAIN")) {
        await session.command(
          `AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`,
          remaining(),
          [235],
          "AUTH PLAIN",
        );
      } else if (mechs.includes("LOGIN")) {
        await session.command("AUTH LOGIN", remaining(), [334], "AUTH LOGIN");
        await session.command(
          Buffer.from(user).toString("base64"),
          remaining(),
          [334],
          "AUTH LOGIN username",
        );
        await session.command(
          Buffer.from(password).toString("base64"),
          remaining(),
          [235],
          "AUTH LOGIN password",
        );
      } else {
        throw new SmtpError(
          null,
          "SMTP server offers no supported AUTH mechanism (need PLAIN or LOGIN)",
        );
      }
    }

    await session.command(`MAIL FROM:<${from}>`, remaining(), [250], "MAIL FROM");
    await session.command(`RCPT TO:<${rcpt}>`, remaining(), [250, 251], "RCPT TO");
    await session.command("DATA", remaining(), [354], "DATA");
    session.writeData(buildVerificationMessage(fromHeader, to, url) + "\r\n.\r\n");
    await session.readReply(remaining(), [250], "DATA payload");
    try {
      await session.command("QUIT", remaining(), [221], "QUIT");
    } catch {
      // Server may close before replying to QUIT; delivery already succeeded.
    }
  } finally {
    session?.end();
  }
}
