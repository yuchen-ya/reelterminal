# E2E Contract — first minimal path

Target path (from the audit brief):

```
external Agent → MCP → facade → headless runtime → import input.mp4 → trim 0–5s
  → add "Hello world" → export output.mp4 → ffprobe + frame/OCR verification
```

Letters: **P** pure Node today · **A** needs an injected adapter · **C** needs
Chromium/headless browser · **D** Electron/Desktop only · **X** missing / semantically
inconsistent / unverified.

Evidence base: `audit/areas/media-render-e2e.md` E2E-CLASSIFICATION (primary),
`agent-runner-headless.md` (probe 12/12), `desktop-mcp.md` (transport), probe outputs in
`audit/probes/out/`.

## Step classification

| # | Step | Letter | Exists today | Blocker | Minimal unblock |
|---|------|--------|--------------|---------|-----------------|
| 1 | external Agent → MCP | **D** | MCP HTTP+token server in Electron main (`apps/desktop/src/main/mcp/http-server.ts:81-131`), stdio shim bin | requires open GUI window; no txn/idempotency | skip MCP for v0: drive `executeTool(name,args,host)` (`packages/agent/src/executor.ts:32`) behind a thin Node transport |
| 2 | facade → headless runtime | **P** | HeadlessHost + runTurn + registry all load and execute in pure Node (probe: 135-file closure, 2 stubs; 12/12 smoke PASS) | — | none |
| 2a | create_project | **P→A** | `project.create` via createEmptyProject (project-io.ts:34-48) works headless; registry `create_project` tool needs optional `host.createProject` (UNSUPPORTED headless) | host optional method | facade calls project-io directly, or HeadlessHost gains createProject (~20 LOC) |
| 3 | import input.mp4 | **A** | tool `import_media_from_url` (desktop-gated, MEDIA-03); core action `media/import` zeroes metadata; mediabunny metadata probe is pure TS | HeadlessHost has no fs/Blob ingest; thumbnails/MOV-check are DOM-only (skippable via quickMode) | `HeadlessHost.importMediaFromUrl(pathOrUrl)`: `fs.readFile` → `new File([bytes])` → mediabunny metadata extract; ~50 LOC; no Chromium |
| 3a | add_clip (mediaId→track) | **P** | `add_clip` → `clip/add` (action-executor.ts:657-697); 5s default duration if metadata missing | — | none |
| 4 | trim 0–5s | **P** | `trim_clip` → `clip/trim` (action-executor.ts:788-813); pure model math | known stale-base quirk when both in+out move in ONE action (MEDIA-04) — avoid by sending only outPoint for this slice | none |
| 5 | add "Hello world" | model **P** / pixels **X** | tool `create_text_clip`; raw lane writes `project.textClips` only (probe case 6); render/export read `titleEngine` singleton | headless write never reaches the render reader; text-only project fails export duration calc | (a) HeadlessHost.createTextOverlay registering into `titleEngine` (mirror live-host.ts:489-536), or (b) renderer fallback to `project.textClips` (~15 LOC, fixes all envs). Plus RUNNER-02: schema must expose/generate clip.id |
| 6 | export output.mp4 | **X** headless / **C** pragmatic | `export_video` jobTool → `runJob("exportVideo")`; headless fails w/o JobRunner (probe case 8); live runner = WebCodecs+mediabunny (browser); desktop = native ffmpeg sidecar; cloud = external GPU infra | every frame producer needs OffscreenCanvas/ImageBitmap/WebCodecs; no Node compositor exists | smallest honest slice: **C** — Chromium harness (Playwright) running the existing web job runner, intercepting the download instead of broker upload. Alternative A (shell-out ffmpeg) still needs C for frames. A net-new Node compositor is a project, not an adapter |
| 7 | ffprobe + frame/OCR verify | **X→A** | nothing (no ffprobe/OCR/frame-compare in repo; comment at ffmpeg-fallback.ts:443 admits it) | no binary, no orchestration | Node `child_process` spawn of system/bundled ffprobe (~30 LOC) for container/codec/duration contract; frame-extract via same binary → pixel-diff or OCR lib |

## Net assessment

- Steps 1–5 (model level): **P or one small adapter away** (import adapter ≈50 LOC,
  text engine-sync ≈15–50 LOC, createProject passthrough ≈20 LOC).
- Step 6 (pixels→mp4): **X today; C is the minimal honest route.** This is the single
  hard constraint of the first E2E slice.
- Step 7: greenfield but small once a binary source is decided.

## E2E contract (to be honored by the eventual implementation — not implemented here)

1. `facade.e2e_smoke` scenario = the 7 steps above executed against one runtime, with:
   - atomicity: the edit steps (import→trim→text) run as ONE undoable unit
     (beginTransaction/commit; rollback on any failure);
   - deterministic assertions: project JSON diff after each step, export artifact
     contract (`output.mp4`: container=mp4, video codec h264, duration 5s ±1 frame,
     resolution = project settings), OCR/pixel check for "Hello world" in a
     mid-clip frame;
   - environment labeling: every step reports which letter it ran as (P/A/C/D) so
     regressions in P-ness are caught mechanically.
2. The scenario MUST run with zero product-code changes beyond the adapters listed
   above; any additional product edit reclassifies the slice and must be re-audited.
