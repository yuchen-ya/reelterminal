# Cleanup decisions and follow-ups — 2026-09

Status: decided 2026-09-23 on the maintainer-approved recommendations from the
2026-09-22 dead-code / bloat / problem review. This page registers what is kept
deliberately and what is deferred, so later cleanup rounds start here instead
of re-deciding. Section references below are to
[`open-source-readiness/PLAN.md`](open-source-readiness/PLAN.md).

## Kept deliberately

- **`packages/creation-schema`** — creation scene schema with no in-repo
  consumer since the creation-agent verbs were removed. It is the planning
  layer for agent-ifying the native creation engine (`packages/creation-core` /
  `packages/creation-bindings`, still live in the desktop renderer), and a lack
  of usage evidence is not evidence of no use (readiness plan §3).
  **Disposition criterion**: if that roadmap is confirmed cancelled, delete the
  package plus its `tsconfig.base.json` paths in a later round. The
  naming-registry row for its generator string stays either way — it is a
  legacy persisted identifier.
- **`apps/web/src/gui-manual`** — web-side bridge for the shipped GUI manual.
  Scheduled for wiring, not deletion: `open-source-readiness/GUI-PLAN.md` §2.6
  ships a version-bound GUI manual whose shortcut table reuses existing data,
  and this bridge resolves the facade's shortcut ids against the live shortcut
  registry.

## Deferred follow-ups

- **zod major-version split** — `apps/desktop` on v3; `apps/image`,
  `apps/studio`, `packages/fxpkg`, `packages/image-core` on v4. Unify on v4
  when desktop next touches its zod schemas (an API-change pass is required);
  batch dependency upgrades are out of scope this round (readiness plan §2).
- **Local/offline packaging of the runtime cores** — the FFmpeg.wasm core and
  the vidstab cores still load from their CDNs. Download-location overrides
  landed 2026-09-23 (see `EXTERNAL-DEPENDENCIES.md` W9/W10); offline packing
  stays planned follow-up work (readiness plan §5.3).
- **Oversized files** — `Preview.tsx` (~7.7k lines), `StageCanvas.tsx` (~5.9k),
  `PropertiesPanel.tsx` (~5.4k), `project-store.ts` (~4.4k) and the other
  multi-thousand-line modules are not split mechanically. Extract per
  functional domain when those areas change; do not let them grow further.

## Historical residue (open-source readiness checklist)

Recorded per readiness plan §6 (report location and category only); history
rewrite is out of scope (§2).

- `creating-views/project/uploads/` — two design-tool export images (~3 MB
  total) from the Claude Design handoff. Removed from the working tree on
  2026-09-23 and covered by `.gitignore`; still present in git history at the
  same paths. Category: one-off tool-export residue. The handoff's
  `Editor.dc.html` and README stay as historical design reference (§3).
