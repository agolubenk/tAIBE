import net from "node:net";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { blockedDestinationError } from "../../import/blocked-destination-error";
import { fetchLink } from "./link-fetch";

// Synthetic hosts only; nothing leaves the process.
const HOSTS: Record<string, string> = {
  "docs.example.com": "93.184.216.34",
  "intranet.example.com": "10.0.0.7",
};
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    const address = net.isIP(hostname) ? hostname : HOSTS[hostname];
    if (!address) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND",
      });
    }
    return [{ address, family: net.isIP(address) }];
  }),
}));

const PAGE = new URL("https://docs.example.com/guide");
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function page(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

function refused(status: number, code: string) {
  return expect.objectContaining({ status, code });
}

describe("fetchLink", () => {
  beforeEach(() => {
    vi.stubEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads an allowed page and decodes its charset", async () => {
    const baseFetch = vi.fn<Fetch>(async () =>
      page(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), {
        "content-type": "text/plain; charset=windows-1251",
      }),
    );

    await expect(fetchLink(PAGE, { baseFetch })).resolves.toEqual({
      mime: "text/plain",
      body: "Привет",
    });
    expect(baseFetch).toHaveBeenCalledWith(
      PAGE.href,
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("refuses plain http, on the first request and after a redirect", async () => {
    const baseFetch = vi.fn<Fetch>(async () =>
      redirect("http://docs.example.com/guide"),
    );

    await expect(
      fetchLink(new URL("http://docs.example.com/"), { baseFetch }),
    ).rejects.toEqual(refused(400, "LINK_NOT_HTTPS"));
    expect(baseFetch).not.toHaveBeenCalled();
    await expect(fetchLink(PAGE, { baseFetch })).rejects.toEqual(
      refused(400, "LINK_NOT_HTTPS"),
    );
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a private address", "https://10.0.0.5/admin"],
    ["localhost", "https://localhost/admin"],
    ["loopback", "https://127.0.0.1:6379/"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "https://[::1]/"],
    [
      "a name that resolves to a private address",
      "https://intranet.example.com/",
    ],
  ])("refuses %s before sending anything", async (_case, url) => {
    const baseFetch = vi.fn<Fetch>(async () => page("secret"));

    await expect(fetchLink(new URL(url), { baseFetch })).rejects.toEqual(
      refused(422, "LINK_UNREACHABLE"),
    );
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a private address without following it", async () => {
    const baseFetch = vi.fn<Fetch>(async () =>
      redirect("https://127.0.0.1/admin"),
    );

    await expect(fetchLink(PAGE, { baseFetch })).rejects.toEqual(
      refused(422, "LINK_UNREACHABLE"),
    );
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an address that turns private at connect time", async () => {
    const baseFetch = vi.fn<Fetch>(async () => {
      throw new TypeError("fetch failed", { cause: blockedDestinationError() });
    });

    await expect(fetchLink(PAGE, { baseFetch })).rejects.toEqual(
      refused(422, "LINK_UNREACHABLE"),
    );
  });

  it("ignores KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", async () => {
    vi.stubEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");
    const baseFetch = vi.fn<Fetch>(async () => page("secret"));

    await expect(
      fetchLink(new URL("https://10.0.0.5/"), { baseFetch }),
    ).rejects.toEqual(refused(422, "LINK_UNREACHABLE"));
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("refuses a page larger than the cap, declared or streamed", async () => {
    const declared = vi.fn<Fetch>(async () =>
      page("x", { "content-length": "2048" }),
    );
    await expect(
      fetchLink(PAGE, { baseFetch: declared, maxBytes: 1024 }),
    ).rejects.toEqual(refused(413, "LINK_TOO_LARGE"));

    const streamed = vi.fn<Fetch>(async () => page("x".repeat(1025)));
    await expect(
      fetchLink(PAGE, { baseFetch: streamed, maxBytes: 1024 }),
    ).rejects.toEqual(refused(413, "LINK_TOO_LARGE"));
  });

  it("times out a host that never answers or stalls the body", async () => {
    const silent = vi.fn<Fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      fetchLink(PAGE, { baseFetch: silent, timeoutMs: 50 }),
    ).rejects.toEqual(refused(422, "LINK_TIMEOUT"));
    expect(silent.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    const stalled = vi.fn<Fetch>(async () =>
      page(new ReadableStream({ pull: () => new Promise(() => {}) })),
    );
    await expect(
      fetchLink(PAGE, { baseFetch: stalled, timeoutMs: 50 }),
    ).rejects.toEqual(refused(422, "LINK_TIMEOUT"));
  });

  it("refuses content types other than HTML, Markdown and plain text", async () => {
    const json = vi.fn<Fetch>(async () =>
      page("{}", { "content-type": "application/json" }),
    );
    await expect(fetchLink(PAGE, { baseFetch: json })).rejects.toEqual(
      refused(415, "LINK_CONTENT_TYPE"),
    );

    // A Blob without a type sends no content-type at all.
    const untyped = vi.fn<Fetch>(async () => new Response(new Blob(["text"])));
    await expect(fetchLink(PAGE, { baseFetch: untyped })).rejects.toEqual(
      refused(415, "LINK_CONTENT_TYPE"),
    );

    const pdf = vi.fn<Fetch>(async () =>
      page("%PDF-1.7", { "content-type": "application/pdf" }),
    );
    await expect(fetchLink(PAGE, { baseFetch: pdf })).rejects.toEqual(
      refused(415, "LINK_PDF_UNSUPPORTED"),
    );
  });

  it("refuses error statuses, redirect loops and unreachable hosts", async () => {
    const missing = vi.fn<Fetch>(
      async () => new Response("gone", { status: 404 }),
    );
    await expect(fetchLink(PAGE, { baseFetch: missing })).rejects.toEqual(
      refused(422, "LINK_UPSTREAM_STATUS"),
    );

    const loop = vi.fn<Fetch>(async () => redirect(PAGE.href));
    await expect(fetchLink(PAGE, { baseFetch: loop })).rejects.toEqual(
      refused(422, "LINK_TOO_MANY_REDIRECTS"),
    );

    const down = vi.fn<Fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchLink(PAGE, { baseFetch: down })).rejects.toEqual(
      refused(422, "LINK_UNREACHABLE"),
    );

    await expect(
      fetchLink(new URL("https://nowhere.example.com/"), { baseFetch: down }),
    ).rejects.toEqual(refused(422, "LINK_UNREACHABLE"));
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("answers a private address and an unknown name alike (TB-132)", async () => {
    const baseFetch = vi.fn<Fetch>(async () => page("secret"));
    const answer = async (url: string) => {
      const error = await fetchLink(new URL(url), { baseFetch }).catch(
        (e: unknown) => e,
      );
      const { status, code, message } = error as {
        status: number;
        code: string;
        message: string;
      };
      return { status, code, message };
    };

    const known = await answer("https://intranet.example.com/");
    const unknown = await answer("https://nowhere.example.com/");

    expect(known).toEqual(unknown);
    expect(known).toEqual({
      status: 422,
      code: "LINK_UNREACHABLE",
      message: "The page could not be reached.",
    });
    expect(baseFetch).not.toHaveBeenCalled();

    const viaRedirect = vi.fn<Fetch>(async () =>
      redirect("https://intranet.example.com/admin"),
    );
    await expect(fetchLink(PAGE, { baseFetch: viaRedirect })).rejects.toEqual(
      expect.objectContaining(unknown),
    );
  });

  it("reads the charset from <meta> when the header has none (TB-132)", async () => {
    const cp1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // «Привет»
    const html = (head: string) =>
      new Uint8Array([
        ...new TextEncoder().encode(`<html><head>${head}</head><body>`),
        ...cp1251,
      ]);
    const fetched = async (body: Uint8Array<ArrayBuffer>, type = "text/html") =>
      (
        await fetchLink(PAGE, {
          baseFetch: vi.fn<Fetch>(async () =>
            page(body, { "content-type": type }),
          ),
        })
      ).body;

    expect(await fetched(html('<meta charset="windows-1251">'))).toContain(
      "Привет",
    );
    expect(
      await fetched(
        html(
          '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">',
        ),
      ),
    ).toContain("Привет");
    // The header wins over <meta>.
    expect(
      await fetched(
        html('<meta charset="utf-8">'),
        "text/html; charset=windows-1251",
      ),
    ).toContain("Привет");
    // <meta> past the prescan window and in plain text is not read.
    const late = html(
      `<!--${"x".repeat(1100)}--><meta charset="windows-1251">`,
    );
    expect(await fetched(late)).not.toContain("Привет");
    expect(
      await fetched(html('<meta charset="windows-1251">'), "text/plain"),
    ).not.toContain("Привет");
    // A byte-order mark wins over <meta>.
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('<meta charset="windows-1251">Привет'),
    ]);
    expect(await fetched(bom)).toContain("Привет");
  });
});
