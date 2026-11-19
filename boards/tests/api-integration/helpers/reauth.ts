import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vite-plus/test";
import db, { schema } from "../../../apps/api/src/database";
import type { createApp } from "../../../apps/api/src/index";
import { signUpWithSession } from "./auth-session";

// TB-31 R-5: requests and checks shared by the reauth integration tests.

export type App = ReturnType<typeof createApp>["app"];
export const PASSWORD = "correct horse battery staple";

export function post(
  app: App,
  path: string,
  cookies: string,
  body: unknown = {},
) {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies },
    body: JSON.stringify(body),
  });
}

export function get(app: App, path: string, cookies: string) {
  return app.request(`/api/auth${path}`, { headers: { cookie: cookies } });
}

export async function person(app: App, role?: "admin") {
  return signUpWithSession(app, {
    email: `${randomUUID()}@example.com`,
    name: "Person",
    role,
  });
}

/** The session is no longer fresh: its mark is gone. */
export async function staleSessions(userId: string) {
  const sessions = await db
    .select({ id: schema.sessionTable.id })
    .from(schema.sessionTable)
    .where(eq(schema.sessionTable.userId, userId));
  for (const { id } of sessions) {
    await db
      .delete(schema.verificationTable)
      .where(eq(schema.verificationTable.identifier, `tb-reauth:${id}`));
  }
  return sessions.map(({ id }) => id);
}

export async function sessionIdOf(app: App, cookies: string) {
  const response = await get(app, "/get-session", cookies);
  const body = (await response.json()) as { session: { id: string } };
  return body.session.id;
}

export async function countSessions(userId: string) {
  const rows = await db
    .select({ id: schema.sessionTable.id })
    .from(schema.sessionTable)
    .where(eq(schema.sessionTable.userId, userId));
  return rows.length;
}

export async function ageSessions(userId: string, hours: number) {
  await db
    .update(schema.sessionTable)
    .set({ createdAt: new Date(Date.now() - hours * 3600 * 1000) })
    .where(eq(schema.sessionTable.userId, userId));
}

export async function expectNotFresh(response: Response, methods: string[]) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "SESSION_NOT_FRESH",
    methods,
  });
}

export async function expectError(
  response: Response,
  status: number,
  code: string,
  methods?: string[],
) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { code: string; methods?: string[] };
  expect(body.code).toBe(code);
  if (methods) expect(body.methods).toEqual(methods);
}

export async function userExists(userId: string) {
  const rows = await db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId));
  return rows.length === 1;
}

/** The raw session token: the bearer plugin signs it like the cookie. */
export async function tokenOf(sessionId: string) {
  const [row] = await db
    .select({ token: schema.sessionTable.token })
    .from(schema.sessionTable)
    .where(eq(schema.sessionTable.id, sessionId));
  if (!row) throw new Error("no session");
  return row.token;
}

export function viaBearer(
  app: App,
  token: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body === undefined) return app.request(`/api/auth${path}`, { headers });
  headers["content-type"] = "application/json";
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
