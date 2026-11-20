import type { Passkey } from "@better-auth/passkey/client";
import {
  PASSKEY_ALERT_ROUTES,
  type PasskeyAlertInspect,
} from "@kaneo/permissions";
import { authClient } from "@/lib/auth-client";
import { throwIfNotFresh } from "@/lib/reauth/reauth-errors";

// TB-31 R-6: the plain routes of the passkey plugin and of «This wasn't me».
// No ceremony here, so no plugin client: `$fetch` of the main client.

const ROUTES = {
  list: "/passkey/list-user-passkeys",
  rename: "/passkey/update-passkey",
  remove: "/passkey/delete-passkey",
} as const;

// The longest name the «Rename» field takes.
export const PASSKEY_NAME_MAX = 64;

export type PasskeyItem = {
  id: string;
  // null: the server did not know the provider by `aaguid`.
  name: string | null;
  deviceType: Passkey["deviceType"];
  createdAt: string;
};

type WirePasskey = Pick<Passkey, "id" | "name" | "deviceType"> & {
  createdAt: string;
};

/** A failed call; `code` is the server code, `status` 0 is no answer. */
export class PasskeyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code || `HTTP ${status}`);
    this.name = "PasskeyRequestError";
  }
}

type ErrorFields = { status?: number; code?: unknown };

function failure(error: ErrorFields): PasskeyRequestError {
  return new PasskeyRequestError(
    error.status ?? 0,
    typeof error.code === "string" ? error.code : "",
  );
}

/** The person's keys, newest first. */
export async function listPasskeys(): Promise<PasskeyItem[]> {
  const { data, error } = await authClient.$fetch<WirePasskey[]>(ROUTES.list, {
    method: "GET",
  });
  if (error) throw failure(error);
  return (data ?? [])
    .map((key) => ({
      id: key.id,
      name: key.name?.trim() || null,
      deviceType: key.deviceType,
      createdAt: key.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const { error } = await authClient.$fetch(ROUTES.rename, {
    method: "POST",
    body: { id, name },
  });
  if (error) throw failure(error);
}

/** Guarded by R-5: a session that is not fresh gets SessionNotFreshError. */
export async function removePasskey(id: string): Promise<void> {
  const { error } = await authClient.$fetch(ROUTES.remove, {
    method: "POST",
    body: { id },
  });
  if (!error) return;
  throwIfNotFresh(error);
  throw failure(error);
}

export type PasskeyAlertReply<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string };

async function postAlert<T>(
  route: string,
  token: string,
): Promise<PasskeyAlertReply<T>> {
  try {
    const { data, error } = await authClient.$fetch<T>(route, {
      method: "POST",
      body: { token },
    });
    if (error || data === null) {
      const { status, code } = failure(error ?? {});
      return { ok: false, status, code };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, code: "" };
  }
}

/** «This wasn't me», on open: what the link is about. Changes nothing. */
export function inspectPasskeyAlert(token: string) {
  return postAlert<PasskeyAlertInspect>(PASSKEY_ALERT_ROUTES.inspect, token);
}

/** «This wasn't me», on press: removes the key and signs the person out. */
export function confirmPasskeyAlert(token: string) {
  return postAlert<{ status: true }>(PASSKEY_ALERT_ROUTES.confirm, token);
}
