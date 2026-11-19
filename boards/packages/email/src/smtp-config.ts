import { readFileSync } from "node:fs";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

type SmtpEnv = Record<string, string | undefined>;

// A hung relay otherwise holds the socket and the send promise for up to
// 10 minutes (nodemailer defaults: 2 min, 30 s, 10 min). TB-31 R-10.
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

/**
 * The SMTP password: `SMTP_PASSWORD`, else the file in `SMTP_PASSWORD_FILE`.
 *
 * The VPS compose always sets the file path (`/run/tb-secrets/smtp_password`),
 * so a missing or empty file means "no password", not an error: mail stays
 * off until SMTP_HOST and SMTP_FROM are set. Any other read error is reported
 * once by its code and the path, never by the content.
 */
export function readSmtpPassword(
  env: SmtpEnv = process.env,
): string | undefined {
  if (env.SMTP_PASSWORD) return env.SMTP_PASSWORD;
  const file = env.SMTP_PASSWORD_FILE?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").replace(/(?:\r?\n)+$/, "") || undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code !== "ENOENT") {
      console.warn(
        `[smtp] SMTP_PASSWORD_FILE could not be read (${code}): ${file}`,
      );
    }
    return undefined;
  }
}

/**
 * Build the nodemailer transport options from the environment.
 *
 * `auth` is only included when both a user and a password are set. Passing an
 * `auth` object with undefined values makes nodemailer authenticate anyway,
 * which fails against relays that accept unauthenticated mail. The same goes
 * for `port`: leaving it out lets nodemailer pick the default for the chosen
 * security mode instead of receiving NaN.
 */
export function getSmtpTransportOptions(
  env: SmtpEnv = process.env,
): SMTPTransport.Options {
  if (env.SMTP_IGNORE_TLS === "true") {
    throw new Error(
      "SMTP_IGNORE_TLS=true is no longer supported: it disables STARTTLS, not certificate validation. Remove it and trust your SMTP CA using NODE_EXTRA_CA_CERTS. For an intentionally unencrypted local relay, set SMTP_SECURE=false and SMTP_REQUIRE_TLS=false explicitly.",
    );
  }

  // No `logger` or `debug`: with them the AUTH command reaches the log.
  const options: SMTPTransport.Options = {
    host: env.SMTP_HOST,
    secure: env.SMTP_SECURE !== "false",
    requireTLS: env.SMTP_REQUIRE_TLS !== "false",
    ignoreTLS: false,
    ...SMTP_TIMEOUTS,
  };

  if (env.SMTP_PORT) {
    options.port = Number(env.SMTP_PORT);
  }

  const password = env.SMTP_USER ? readSmtpPassword(env) : undefined;
  if (env.SMTP_USER && password) {
    options.auth = { user: env.SMTP_USER, pass: password };
  }

  return options;
}

/**
 * Whether outgoing mail can be sent at all. This is what the send helpers
 * actually require: a host to connect to and an envelope sender.
 */
export function isSmtpConfigured(env: SmtpEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST) && Boolean(env.SMTP_FROM);
}
