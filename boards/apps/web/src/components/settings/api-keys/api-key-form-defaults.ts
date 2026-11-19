import {
  type ApiKeyExpiration,
  DEFAULT_API_KEY_EXPIRATION,
} from "./api-key-expirations";
import { ALL_WORKSPACES } from "./api-key-workspace";

export type CreateApiKeyFormValues = {
  name: string;
  expiresIn: ApiKeyExpiration;
  workspace: string;
  readOnly: boolean;
};

// TB-96, owner answer A (Q-002): a new key reads only. Agents and the MCP hub
// need write, and their owner turns the switch off. form.reset() after a
// created key comes back here, so the next key starts read-only again.
export const CREATE_API_KEY_DEFAULTS: Readonly<CreateApiKeyFormValues> = {
  name: "",
  expiresIn: DEFAULT_API_KEY_EXPIRATION,
  workspace: ALL_WORKSPACES,
  readOnly: true,
};
