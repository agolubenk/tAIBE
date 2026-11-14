import { describe, expect, it } from "vite-plus/test";
import type { ApiKey } from "../openapi";
import { agentKeyIssuer } from "./issuer";

type IssuerContext = Parameters<typeof agentKeyIssuer>[0];

function context(apiKey: ApiKey | undefined): IssuerContext {
  const vars: Record<string, unknown> = {
    apiKey,
    user: { role: "user" },
    userId: "owner-1",
  };
  return { get: (key: string) => vars[key] } as unknown as IssuerContext;
}

const key = (extra: Partial<ApiKey>): ApiKey =>
  ({ id: "key-1", ...extra }) as ApiKey;

describe("agentKeyIssuer", () => {
  it("refuses a read-only key (TB-96 R-016)", () => {
    expect(() => agentKeyIssuer(context(key({ access: "read" })))).toThrow(
      "agent_forbidden: a read-only key cannot issue or manage agent keys",
    );
  });

  it("lets a full key and a session issue agent keys", () => {
    for (const apiKey of [key({ access: "full" }), key({}), undefined]) {
      expect(agentKeyIssuer(context(apiKey)).ownerId).toBe("owner-1");
    }
  });
});
