import type { TFunction } from "i18next";
import { HttpError } from "@/lib/http-error";

// 409 FORM_TEMPLATE_CONFLICT (TB-173, #358): the API text asks to save a
// template as a new version, and the web cannot do that, so the toast
// explains the conflict by its code. Other errors keep the API text.
export function moveErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof HttpError && error.code === "FORM_TEMPLATE_CONFLICT") {
    return t("settings:projectGeneral.toastMoveTemplateConflict");
  }
  return error instanceof Error
    ? error.message
    : t("settings:projectGeneral.toastMoveError");
}
