import type { User as BetterAuthUser } from "better-auth/types";

export type User = BetterAuthUser & {
  locale?: string | null;
  role?: string | null;
  // TB-31 R-1: the login in lower case and as the person typed it.
  username?: string | null;
  displayUsername?: string | null;
};
