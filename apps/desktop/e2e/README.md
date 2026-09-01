# Electron live-collaboration E2E (ADR 0004, Slice 3)

Automated end-to-end tests for "Live Human–Agent Collaboration" on the real
built desktop app. Binding contract: `docs/adr/0004-live-collaboration-slice-3.md`.

**Channels, per the product red lines:**

- **Human side** — real UI input only: Playwright mouse/keyboard on the
  Electron window (`_electron.launch` from playwright-core). No store calls,
  no window internals to fake a user action. (DOM/`facade.call` reads are
  used for observation and aiming only.)
- **External agent** — a real MCP stdio client: `@modelcontextprotocol/sdk`
  `Client` + `StdioClientTransport` → `openreel-mcp` shim → token-authed
  loopback live endpoint → main-process live facade session.
- **Embedded agent** — `window.openreel.facade.call` from the renderer
  (exactly what the chat UI uses), covered in the cross-cutting spec.

## Run

```bash
pnpm --filter @openreel/desktop build      # renderer (vite) + main (tsup, incl. mcp-shim)
pnpm --filter @openreel/desktop test:e2e   # this suite (vitest, serial, long timeouts)
```

Prerequisites on the host: the Playwright-managed Chromium
(`pnpm --filter @openreel/runtime-chromium exec playwright-core install chromium`)
and ffmpeg/ffprobe on PATH (pixel assertions decode the rendered PNG with
ffmpeg — no image libraries).

Specs are `e2e/*.e2e.ts` under a separate config (`e2e/vitest.config.ts`);
the default `pnpm --filter @openreel/desktop test:run` never picks them up.

Each spec launches its own app instance with a per-run temp dir:
`--user-data-dir` isolates the Chromium profile (IndexedDB autosave) and the
live-artifacts root; `OPENREEL_LIVE_ENDPOINT_FILE` /
`OPENREEL_MCP_ENDPOINT_FILE` redirect both endpoint descriptor files so a
test run never touches the developer's real `~/.openreel` files.

## Coverage

- `flow-a-text-rewrite.e2e.ts` — select text via real UI; external agent
  reads the selection (`editor.get_context`), rewrites it with a context-CAS
  `edit.apply`; GUI updates without reload; the human undoes/redoes the
  agent batch with REAL Cmd+Z / Cmd+Shift+Z (one batch = one undo unit);
  handoff legibility after a real human drag.
- `flow-b-canvas-caption.e2e.ts` — real ruler/crosshair gestures land the
  playhead and the canvas target point; agent places the caption with
  `expectedContextRevision`; GUI + rendered pixels agree (centroid of
  non-background pixels inside a tolerance box); stale-context replay →
  CONFLICT, no duplicate.
- `cross-cutting.e2e.ts` — shared revision + CAS against a real human drag;
  disable → MCP fails cleanly → re-enable/reconnect; `project.save` → full
  relaunch → autosave recovery; embedded↔external writer lease (CONFLICT
  with `leaseHolder: "external"`, ADR-faithful lifecycle); token security
  boundary (no renderer accessor, 0600 endpoint file, renderer fetch denied,
  401 enforcement, token never in any captured output).
- `tools-list.e2e.ts` — `tools/list` is EXACTLY the 15 facade tools (no
  `execute_action`); unknown tool → protocol error.

## Evidence

Every run writes machine-readable evidence to `e2e/.artifacts/` (gitignored,
uploaded in CI with `if-no-files-found: error`): one JSON document per spec
(requests, revisions, conflict codes, pixel stats, security probes) plus PNG
screenshots and the rendered frame under test.

## Known product gaps found by this suite (see the delivery report)

- **G-01 (RESOLVED)** — desktop undo/redo existed only as a native NSMenu
  accelerator, unreachable to DOM-level input. Fixed by a DOM-level
  Cmd+Z / Cmd+Shift+Z / Ctrl+Z / Ctrl+Y handler in `DesktopApp.tsx` (same
  store methods as the menu path; text-entry guard mirrors
  `services/keyboard-shortcuts.ts`). Flow-A's real-keyboard undo/redo leg
  now runs and passes.
- **G-02 (medium, ADR 0004 errata — lease TTL/heartbeat)** — the writer
  lease is session-bound: an external client disconnect does NOT release it
  (only disable/setMode dispose sessions). Current behavior is pinned by
  test with a TODO to flip when a disconnect-release lands.
- **G-03 (low)** — `disable()` blocks for seconds while the endpoint's
  `server.close()` drains the shim's HTTP keep-alive socket.
- **G-04 (high, ADR 0004 errata — status-event sequencing)** — collab
  status pushes race: stale `enabled:true` status events can arrive after a
  disable ack and leave the UI claiming the session is on. Recorded as
  evidence (inherently racy); the deterministic contract is asserted.
