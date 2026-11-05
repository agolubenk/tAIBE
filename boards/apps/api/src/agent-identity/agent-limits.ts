// A day: a key that leaks stops working by tomorrow, and the MCP bridge asks
// for a new one when the old one is refused.
export const AGENT_KEY_TTL_SECONDS = 24 * 60 * 60;
// An agent its session has not used for as long as a key lives goes to the
// archive (TB-74): its last key has run out by then, so no working session
// loses anything, and the place under the cap is free for a new one.
export const AGENT_IDLE_ARCHIVE_MS = AGENT_KEY_TTL_SECONDS * 1000;
// Active agents per owner, neither disabled nor archived: a bridge looping
// over labels cannot fill the workspace with users, and every agent fits the
// owner's list to disable.
export const MAX_AGENTS_PER_OWNER = 50;
export const AGENTS_SETTINGS_PATH = "/dashboard/settings/account/agents";

const IDLE_HOURS = AGENT_IDLE_ARCHIVE_MS / (60 * 60 * 1000);

// The agent reading this cannot free a place itself (TB-72): the text says
// what frees one by itself, who else acts and where.
export const AGENT_CAP_MESSAGE = `the owner already has ${MAX_AGENTS_PER_OWNER} active agents, the most allowed, so this session gets no key for now; an agent idle for ${IDLE_HOURS} hours goes to the archive by itself and frees its place, and an archived agent comes back on its own when its session asks again; only the owner disables agents, in Settings → Account → Agents and MCP (${AGENTS_SETTINGS_PATH}); agents already active keep working`;
