/**
 * DEPRECATED — replaced in round 2 by the in-canvas issue panel.
 *
 * The first migration lifted the prototype's `PredictiveIssueKanban` out of the
 * image/video workspaces into this page-level, read-only right column. That
 * introduced the fixed `w-[300px]` width conflict and removed the manual issue
 * editing closure (select → locate → suggestion → tag reference → save /
 * rework / delete).
 *
 * Round 2 restores the prototype hierarchy:
 * - `components/WorkbenchIssuePanel.tsx` is the editable issue panel rendered
 *   beside the image/video viewer (width owned by WorkbenchPage);
 * - processed items + retrieval live in the left queue's status switch
 *   (`PendingLineagePanel`, 全部 / 待审 / 有返工 + 取回).
 *
 * The component is intentionally removed rather than kept as a second,
 * read-only source of truth for the same selection. See
 * `docs/AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md` for the migration record.
 */
export {};
