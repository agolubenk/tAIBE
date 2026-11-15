import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import getTaskForms from "./get-task-forms";
import saveTaskFormAnswers, {
  type SaveFailure,
  SaveTaskFormError,
} from "./save-task-form-answers";

const request = {
  formId: "form-1",
  answers: { form: "seven-types", version: 1, answers: { mood: { v: 4 } } },
  submit: false,
  rowVersion: 3,
};

const respond = (body: unknown, status: number) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(body, { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

const failureOf = async (): Promise<SaveTaskFormError> => {
  try {
    await saveTaskFormAnswers(request);
  } catch (error) {
    if (error instanceof SaveTaskFormError) return error;
  }
  throw new Error("no SaveTaskFormError");
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task form fetchers (TB-173)", () => {
  it("puts the answers with the row version and returns the saved state", async () => {
    const saved = { status: "draft", rowVersion: 4, submittedAt: null };
    const fetch = respond(saved, 200);
    await expect(
      saveTaskFormAnswers(request, { keepalive: true }),
    ).resolves.toEqual(saved);
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toMatch(/\/api\/form\/form-1\/answers$/);
    expect(call?.[1]).toMatchObject({
      method: "PUT",
      credentials: "include",
      keepalive: true,
    });
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      answers: request.answers,
      submit: false,
      rowVersion: 3,
    });
  });

  it.each<[number, unknown, SaveFailure]>([
    [409, { code: "ROW_VERSION_CONFLICT" }, "row_version"],
    [409, { code: "VERSION_MISMATCH" }, "version_mismatch"],
    [409, {}, "row_version"],
    [403, { code: "PERSON_ONLY" }, "forbidden"],
    [413, { code: "PAYLOAD_TOO_LARGE" }, "failed"],
    [401, { message: "no" }, "failed"],
    [500, { message: "boom" }, "failed"],
  ])("tells a %i %j apart as %s", async (status, body, failure) => {
    respond(body, status);
    expect((await failureOf()).failure).toBe(failure);
  });

  it("gives the issues of a refused answer set", async () => {
    const issues = [{ fieldId: "mood", code: "out_of_range" }];
    respond({ code: "INVALID_ANSWERS", answerIssues: issues }, 422);
    const error = await failureOf();
    expect(error.failure).toBe("invalid");
    expect(error.issues).toEqual(issues);
  });

  it("reports a network error as a failed save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect((await failureOf()).failure).toBe("failed");
  });

  it("reads no route or no task as no forms", async () => {
    respond({ message: "Not Found" }, 404);
    await expect(getTaskForms("task-1")).resolves.toEqual([]);
    respond({ forms: [{ id: "form-1" }] }, 200);
    await expect(getTaskForms("task-1")).resolves.toEqual([{ id: "form-1" }]);
  });
});
