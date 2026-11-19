import {
  passkeyAddedSubject,
  passkeyDisplayName,
  sendPasskeyAddedEmail,
} from "@kaneo/email";
import {
  PASSKEY_ALERT_PAGE,
  PASSKEY_ALERT_ROUTES,
  PASSKEY_ALERT_TTL_DAYS,
  PASSKEY_ERRORS,
} from "@kaneo/permissions";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import * as z from "zod";
import db, { schema } from "../database";
import { getEmailRequestContext } from "../utils/email-request-context";
import { revokeUserConnections } from "../ws";
import {
  type AddedPasskey,
  inspectPasskeyAlert,
  issuePasskeyAlert,
  revokeByPasskeyAlert,
} from "./passkey-alert-store";

/** The passkey `/passkey/verify-registration` returns, or null. */
export function addedPasskey(returned: unknown): AddedPasskey | null {
  if (!returned || typeof returned !== "object" || isAPIError(returned))
    return null;
  const key = returned as Record<string, unknown>;
  if (typeof key.id !== "string" || typeof key.userId !== "string")
    return null;
  const createdAt = new Date(
    key.createdAt instanceof Date || typeof key.createdAt === "string"
      ? key.createdAt
      : Number.NaN,
  );
  if (Number.isNaN(createdAt.getTime())) return null;
  return {
    id: key.id,
    userId: key.userId,
    name: typeof key.name === "string" && key.name ? key.name : null,
    createdAt,
  };
}

async function recipient(userId: string) {
  const [row] = await db
    .select({ email: schema.userTable.email, locale: schema.userTable.locale })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * After a key is added: the alert row, then the email in the background. The
 * key stays whatever happens here: no SMTP, or a failure, is only logged.
 */
export async function notifyPasskeyAdded(
  key: AddedPasskey,
  clientUrl: string,
  headers: Headers | null | undefined,
): Promise<void> {
  try {
    const [token, to] = await Promise.all([
      issuePasskeyAlert(key),
      recipient(key.userId),
    ]);
    if (!to) return;
    const name = passkeyDisplayName(key.name, key.createdAt, to.locale);
    const alertLink = `${clientUrl}${PASSKEY_ALERT_PAGE}#t=${token}`;
    void sendPasskeyAddedEmail(to.email, passkeyAddedSubject(name, to.locale), {
      keyName: key.name,
      alertLink,
      days: PASSKEY_ALERT_TTL_DAYS,
      locale: to.locale,
      ...getEmailRequestContext(headers),
    }).catch(() => {
      console.error("[passkey] the «passkey added» email was not sent");
    });
  } catch (error) {
    console.error(
      "[passkey] the «passkey added» alert was not written:",
      error instanceof Error ? error.message : error,
    );
  }
}

const TokenBody = z.object({ token: z.string().max(256) });

function invalidAlert() {
  return new APIError("BAD_REQUEST", {
    code: PASSKEY_ERRORS.alertInvalid,
    message: "The link is not valid any more.",
  });
}

/** «This wasn't me»: no session, the link is the proof (rate limit — R-8). */
export const passkeyAlertEndpoints = {
  tbPasskeyAlertInspect: createAuthEndpoint(
    PASSKEY_ALERT_ROUTES.inspect,
    { method: "POST", body: TokenBody },
    async (ctx) => {
      const found = await inspectPasskeyAlert(ctx.body.token);
      if (!found) throw invalidAlert();
      return ctx.json(found);
    },
  ),
  tbPasskeyAlertConfirm: createAuthEndpoint(
    PASSKEY_ALERT_ROUTES.confirm,
    { method: "POST", body: TokenBody },
    async (ctx) => {
      const revoked = await revokeByPasskeyAlert(ctx.body.token);
      if (!revoked) throw invalidAlert();
      await Promise.all(
        [revoked.userId, ...revoked.agentIds].map((id) =>
          revokeUserConnections(id),
        ),
      );
      return ctx.json({ status: true as const });
    },
  ),
};
