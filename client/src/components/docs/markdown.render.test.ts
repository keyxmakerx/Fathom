import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

const html = (source: string) =>
  renderToStaticMarkup(createElement(Markdown, { source }));

describe("the docs Markdown subset", () => {
  it("draws headings, lists, emphasis, code and tables", () => {
    const out = html(
      "# Title\n\n- a\n- **b** and *c*\n\n1. one\n2. two\n\n`x < y`\n\n```\nraw <b>\n```\n\n| h1 | h2 |\n|----|----|\n| a | b |",
    );
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain(
      "<ul><li>a</li><li><strong>b</strong> and <em>c</em></li></ul>",
    );
    expect(out).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(out).toContain("<code>x &lt; y</code>");
    expect(out).toContain("<pre><code>raw &lt;b&gt;</code></pre>");
    expect(out).toContain("<th>h1</th>");
    expect(out).toContain("<td>b</td>");
  });

  it("shows raw HTML as text and never as markup", () => {
    for (const evil of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      '<iframe src="https://evil.test"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<svg onload=alert(1)>",
      "<style>@import url(https://evil.test/x.css)</style>",
    ]) {
      const out = html(evil);
      // Only the wrapper and paragraph tags are markup; everything typed is escaped text.
      expect(out.replace(/<\/?(div|p)( class="doc-md")?>/g, "")).not.toContain(
        "<",
      );
    }
    expect(html("&lt;b&gt;")).toContain("&amp;lt;b&amp;gt;");
  });

  it("links only to http and https, with noopener noreferrer and the host shown", () => {
    const ok = html("[Vendor](https://docs.example.com/x?y=1)");
    expect(ok).toContain('href="https://docs.example.com/x?y=1"');
    expect(ok).toContain('rel="noopener noreferrer"');
    expect(ok).toContain('target="_blank"');
    expect(ok).toContain("(docs.example.com)");
    for (const bad of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](java&#115;cript:alert(1))",
      "[x](data:text/html;base64,PHNjcmlwdD4=)",
      "[x](vbscript:msgbox)",
      "[x](file:///etc/passwd)",
      "[x](//evil.test/a)",
      "[x](/relative)",
      "[x](https://user:pw@evil.test/)",
    ]) {
      const out = html(bad);
      expect(out).not.toContain("href=");
    }
  });

  it("never fetches an image: it says so in words", () => {
    const out = html("![tracker](https://evil.test/pixel.gif)");
    expect(out).not.toMatch(/<img|src=|evil\.test/);
    expect(out).toContain("image: tracker");
  });

  it("draws a value the gate destroyed as a block", () => {
    expect(html("enable secret <REDACTED:password> here")).toContain(
      "password · destroyed at the gate",
    );
  });

  it("survives deep and odd nesting without hanging", () => {
    const out = html(
      "*".repeat(500) +
        "a" +
        "*".repeat(500) +
        "\n\n" +
        "[".repeat(300) +
        "](" +
        ")".repeat(300) +
        "\n\n" +
        "| a |\n|---|\n" +
        "| b |\n".repeat(500),
    );
    expect(out.length).toBeGreaterThan(0);
  });
});
