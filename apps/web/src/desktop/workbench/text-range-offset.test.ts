import { describe, expect, it } from "vitest";
import { selectionOffsetsInRange, textBoundaryOffset } from "./text-range-offset";

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function rangeInText(root: HTMLElement, start: number, end: number): Range {
  const text = root.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return range;
}

describe("workbench text range offsets", () => {
  it("selects the second occurrence of a repeated phrase, not the first", () => {
    const text = "重复短语一。重复短语二。";
    const root = makeRoot(text);
    const second = text.lastIndexOf("重复短语");
    const range = rangeInText(root, second, second + 4);

    expect(selectionOffsetsInRange(root, range)).toEqual({
      start: second,
      end: second + 4,
    });
    expect(text.slice(second, second + 4)).toBe("重复短语");
  });

  it("counts emoji surrogate pairs as UTF-16 code units", () => {
    const text = "A🙂B";
    const root = makeRoot(text);
    // The emoji occupies code units [1, 3) in UTF-16.
    const range = rangeInText(root, 1, 3);

    expect(selectionOffsetsInRange(root, range)).toEqual({ start: 1, end: 3 });
    expect(text.slice(1, 3)).toBe("🙂");
  });

  it("keeps multi-line text and newlines in the measured interval", () => {
    const text = "第一行\n第二行\n第三行";
    const root = makeRoot(text);
    const start = text.indexOf("第二行");
    const end = start + "第二行".length;
    const range = rangeInText(root, start, end);

    const offsets = selectionOffsetsInRange(root, range);
    expect(offsets).toEqual({ start, end });
    expect(text.slice(offsets!.start, offsets!.end)).toBe("第二行");
  });

  it("spans multiple text nodes in document order", () => {
    const root = makeRoot("ab<span>cd</span>ef");
    const first = root.firstChild as Text;
    const middle = root.querySelector("span")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(middle, 1);

    expect(selectionOffsetsInRange(root, range)).toEqual({ start: 1, end: 3 });
  });

  it("resolves element-container boundaries by document order", () => {
    const root = makeRoot("<span>ab</span><span>cd</span>");
    const range = document.createRange();
    range.setStart(root, 1);
    range.setEnd(root, 2);

    expect(selectionOffsetsInRange(root, range)).toEqual({ start: 2, end: 4 });
    expect(textBoundaryOffset(root, root, 2)).toBe(4);
  });

  it("rejects ranges that are not fully contained by the body root", () => {
    const root = makeRoot("inside");
    const outside = document.createElement("p");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.setStart(outside.firstChild as Text, 0);
    range.setEnd(outside.firstChild as Text, 3);

    expect(selectionOffsetsInRange(root, range)).toBeNull();
  });
});
