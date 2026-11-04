import type { FetchLike } from "@kaneo/importers";
import { Agent, fetch, type RequestInit as UndiciRequestInit } from "undici";
import { createDestinationLookup } from "./destination-lookup";

function fetchThrough(agent: Agent): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, {
      ...(init as UndiciRequestInit),
      dispatcher: agent,
    });
    return response as unknown as Response;
  };
}

export const destinationFetch = fetchThrough(
  new Agent({ connect: { lookup: createDestinationLookup() } }),
);

// Checks the address at connect time even when the instance allows private
// destinations, for fetches a workspace member points anywhere (notebook links).
export const publicDestinationFetch = fetchThrough(
  new Agent({
    connect: {
      lookup: createDestinationLookup(undefined, { alwaysPublic: true }),
    },
  }),
);
