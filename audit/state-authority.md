# State Authority Map

Baseline `2566c34e0f8ea22992a85f3ff16e048307b49365`. Synthesized from
`audit/areas/livehost-state.md` (primary), `core-actions.md`, `agent-runner-headless.md`;
mechanical backing in `audit/tool-catalog.jsonl` (per-tool `host_methods`/`action_type`).

## Authorities per state slice

| State slice | Authority (writer of record) | Storage | Who reads | Who writes | Evidence |
|---|---|---|---|---|---|
| Project core: tracks, clips, transitions, markers, mediaLibrary **metadata**, settings, masks, motionCompositions | `useProjectStore.project` (live) / in-memory `project` (headless) | store object / RAM | UI, hosts, exporters, VideoEngine | `ActionExecutor.execute` handlers mutate **in place**, store ref-bumps (`project-store.ts:2893-2909`) | livehost-state.md §2; core-actions.md F2 |
| Text clips (runtime pixels) | `titleEngine` module singleton (core) | process memory | Preview, ExportEngine duration calc | store convenience methods only (`text-graphics-slice.ts:197`, `store-helpers.ts:97-133`) | livehost-state.md STATE-AUTHORITY; media-render-e2e.md F13-F14 |
| Shape/SVG/Sticker clips (runtime pixels) | `graphicsEngine` module singleton | process memory | Preview, save merge | same store convenience path | livehost-state.md STATE-AUTHORITY |
| Overlay mirrors | `project.textClips/shapeClips/svgClips/stickerClips` | project object | serializers, undo merge, VideoEngine.renderFrame overlay pass | `recordOverlay*` helpers; raw `text/create`-family actions (mirror ONLY) | livehost-state.md §1; overlay handlers packages/core/src/actions/handlers/overlay.ts:38-146 |
| Undo/redo | `ActionHistory` (in ActionExecutor) + `clipUndoStack` + `templateUndoStack` | process memory | `history-slice.undo()` arbitrates by timestamp | every mutation path | livehost-state.md §4; core-actions.md F7 |
| Timeline selection | `useUIStore` | store | inspector/timeline | UI only — never host/core | livehost-state.md STATE-AUTHORITY |
| Playback (playhead/isPlaying) | `useTimelineStore` + PlaybackController | store | Preview rAF | playback controls; never core actions | livehost-state.md STATE-AUTHORITY |
| Render caches | RenderBridge LRU / Preview refs | process memory | renderers | renderers; no invalidation contract with store | livehost-state.md STATE-AUTHORITY |
| Media blobs (pixels) | IndexedDB `openreel-db` (browser) / **nothing headless** | IndexedDB | decoders, preview, export | `importMedia`/`importMediaFromUrl` (live only) | livehost-state.md §8; media-render-e2e.md G4 |
| Persistence | IndexedDB autosave slots `openreel-autosave` (30s interval, 3 slots) | IndexedDB | recovery, listProjects | AutoSaveManager / forceSave | livehost-state.md §8 |
| Settings (incl. MCP gate) | `useSettingsStore` | localStorage/bridge | mcp-listener | settings UI | desktop-mcp.md F9 |
| GPU/export jobs | external broker (cloud) or desktop sidecar | out-of-process | job tools via runJob | JobRunner adapters | agent-runner-headless.md F13-F15 |

## The one structural split that matters

Overlay clips have **dual authority**: engine singletons own what renders; project arrays own
what serializes. They stay in lockstep only when writes flow through the web store convenience
methods. Any path that writes only one side diverges silently:

- raw `text/create` via `applyAction` → mirror only → **renders nothing** (documented at
  `packages/agent/src/host.ts:250-263`, verified in probe `audit/probes/out/headless-smoke.json` case 6).
- direct engine writes without `recordOverlay*` → mirror stale → lost on save/undo-resync
  (`syncOverlayEnginesFromProject` only runs on undo/redo/load, `store-helpers.ts:219-230`).

Confidence: HIGH (two independent area audits + self-documenting code comment + live probe).

## Host-level transaction semantics (divergent)

| | HeadlessHost | LiveEditorHost |
|---|---|---|
| `beginTransaction` | `structuredClone(project)` snapshot + history group | history group only |
| `rollbackTransaction` | restore snapshot + **`history.clear()` (nukes ALL prior undo)** | endGroup + ONE group undo — broken by any null-inverse action in the turn |
| `commitTransaction` | drop snapshot | endGroup |
| Evidence | `headless-host.ts:44-70` | `live-host.ts:161-185`; core-actions.md F8/CORE-05 |

## Facade implications

1. Facade must treat **the store/executor pair as the only write path** for project state;
   overlay writes must use engine-aware adapters (or fix the renderer fallback, see
   media-render-map.md §text) — never raw `text/create` from an external surface.
2. Revision tracking does not exist (`modifiedAt` is the closest). Facade must layer its own
   revision counter/precondition (core-actions.md F3).
3. Atomicity must come from the HeadlessHost snapshot pattern; LiveEditorHost group-undo
   rollback is not safe to promise over a wire protocol (CORE-05, DESK-02).
4. Undo across the facade must bypass the 3-stack arbitration ambiguity — expose
   `history.undo`/`redo` scoped to ActionHistory groups created by the facade itself.
