import type { BaseVariables } from "../openapi";
import { isDeviceSession } from "./device-session";
import { type NotFreshBody, staleSessionRefusal } from "./guard";

type Caller = Pick<BaseVariables, "apiKey" | "session" | "userId">;

/**
 * TB-31 R-5, owner taibe-d-tb31-agent-key-1811 = A: who may issue an agent
 * key now. A key passes (it was made under the guard). A session from the
 * device flow passes: its approval was under the guard. A browser session
 * passes only with a fresh mark. Returns the 403 body, or null to go on.
 */
export async function agentKeyRefusal(
  caller: Caller,
): Promise<NotFreshBody | null> {
  if (caller.apiKey || !caller.session) return null;
  return staleSessionRefusal(caller.session, caller.userId, isDeviceSession);
}
