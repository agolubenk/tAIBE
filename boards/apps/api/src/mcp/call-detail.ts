import type { ToolCall } from "@kaneo/mcp/tools";
import { redact } from "@kaneo/redact";

// The journal keeps 2000 characters of detail. The arguments go last, cut
// here, so the sizes always survive and the JSON stays whole.
const ARGS_MAX = 1500;

// Quotes and backslashes double when the arguments are escaped again inside
// the detail, so the cut is measured on the escaped text.
function cut(text: string) {
  if (JSON.stringify(text).length <= ARGS_MAX) return text;
  let kept = text.slice(0, ARGS_MAX);
  for (;;) {
    const over = JSON.stringify(`${kept}…`).length - ARGS_MAX;
    if (over <= 0) return `${kept}…`;
    kept = kept.slice(0, kept.length - over);
  }
}

// R-036: what an MCP call journals. Secrets in the arguments are replaced by
// a label before the row is written and before the cut, so a cut never splits
// a secret past the detector (D-011). The tool is named here because a call
// about a card is filed under the card (callTarget).
export function callDetail(
  call: Pick<ToolCall, "tool" | "args" | "bytes" | "tokens" | "ms">,
) {
  const args = cut(redact(JSON.stringify(call.args ?? null)).text);
  return JSON.stringify({
    tool: call.tool,
    bytes: call.bytes,
    tokens: call.tokens,
    ms: call.ms,
    args,
  });
}

// A board task id: what createId and the seeds produce. Anything else (a
// pasted URL, a secret) is never written as a target.
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

// TB-44: an answered call that names a card by taskId is filed under the card,
// so its tokens add up per card. A refused call, or one without a taskId
// (search, list_tasks, get_task_by_ticket_id), stays under the tool.
type CallFacts = Pick<ToolCall, "tool" | "args" | "ok">;

export function toolTarget(call: Pick<ToolCall, "tool">) {
  return { targetType: "mcp_tool", targetId: call.tool };
}

export function callTarget(call: CallFacts) {
  const taskId = (call.args as { taskId?: unknown } | null)?.taskId;
  if (call.ok && typeof taskId === "string" && TASK_ID.test(taskId)) {
    return { targetType: "task", targetId: taskId };
  }
  return toolTarget(call);
}
