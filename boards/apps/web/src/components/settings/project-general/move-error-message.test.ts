import type { TFunction } from "i18next";
import { describe, expect, it } from "vite-plus/test";
import { HttpError } from "@/lib/http-error";
import { moveErrorMessage } from "./move-error-message";

const t = ((key: string) => key) as unknown as TFunction;

describe("moveErrorMessage", () => {
  it("explains a form template conflict by its code", () => {
    const error = new HttpError(409, "The target workspace has …", {
      code: "FORM_TEMPLATE_CONFLICT",
    });

    expect(moveErrorMessage(error, t)).toBe(
      "settings:projectGeneral.toastMoveTemplateConflict",
    );
  });

  it("keeps the API text of another conflict", () => {
    const error = new HttpError(409, "Project key conflict", {
      code: "CONFLICT",
    });

    expect(moveErrorMessage(error, t)).toBe("Project key conflict");
  });

  it("falls back to the generic text for a value that is not an error", () => {
    expect(moveErrorMessage("offline", t)).toBe(
      "settings:projectGeneral.toastMoveError",
    );
  });
});
