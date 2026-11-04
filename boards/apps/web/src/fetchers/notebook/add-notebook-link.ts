import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function addNotebookLink(workspaceId: string, url: string) {
  const response = await client.notebook[":workspaceId"].sources.link.$post({
    param: { workspaceId },
    json: { url },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default addNotebookLink;
