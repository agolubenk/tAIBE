// A link address from Notion, vetted before it goes into markdown (lens 4,
// 30.10). The URL parser reads the scheme, so case, spaces and control
// characters cannot slip a `javascript:` past a pattern. Only an absolute
// http(s) address without credentials or a signature is kept.
export type LinkLoss = "personal" | "signed" | "scheme";

const NOTION_URL = "https://www.notion.so";
const SIGNED =
  /X-Amz-Signature|prod-files-secure|file\.notion\.so\/f\/|secure\.notion-static\.com/i;
const SIGNED_PARAMS = new Set([
  "token",
  "access_token",
  "sig",
  "signature",
  "x-goog-signature",
  "x-amz-signature",
  "expires",
]);
// The parser's form already encodes controls, spaces, `<` and `>`;
// parentheses and a backslash in the query or fragment would still end
// the markdown destination.
const UNSAFE = /[\\()]/g;

export function vetLink(href: string): { url: string } | { loss: LinkLoss } {
  // Notion writes links to its own pages relative to the workspace; any
  // other relative or protocol-relative (`//host`) address fails to parse.
  const address = /^\/(?![/\\])/.test(href) ? `${NOTION_URL}${href}` : href;

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { loss: "scheme" };
  }
  if (url.protocol === "mailto:") return { loss: "personal" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { loss: "scheme" };
  }
  if (url.username || url.password || isSigned(address, url)) {
    return { loss: "signed" };
  }
  // What was checked is what is written (role 1, 30.10): the parser's form,
  // with the characters it leaves that would end the markdown link.
  return { url: url.href.replace(UNSAFE, percent) };
}

function isSigned(address: string, url: URL): boolean {
  if (SIGNED.test(address) || SIGNED.test(url.href)) return true;
  const params = [
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.slice(1)).keys(),
  ];
  return params.some((name) => SIGNED_PARAMS.has(name.toLowerCase()));
}

function percent(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}
