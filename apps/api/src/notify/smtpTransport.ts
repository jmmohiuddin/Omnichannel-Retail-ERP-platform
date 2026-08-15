/**
 * Notification transport port and its SMTP adapter (R13.1).
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN nodemailer. The requirement that shapes
 * this file is not "send mail" — it is "distinguish a bounce from a transient
 * failure", because that distinction decides whether a row is retried or
 * surfaced on the Messages screen as undeliverable. That decision is made from
 * the SMTP reply code *and the stage it arrived at*, and a library that
 * flattens both into an Error loses exactly the information R13.1 needs. What
 * we need from SMTP is the submission subset — EHLO, STARTTLS, AUTH, one
 * recipient, a UTF-8 multipart body — which is small, fully specified, and
 * tested here against a real socket-level fake server rather than trusted.
 * DKIM signing, OAuth2, pooling and attachments are the parts that genuinely
 * want a library; when we need them, `NotificationTransport` is the seam and
 * swapping in nodemailer touches this file only.
 *
 * THE STAGE DISTINCTION. A 5xx is only a *bounce* if it came back at RCPT TO —
 * that is the server rejecting the recipient's address, and no amount of
 * retrying will conjure a mailbox into existence. A 5xx at connect, EHLO,
 * STARTTLS or AUTH is our own misconfiguration (wrong password, expired cert).
 * Classifying those as bounces would mark every queued message as "customer's
 * address is bad" and hide a broken SMTP credential behind a wall of false
 * bounces. Those stay transient: they retry, and after max_attempts they land
 * in `failed`, which is the honest state for "our side is broken".
 */
import net from "node:net";
import tls from "node:tls";
import type { Locale } from "./templates.js";

export interface OutgoingMessage {
  /** Notification row id — becomes the Message-ID and the MIME boundary, so a
   *  resend of the same row is byte-identical and traceable in mail logs. */
  notificationId: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  locale: Locale;
}

export interface SendResult {
  /** The provider's own handle for the accepted message, stored on the attempt. */
  providerRef?: string;
}

export interface NotificationTransport {
  send(message: OutgoingMessage): Promise<SendResult>;
}

/** Where in the SMTP conversation a failure happened. Drives classification. */
export type SmtpStage =
  | "address"
  | "connect"
  | "greeting"
  | "ehlo"
  | "starttls"
  | "auth"
  | "mail_from"
  | "rcpt_to"
  | "data"
  | "body"
  | "quit";

/**
 * `permanent` → the notification is `bounced` and never retried.
 * `transient`  → the notification is `failed` and retried with backoff.
 */
export type FailureKind = "permanent" | "transient";

export class TransportError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly stage: SmtpStage,
    /** SMTP reply code when the failure came from the server; undefined for
     *  socket-level faults (DNS, refused connection, timeout). */
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * The R13.1 rule, in one place so it can be unit-tested without a socket.
 *
 * Only a 5xx aimed at the *recipient* is a bounce. Everything else — 4xx
 * anywhere, 5xx during setup or authentication, socket faults — is worth
 * another attempt. DATA/body rejections are permanent because the message we
 * would retry is byte-identical to the one just refused.
 */
export const classifySmtpFailure = (stage: SmtpStage, code: number | undefined): FailureKind => {
  if (stage === "address") return "permanent";
  if (code === undefined) return "transient"; // socket, DNS, timeout
  if (code < 500) return "transient";
  switch (stage) {
    case "rcpt_to":
    case "data":
    case "body":
      return "permanent";
    default:
      // connect / greeting / ehlo / starttls / auth / mail_from / quit:
      // our configuration, not their address.
      return "transient";
  }
};

/**
 * Exponential backoff with full jitter, capped. Deterministic when `random` is
 * supplied, which is how it is tested. Jitter matters because a provider
 * outage fails a whole queue at once and an unjittered schedule would retry
 * the entire batch in lockstep forever.
 */
export const backoffMs = (
  attempts: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number => {
  const base = options.baseMs ?? 60_000;
  const cap = options.capMs ?? 6 * 60 * 60_000; // 6 hours
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  const ceiling = Math.min(cap, base * 2 ** exponent);
  const random = options.random ?? Math.random;
  // Full jitter over [ceiling/2, ceiling]: still monotonically increasing in
  // expectation, but never a synchronized thundering herd.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
};

// ---------------------------------------------------------------------------
// In-memory transport (tests, local development)
// ---------------------------------------------------------------------------

/**
 * Records what would have been sent. `failWith` scripts a failure by recipient
 * so a test can drive the bounce path without a mail server.
 */
export class MemoryTransport implements NotificationTransport {
  readonly sent: OutgoingMessage[] = [];
  private readonly scripted = new Map<string, TransportError>();

  /** Make every send to `recipient` fail with `error` until cleared. */
  failFor(recipient: string, error: TransportError): void {
    this.scripted.set(recipient.toLowerCase(), error);
  }

  clearFailure(recipient: string): void {
    this.scripted.delete(recipient.toLowerCase());
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const scripted = this.scripted.get(message.to.toLowerCase());
    if (scripted) throw scripted;
    this.sent.push(message);
    return { providerRef: `memory:${message.notificationId}` };
  }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). */
  secure?: boolean;
  /** On a plaintext port, refuse to continue if STARTTLS is unavailable.
   *  Defaults to true: credentials must never cross the wire in the clear. */
  requireTls?: boolean;
  user?: string;
  pass?: string;
  fromAddress: string;
  fromName?: string;
  /** Per-command deadline. Default 20s. */
  timeoutMs?: number;
  /** Only for self-signed dev servers. */
  rejectUnauthorized?: boolean;
  /** Injected in tests so Date-header output is deterministic. */
  now?: () => Date;
}

/** Read SMTP config from the environment; undefined when unconfigured. */
export const smtpConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | undefined => {
  const host = env.SMTP_HOST;
  const fromAddress = env.SMTP_FROM;
  if (!host || !fromAddress) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: env.SMTP_SECURE === "true" || port === 465,
    requireTls: env.SMTP_REQUIRE_TLS !== "false",
    ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
    ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
    fromAddress,
    ...(env.SMTP_FROM_NAME ? { fromName: env.SMTP_FROM_NAME } : {}),
    rejectUnauthorized: env.SMTP_TLS_INSECURE !== "true",
  };
};

const CRLF = "\r\n";

/** Deliberately strict: a display-name-wrapped address is a caller bug here. */
const ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;.]+(\.[^\s@<>,;.]+)+$/;

export const isDeliverableAddress = (value: string): boolean => ADDRESS_RE.test(value.trim());

/** RFC 2047 encoded-word — required the moment a subject contains Arabic. */
const encodeHeaderValue = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
};

const base64Lines = (value: string): string => {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) chunks.push(encoded.slice(i, i + 76));
  return chunks.join(CRLF);
};

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/**
 * Build the RFC 5322 message.
 *
 * Bodies are base64 throughout rather than quoted-printable: an Arabic body is
 * almost entirely non-ASCII, where quoted-printable inflates the payload ~3x
 * and invites line-length bugs, while base64 is fixed-cost and cannot produce
 * a line that needs dot-stuffing.
 */
export const buildMimeMessage = (
  message: OutgoingMessage,
  config: Pick<SmtpConfig, "fromAddress" | "fromName" | "now">,
): { messageId: string; raw: string } => {
  const from = config.fromName
    ? `${encodeHeaderValue(config.fromName)} <${config.fromAddress}>`
    : config.fromAddress;
  // Deterministic per notification: a redelivered row keeps one identity in
  // the receiving server's logs instead of looking like a new message.
  const messageId = `<${message.notificationId}@${domainOf(config.fromAddress)}>`;
  const boundary = `----voltix-${message.notificationId}`;
  const date = (config.now?.() ?? new Date()).toUTCString().replace("GMT", "+0000");

  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Content-Language: ${message.locale}`,
    // Transactional mail: keep it out of vacation-responder and list loops.
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
  ];

  if (!message.bodyHtml) {
    return {
      messageId,
      raw: [
        ...headers,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(message.bodyText),
      ].join(CRLF),
    };
  }

  return {
    messageId,
    raw: [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      // Plain part first: multipart/alternative is least-preferred first.
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.bodyText),
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.bodyHtml),
      "",
      `--${boundary}--`,
    ].join(CRLF),
  };
};

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * One SMTP conversation. A fresh connection per message: submission volumes
 * here are low, and a pooled connection that dies mid-queue is a much harder
 * failure to reason about than a reconnect.
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket | undefined;
  private buffer = "";
  /** Replies parsed but not yet consumed — a server may coalesce them into one
   *  TCP segment, and dropping the second would desync every later command. */
  private readonly replies: SmtpReply[] = [];
  private pending: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | undefined;
  private fatal: Error | undefined;

  constructor(private readonly config: SmtpConfig) {}

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? 20_000;
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.onFatal(err));
    socket.on("timeout", () => this.onFatal(new Error("SMTP socket timed out")));
    socket.on("close", () => this.onFatal(new Error("SMTP connection closed unexpectedly")));
  }

  private onFatal(err: Error): void {
    this.fatal ??= err;
    const waiter = this.pending;
    this.pending = undefined;
    waiter?.reject(err);
  }

  /**
   * SMTP replies are multiline: continuation lines put a hyphen after the
   * code, the final line a space. Reading only the first line would desync the
   * whole conversation the first time a server announces its extensions.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const lines = this.buffer.split(CRLF);
      // The trailing element is an incomplete line (or "" after a clean break).
      const complete = lines.slice(0, -1);
      const terminatorIndex = complete.findIndex((line) => /^\d{3}(?: |$)/.test(line));
      if (terminatorIndex === -1) return;
      const replyLines = complete.slice(0, terminatorIndex + 1);
      this.buffer = [...complete.slice(terminatorIndex + 1), lines.at(-1) ?? ""].join(CRLF);
      const code = Number(replyLines.at(-1)!.slice(0, 3));
      const text = replyLines.map((line) => line.slice(4)).join(" ").trim();
      const waiter = this.pending;
      this.pending = undefined;
      waiter?.resolve({ code, text });
      if (!this.pending) return;
    }
  }

  private read(): Promise<SmtpReply> {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise<SmtpReply>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private async command(line: string): Promise<SmtpReply> {
    if (this.fatal) throw this.fatal;
    const reply = this.read();
    this.socket!.write(line + CRLF);
    return reply;
  }

  private expect(reply: SmtpReply, ok: number[], stage: SmtpStage): SmtpReply {
    if (ok.includes(reply.code)) return reply;
    throw new TransportError(
      classifySmtpFailure(stage, reply.code),
      stage,
      reply.code,
      `SMTP ${stage} rejected: ${reply.code} ${reply.text}`,
    );
  }

  private connectSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      const socket = this.config.secure
        ? tls.connect({
            host: this.config.host,
            port: this.config.port,
            servername: this.config.host,
            rejectUnauthorized: this.config.rejectUnauthorized ?? true,
          }, () => { socket.removeListener("error", onError); resolve(socket); })
        : net.connect({ host: this.config.host, port: this.config.port }, () => {
            socket.removeListener("error", onError);
            resolve(socket);
          });
      socket.setTimeout(this.timeoutMs, () => reject(new Error("SMTP connect timed out")));
      socket.once("error", onError);
    });
  }

  private async upgradeToTls(): Promise<void> {
    const plain = this.socket!;
    plain.removeAllListeners();
    plain.setTimeout(0);
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const upgraded = tls.connect({
        socket: plain,
        servername: this.config.host,
        rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      }, () => { upgraded.removeListener("error", reject); resolve(upgraded); });
      upgraded.once("error", reject);
    });
    this.fatal = undefined;
    this.attach(secured);
  }

  private async authenticate(extensions: string): Promise<void> {
    const { user, pass } = this.config;
    if (!user || pass === undefined) return;
    const mechanisms = extensions.toUpperCase();
    if (mechanisms.includes("PLAIN")) {
      const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
      this.expect(await this.command(`AUTH PLAIN ${token}`), [235], "auth");
      return;
    }
    if (mechanisms.includes("LOGIN")) {
      this.expect(await this.command("AUTH LOGIN"), [334], "auth");
      this.expect(
        await this.command(Buffer.from(user, "utf8").toString("base64")),
        [334],
        "auth",
      );
      this.expect(
        await this.command(Buffer.from(pass, "utf8").toString("base64")),
        [235],
        "auth",
      );
      return;
    }
    throw new TransportError(
      "transient",
      "auth",
      undefined,
      "SMTP server advertises no supported AUTH mechanism (PLAIN or LOGIN)",
    );
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const ehloName = domainOf(this.config.fromAddress) || "localhost";
    try {
      this.attach(await this.connectSocket());
    } catch (err) {
      throw new TransportError("transient", "connect", undefined, (err as Error).message);
    }
    try {
      this.expect(await this.read(), [220], "greeting");
      let ehlo = this.expect(await this.command(`EHLO ${ehloName}`), [250], "ehlo");

      if (!this.config.secure) {
        const offersStartTls = ehlo.text.toUpperCase().includes("STARTTLS");
        if (offersStartTls) {
          this.expect(await this.command("STARTTLS"), [220], "starttls");
          await this.upgradeToTls();
          ehlo = this.expect(await this.command(`EHLO ${ehloName}`), [250], "ehlo");
        } else if (this.config.requireTls ?? true) {
          throw new TransportError(
            "transient",
            "starttls",
            undefined,
            "SMTP server does not offer STARTTLS and SMTP_REQUIRE_TLS is set",
          );
        }
      }

      await this.authenticate(ehlo.text);

      this.expect(
        await this.command(`MAIL FROM:<${this.config.fromAddress}>`),
        [250, 251],
        "mail_from",
      );
      this.expect(await this.command(`RCPT TO:<${message.to.trim()}>`), [250, 251], "rcpt_to");
      this.expect(await this.command("DATA"), [354], "data");

      const { messageId, raw } = buildMimeMessage(message, this.config);
      // Dot-stuffing (RFC 5321 §4.5.2). Base64 bodies cannot produce a leading
      // dot, but headers are caller-influenced, so do not rely on that.
      const stuffed = raw.split(CRLF).map((l) => (l.startsWith(".") ? `.${l}` : l)).join(CRLF);
      const accepted = this.expect(await this.command(`${stuffed}${CRLF}.`), [250], "body");

      await this.command("QUIT").catch(() => undefined);
      return { providerRef: accepted.text.trim() || messageId };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      // Socket died mid-conversation: the message may or may not have been
      // accepted, but the only safe read is "unknown", which is transient.
      throw new TransportError("transient", "connect", undefined, (err as Error).message);
    } finally {
      const socket = this.socket;
      this.socket = undefined;
      socket?.removeAllListeners();
      socket?.destroy();
    }
  }
}

/** Real SMTP submission. One connection per message; see SmtpSession. */
export class SmtpTransport implements NotificationTransport {
  constructor(private readonly config: SmtpConfig) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    // Cheap pre-flight: a syntactically impossible address is a bounce we can
    // determine without opening a connection or burning an attempt on a retry.
    if (!isDeliverableAddress(message.to)) {
      throw new TransportError(
        "permanent",
        "address",
        undefined,
        `not a deliverable email address: ${message.to}`,
      );
    }
    return new SmtpSession(this.config).send(message);
  }
}
