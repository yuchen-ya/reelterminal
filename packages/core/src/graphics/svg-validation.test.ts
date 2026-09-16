import { describe, expect, it } from "vitest";
import {
  SVG_MAX_CONTENT_BYTES,
  SVG_MAX_ELEMENT_COUNT,
  SvgValidationError,
  assertValidSvgContent,
  validateSvgContent,
} from "./svg-validation";

const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/>' +
  "</svg>";

const expectCode = (
  content: string,
  code: string,
  options?: Parameters<typeof validateSvgContent>[1],
) => {
  const result = validateSvgContent(content, options);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
    expect(result.message.length).toBeGreaterThan(0);
  }
};

describe("validateSvgContent", () => {
  it("accepts a plain valid SVG", () => {
    expect(validateSvgContent(VALID_SVG)).toEqual({ ok: true });
  });

  it("accepts the svg namespace declaration (an identifier, never fetched)", () => {
    expect(validateSvgContent(VALID_SVG).ok).toBe(true);
  });

  it("accepts relative and fragment references and data:image URIs", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<image href="assets/picture.png"/>' +
      '<image xlink:href="#internalSymbol"/>' +
      '<use href="#shape-1"/>' +
      '<image href="data:image/png;base64,iVBORw0KGgo="/>' +
      "</svg>";
    expect(validateSvgContent(svg)).toEqual({ ok: true });
  });

  it("accepts an internal <style> block without external imports", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      "<style>rect { fill: #00ff00; }</style>" +
      "<rect width='10' height='10'/></svg>";
    expect(validateSvgContent(svg)).toEqual({ ok: true });
  });

  it("rejects empty and whitespace-only content", () => {
    expectCode("", "empty");
    expectCode("   \n\t ", "empty");
  });

  it("rejects content over the byte ceiling", () => {
    expectCode(VALID_SVG, "tooLarge", { maxBytes: 10 });
    expect(
      validateSvgContent(VALID_SVG, {
        maxBytes: new TextEncoder().encode(VALID_SVG).length,
      }).ok,
    ).toBe(true);
  });

  it("exposes conservative default limits as constants", () => {
    expect(SVG_MAX_CONTENT_BYTES).toBe(2 * 1024 * 1024);
    expect(SVG_MAX_ELEMENT_COUNT).toBe(10_000);
  });

  it("rejects documents over the element ceiling", () => {
    const manyRects = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(
      6,
    )}</svg>`;
    expectCode(manyRects, "tooComplex", { maxElements: 5 });
    expect(
      validateSvgContent(manyRects, { maxElements: 7 }).ok,
    ).toBe(true);
  });

  it("rejects content without an svg root element", () => {
    expectCode("<div>not svg</div>", "noSvgRoot");
    expectCode("<notsvg></notsvg>", "noSvgRoot");
  });

  it("rejects script elements in any casing", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "script",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT type="text/javascript">x()</SCRIPT></svg>',
      "script",
    );
  });

  it("rejects foreignObject elements", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>hi</p></foreignObject></svg>',
      "foreignObject",
    );
  });

  it("rejects namespace-prefixed script and foreignObject elements", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
      "script",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:evil="urn:evil"><evil:script>x()</evil:script></svg>',
      "script",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:foreignObject><p>hi</p></svg:foreignObject></svg>',
      "foreignObject",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:x"><x:foreignObject/></svg>',
      "foreignObject",
    );
  });

  it("accepts a namespace-prefixed svg root", () => {
    const svg =
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg:svg>';
    expect(validateSvgContent(svg)).toEqual({ ok: true });
  });

  it("applies reference rules to attributes on namespace-prefixed elements", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:image href="https://example.com/cat.png"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:style>@import url("https://example.com/x.css");</svg:style></svg>',
      "externalResource",
    );
  });

  it("rejects event handler attributes", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
      "eventHandler",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onclick="x()" ONMOUSEOVER="y()"/></svg>',
      "eventHandler",
    );
  });

  it("does not mistake innocuous attributes for event handlers", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-online="true" width="1" height="1"/></svg>';
    expect(validateSvgContent(svg)).toEqual({ ok: true });
  });

  it("rejects javascript and vbscript URL schemes", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>',
      "unsafeProtocol",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="vbscript:alert(1)"/></svg>',
      "unsafeProtocol",
    );
  });

  it("rejects non-image data URIs, including entity-encoded schemes", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html;base64,PHNjcmlwdD4="/></svg>',
      "unsafeProtocol",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#106;avascript:alert(1)"/></svg>',
      "unsafeProtocol",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="jav&#x09;ascript:alert(1)"/></svg>',
      "unsafeProtocol",
    );
  });

  it("rejects http(s), file and protocol-relative references", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/cat.png"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="http://example.com/cat.png"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="//cdn.example.com/cat.png"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///C:/cat.png"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><link rel="stylesheet" href="http://example.com/x.css"/></svg>',
      "externalResource",
    );
  });

  it("rejects external stylesheet processing instructions and CSS @import", () => {
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><?xml-stylesheet href="https://example.com/x.css"?><rect width="1" height="1"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://example.com/x.css");</style><rect width="1" height="1"/></svg>',
      "externalResource",
    );
    expectCode(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "//evil.example/x.css";</style><rect width="1" height="1"/></svg>',
      "externalResource",
    );
  });

  it("prefers the unsafeProtocol finding over externalResource", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<image href="https://example.com/a.png" xlink:href="javascript:alert(1)"/></svg>';
    expectCode(svg, "unsafeProtocol");
  });

  it("reports script before external references", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><image href="https://example.com/a.png"/></svg>';
    expectCode(svg, "script");
  });

  it("assertValidSvgContent throws a coded SvgValidationError", () => {
    let caught: unknown;
    try {
      assertValidSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SvgValidationError);
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof SvgValidationError) {
      expect(caught.code).toBe("script");
      expect(caught.message).toContain("<script>");
    }
  });

  it("assertValidSvgContent does not throw for valid content", () => {
    expect(() => assertValidSvgContent(VALID_SVG)).not.toThrow();
  });
});
