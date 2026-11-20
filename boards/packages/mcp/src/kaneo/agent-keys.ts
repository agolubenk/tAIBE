import { type AgentIdentity, identityKey } from "./agent-identity.js";

export type AgentKey = {
  key: string;
  agent: { id: string; name: string; harness: string; session: string };
  expiresAt: number | null;
};

// Renew a little before the server stops taking the key.
const RENEW_BEFORE_MS = 5 * 60 * 1000;

type Issue = (identity: AgentIdentity) => Promise<Response>;

// R-010: one key per session, asked of the API with the owner's credential and
// kept for the process. null means the server predates agent identities: calls
// then go out under the owner's credential as before.
export class AgentKeys {
  private readonly keys = new Map<string, Promise<AgentKey | null>>();
  private unsupported = false;

  constructor(private readonly issue: Issue) {}

  async get(identity: AgentIdentity): Promise<AgentKey | null> {
    if (this.unsupported) return null;
    const id = identityKey(identity);
    const cached = this.keys.get(id);
    if (cached) {
      const key = await cached;
      if (key === null || !expiring(key)) return key;
      if (this.keys.get(id) === cached) this.keys.delete(id);
    }
    const pending = this.fetch(identity);
    this.keys.set(id, pending);
    // A refusal is not kept: the owner may enable the agent again.
    pending.catch(() => {
      if (this.keys.get(id) === pending) this.keys.delete(id);
    });
    return pending;
  }

  // The server refused the key (expired or the agent was disabled).
  drop(identity: AgentIdentity) {
    this.keys.delete(identityKey(identity));
  }

  private async fetch(identity: AgentIdentity): Promise<AgentKey | null> {
    const res = await this.issue(identity);
    if (res.status === 404) {
      this.unsupported = true;
      return null;
    }
    const body = (await res.json().catch(() => null)) as {
      key?: string;
      agent?: AgentKey["agent"];
      expiresAt?: string | null;
      message?: string;
      code?: string;
    } | null;
    if (!res.ok || !body?.key || !body.agent) {
      // TB-31 R-5: the client already signed in on the device once more for
      // this refusal (KaneoClient.issueAgentKey); the server log says why the
      // new session got no device mark.
      const why =
        body?.code === "SESSION_NOT_FRESH"
          ? "the server refused this device session for agent keys (SESSION_NOT_FRESH) even after a new device sign-in; see the server log, or use KANEO_API_KEY"
          : (body?.message ?? `HTTP ${res.status}`);
      throw new Error(
        `agent key for ${identity.session ?? identity.harness}: ${why}`,
      );
    }
    return {
      key: body.key,
      agent: body.agent,
      expiresAt: body.expiresAt ? Date.parse(body.expiresAt) : null,
    };
  }
}

function expiring(key: AgentKey) {
  return key.expiresAt !== null && key.expiresAt - Date.now() < RENEW_BEFORE_MS;
}
