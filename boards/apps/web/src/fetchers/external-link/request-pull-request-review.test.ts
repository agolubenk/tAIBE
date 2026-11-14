import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HttpError } from "@/lib/http-error";
import requestPullRequestReview from "./request-pull-request-review";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPullRequestReview (TB-172)", () => {
  it("posts to the task's link route with the session cookie", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "l 1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestPullRequestReview({ taskId: "t/1", id: "l 1" }),
    ).resolves.toEqual({ id: "l 1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(
      /\/api\/external-link\/task\/t%2F1\/l%201\/review-request$/,
    );
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("throws an HttpError with the body's code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: "fork", code: "PR_FROM_FORK" }),
            { status: 422 },
          ),
      ),
    );
    const error = await requestPullRequestReview({
      taskId: "t",
      id: "l",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 422, code: "PR_FROM_FORK" });
  });
});
