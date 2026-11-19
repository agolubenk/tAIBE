import { authClient } from "@/lib/auth-client";
import { throwIfNotFresh } from "@/lib/reauth/reauth-errors";
import type { UpdateAdminUserRequest } from "./types";

export async function updateAdminUser({
  userId,
  name,
  email,
  role,
}: UpdateAdminUserRequest) {
  const { data, error } = await authClient.admin.updateUser({
    userId,
    data: { name, email, ...(role === undefined ? {} : { role }) },
  });

  if (error) {
    // TB-31 R-5: the server asks for a fresh sign-in only when the email changes.
    throwIfNotFresh(error);
    throw new Error(error.message ?? "");
  }

  return data;
}
