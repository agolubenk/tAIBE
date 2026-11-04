import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function briefNotebookThread(workspaceId: string, threadId: string) {
  const response = await client.notebook[":workspaceId"].threads[
    ":threadId"
  ].brief.$post({ param: { workspaceId, threadId } });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default briefNotebookThread;
