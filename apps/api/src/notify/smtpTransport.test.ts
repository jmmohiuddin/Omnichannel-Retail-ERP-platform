/**
 * Transport tests (R13.1).
 *
 * The classification rules are pure and tested directly. The SMTP client is
 * tested against a real TCP server that speaks the real protocol — the point
 * of writing the client rather than taking a dependency was to own the reply
 * codes, so the reply codes are what gets exercised here, on a socket, not
 * behind a mock.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryTransport,
  SmtpTransport,
  TransportError,
  backoffMs,
  buildMimeMessage,
  classifySmtpFailure,
  isDeliverableAddress,
  smtpConfigFromEnv,
  type OutgoingMessage,
} from "./smtpTransport.js";

const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  notificationId: "11111111-2222-3333-4444-555555555555",
  to: "shopper@example.ae",
  subject: "Order INV-000123 confirmed",
  bodyText: "Hello\nYour order is confirmed.",
  bodyHtml: "<p>Your order is confirmed.</p>",
  locale: "en",
  ...over,
});

// ---------------------------------------------------------------------------
// Classification and backoff (R13.1)
// ---------------------------------------------------------------------------

describe("bounce vs transient classification", () => {
  it("treats a 5xx at RCPT TO as a permanent bounce", () => {
    expect(classifySmtpFailure("rcpt_to", 550)).toBe("permanent");
    expect(classifySmtpFailure("rcpt_to", 553)).toBe("permanent");
  });

  it("treats a 4xx anywhere as transient", () => {
    expect(classifySmtpFailure("rcpt_to", 450)).toBe("transient");
    expect(classifySmtpFailure("greeting", 421)).toBe("transient");
    expect(classifySmtpFailure("body", 452)).toBe("transient");
  });

  it("does NOT call a 5xx during setup a bounce", () => {
    // This is the distinction that keeps a wrong SMTP password from marking
    // every customer's address as undeliverable.
    expect(classifySmtpFailure("auth", 535)).toBe("transient");
    expect(classifySmtpFailure("ehlo", 500)).toBe("transient");
    expect(classifySmtpFailure("starttls", 502)).toBe("transient");
    expect(classifySmtpFailure("connect", 554)).toBe("transient");
    // A rejected SENDER is our configuration, not their mailbox.
    expect(classifySmtpFailure("mail_from", 550)).toBe("transient");
  });

  it("treats a rejected message body as permanent — a retry is byte-identical", () => {
    expect(classifySmtpFailure("data", 554)).toBe("permanent");
    expect(classifySmtpFailure("body", 552)).toBe("permanent");
  });

  it("treats socket-level faults as transient", () => {
    expect(classifySmtpFailure("connect", undefined)).toBe("transient");
    expect(classifySmtpFailure("body", undefined)).toBe("transient");
  });

  it("treats a syntactically impossible address as permanent", () => {
    expect(classifySmtpFailure("address", undefined)).toBe("permanent");
    expect(isDeliverableAddress("shopper@example.ae")).toBe(true);
    expect(isDeliverableAddress("not-an-address")).toBe(false);
    expect(isDeliverableAddress("shopper@localhost")).toBe(false);
    expect(isDeliverableAddress("two @spaces.ae")).toBe(false);
  });
});

describe("retry backoff", () => {
  it("doubles per attempt", () => {
    const fixed = { baseMs: 60_000, random: () => 1 };
    expect(backoffMs(1, fixed)).toBe(60_000);
    expect(backoffMs(2, fixed)).toBe(120_000);
    expect(backoffMs(3, fixed)).toBe(240_000);
    expect(backoffMs(4, fixed)).toBe(480_000);
  });

  it("jitters over the top half of the window", () => {
    expect(backoffMs(3, { baseMs: 60_000, random: () => 0 })).toBe(120_000);
    expect(backoffMs(3, { baseMs: 60_000, random: () => 1 })).toBe(240_000);
    expect(backoffMs(3, { baseMs: 60_000, random: () => 0.5 })).toBe(180_000);
  });

  it("never exceeds the cap, however many attempts have been made", () => {
    expect(backoffMs(30, { baseMs: 60_000, capMs: 3_600_000, random: () => 1 })).toBe(3_600_000);
    expect(backoffMs(30, { baseMs: 60_000, capMs: 3_600_000, random: () => 0 })).toBe(1_800_000);
  });

  it("is monotonic and always positive", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = backoffMs(attempt, { baseMs: 1_000, random: () => 0 });
      expect(delay).toBeGreaterThan(previous);
      previous = delay;
    }
  });
});

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

describe("MIME construction", () => {
  const config = {
    fromAddress: "orders@alnoor.ae",
    fromName: "Al Noor Electronics",
    now: () => new Date("2026-08-14T08:00:00.000Z"),
  };

  it("builds a multipart/alternative with both bodies base64-encoded", () => {
    const { raw } = buildMimeMessage(message(), config);
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(2);
    expect(raw).toContain(Buffer.from("Hello\nYour order is confirmed.").toString("base64"));
  });

  it("RFC 2047-encodes an Arabic subject rather than sending raw UTF-8", () => {
    const { raw } = buildMimeMessage(
      message({ subject: "تأكيد الطلب INV-000123", locale: "ar" }),
      config,
    );
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("Content-Language: ar");
    // The literal Arabic must not appear unencoded in the header block.
    const headerBlock = raw.slice(0, raw.indexOf("\r\n\r\n"));
    expect(headerBlock).not.toContain("تأكيد");
  });

  it("leaves a plain ASCII subject alone", () => {
    const { raw } = buildMimeMessage(message(), config);
    expect(raw).toContain("Subject: Order INV-000123 confirmed");
  });

  it("derives a stable Message-ID from the notification id", () => {
    const a = buildMimeMessage(message(), config);
    const b = buildMimeMessage(message(), config);
    expect(a.messageId).toBe("<11111111-2222-3333-4444-555555555555@alnoor.ae>");
    expect(a.raw).toBe(b.raw);
  });

  it("falls back to a single text part when there is no HTML body", () => {
    const { raw } = buildMimeMessage(message({ bodyHtml: null }), config);
    expect(raw).not.toContain("multipart/alternative");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it("marks the mail auto-generated so it cannot start a vacation-responder loop", () => {
    expect(buildMimeMessage(message(), config).raw).toContain("Auto-Submitted: auto-generated");
  });
});

describe("MemoryTransport", () => {
  it("records what it was asked to send", async () => {
    const transport = new MemoryTransport();
    const result = await transport.send(message());
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe("shopper@example.ae");
    expect(result.providerRef).toContain("memory:");
  });

  it("replays a scripted failure for a recipient", async () => {
    const transport = new MemoryTransport();
    transport.failFor("bad@example.ae", new TransportError("permanent", "rcpt_to", 550, "no such user"));
    await expect(transport.send(message({ to: "bad@example.ae" }))).rejects.toThrow("no such user");
    transport.clearFailure("bad@example.ae");
    await expect(transport.send(message({ to: "bad@example.ae" }))).resolves.toBeTruthy();
  });
});

describe("smtpConfigFromEnv", () => {
  it("is undefined until both host and from address are set", () => {
    expect(smtpConfigFromEnv({})).toBeUndefined();
    expect(smtpConfigFromEnv({ SMTP_HOST: "mail.test" })).toBeUndefined();
  });

  it("defaults to submission on 587 with TLS required", () => {
    const config = smtpConfigFromEnv({ SMTP_HOST: "mail.test", SMTP_FROM: "a@b.ae" })!;
    expect(config.port).toBe(587);
    expect(config.requireTls).toBe(true);
    expect(config.secure).toBe(false);
  });

  it("switches to implicit TLS on 465", () => {
    const config = smtpConfigFromEnv({
      SMTP_HOST: "mail.test", SMTP_FROM: "a@b.ae", SMTP_PORT: "465",
    })!;
    expect(config.secure).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The wire protocol, against a real socket
// ---------------------------------------------------------------------------

interface FakeSmtpOptions {
  ehloExtensions?: string[];
  rcptReply?: string;
  dataEndReply?: string;
  authReply?: string;
  greeting?: string;
}

interface FakeSmtp {
  port: number;
  connections: number;
  received: string[];
  commands: string[];
  close: () => Promise<void>;
}

/** A minimal SMTP server. Speaks the real protocol so the client is not mocked. */
const startFakeSmtp = async (options: FakeSmtpOptions = {}): Promise<FakeSmtp> => {
  const state: FakeSmtp = {
    port: 0,
    connections: 0,
    received: [],
    commands: [],
    close: async () => undefined,
  };
  const extensions = options.ehloExtensions ?? ["AUTH PLAIN LOGIN"];

  const server = net.createServer((socket) => {
    state.connections++;
    let buffer = "";
    let inData = false;
    let body = "";
    socket.setEncoding("utf8");
    socket.write(`${options.greeting ?? "220 fake.test ESMTP ready"}\r\n`);

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            state.received.push(body);
            body = "";
            socket.write(`${options.dataEndReply ?? "250 2.0.0 Ok: queued as FAKE123"}\r\n`);
          } else {
            body += `${line}\n`;
          }
          continue;
        }

        state.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          const lines = ["fake.test", ...extensions];
          socket.write(
            lines
              .map((l, i) => `250${i === lines.length - 1 ? " " : "-"}${l}`)
              .join("\r\n") + "\r\n",
          );
        } else if (upper.startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("AUTH")) {
          socket.write(`${options.authReply ?? "235 2.7.0 Authentication successful"}\r\n`);
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          socket.write(`${options.rcptReply ?? "250 2.1.5 Ok"}\r\n`);
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // AUTH LOGIN credential exchange.
          socket.write(
            state.commands.filter((c) => /^[A-Za-z0-9+/=]+$/.test(c)).length >= 2
              ? `${options.authReply ?? "235 2.7.0 Authentication successful"}\r\n`
              : "334 UGFzc3dvcmQ6\r\n",
          );
        } else {
          socket.write("500 5.5.2 Unrecognized command\r\n");
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return state;
};

describe("SMTP over a real socket", () => {
  let server: FakeSmtp | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const transportFor = (fake: FakeSmtp, over: Record<string, unknown> = {}) =>
    new SmtpTransport({
      host: "127.0.0.1",
      port: fake.port,
      requireTls: false,
      fromAddress: "orders@alnoor.ae",
      fromName: "Al Noor",
      timeoutMs: 5_000,
      ...over,
    });

  it("delivers a message and returns the provider's reference", async () => {
    server = await startFakeSmtp();
    const result = await transportFor(server).send(message());
    expect(result.providerRef).toContain("queued as FAKE123");
    expect(server.received).toHaveLength(1);
    expect(server.commands).toContain("RCPT TO:<shopper@example.ae>");
    expect(server.commands).toContain("QUIT");
  });

  it("parses a multiline EHLO without desyncing the conversation", async () => {
    server = await startFakeSmtp({
      ehloExtensions: ["PIPELINING", "SIZE 10240000", "8BITMIME", "AUTH PLAIN LOGIN"],
    });
    await expect(transportFor(server).send(message())).resolves.toBeTruthy();
  });

  it("authenticates with AUTH PLAIN when it is offered", async () => {
    server = await startFakeSmtp();
    await transportFor(server, { user: "postmaster", pass: "s3cret" }).send(message());
    const expected = Buffer.from("\0postmaster\0s3cret").toString("base64");
    expect(server.commands).toContain(`AUTH PLAIN ${expected}`);
  });

  it("falls back to AUTH LOGIN when PLAIN is not offered", async () => {
    server = await startFakeSmtp({ ehloExtensions: ["AUTH LOGIN"] });
    await transportFor(server, { user: "postmaster", pass: "s3cret" }).send(message());
    expect(server.commands).toContain("AUTH LOGIN");
    expect(server.commands).toContain(Buffer.from("postmaster").toString("base64"));
  });

  it("carries an Arabic body through intact", async () => {
    server = await startFakeSmtp();
    const arabic = "مرحباً، تم تأكيد طلبك رقم INV-000123";
    await transportFor(server).send(message({ bodyText: arabic, locale: "ar", bodyHtml: null }));
    const raw = server.received[0]!;
    const encoded = raw.slice(raw.indexOf("\n\n") + 2).replace(/\n/g, "");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(arabic);
  });

  it("classifies a 550 at RCPT TO as a bounce", async () => {
    server = await startFakeSmtp({ rcptReply: "550 5.1.1 <shopper@example.ae>: user unknown" });
    const error = await transportFor(server).send(message()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("permanent");
    expect((error as TransportError).stage).toBe("rcpt_to");
    expect((error as TransportError).code).toBe(550);
  });

  it("classifies a 451 at RCPT TO as transient", async () => {
    server = await startFakeSmtp({ rcptReply: "451 4.3.0 Try again later" });
    const error = await transportFor(server).send(message()).catch((e: unknown) => e);
    expect((error as TransportError).kind).toBe("transient");
    expect((error as TransportError).code).toBe(451);
  });

  it("classifies a 535 auth failure as transient, not as a bounce", async () => {
    server = await startFakeSmtp({ authReply: "535 5.7.8 Authentication credentials invalid" });
    const error = await transportFor(server, { user: "u", pass: "wrong" })
      .send(message())
      .catch((e: unknown) => e);
    expect((error as TransportError).kind).toBe("transient");
    expect((error as TransportError).stage).toBe("auth");
  });

  it("classifies a rejected message body as permanent", async () => {
    server = await startFakeSmtp({ dataEndReply: "554 5.6.0 Message content rejected" });
    const error = await transportFor(server).send(message()).catch((e: unknown) => e);
    expect((error as TransportError).kind).toBe("permanent");
    expect((error as TransportError).stage).toBe("body");
  });

  it("classifies a 421 greeting as transient", async () => {
    server = await startFakeSmtp({ greeting: "421 4.7.0 Too many connections" });
    const error = await transportFor(server).send(message()).catch((e: unknown) => e);
    expect((error as TransportError).kind).toBe("transient");
    expect((error as TransportError).stage).toBe("greeting");
  });

  it("refuses a plaintext session when TLS is required and not offered", async () => {
    server = await startFakeSmtp();
    const error = await transportFor(server, { requireTls: true })
      .send(message())
      .catch((e: unknown) => e);
    expect((error as TransportError).stage).toBe("starttls");
    expect((error as TransportError).kind).toBe("transient");
    // Credentials must never have been offered over the clear channel.
    expect(server.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
  });

  it("rejects an impossible address without opening a connection", async () => {
    server = await startFakeSmtp();
    const error = await transportFor(server)
      .send(message({ to: "not-an-address" }))
      .catch((e: unknown) => e);
    expect((error as TransportError).kind).toBe("permanent");
    expect((error as TransportError).stage).toBe("address");
    expect(server.connections).toBe(0);
  });

  it("reports a refused connection as transient", async () => {
    const closed = await startFakeSmtp();
    const port = closed.port;
    await closed.close();
    const transport = new SmtpTransport({
      host: "127.0.0.1",
      port,
      requireTls: false,
      fromAddress: "orders@alnoor.ae",
      timeoutMs: 2_000,
    });
    const error = await transport.send(message()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("transient");
    expect((error as TransportError).code).toBeUndefined();
  });

  it("opens a fresh connection per message", async () => {
    server = await startFakeSmtp();
    const transport = transportFor(server);
    await transport.send(message({ notificationId: randomUUID() }));
    await transport.send(message({ notificationId: randomUUID() }));
    expect(server.connections).toBe(2);
    expect(server.received).toHaveLength(2);
  });
});
