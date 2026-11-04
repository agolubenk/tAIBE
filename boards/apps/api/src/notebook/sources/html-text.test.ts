import { describe, expect, it } from "vite-plus/test";
import { htmlToText } from "./html-text";

const PAGE = `<!doctype html>
<html><head><title>Аренда &amp; рубка</title>
<style>p { color: red }</style><script>window.secret = "<p>no</p>";</script></head>
<body><nav><a href="/">Home</a></nav>
<h1>Лес</h1><p>Аренда истекает
  через <b>час</b>.</p>
<h2 class="x">Данные</h2>
<ul><li>Первое</li><li>Второе &laquo;в кавычках&raquo;</li></ul>
<pre><code>if (a &lt; b) {
  grow();
}</code></pre>
<p>Строка<br>и ещё</p><!-- <h2>не заголовок</h2> -->
<table><tr><th>Имя</th><th>Роль</th></tr><tr><td>Ann</td><td>Lead</td></tr></table>
<footer>© 2026</footer></body></html>`;

describe("htmlToText", () => {
  it("keeps headings, paragraphs, lists and code, and drops page chrome", () => {
    expect(htmlToText(PAGE)).toEqual({
      title: "Аренда & рубка",
      text: [
        "# Лес",
        "Аренда истекает через час.",
        "## Данные",
        "- Первое\n- Второе «в кавычках»",
        "```\nif (a < b) {\n  grow();\n}\n```",
        "Строка\nи ещё",
        "Имя Роль\nAnn Lead",
      ].join("\n\n"),
    });
  });

  it("does not let a quote or a > inside an attribute end the tag early", () => {
    expect(
      htmlToText(`<p title="a > b" data-x='<h1>'>Text</p><a href=it's>link</a>`)
        .text,
    ).toBe("Text\n\nlink");
  });

  it("returns nothing for a page that only renders with JavaScript", () => {
    expect(
      htmlToText(`<body><div id="root"></div><script>app()</script></body>`),
    ).toEqual({ title: "", text: "" });
  });

  // Each of these made turndown quadratic or overflow its stack.
  it.each([
    ["line breaks", (n: number) => `<p>a${"<br>".repeat(n)}b</p>`],
    ["nested blocks", (n: number) => `${"<div>".repeat(n)}x`],
    ["spaces in pre", (n: number) => `<pre>${" \t\n".repeat(n)}x</pre>`],
    ["unclosed titles", (n: number) => "<title>".repeat(n)],
    ["unclosed tags", (n: number) => "<a ".repeat(n)],
    ["hash headings", (n: number) => `<h1>x${"#".repeat(n * 3)}y</h1>`],
  ])("reads 2 MB of %s in linear time", (_case, make) => {
    const html = make(500_000).slice(0, 2 * 1024 * 1024);
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
