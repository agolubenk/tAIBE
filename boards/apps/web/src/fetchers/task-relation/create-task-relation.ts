import { client } from "@kaneo/libs";

import { HttpError } from "@/lib/http-error";

async function createTaskRelation({
  sourceTaskId,
  targetTaskId,
  relationType,
  replaceParent,
}: {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: "subtask" | "blocks" | "related";
  replaceParent?: boolean;
}) {
  const response = await client["task-relation"].$post({
    json: {
      sourceTaskId,
      targetTaskId,
      relationType,
      ...(replaceParent ? { replaceParent } : {}),
    },
  });

  if (!response.ok) {
    throw await HttpError.fromResponse(response);
  }

  const data = await response.json();

  return data;
}

export default createTaskRelation;
