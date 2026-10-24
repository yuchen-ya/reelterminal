import type { WorkbenchFeedback, WorkbenchTextContent } from "@reelterminal/core";
import type { TextRangeCommentView } from "./types";

/**
 * Build the read model for text-range comments. The quoted source always comes
 * from the version the comment was anchored to; `record.text` is the
 * suggestion and must never be shown as the original quote.
 */
export function buildTextRangeComments(
  content: WorkbenchTextContent,
  feedback: readonly WorkbenchFeedback[],
): TextRangeCommentView[] {
  return feedback
    .filter(
      (record): record is WorkbenchFeedback & {
        target: Extract<NonNullable<WorkbenchFeedback["target"]>, { kind: "text-range" }>;
      } => record.target?.kind === "text-range",
    )
    .map((record) => {
      const target = record.target;
      const boundVersion = content.versions.find(
        (version) => version.version === target.version,
      );
      const quoted = boundVersion?.text.slice(target.startOffset, target.endOffset);
      return {
        id: record.id,
        entryId: target.entryId,
        version: target.version,
        startOffset: target.startOffset,
        endOffset: target.endOffset,
        quotedText: quoted
          ? quoted.length <= 80
            ? quoted
            : `${quoted.slice(0, 80)}…`
          : "（绑定版本原文不可用）",
        suggestion: record.text,
        referencedTags: [...record.referencedTagIds],
      };
    });
}
