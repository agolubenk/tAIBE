// A link address from Notion, vetted before it goes into markdown (lens 4,
// 30.10). The URL parser reads the scheme, so case, spaces and control
// characters cannot slip a `javascript:` past a pattern. Only an absolute
// http(s) address without credentials or a signature is kept.
export type LinkLoss = "personal" | "signed" | "scheme";

const NOTION_URL = "https://www.notion.so";
const SIGNED =
  /X-Amz-Signature|prod-files-secure|file\.notion\.so\/f\/|secure\.notion-static\.com/i;
// A signature or token key anywhere in the query or the fragment, raw or
// decoded: a hash router puts its own query after `#/path?`.
const SIGNED_PARAM =
  /(?:^|[?&#/!;])(?:token|access_token|sig|signature|x-goog-signature|x-amz-signature|expires)=/i;

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
  const tail = `${url.search}${url.hash}`;
  return SIGNED_PARAM.test(tail) || SIGNED_PARAM.test(decoded(tail));
}

// Each valid escape on its own, as Python's unquote_plus does: one broken
// `%` elsewhere must not switch the decoded check off (lens 4, 30.10).
function decoded(text: string): string {
  return text
    .replaceAll("+", " ")
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function percent(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}
