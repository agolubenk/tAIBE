import { expect } from "vite-plus/test";
import { type App, get, post } from "./reauth";
import type { SoftPasskey } from "./soft-passkey";

// TB-31 R-6: the passkey ceremonies of the integration tests (passkey.test.ts,
// passkey-alert.test.ts).

/** The cookie header after a response: its Set-Cookie wins, cleared ones go. */
export function withCookies(cookies: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const pair of cookies.split("; ").filter(Boolean)) {
    const [name, ...value] = pair.split("=");
    if (name) jar.set(name, value.join("="));
  }
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, ...value] = (pair ?? "").split("=");
    if (!name) continue;
    if (value.join("") === "" || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value.join("="));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export const sessionCookieSet = (response: Response) =>
  response.headers
    .getSetCookie()
    .some((line) => /session_token=[^;]/.test(line));

export async function register(
  app: App,
  cookies: string,
  key: SoftPasskey,
  options: { uv?: boolean; body?: Record<string, unknown> } = {},
) {
  const started = await get(app, "/passkey/generate-register-options", cookies);
  if (started.status !== 200) return started;
  const challenge = (await started.clone().json()) as { challenge: string };
  return post(
    app,
    "/passkey/verify-registration",
    withCookies(cookies, started),
    {
      response: key.create(challenge, { uv: options.uv }),
      name: "Laptop",
      ...options.body,
    },
  );
}

export async function signInWithKey(
  app: App,
  cookies: string,
  key: SoftPasskey,
  options: { uv?: boolean; counter?: number } = {},
) {
  const started = await get(
    app,
    "/passkey/generate-authenticate-options",
    cookies,
  );
  expect(started.status).toBe(200);
  const challenge = (await started.clone().json()) as {
    challenge: string;
    userVerification?: string;
    allowCredentials?: { id: string }[];
  };
  const finished = await post(
    app,
    "/passkey/verify-authentication",
    withCookies(cookies, started),
    { response: key.get(challenge, options) },
  );
  return { challenge, finished };
}
