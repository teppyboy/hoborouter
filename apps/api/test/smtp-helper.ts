// Shared fake SMTP server for tests: extracted from smtp.test.ts so API-level
// suites (email-verification.test.ts) can import it without re-running the
// SMTP transport suite. Plaintext dev mode only; no live mail.
export interface FakeSmtpOptions {
  ehloLines?: string[]; // capability lines, code prefixes added by server
  authAccept?: boolean; // default: accept
  rcptAccept?: boolean; // default: accept
  requireAuth?: boolean; // 530 on MAIL FROM when not authenticated
  greetingCode?: number; // non-220 greeting to test fast failure
  fragmentGreeting?: boolean;
  fragmentEhlo?: boolean;
}

export interface FakeSmtpState {
  port: number;
  connections: number;
  ehloCount: number;
  authAttempts: number;
  starttlsAttempts: number;
  quitCount: number;
  authPlainDecoded: string | null;
  authLoginUser: string | null;
  messages: { mailFrom: string | null; rcptTo: string | null; data: string }[];
  stop: () => void;
}

export function startFakeSmtp(opts: FakeSmtpOptions = {}): FakeSmtpState {
  const ehloLines = opts.ehloLines ?? ["hbr-fake ready", "SIZE 10485760", "AUTH PLAIN LOGIN"];
  const state = {
    port: 0,
    connections: 0,
    ehloCount: 0,
    authAttempts: 0,
    starttlsAttempts: 0,
    quitCount: 0,
    authPlainDecoded: null as string | null,
    authLoginUser: null as string | null,
    messages: [] as FakeSmtpState["messages"],
    stop: () => {},
  };
  const reply = (
    sock: { write: (s: string) => unknown },
    code: number,
    lines: string[],
  ): void => {
    const body = lines
      .map((l, i) => (i === lines.length - 1 ? `${code} ${l}` : `${code}-${l}`))
      .join("\r\n");
    sock.write(body + "\r\n");
  };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        state.connections++;
        conns.set(sock, { buffer: "", inData: false, dataBuf: "", mailFrom: null, rcptTo: null, authed: false, loginStep: 0 });
        if (opts.greetingCode !== undefined) {
          sock.write(`${opts.greetingCode} service unavailable\r\n`);
        } else if (opts.fragmentGreeting) {
          sock.write("220-hbr-fake rea");
          setTimeout(() => {
            sock.write("dy\r\n220 go\r\n");
          }, 5);
        } else {
          reply(sock, 220, ["hbr-fake greeting line one", "go"]);
        }
      },
      data(sock, chunk) {
        const conn = conns.get(sock);
        if (!conn) return;
        let buffer = conn.buffer + String(chunk);
        let inData = conn.inData;
        let dataBuf = conn.dataBuf;
        let mailFrom = conn.mailFrom;
        let rcptTo = conn.rcptTo;
        let authed = conn.authed;
        let loginStep = conn.loginStep;
        const handleLine = (line: string): void => {
          if (inData) {
            if (line === ".") {
              inData = false;
              state.messages.push({ mailFrom, rcptTo, data: dataBuf });
              dataBuf = "";
              reply(sock, 250, ["OK message accepted"]);
            } else {
              // Deliberately NOT un-stuffing: tests assert wire format.
              dataBuf += line + "\r\n";
            }
            return;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            state.ehloCount++;
            if (opts.fragmentEhlo) {
              sock.write(`250-${ehloLines[0]!.slice(0, 8)}`);
              setTimeout(() => {
                reply(sock, 250, [ehloLines[0]!.slice(8) === "" ? "" : ehloLines[0]!.slice(8)]);
                const rest = ehloLines.slice(1);
                if (rest.length > 0) reply(sock, 250, rest);
              }, 5);
            } else {
              reply(sock, 250, ehloLines);
            }
          } else if (upper.startsWith("AUTH PLAIN")) {
            state.authAttempts++;
            const b64 = line.split(" ")[2] ?? "";
            state.authPlainDecoded = Buffer.from(b64, "base64").toString();
            authed = opts.authAccept !== false;
            reply(sock, authed ? 235 : 535, [authed ? "authenticated" : "bad credentials"]);
          } else if (upper === "AUTH LOGIN") {
            state.authAttempts++;
            loginStep = 1;
            sock.write("334 VXNlcm5hbWU6\r\n"); // "Username:"
          } else if (loginStep === 1) {
            loginStep = 2;
            state.authLoginUser = Buffer.from(line, "base64").toString();
            sock.write("334 UGFzc3dvcmQ6\r\n"); // "Password:"
          } else if (loginStep === 2) {
            loginStep = 0;
            authed = opts.authAccept !== false;
            reply(sock, authed ? 235 : 535, [authed ? "authenticated" : "bad credentials"]);
          } else if (upper.startsWith("MAIL FROM")) {
            if (opts.requireAuth && !authed) {
              reply(sock, 530, ["authentication required"]);
            } else {
              mailFrom = line;
              reply(sock, 250, ["sender ok"]);
            }
          } else if (upper.startsWith("RCPT TO")) {
            rcptTo = line;
            if (opts.rcptAccept === false) {
              reply(sock, 550, ["mailbox unavailable"]);
            } else {
              reply(sock, 250, ["recipient ok"]);
            }
          } else if (upper === "DATA") {
            inData = true;
            sock.write("354 end data with <CRLF>.<CRLF>\r\n");
          } else if (upper === "STARTTLS") {
            state.starttlsAttempts++;
            reply(sock, 454, ["TLS not available"]);
          } else if (upper === "QUIT") {
            state.quitCount++;
            sock.write("221 bye\r\n");
            sock.end();
          } else {
            reply(sock, 500, ["unknown command"]);
          }
        };
        while (true) {
          const idx = buffer.indexOf("\r\n");
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleLine(line);
        }
        Object.assign(conn, { buffer, inData, dataBuf, mailFrom, rcptTo, authed, loginStep });
      },
    },
  });
  const conns = new Map<object, { buffer: string; inData: boolean; dataBuf: string; mailFrom: string | null; rcptTo: string | null; authed: boolean; loginStep: number }>();
  state.port = server.port;
  state.stop = () => server.stop(true);
  return state;
}
