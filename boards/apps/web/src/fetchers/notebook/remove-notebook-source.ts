import { client } from "@kaneo/libs";
import type { AddedSourceKind } from "@/components/notebook/added-source-kind";
import { HttpError } from "@/lib/http-error";

async function removeNotebookSource(
  workspaceId: string,
  kind: AddedSourceKind,
  ref: string,
) {
  const response = await client.notebook[":workspaceId"].sources.remove.$post({
    param: { workspaceId },
    json: { kind, ref },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default removeNotebookSource;
