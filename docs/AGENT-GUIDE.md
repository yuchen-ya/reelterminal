# ReelTerminal external Agent guide

ReelTerminal does not bundle a conversational Agent or generative model and does
not manage conversations. Use the Agent you already trust for its chat,
model, credentials, permissions, and history;
connect that Agent to the open ReelTerminal desktop project through MCP.

## Connect to the open desktop project

1. Build the desktop main process:

   ```sh
   corepack pnpm --filter @openreel/desktop build:main
   ```

2. Open a project and enable **Agent Session** in the collaboration bar.
3. Configure your Agent's MCP client to launch:

   ```text
   node /absolute/path/to/apps/desktop/dist/live-mcp/index.js
   ```

The connector reads `~/.openreel/live-endpoint.json`, forwards stdio MCP to
the authenticated loopback endpoint, and exposes exactly the 25 live tools
listed in the root [`SKILL.md`](../SKILL.md). Do not copy the endpoint token
into prompts, project files, or logs.

Never print or `cat` the descriptor while diagnosing a connection. Read it only
inside the connector/client process and pass the token directly to the loopback
Authorization header. A descriptor left by an unclean exit may be stale, so
probe liveness without echoing credentials and let a newly prepared desktop
session replace it. Bypass system HTTP proxies for `127.0.0.1` and `localhost`.

No endpoint file means the GUI session is not ready; it does not select the
headless workflow. For normal user-facing creation, an Agent with local-app
control should launch ReelTerminal and complete the project/Agent Session steps
through the GUI. Otherwise it should ask the user to do so. Headless is used
only when the user explicitly asks for it or GUI-visible collaboration is not
part of the task.

When a project is already open, its format and current edits are user-provided
context. Continue in that project unless the user explicitly asks to replace it
or change format; do not hunt for a different project merely because another
aspect ratio seems more conventional.

The Agent and GUI edit the same canonical project with revision checks and one
undo history. Use `editor_get_context` before an edit; it includes current
work mode and semantics, selection, playhead, context revision, and stable
numbered Agent references (`@A1`, `@A2`, …) and persisted review markers
(`R1`, `R2`, …). If a referenced item has been deleted, it
remains visibly stale and its number is never rebound.

## Work mode is an elastic collaboration preference

The compact GUI selector offers **Guided**, **Collaborative** (default), and
**Autonomous**. The mode changes how proactively the Agent proposes and acts,
and how densely it aligns with the user. It does not change tool permissions,
the writer lease, destructive-action approval, or the explicit delivery
boundary. `session_describe` and `editor_get_context` expose the current value
and its semantics; the optional conversation attachment receives the same
context without creating a second conversation.

- Guided proposes defaults before asking a few consequential questions,
  explains important tradeoffs, previews before expensive production, and asks
  the user to review the full first cut.
- Collaborative acts on low-risk reversible work and aligns on uncertain,
  costly, or broad changes. A complete user plan is followed directly.
- Autonomous makes most production decisions while surfacing assumptions and
  watchable results, preserving recovery points, and respecting capability,
  risk, and delivery boundaries.

Professional production remains a flexible reasoning loop, not a GUI wizard:
understand the goal and material before costly work, establish source options
before generating missing media, prefer a low-cost watchable previsualization,
develop sound with picture, preserve recovery points before broad changes, and
review the complete cut with sound. Steps may be skipped, reordered, or revisited.

## Task-dependent inspection and review

Choose inspection depth by task, not by whether export was requested:

- Mechanical adjustment: read bounded context, apply one atomic batch when dependencies allow, and inspect the changed area.
- Semantic selection: overview each source, record candidate ranges, evidence and uncertainty, then inspect candidates densely with `media_inspect` `timesSec` and paired `roi` crops. Static frames can miss brief events and cannot establish continuous action or audio. No game HUD rule or kill detector is built in.
- Rhythm/structure recut: repeat candidate inspection and source audio analysis as needed. Use `media_analyze_start` with `analysisTypes:["audioSummary"]`, explicit source `startSec/endSec` (at most 120 seconds), and poll/cancel through jobs. Local FFmpeg must pass capabilities preflight. Inspect meaningful visual events and their lead-in/result, not only cut boundaries; clips may span different numbers of beats.
- Export delivery: only on request, save/export/poll/verify the artifact. Technical export verification does not replace content review.

Before constructing a highlight timeline, make a feasibility ledger: candidate source ranges, evidence, confidence/uncertainty, useful action duration, and whether the requested duration would require low-value filler. Raw source duration is not usable-content duration. A short first selection is not the maximum possible cut. Investigate uncertain candidates; when content conflicts with target duration, propose concrete alternatives (shorter strong cut, wider definition of highlights, or additional source). Do not silently pad with irrelevant action or ask the user to pre-judge feasibility.

Use meaningful source events as alignment anchors. Preserve enough cause and result to establish what happened. Map source times through trim/speed, check project frame rate and visible clip range, and separately report event localization uncertainty, audio detection uncertainty and nearest-frame rounding. Periodic transients are not proven beats/downbeats. Analysis never edits markers or audio; selected anchors become markers only via canonical `edit_apply`. `clip.add` cannot accept explicit `clipId` live: use returned ids in a dependent transaction. `edit_validate` accepts ops/revision/context preconditions, not `idempotencyKey`; `edit_apply` accepts a fresh key. Multiple dependent transactions and review rounds are appropriate for selection and recutting.

Report review evidence separately: **frames inspected**, **playback executed**, **supported audiovisual review completed**, **export technically verified**. Current MCP transports embed PNG/text and have no audio/video consumption contract. GUI play, a playable file, waveform measurements or mathematical alignment do not establish that the Agent watched/heard a sequence. Perform all inspection the host supports; disclose remaining perceptual limits without treating the user as the default outsourced reviewer. GUI synchronization is collaboration, not a quality certificate.

Import first uses `media_import_preflight`: cheap root/stat/size checking, with codec support explicitly unchecked. Capabilities reports the live 256MiB whole-file GUI buffer limit. Preserve originals and source offsets for explicit segments; no automatic proxy/relink pipeline exists. See [material analysis workflow](MATERIAL-ANALYSIS.md) for parameters, limits and a concrete anchor example.

## Keep every creation task in one workspace

Start by calling `capabilities_get`. Create one task directory under
`mediaImport.recommendedRoot/jobs`, following the fixed structure documented in
[`AGENT-WORKSPACE.md`](AGENT-WORKSPACE.md). Do not put generated assets,
recording frames, helper scripts, or finished videos in the repository root.
The desktop app creates the recommended `ReelTerminal Agent Workspace`
automatically; the older `ReelTerminal Agent Imports` path remains readable for
compatibility only.

## Attach a Codex conversation

The repository ships a reference adapter for the signed-in local Codex CLI. It
uses Codex App Server for the Agent-owned thread and the live MCP connector for
editor operations; ReelTerminal remains a view and never owns the model,
credentials, or history.

After building the desktop main process, opening a project, and enabling
**Agent Session**, start either a new Codex thread:

```sh
node scripts/conversation-adapter/codex-adapter.mjs \
  --new-thread \
  --cwd /absolute/path/to/agent-video-engine-lab
```

or resume one with `--thread-id <codex-thread-id>`. Then open the external
Agent panel and choose **Connect external Agent**. Stop the adapter with
Ctrl+C; it removes only its private conversation descriptor.

The adapter preapproves the dedicated `openreel_live` MCP server because the
user already enabled Agent Session in the ReelTerminal GUI. The live facade
continues to enforce access level, work-mode context, the one-writer lease,
revision checks, and shared undo. Codex command and file-change requests remain
explicit approval events in the conversation panel. See the
[`scripts/conversation-adapter` guide](../scripts/conversation-adapter/README.md)
for setup and acceptance tests.

At each user turn, ReelTerminal gives Codex a visual-state keyframe or compact
changed-region atlas plus exact revision/selection/playhead fields. Treat that packet as the
normal starting context: for a routine edit, go directly to one atomic
`edit_apply` call when it contains everything required. Use
`editor_get_context`, `timeline_get`, or `project_get_state` only to recover an
exact field that is absent or stale. The image never relaxes revision checks.

For deterministic headless workflows without a GUI, the optional
`agent-video serve/run` facade transport remains documented in
[`SKILL.md`](../SKILL.md). It exposes editor tools; it does not choose a model,
store provider keys, or run an LLM inference loop.
