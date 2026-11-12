export type ActorView =
  | { kind: "person" }
  | { kind: "owner-session" }
  | { kind: "owner-queue" }
  | { kind: "agent"; label: string | null };

// History rows name the actor as the API built it (forest/actor.ts):
// "session:<id>" for a browser session, "key:<keyId>[:<label>]" or
// "bearer:<userId>[:<label>]" for an agent, "owner-queue" for an answer from
// the owner queue, null for kaneo's own routes.
export function describeActor(actorId: string | null): ActorView {
  if (!actorId) return { kind: "person" };
  if (actorId.startsWith("session:")) return { kind: "owner-session" };
  // The owner's «да» from the owner queue, applied by the server (TB-102).
  if (actorId === "owner-queue" || actorId.startsWith("owner-migration:")) {
    return { kind: "owner-queue" };
  }
  const parts = actorId.split(":");
  return {
    kind: "agent",
    label: parts.length > 2 ? parts.slice(2).join(":") : null,
  };
}
