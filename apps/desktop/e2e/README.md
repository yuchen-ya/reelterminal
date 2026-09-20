# Electron live-collaboration E2E (ADR 0004, Slice 3)

Automated end-to-end tests for "Live Human–Agent Collaboration" on the real
built desktop app. Binding contract: `docs/adr/0004-live-collaboration-slice-3.md`.

**Channels, per the product red lines:**

- **Human side** — real UI input only: Playwright mouse/keyboard on the
  Electron window (`_electron.launch` from playwright-core). No store calls,
  no window internals to fake a user action.
- **External agent** — a real MCP JSON-RPC client posts directly to the
  token-authenticated loopback live endpoint → main-process live facade
  session.
- **In-app conversation** — when available, it is only a view into the same
  external agent session; there is no embedded inference channel.

## Run

```bash
pnpm --filter @reelterminal/desktop build      # renderer (vite) + main (tsup)
pnpm --filter @reelterminal/desktop test:e2e   # this suite (vitest, serial, long timeouts)
```

Prerequisites on the host: the Playwright-managed Chromium
(`pnpm --filter @reelterminal/runtime-chromium exec playwright-core install chromium`)
and ffmpeg/ffprobe on PATH (pixel assertions decode the rendered PNG with
ffmpeg — no image libraries).

Specs are `e2e/*.e2e.ts` under a separate config (`e2e/vitest.config.ts`);
the default `pnpm --filter @reelterminal/desktop test:run` never picks them up.

Each spec launches its own app instance with a per-run temp dir:
`--user-data-dir` isolates the Chromium profile (IndexedDB autosave) and the
live-artifacts root; `REELTERMINAL_LIVE_ENDPOINT_FILE` redirects the endpoint
descriptor so a test run never touches the developer's real `~/.reelterminal`
(or legacy `~/.openreel`) file.
`REELTERMINAL_CONVERSATION_ENDPOINT_FILE` likewise isolates the external
conversation descriptor.

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
  relaunch → autosave recovery; token
  security boundary (no renderer accessor, 0600 endpoint file, renderer fetch
  denied, 401 enforcement, token never in any captured output).
- `tools-list.e2e.ts` — `tools/list` is EXACTLY the 24 facade tools (no
  `execute_action`); unknown tool → protocol error.
- `external-conversation.e2e.ts` — reference adapter → built Electron app;
  prompt forwarding, chronological safe work log, approval round-trip, and
  raw tool-payload exclusion.
- `codex-conversation.e2e.ts` — opt-in, real Codex App Server → shipped
  adapter → live MCP → built Electron app; autonomous text-overlay edit,
  exact one-revision commit, and real GUI undo/redo.
- `work-modes.e2e.ts` — default Collaborative and Chinese Guided /
  Collaborative / Autonomous UI; switching while disabled; live MCP and
  conversation-context synchronization; floating-window/draft continuity;
  and full-relaunch persistence.

## Evidence

Every run writes machine-readable evidence to `e2e/.artifacts/` (gitignored,
uploaded in CI with `if-no-files-found: error`): one JSON document per spec
(requests, revisions, conflict codes, pixel stats, security probes) plus PNG
screenshots and the rendered frame under test.

The real Codex spec is skipped by default because it uses the host's signed-in
Codex account and a live model turn. Run it explicitly after the desktop build:

```sh
REELTERMINAL_REAL_CODEX_E2E=1 \
  pnpm --filter @reelterminal/desktop exec vitest run \
  --config e2e/vitest.config.ts e2e/codex-conversation.e2e.ts
```

## Known product gaps found by this suite (see the delivery report)

- **G-01 (RESOLVED)** — desktop undo/redo existed only as a native NSMenu
  accelerator, unreachable to DOM-level input. Fixed by a DOM-level
  Cmd+Z / Cmd+Shift+Z / Ctrl+Z / Ctrl+Y handler in `DesktopApp.tsx` (same
  store methods as the menu path; text-entry guard mirrors
  `services/keyboard-shortcuts.ts`). Flow-A's real-keyboard undo/redo leg
  now runs and passes.
- **G-03 (low)** — `disable()` blocks for seconds while the endpoint's
  `server.close()` drains any HTTP keep-alive socket.
- **G-04 (RESOLVED)** — main owns a monotonic status-snapshot sequence shared
  by pushes and control replies; the renderer rejects older snapshots. The
  cross-cutting flow now asserts UI and endpoint both report disabled.
