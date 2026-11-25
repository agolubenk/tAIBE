import type { AuthService } from "../auth/auth-service.js";
import { type AgentIdentity, currentAgentIdentity } from "./agent-identity.js";
import { AgentKeys } from "./agent-keys.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export class KaneoClient {
  readonly baseUrl: string;
  private readonly auth: AuthService;
  // R-010: with it, a call made under an agent identity goes out with that
  // agent's own key, issued by the owner's credential.
  private readonly agentKeys?: AgentKeys;

  constructor(options: {
    baseUrl: string;
    auth: AuthService;
    agentSessions?: boolean;
  }) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    if (options.agentSessions) {
      this.agentKeys = new AgentKeys((identity) =>
        this.issueAgentKey(identity),
      );
    }
  }

  /**
   * TB-31 R-5: the server issues agent keys to a device-flow session by its
   * device mark. A session from before the mark is refused with
   * SESSION_NOT_FRESH; one new device sign-in gets a marked session. A key
   * has nothing to sign in again, so its refusal goes to the caller.
   */
  private async issueAgentKey(
    identity: AgentIdentity,
    didRetry = false,
  ): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const res = await this.send(
      "/api/agent-identity/session",
      { method: "POST", body: JSON.stringify(identity) },
      token,
    );
    if (res.status !== 403 || didRetry || this.auth.usingApiKey) return res;
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: unknown } | null;
    if (body?.code !== "SESSION_NOT_FRESH") return res;
    // Another call may have signed in again already: clear only this token.
    if ((await this.auth.getAccessToken()) === token) {
      await this.auth.clearToken();
    }
    return this.issueAgentKey(identity, true);
  }

  get usingApiKey() {
    return this.auth.usingApiKey;
  }

  private send(path: string, init: RequestInit | undefined, token: string) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetch(url, { ...init, headers, signal });
  }

  private async agentFetch(
    identity: AgentIdentity,
    path: string,
    init: RequestInit | undefined,
  ): Promise<Response | null> {
    const agentKeys = this.agentKeys;
    if (!agentKeys) return null;
    const agent = await agentKeys.get(identity);
    if (!agent) return null;
    const res = await this.send(path, init, agent.key);
    if (res.status !== 401) return res;
    // Expired or revoked: one new key; a disabled agent is refused there.
    agentKeys.drop(identity);
    const renewed = await agentKeys.get(identity);
    return renewed ? this.send(path, init, renewed.key) : res;
  }

  private async authorizedFetch(
    path: string,
    init?: RequestInit,
    didRetry = false,
  ): Promise<Response> {
    const identity = this.agentKeys ? currentAgentIdentity() : undefined;
    let request = init;
    if (identity) {
      const res = await this.agentFetch(identity, path, init);
      if (res) return res;
      // A server without agent identities tells sessions apart by header.
      if (identity.session) {
        const headers = new Headers(init?.headers);
        if (!headers.has("x-t-boards-session")) {
          headers.set("x-t-boards-session", identity.session);
        }
        request = { ...init, headers };
      }
    }
    const res = await this.send(
      path,
      request,
      await this.auth.getAccessToken(),
    );

    // With a static API key there is nothing to refresh, so surface the 401
    // instead of looping back into the interactive device flow.
    if (res.status === 401 && !didRetry && !this.auth.usingApiKey) {
      await this.auth.clearToken();
      return this.authorizedFetch(path, request, true);
    }

    return res;
  }

  async json<T = Json>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.authorizedFetch(path, init);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      let detail: string;
      if (
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
      ) {
        detail = (body as { message: string }).message;
      } else if (typeof body === "string" && body.length > 0) {
        detail = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      } else {
        detail = `HTTP ${res.status}`;
      }
      const code =
        typeof body === "object" &&
        body !== null &&
        "code" in body &&
        typeof (body as { code: unknown }).code === "string"
          ? ` (${(body as { code: string }).code})`
          : "";
      throw new Error(`${path}: ${detail}${code}`);
    }
    return body as T;
  }
}
