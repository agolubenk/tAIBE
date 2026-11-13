import { describe, expect, it, vi } from "vite-plus/test";
import { pushRepos } from "../../../apps/api/src/ssr/push-repos";

// TB-93: a workspace pushes only into the repo named for it.
describe("pushRepos", () => {
  it("reads workspace=owner/repo pairs", () => {
    expect(pushRepos(" ws1=acme/product-a , ws2=acme/product.b-2 ,")).toEqual(
      new Map([
        ["ws1", "acme/product-a"],
        ["ws2", "acme/product.b-2"],
      ]),
    );
    expect(pushRepos("")).toEqual(new Map());
  });

  it("skips a malformed pair and drops a workspace named twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      pushRepos(
        "acme/product-a,ws1=acme,ws2=a/b/c,ws3=acme/x,ws3=acme/y,ws4=acme/z",
      ),
    ).toEqual(new Map([["ws4", "acme/z"]]));
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});
