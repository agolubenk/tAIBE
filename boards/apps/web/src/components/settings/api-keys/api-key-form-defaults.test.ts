import { describe, expect, it } from "vite-plus/test";
import { CREATE_API_KEY_DEFAULTS } from "./api-key-form-defaults";
import {
  ALL_WORKSPACES,
  apiKeyMetadata,
  isReadOnlyApiKey,
} from "./api-key-workspace";

describe("CREATE_API_KEY_DEFAULTS (TB-96, Q-002)", () => {
  it("issues a read-only key for all workspaces unless the switch is turned off", () => {
    expect(CREATE_API_KEY_DEFAULTS.readOnly).toBe(true);
    expect(CREATE_API_KEY_DEFAULTS.workspace).toBe(ALL_WORKSPACES);
    const metadata = apiKeyMetadata(
      CREATE_API_KEY_DEFAULTS.workspace,
      CREATE_API_KEY_DEFAULTS.readOnly,
    );
    expect(metadata).toEqual({ access: "read" });
    expect(isReadOnlyApiKey(JSON.stringify(metadata))).toBe(true);
  });
});
