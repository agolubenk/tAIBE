import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function addNotebookPullRequest(workspaceId: string, url: string) {
  const response = await client.notebook[":workspaceId"].sources[
    "github-pr"
  ].$post({
    param: { workspaceId },
    json: { url },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default addNotebookPullRequest;
