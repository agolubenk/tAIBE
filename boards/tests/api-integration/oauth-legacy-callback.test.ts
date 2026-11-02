import { describe, expect, it } from "vite-plus/test";
import { createApp } from "../../apps/api/src/index";

// better-auth 1.7 moved generic OAuth callbacks from /oauth2/callback/:id to
// /callback/:id. Identity providers configured before the upgrade must keep
// signing people in.
describe("legacy generic OAuth callback", () => {
  it("redirects GET with the query intact", async () => {
    const { app } = createApp();
    const res = await app.request(
      "/api/auth/oauth2/callback/custom?code=abc&state=xyz",
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "/api/auth/callback/custom?code=abc&state=xyz",
    );
  });

  it("keeps POST (form_post) as POST through 307", async () => {
    const { app } = createApp();
    const res = await app.request("/api/auth/oauth2/callback/custom", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=abc&state=xyz",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/api/auth/callback/custom");
  });
});
