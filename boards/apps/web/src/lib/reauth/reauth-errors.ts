import {
  isSessionNotFresh,
  type ReauthErrorBody,
  type ReauthMethod,
} from "@kaneo/permissions";

/**
 * TB-31 R-5: the server refused a guarded action until the person confirms
 * who they are. `useFreshSession` opens the window on it and repeats the action.
 */
export class SessionNotFreshError extends Error {
  readonly methods: ReauthMethod[];
  readonly impersonated: boolean;

  constructor(body: ReauthErrorBody) {
    super(body.message);
    this.name = "SessionNotFreshError";
    this.methods = body.methods ?? [];
    this.impersonated = body.impersonated === true;
  }
}

/** The person closed the window: the action did not run. */
export class ReauthCancelledError extends Error {
  constructor() {
    super("reauth cancelled");
    this.name = "ReauthCancelledError";
  }
}

/** A guarded call turns the guard reply into SessionNotFreshError. */
export function throwIfNotFresh(error: unknown): void {
  if (isSessionNotFresh(error)) throw new SessionNotFreshError(error);
}

/** The window itself answers these errors, so callers show no toast for them. */
export function isReauthFlowError(error: unknown): boolean {
  return (
    error instanceof SessionNotFreshError ||
    error instanceof ReauthCancelledError
  );
}
