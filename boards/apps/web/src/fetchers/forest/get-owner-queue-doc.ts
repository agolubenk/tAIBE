import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { OwnerQueueCollection } from "./list-owner-queue";

async function getOwnerQueueDoc(
  workspaceId: string,
  collection: OwnerQueueCollection,
  id: string,
) {
  const response = await client.forest[":workspaceId"]["owner-queue"][
    ":collection"
  ][":id"].$get({
    param: { workspaceId, collection, id },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getOwnerQueueDoc;
