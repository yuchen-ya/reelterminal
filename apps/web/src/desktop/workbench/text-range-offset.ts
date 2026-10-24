/**
 * UTF-16 character-range measurement for the workbench text corpus.
 *
 * The workbench binds range comments to half-open UTF-16 offsets into the
 * persisted text. Offsets must come from the DOM position of the selection,
 * never from `indexOf` of the selected string: repeated phrases, emoji
 * surrogate pairs, leading/trailing whitespace and multi-line selections all
 * have to land on the real offsets. This module is intentionally DOM-only and
 * free of React so it can be unit-tested with jsdom.
 */

export interface TextSelectionOffsets {
  /** Inclusive UTF-16 code-unit offset into the persisted text. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset into the persisted text. */
  readonly end: number;
}

/**
 * UTF-16 code-unit offset of one Range boundary relative to `root`.
 *
 * Text-node containers resolve by accumulating `Text.data.length` (code
 * units, so surrogate-pair emoji count as 2). Element containers resolve by
 * counting every text node strictly before `childNodes[offset]` — the DOM
 * position of the boundary, not a string search, so repeated phrases and
 * leading/trailing whitespace always land on the real offsets.
 */
export function textBoundaryOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node = walker.nextNode();
  if (container.nodeType === Node.TEXT_NODE) {
    while (node) {
      if (node === container) return total + offset;
      total += (node as Text).data.length;
      node = walker.nextNode();
    }
    return null;
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const element = container as Element;
  const boundaryChild = element.childNodes[offset] ?? null;
  while (node) {
    if (boundaryChild !== null) {
      // Boundary sits immediately before boundaryChild; the child itself and
      // anything after it are outside the counted prefix.
      if (
        node === boundaryChild ||
        (boundaryChild.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      ) {
        break;
      }
    } else {
      // Boundary after the element's last child: text the element contains
      // is inside the prefix, later siblings are not.
      const position = element.compareDocumentPosition(node);
      const containedBy = (position & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0;
      const following = (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!containedBy && following) break;
    }
    total += (node as Text).data.length;
    node = walker.nextNode();
  }
  return total;
}

/** Half-open [start, end) offsets of a selection clipped to one body root. */
export function selectionOffsetsInRange(
  root: HTMLElement,
  range: Range,
): TextSelectionOffsets | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = textBoundaryOffset(root, range.startContainer, range.startOffset);
  const end = textBoundaryOffset(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
