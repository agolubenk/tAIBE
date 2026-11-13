import { describe, expect, it } from "vite-plus/test";
import { formatValidationIssues } from "../../errors/validation-issues";
import { requestApprovalBody } from "./schema";

const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => `task-${i + 1}`);

const parse = (body: Record<string, unknown>) =>
  requestApprovalBody.safeParse({ targetId: "ws-1", reason: "r", ...body });

describe("requestApprovalBody taskIds limit per action (TB-114)", () => {
  it.each(["create_label", "attach_label"])(
    "lets %s name at most 20 cards, with the grant's own message",
    (action) => {
      expect(parse({ action, taskIds: ids(20) }).success).toBe(true);
      const tooMany = parse({ action, taskIds: ids(21) });
      expect(tooMany.success).toBe(false);
      expect(formatValidationIssues(tooMany.error?.issues ?? []).message).toBe(
        "taskIds: a grant names at most 20 cards",
      );
    },
  );

  it("lets a batch close name up to 250 cards", () => {
    expect(parse({ action: "close_task", taskIds: ids(250) }).success).toBe(
      true,
    );
    const tooMany = parse({ action: "close_task", taskIds: ids(251) });
    expect(tooMany.success).toBe(false);
    expect(formatValidationIssues(tooMany.error?.issues ?? []).message).toMatch(
      /^taskIds: .*250/,
    );
  });

  it("keeps the other actions and an unknown action as before", () => {
    expect(parse({ action: "set_priority", value: "high" }).success).toBe(true);
    expect(parse({ action: "fell_tree" }).success).toBe(true);
    expect(parse({ action: "delete_everything" }).success).toBe(false);
  });
});
