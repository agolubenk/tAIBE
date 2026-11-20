import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type OwnerQueueCollection = "items" | "checks";
export type OwnerQueueState = "open" | "answered" | "all";

export type OwnerQueueFilter = {
  collection: OwnerQueueCollection;
  state: OwnerQueueState;
  product?: string;
  page: number;
};

async function listOwnerQueue(workspaceId: string, filter: OwnerQueueFilter) {
  const response = await client.forest[":workspaceId"]["owner-queue"][
    ":collection"
  ].$get({
    param: { workspaceId, collection: filter.collection },
    query: {
      state: filter.state,
      product: filter.product,
      page: String(filter.page),
    },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listOwnerQueue;
