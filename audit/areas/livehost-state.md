# Area: LiveEditorHost, state authority, browser/renderer/store bindings (apps/web)

## SUMMARY

- LiveEditorHost (apps/web/src/services/agent/live-host.ts) is a thin adapter over the Zustand `useProjectStore`. It implements all 8 required `EditingHost` members plus all 19 optional ones (27 total, host.ts:197-289). It holds **no project copy of its own** — every read/write goes through the store.
- The live app has **dual authority for overlay clips**: runtime truth lives in two module-level engine singletons (`titleEngine`, `graphicsEngine` in packages/core), while `project.textClips/shapeClips/svgClips/stickerClips` in the store is a **maintained mirror** written by the same store methods (`recordOverlayCreate/Update/Remove`). A raw `text/create` action via `applyAction` mutates only the mirror and "renders nothing" — this is documented as the reason the overlay* host methods exist (packages/agent/src/host.ts:262-280).
- Timeline/media/settings state IS single-authority in the store: core ActionExecutor handlers mutate `project` in place; `executeAction` then bumps the reference so React re-renders (project-store.ts:2893-2909).
- Undo is unified but plural-stacked: one `ActionHistory` inside `ActionExecutor` plus two side stacks (`clipUndoStack`, `templateUndoStack`) interleaved by timestamp in `undo()` (stores/project/history-slice.ts:73-277). User Ctrl+Z / menu undo / chat "undo last turn" / agent rollback all call the same `useProjectStore.undo()`.
- Preview invalidation after an agent action is **implicit via `project.modifiedAt`**: every successful mutation path bumps `modifiedAt`; Preview.tsx watches it and does a debounced (150ms) Canvas2D re-render at the playhead. There is no explicit dirty-flag from host to renderer.
- Persistence is browser-local only: auto-save slots in IndexedDB `openreel-autosave`, media blobs in `openreel-db`, recent projects in `openreel-projects`. No server sync exists in the web app.

## FINDINGS

### 1. Method inventory of LiveEditorHost (live-host.ts)

Required interface members (host.ts:200-215) — all implemented:
| # | Method | live-host.ts line | Backing |
|---|--------|-------------------|---------|
| 1 | getProject | 156 | `useProjectStore.getState().project` |
| 2 | applyAction | 161 | `store.executeAction(action)` → ActionExecutor |
| 3 | beginTransaction | 168 | `beginHistoryGroup(label)` → ActionHistory.beginGroup |
| 4 | commitTransaction | 174 | `endHistoryGroup()` |
| 5 | rollbackTransaction | 178 | `endHistoryGroup()` + one `undo()` (undoes whole group; executor.undo pops group entries together, action-executor.ts:157) |
| 6 | runJob | 187 | injected JobRunner (`export-job-runner.ts`) or `{ok:false}` |
| 7 | capabilities | 197 | static `CAPABILITY_MANIFEST` from core |
| 8 | requireOpenProject | 201 | throws unless `hasOpenProject` |

Optional methods (host.ts:216-289), 19 implemented + helper `setJobRunner` (152):
createProject(207), listProjects(217), openProject(229), saveProject(235), importMediaFromUrl(242), exportMotionScene(276), motionRenderQueue bridge add/run/list/cancel(329-435), probeRiggingBackend(437), inspectModel(449), rigHumanoidModel(456), createTextOverlay(489), createShapeOverlay(538), updateTextOverlay(607), updateShapeOverlay(643), createStickerOverlay(690), updateStickerOverlay(724), createSvgOverlay(743), updateSvgOverlay(753), removeOverlay(763). Confidence HIGH.

Mapping pattern: ~half of the optional methods go through **store convenience methods that write engines directly + push synthesized actions into history themselves** (recordOverlay helpers, text-graphics-slice/store-helpers), NOT through `applyAction`; the other half are plain reads/writes of stores or window bridges. Confidence HIGH.

### 2. How edits flow (canonical path)

`LiveEditorHost.applyAction` (live-host.ts:161) → `useProjectStore.executeAction` (project-store.ts:2893) → `actionExecutor.execute(action, project)` (packages/core/src/actions/action-executor.ts:75): validates → deep JSON snapshot → InverseActionGenerator → registered handler mutates project **in place** and sets `modifiedAt` (e.g. handlers/creation.ts:73-77) → pushes {action, inverse} into ActionHistory → back in the store, `set({ project: {...project} })` (2904-2907) triggers subscribers.
Note: the handler mutates the *same object* the store references; the wrapper spread is the only identity bump. Confidence HIGH.

Overlay writes take a different path: `store.createTextClip(...)` (text-graphics-slice.ts:197) calls `titleEngine.createTextClip` AND mirrors into `project.textClips` + clears redo via `recordOverlayCreate` (store-helpers.ts:97-133). No ActionValidator runs on these; the synthetic action/inverse pair is pushed straight into history. Confidence HIGH.

### 3. Optional-method implementations (task item 2)

- **createTextOverlay** (489-536): finds-or-creates a `type:"text"` track (track/add executed as a real action, 500); creates clip via store→TitleEngine; optionally applies animation preset. Returns OverlayRef{id, trackId}.
- **importMediaFromUrl** (242-274): requires desktop bridge `window.openreel.media.fetchUrl` (global.d.ts types/global.d.ts:304-315); builds a File from returned bytes, runs `store.importMedia(file)` (media-bridge + MediaStorage persistence), returns metadata from the mirrored library item keyed by result.actionId.
- **saveProject** (235-240): `store.forceSave()` merges engine clips over the project (3016-3029) and writes an auto-save record (IndexedDB). No file picker, no server.
- **listProjects** (217-227): enumerates ALL auto-save slots via `checkForRecovery()` (services/auto-save.ts:493) across projects; collapses to latest slot per projectId, sorted by modifiedAt. **ProjectRef.id here is the save-slot id `${projectId}-slot-${n}`** (auto-save.ts:180), not the projectId.
- **openProject** (229-233): `recoverFromAutoSave(saveId)` (project-store.ts:2952-3014): loads slot, reloads media blobs from IndexedDB, **loadTextClips/loadShapeClips into engines**, replaces ActionHistory+executor with fresh instances (history is NOT preserved across open).
- **removeOverlay** (763-778): switch on kind → deleteTextClip/deleteShapeClip/deleteStickerClip/deleteSVGClip — each deletes in the engine then records inverse into history (text-graphics-slice.ts:678-712).
- **exportMotionScene** (276-327): finds composition in `project.motionCompositions`, enforces ProRes/alpha only on desktop (`window.openreel.platform === "desktop"`), normalizes web requests to H.264 mp4 with consent gate (`acknowledgeH264Fallback`), then renders renderer-side via DOM canvas pipeline (motion/export-motion-frame.ts:1053-1062). Confidence HIGH.

### 4. Undo paths (task item 3)

- Single user-visible undo funnel: `useProjectStore.undo()` (history-slice.ts:73). Hit by: keyboard shortcut `cmd+z` defined services/keyboard-shortcuts.ts:195-206 and dispatched via native menu "undo" in DesktopApp.tsx:46-47 (desktop keyboard/menu); HistoryPanel button (components/editor/inspector/HistoryPanel.tsx:85-95); Toolbar TLTool (Timeline.tsx:964 uses canUndo()); chat-store undoLastTurn (chat-store.ts:285-297); LiveEditorHost.rollbackTransaction (live-host.ts:178-185).
- `undo()` picks among THREE stacks by recency comparison of timestamps: templateUndoStack / clipUndoStack / ActionHistory (94-137, 266). If the most recent entry is a clip op, it restores engine state directly and may additionally pop an auto-created empty track/add from ActionHistory (218-258).
- ActionExecutor.undo pops entries as a GROUP (history.undoGroup(), action-executor.ts:146-181), which is how a whole agent turn reverts with one undo when begin/commit transaction bracketed it.
- UI subscription: only HistoryPanel subscribes to `actionHistory.subscribe(updateHistory)` (HistoryPanel.tsx:79); ActionHistory maintains listeners (action-history.ts:144-151) and notifies on push/undo/endGroup. Toolbar/Timeline buttons read state reactively per render (they re-render on store changes; canUndo derives from store fields + history size, history-slice.ts:491-507 — note history-stack depth is NOT itself reactive outside HistoryPanel).
- Interleaved user+agent: chat turn and each MCP tool call hold a shared promise-chain lock `runExclusive` (host-singleton.ts:20-27), serialized against each other and CreationWorkspacePanel (motion/components/CreationWorkspacePanel.tsx:170). **Plain user UI edits do NOT acquire this lock** — during the async gaps of an agent turn (LLM streaming between tool calls), user mutations enter the SAME open history group because `beginGroup` just sets a token and any push while set joins it (action-history.ts:225-230). Also nested beginGroup would silently overwrite the token. Mitigation that exists: chat's "Undo AI turn" refuses if stack size changed since commit (chat-store.ts:285-297). Confidence HIGH.

### 5. mcp-listener.ts (task item 4)

- Web side is transport-agnostic: `installMcpListener()` registers `handleMcpBridgeRequest` with `window.openreel.mcp.onRequest(handler)` and no-ops off desktop (mcp-listener.ts:214-219). The bridge type (types/global.d.ts:264-273) frames requests as `{callId, kind:"listTools"|"callTool", name?, args?}` → `{ok, result?, error?}`; this is the preload contextBridge API the Electron main process invokes (i.e., IPC fan-out from the main-process MCP HTTP server — main-side belongs to the desktop audit). Installed once in DesktopApp.tsx:72-75, alongside `setJobRunner(createExportJobRunner())`.
- Semantics: listTools → registry dump (`toMcpTools()`); callTool → gate destructive/expensive tools behind settings flag `mcpAutoAllowTrustedLocal` (**default true**, settings-store.ts:129) returning CONFIRMATION_REQUIRED otherwise (mcp-listener.ts:185-196); execute via `runExclusive(() => executeTool(name, args, getLiveEditorHost()))` (199-201).
- After motion-domain tools it drives UI focus: sets desktopPage to edit/motion, switches activeCompositionId, moves playhead to a focus time parsed from args, selects layer (134-167). Confidence HIGH.

### 6. host-singleton.ts lifecycle (task item 5)

- One module-level `LiveEditorHost` per page/render process, created lazily on first use by chat panel, MCP listener, or creation workspace panel (host-singleton.ts:10-12). It is per-page, NOT per-project: opening/recovering a project swaps the store's ActionHistory/ActionExecutor under the same host instance (project-store.ts:2993-3002), so the singleton keeps working against whatever project is open. Documented purpose: single consistent undo bookkeeping across BYOK chat + MCP bridge (host-singleton.ts:5-9). Confidence HIGH.

### 7. Preview render pipeline & invalidation (OVERLAY-TO-PIXEL)

Component: `Preview.tsx` (8453 lines) owns the visible canvas (`canvasRef`), subscribing to whole-project (1187), overlay lists read **from engines** via useMemo keyed by `[getTitleEngine, project.modifiedAt]` / `[getGraphicsEngine, project.modifiedAt]` (1190-1204).

Pipeline at rest (paused): effect deps include `playheadPosition`, `isPlaying`, `project.modifiedAt` (6158-6231): modifiedChanged ⇒ 150ms-debounced `doRender(playheadPosition)` → `renderFrameDirectly(time)` (2595-3229): pure Canvas2D compositor in the component — decodes video/image via `drawClipFrame`, draws shapes/SVG/stickers, subtitles, adjustment layers, then **text via `renderTextClipToCanvas`** from components/editor/preview/canvas-renderers.ts (with subject-mask variant renderTextClipWithSubjectMask, 768-830). Optional per-layer GPU acceleration: `renderFrameWithGPU(renderer,...)` using the core WebGPU Renderer (414-473; webgpu renderer impl in packages/core/src/video/webgpu-renderer-impl.ts) and three.js for 3D-text layers (preview/threejs-layer-renderer.ts:1-11). Fallback placeholder frame renders text/shapes even without media (renderFallbackFrame, 3257+).

Invalidation triggers observed:
1. `project.modifiedAt` change → debounce render (all applyAction/overlay writes bump it).
2. playhead change / scrub → immediate coalesced render (6185-6211).
3. Window event `openreel:preview-invalidate` → forced re-render; dispatched by inspector panels only (InspectorPanel.tsx:436 etc.) — **not used by the agent/host path** (they rely on #1).
During playback an rAF loop with master clock redraws from refs (4370-4460).

The engine/compositor underneath: `RenderBridge` (bridges/render-bridge.ts:67+) is a separate VideoEngine-driven path (`videoEngine.renderFrame(project, time)` — OffscreenCanvas 2D compositor that also composites overlays from `project.textClips` arrays, video-engine.ts:1033-1050); RenderBridge is initialized at bootstrap (desktop/editor/useDesktopEditorBootstrap.ts:43) and used mainly for exports/effects rather than the interactive preview pixel path. VideoEngine itself ignores nothing: overlays ARE composited there too, sourced from the mirrored project arrays.

Headless-preview feasibility judgment: the paused preview is ordinary Canvas2D drawing driven purely by {project JSON (+engine-owned overlay lists), decoded media blobs}. A headless snapshot does NOT need WebGL/WebGPU (both are best-effort accelerators with 2D fallbacks — renderFrameWithGPU returns null on failure, Preview.tsx:471). It DOES need: (a) a unified source of overlay clips (mirror array suffices if kept current), (b) media blob access (IndexedDB today), (c) OffscreenCanvas-2D + font/text layout code now entangled with React component internals (~1000 lines inside Preview.tsx, e.g. renderTextClipToCanvas usage sites 2595-3229). Feasible but requires extracting the compositor out of Preview.tsx. Confidence MED-HIGH.

### 8. Persistence (task item 7)

- Auto-save: AutoSaveManager, IndexedDB DB `openreel-autosave` v1 (auto-save.ts:56-57); config interval 30s, maxSlots 3, debounce 2s (63-69). Store wiring in `initializeAutoSave` (project-store.ts:2918-2945): subscribes to `state.project` with subscribeWithSelector selector → `markDirty(getFullProject())` (engine merge at snapshot time). Started from EditorInterface.tsx:83 (web) and useDesktopEditorBootstrap.ts:78 (desktop).
- Explicit save = forceSave → same slot mechanism (project-store.ts:3016-3029). There is no "Save As"/file format in the store here beyond FileSystemFileHandle storage helpers (media-storage.ts:44-55) and project-manager's `openreel-projects` DB for recents/templates (services/project-manager.ts:49, 226-232).
- Desktop lifecycle guard answers unsaved-changes queries with `hasUnsavedChanges(getFullProject())` and flushes via forceSave (DesktopApp.tsx:79-92).
- Media blobs persisted separately in IndexedDB `openreel-db` via StorageEngine (packages/core/src/storage/storage-engine.ts:4,26; apps/web/src/services/media-storage.ts:1-42); restore path pairs them back in recoverFromAutoSave (2954-2973).
- No cloud/server persistence for projects anywhere in apps/web (only desktop GPU-broker uploads for EXPORT artifacts, export-job-runner.ts:145-176). Confidence HIGH.

## STATE-AUTHORITY

| Slice | Owner (authority) | Readers | Writers | Notes |
|---|---|---|---|---|
| Project core (timeline tracks/clips, transitions, markers, mediaLibrary metadata, settings, masks, motionCompositions) | `useProjectStore.project` (single object) | all UI, host.getProject, exporters, VideoEngine.renderFrame | ActionExecutor handlers via store.executeAction; many store convenience methods | Mutated in place + ref-bumped; mirrors of overlay arrays attached below |
| Text clips (runtime) | `coreTitleEngine` module singleton (engine-store.ts:186, 197) | Preview (1190-1196), autosave/getFullProject merge (3021-3027) | TitleEngine via text-graphics-slice store methods | Mirror `project.textClips` written simultaneously by recordOverlayCreate/Update/Remove (store-helpers.ts:97+) |
| Shape/SVG/Sticker clips (runtime) | `coreGraphicsEngine` module singleton (engine-store.ts:199) | Preview (1197-1204), save merge | GraphicsEngine via slice methods | Mirror fields shapeClips/svgClips/stickerClips likewise |
| Undo stacks | ActionHistory (in ActionExecutor, replaced per project-open) + store `clipUndoStack`/`templateUndoStack` | history-slice undo/redo, chat checkpoint | every mutation path (push direct or via executor) | Agent txn = one groupId; user edits during turn join it (RISK) |
| Timeline selection | `useUIStore.selectedItems` (ui-store.ts:68) | inspector/timeline/toolbar | ui-store setters; neither host nor core actions touch it | Agent tools manipulate clips by id, not via selection |
| Playback (playhead, isPlaying) | `useTimelineStore.playheadPosition` (timeline-store.ts:80) + engine PlaybackController/master clock | Preview rAF loop, mcp-listener focus | playback controls; NOT core actions | Separate non-undoable axis |
| Render caches | RenderBridge.frameCache/LRU (render-bridge.ts:81-90), Preview imageBitmap/videoCache refs, engine-store.currentFrame | renderers only | renderers; cleared on dispose/cache-clear (887-893) | No cross-invalidation contract with store; rebuilt per draw |
| Media blobs | IndexedDB `openreel-db` (StorageEngine) via MediaBridge | decoders, previews | importMedia/importMediaFromUrl | In-memory Blobs referenced by mediaLibrary items |
| Motion compositions + queue | `project.motionCompositions` + `useMotionStore` (queue/playhead/selection) | motion shell, host bridges | motion tools/actions; queue via useMotionStore actions (live-host.ts:372-434) | followMcpMotionResult syncs UI focus |
| Settings incl. MCP/auto-confirm | `useSettingsStore` (persisted localStorage/bridge) | mcp-listener gate, chat loop | settings UI | `mcpAutoAllowTrustedLocal` default TRUE (settings-store.ts:129) |

Verdict: single source of truth EXCEPT overlay clips, where runtime authority is split between two engine singletons and store mirror arrays kept in lockstep only when mutations flow through store convenience methods. Confidence HIGH.

## GAPS

1. No executable spec (probe/test) exercises LiveEditorHost.applyAction → Preview invalidation end-to-end; parity between `applyAction`-only tools and engine-aware overlay* tools is only enforced by documentation comments in host.ts:262-280.
2. Core `text/create` action handler path vs TitleEngine registration divergence has no structural guard — future raw-action tools will silently no-op visually again (registry handlers/* contain creation.ts but no title-engine binding in live renderer).
3. `checkForRecovery(projectId?)` in initializeAutoSave vs host.listProjects() rely on undocumented slot-id naming (`${projectId}-slot-${n}`); no versioned key contract file.
4. No test covers interleaving of user UI edits during an open agent transaction group.

## RISKS

- LIVE-01 (HIGH): Overlay dual-write drift. Code writing Title/Graphics engines directly without the recordOverlay mirror leaves `project.*Clips` stale until next engine-mirroring write; conversely `applyAction("text/create")` updates the mirror only and never reaches the runtime engine the preview reads (host.ts:262-270 comment; text-graphics-slice.ts:205-224). Evidence: live-host createTextOverlay deliberately bypasses applyAction (live-host.ts:514-522). Impact: silent visual divergence for any tool not using the overlay* methods.
- LIVE-02 (MEDIUM): Agent-turn history group capture is proximity-based, not scope-based. Any user edit pushed while `currentGroupId` is set (agent turn open, awaiting LLM confirm) joins the agent's group and gets rolled back with it — or survives a rollback meant to be scoped. Evidence: action-history.ts:225-230 (any push adopts currentGroupId); runExclusive excludes UI writers (host-singleton.ts:14-27); beginGroup has no nesting counter (action-history.ts:231-234).
- LIVE-03 (MEDIUM): In-place project mutation before ref bump (executeAction, project-store.ts:2904-2907) means stale-reference consumers (captured `project`) observe mutated data mid-flight, and auto-save hash compares post-mutation objects; combined with JSON deep snapshot per action (action-executor.ts:84) large projects pay heavy GC/latency cost per agent tool call.
- LIVE-04 (LOW-MED): listProjects/openProject conflate save-slot id with project id (live-host.ts:217-233; auto-save.ts:180). Opening by stale slot id works, but identity/recent-list semantics differ from projectManager.addToRecent recents (two competing project registries).
- LIVE-05 (LOW): replaceWhole-history reset on openProject (fresh ActionHistory, project-store.ts:2993-3002) discards undo ability across project switches without notice; combined with the singleton host, an external MCP client sees seamless success while local undo context vanished.
- LIVE-06 (LOW): Destructive/expensive MCP tools gated behind default-on trusted-local auto-allow (settings-store.ts:129 + mcp-listener.ts:185-196): a fresh desktop install allows destructive tool execution without confirmation.
- LIVE-07 (MED): Headless-preview extraction cost: the authoritative 2D compositor for overlay pixels lives inside an 8.4k-line React component (Preview.tsx:2595-3229) reading engine singletons; no package boundary isolates it for Node reuse (canvas-renderers.ts is the reusable seed).

## FACADE-NOTES

For a headless/desktop-consistent facade over LiveEditorHost:
1. Keep `EditingHost` as THE seam (already designed so, host.ts:196-204). For extraction, make the facade wrap the SAME primitive trio: getProject / applyAction-with-txn / capability manifest; treat overlay* methods as adapters that emit both engine-registering calls AND mirrored history entries — replicate exactly their semantics when implementing HeadlessHost equivalents, otherwise same tool produces different undo behavior per host.
2. Selection, playhead, queue status and render-cache state must stay OUT of the facade (non-undoable axes owned by separate stores); expose them as read-only telemetry if needed.
3. The invalidation contract to preserve is "successful mutation ⇒ project.modifiedAt bumped"; any extracted headless renderer should trigger a frame recompute on modifiedAt deltas to match live behavior (Preview.tsx:6166-6225).
4. Snapshot feasibility target: extract compositor inputs as {project(with mirrored overlay arrays), mediaBlobs, playhead time} → pure 2D rasterization path already exists twice (Preview renderFrameDirectly and VideoEngine.renderFrame); consolidating on the latter (which needs no React, video-engine.ts:634+) is the cheapest route to a true headless preview snapshot.
