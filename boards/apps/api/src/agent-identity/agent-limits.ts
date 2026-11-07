// A day: a key that leaks stops working by tomorrow, and the MCP bridge asks
// for a new one when the old one is refused.
export const AGENT_KEY_TTL_SECONDS = 24 * 60 * 60;
// An agent its session has not used for 5 hours goes to the archive (TB-74;
// owner, 07.11, TB-100). Every generation of a session line takes a new label,
// about eight an hour, so a day-long wait filled the cap. Archiving drops the
// agent's keys; a session that comes back after a longer pause is refused once,
// asks for a new key, and its agent leaves the archive with its history.
export const AGENT_IDLE_ARCHIVE_MS = 5 * 60 * 60 * 1000;
// Active agents per owner, neither disabled nor archived: a bridge looping
// over labels cannot fill the workspace with users, and every agent fits the
// owner's list to disable. 200 (owner, 07.11, TB-100): five hours of new
// labels at today's rate, with room for a busy hour.
export const MAX_AGENTS_PER_OWNER = 200;
export const AGENTS_SETTINGS_PATH = "/dashboard/settings/account/agents";

const IDLE_HOURS = AGENT_IDLE_ARCHIVE_MS / (60 * 60 * 1000);

// The agent reading this cannot free a place itself (TB-72): the text says
// what frees one by itself, who else acts and where.
export const AGENT_CAP_MESSAGE = `the owner already has ${MAX_AGENTS_PER_OWNER} active agents, the most allowed, so this session gets no key for now; an agent idle for ${IDLE_HOURS} hours goes to the archive by itself and frees its place, and an archived agent comes back on its own when its session asks again while there is room, so ask again later; only the owner disables agents, in Settings → Account → Agents and MCP (${AGENTS_SETTINGS_PATH}); agents already active keep working`;
