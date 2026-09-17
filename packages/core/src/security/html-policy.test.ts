/**
 * Rule-table tests for the HTML/CSS content policy (media.render_html string
 * gate). One test per policy rule plus the allow-list and evasion defenses,
 * mirroring the svg-validation test style.
 */
import { describe, expect, it } from "vitest";
import {
  HTML_MAX_CONTENT_BYTES,
  HtmlValidationError,
  assertValidHtmlContent,
  classifyHtmlReferenceUrl,
  validateHtmlContent,
} from "./html-policy";

const OK = "<p>hello</p>";

function codeOf(html: string) {
  const result = validateHtmlContent(html);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  return result.code;
}

describe("html policy — structural rules", () => {
  it("accepts a plain document", () => {
    expect(validateHtmlContent(OK)).toEqual({ ok: true });
  });

  it("rejects empty and whitespace-only content", () => {
    expect(codeOf("")).toBe("empty");
    expect(codeOf("   \n\t ")).toBe("empty");
  });

  it("rejects content over the byte ceiling", () => {
    const big = `<p>${"x".repeat(HTML_MAX_CONTENT_BYTES)}</p>`;
    expect(codeOf(big)).toBe("tooLarge");
    expect(
      validateHtmlContent(big, { maxBytes: HTML_MAX_CONTENT_BYTES * 2 }).ok,
    ).toBe(true);
  });

  it("rejects <script> including namespaced and lookalike forms", () => {
    expect(codeOf("<script>alert(1)</script>")).toBe("script");
    expect(codeOf("<SCRIPT src=\"x.js\"></SCRIPT>")).toBe("script");
    expect(codeOf("<svg:script>alert(1)</svg:script>")).toBe("script");
    // A hyphenated lookalike element is NOT a script element.
    expect(validateHtmlContent("<script-button>x</script-button>").ok).toBe(
      true,
    );
  });

  it("rejects iframe / object / embed", () => {
    expect(codeOf('<iframe src="page.html"></iframe>')).toBe("embeddedContent");
    expect(codeOf('<object data="x.swf"></object>')).toBe("embeddedContent");
    expect(codeOf("<embed src=\"x.swf\">")).toBe("embeddedContent");
    expect(codeOf("<EMBED src=\"x.swf\">")).toBe("embeddedContent");
  });

  it("rejects <base href>", () => {
    expect(codeOf('<base href="https://evil.example/">')).toBe("baseHref");
    expect(codeOf("<base href='../elsewhere/'>")).toBe("baseHref");
  });

  it("rejects <meta http-equiv=refresh>", () => {
    expect(codeOf('<meta http-equiv="refresh" content="0;url=x">')).toBe(
      "metaRefresh",
    );
    expect(codeOf("<meta http-equiv='REFRESH' content='0'>")).toBe(
      "metaRefresh",
    );
    // Ordinary meta declarations stay allowed.
    expect(
      validateHtmlContent('<meta charset="utf-8"><meta name="x" content="y">')
        .ok,
    ).toBe(true);
  });

  it("rejects the srcset attribute", () => {
    expect(codeOf('<img src="a.png" srcset="b.png 2x">')).toBe("srcset");
    expect(codeOf("<img SRCSET = 'b.png 2x'>")).toBe("srcset");
  });
});

describe("html policy — script surfaces", () => {
  it("rejects inline event handler attributes", () => {
    expect(codeOf('<div onclick="alert(1)">x</div>')).toBe("eventHandler");
    expect(codeOf("<body ONLOAD = 'go()'>")).toBe("eventHandler");
    expect(codeOf("<svg onload=go()>")).toBe("eventHandler");
    // data-* attributes with 'on' inside are innocent.
    expect(validateHtmlContent('<div data-online="true">x</div>').ok).toBe(
      true,
    );
  });

  it("rejects javascript:/vbscript: URLs incl. entity-encoded evasion", () => {
    expect(codeOf('<a href="javascript:alert(1)">x</a>')).toBe(
      "unsafeProtocol",
    );
    expect(codeOf("<a href='JAVASCRIPT:alert(1)'>x</a>")).toBe(
      "unsafeProtocol",
    );
    expect(codeOf('<a href="vbscript:x">y</a>')).toBe("unsafeProtocol");
    expect(codeOf("&#106;&#97;&#118;&#97;".repeat(0) + '<a href="&#106;avascript:alert(1)">x</a>')).toBe(
      "unsafeProtocol",
    );
    expect(codeOf('<a href="java\tscript:alert(1)">x</a>')).toBe(
      "unsafeProtocol",
    );
  });

  it("rejects non-image data: URIs but allows data:image/*", () => {
    expect(codeOf('<a href="data:text/html,<h1>x</h1>">x</a>')).toBe(
      "unsafeProtocol",
    );
    // SVG data URIs can carry scripts — the policy keeps them out.
    expect(codeOf('<img src="data:image/svg+xml;base64,AAAA">')).toBe(
      "unsafeProtocol",
    );
    expect(
      validateHtmlContent(
        '<img src="data:image/png;base64,iVBORw0KGgo=">',
      ).ok,
    ).toBe(true);
  });
});

describe("html policy — external references", () => {
  it("rejects http(s), file and protocol-relative URLs in URL attributes", () => {
    expect(codeOf('<img src="https://cdn.example/a.png">')).toBe(
      "externalResource",
    );
    expect(codeOf("<img src='http://cdn.example/a.png'>")).toBe(
      "externalResource",
    );
    expect(codeOf('<img src="//cdn.example/a.png">')).toBe("externalResource");
    expect(codeOf('<link href="file:///etc/passwd" rel="x">')).toBe(
      "externalResource",
    );
    expect(codeOf('<video poster="https://x/y.jpg">')).toBe(
      "externalResource",
    );
    expect(codeOf('<a ping="https://x/track">')).toBe("externalResource");
    expect(codeOf('<img src="https://x/a.png" alt="https ok in alt">')).toBe(
      "externalResource",
    );
  });

  it("rejects external CSS url() targets (incl. @font-face)", () => {
    expect(
      codeOf(
        "<style>body{background:url(https://cdn.example/bg.png)}</style>",
      ),
    ).toBe("externalResource");
    expect(codeOf("<style>a{color:red}b{background:url('//x/y')}</style>")).toBe(
      "externalResource",
    );
    expect(
      codeOf(
        '<style>@font-face{font-family:X;src:url("https://f.example/x.woff2")}</style>',
      ),
    ).toBe("externalResource");
    expect(codeOf('<div style="background:url(http://x/y.png)">d</div>')).toBe(
      "externalResource",
    );
  });

  it("rejects external CSS @import", () => {
    expect(codeOf("<style>@import url(https://x/y.css);</style>")).toBe(
      "externalResource",
    );
    expect(codeOf("<style>@import 'https://x/y.css';</style>")).toBe(
      "externalResource",
    );
  });

  it("reports unsafeProtocol over externalResource when both appear", () => {
    expect(
      codeOf(
        '<a href="javascript:x">a</a><img src="https://x/b.png">',
      ),
    ).toBe("unsafeProtocol");
  });
});

describe("html policy — allow list", () => {
  it("allows relative resources, fragments, data:image, inline style and <style>", () => {
    const doc = [
      '<div style="color:red;background:url(bg.png)">styled</div>',
      '<img src="assets/pic.png">',
      "<img src='sub/dir/other.PNG'>",
      '<a href="#section">jump</a>',
      '<img src="data:image/jpeg;base64,/9j/4AAQ">',
      "<style>@font-face{font-family:L;src:url(fonts/local.woff2)}p{color:blue}</style>",
      "<style>@import 'more.css';</style>",
    ].join("\n");
    expect(validateHtmlContent(doc)).toEqual({ ok: true });
  });

  it("classifies URLs exactly at the classifier level", () => {
    expect(classifyHtmlReferenceUrl("pic.png")).toEqual({
      kind: "allowed",
      value: "pic.png",
    });
    expect(classifyHtmlReferenceUrl("#frag").kind).toBe("allowed");
    expect(classifyHtmlReferenceUrl("data:image/webp;base64,II").kind).toBe(
      "allowed",
    );
    expect(classifyHtmlReferenceUrl("https://x/y").kind).toBe(
      "externalResource",
    );
    expect(classifyHtmlReferenceUrl("&#106;avascript:x").kind).toBe(
      "unsafeProtocol",
    );
  });
});

describe("html policy — thrown variant", () => {
  it("throws a coded HtmlValidationError", () => {
    try {
      assertValidHtmlContent("<script></script>");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HtmlValidationError);
      expect((error as HtmlValidationError).code).toBe("script");
    }
    expect(() => assertValidHtmlContent(OK)).not.toThrow();
  });
});
