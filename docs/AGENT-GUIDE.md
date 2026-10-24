# ReelTerminal external Agent guide

For local audio environment setup, use the prompt from Settings → Models &
environment. `reelctl environment get|set|check|test` works without an open project
or Agent write access. Preserve existing configuration, reuse installed models,
and verify actual transcription after dependency checks. See
[application audio configuration](COMMAND-API.md#application-audio-environment-offline).
Do not open or modify a production project just to test a model environment.

The first time you allow editing in each app launch, a notification appears at
the top right. Click it to copy a startup prompt for your external Agent. It
includes this installation's absolute CLI command, the Agent workspace, and
initial status/context/capabilities commands. It contains no endpoint token.

The prompt is generated when you click Copy, using the running installation's
paths. Windows commands use PowerShell; macOS/Linux commands use a POSIX shell.
For development builds, the command requires the documented Node.js version on
PATH. Packaged commands use Electron's included Node runtime.

The CLI path follows the installation, while the workspace normally follows
`<dataRoot>/agent-workspace`. Changing Settings → Storage requires restarting
the app before the new workspace becomes active. Copy a new prompt after that
restart; text already sent to an Agent does not update itself. An absolute
`REELTERMINAL_AGENT_WORKSPACE_ROOT` override takes precedence over the default
workspace, and `REELTERMINAL_DATA_ROOT` takes precedence over the Settings
pointer. `capabilities.get` remains authoritative for the active media roots.

Start ReelTerminal. The command service is available read-only even without a
video project. For independent data review, choose **Review Workspace** and copy
its connection instructions. Run `reelctl review context`, `reelctl review
capabilities` and `reelctl review describe`; bind all work to the returned review
workspace/runtime plus the explicit node ID. Review's own Agent-write checkbox
is separate from the video grant. See the [review command contract](COMMAND-API.md#independent-review-workspace).

For video edits, open a project and click the **Agent · Read-only** button in the status strip. It switches
to **Agent · Editable**; click again to revoke write access. Run:

```powershell
reelctl status
reelctl context --compact
reelctl requirements list --status ready --compact
reelctl schema edit.apply
reelctl help media inspect
```

Use [SKILL.md](../SKILL.md) for the editing workflow and
[AGENT-WORKSPACE.md](AGENT-WORKSPACE.md) before generating media.
See [COMMAND-API.md](COMMAND-API.md) for the live service and CLI contract,
including the legacy project workbench verbs (`workbench.ingest`, `workbench.get`
with optional `includeFeedback`/`includeMarkers`/`includeRevisions`,
`workbench.changes`, `workbench.handoff.get` by `snapshotId` or latest header)
and `edit.apply` ops (`workbench.decide`, `workbench.content.update` with a
required `expectedItemVersion`, `workbench.feedback.save`,
`workbench.handoff.ack`, `workbench.rework`) used to submit review batches and
consume published human handoffs. Rework is bound to the handoff's item
version and decision revision; stale, retrieved or superseded tasks are
rejected instead of overwriting human content.

Desktop review keeps original media references. If browser video decoding is
unavailable, the Chromium worker can decode source frames with local FFmpeg and
pass them through the existing compositor; if neither decoder succeeds, review
returns an error. A genuinely black source is valid. Installed font bytes used
by new desktop snapshots are captured through Local Font Access, so isolated
review can use the same family; unresolved fonts remain reported dependencies.

For a source build, run `pnpm --filter @reelterminal/desktop build:main` and use
`node /absolute/path/to/apps/desktop/dist/reelctl/index.js` in place of `reelctl`.
Windows packaged launchers live beside the application; use an absolute path if
their folder is not on PATH. macOS/Linux packaged prompts invoke the installed
Electron executable with `ELECTRON_RUN_AS_NODE=1` and the CLI entry in app.asar.
The desktop does not change Agent configuration.

## Audio analysis and processing

For local audio measurements, start with [material analysis](MATERIAL-ANALYSIS.md).
Read compact job/record summaries first, then request the needed event window;
waveforms are opt-in. Silence detection is not speech recognition, and inferred
beats are not detected downbeats.

For loudness processing, follow [audio normalization](AUDIO-NORMALIZATION.md):
start the job, inspect the remeasured result, then explicitly register the
derived asset in the original project/workspace. Registration does not replace
clips. Keep generated WAV/provenance files as persistent project media, separate
from disposable analysis caches. Check the running catalog/capabilities rather
than assuming a published package matches current source. Local VAD
(`speechActivity`), record-driven ducking, silence cutting and beat-snapped
splits are implemented; remaining model backends and analysis-driven work are
tracked in the completed [audio backlog](archive/AUDIO-BACKLOG-COMPLETE.md).

## Connection credentials

The endpoint descriptor is a credential. Never print it or copy its token to a
prompt. The client reads it privately and probes loopback liveness. A missing or
stale descriptor requires preparing the GUI, not switching to headless.

## Saves and versions

Normal saves (GUI Ctrl+S, autosave, and regular edit commands) only persist the
editing workspace; a version node is created only by an explicit retention
action. Use `node.save` (with `expectedRevision` and an idempotency key) when a
task asks for a stage version to be retained, and `node.rename` to set a node's
name and optional summary — metadata only, no new version. Previews and
comparisons of history are read-only; adopting an older version is
`node.restore` against the workspace's current revision. GUI project switches
never retarget tasks you already submitted.

## Product boundary

Agents own installation, login, conversations, history and context compression.
ReelTerminal provides project state, editor context, and guarded editing
commands. Voiceover and music generation are handled by the external Agent;
import generated files as ordinary media.

## Collaboration instructions

The existing Board opens a **Collaboration instructions** tab, initially empty.
The user can add a preset or write a title and detailed instruction, optionally
attach project references and source/timeline ranges, then explicitly save.
Presets never activate by themselves. Instructions persist with the project and
participate in undo/redo and saved versions; they are independent of task status.
The **Tasks** tab retains the existing task and review workflow. Asset-to-task and
review requests open that tab directly.

`context --compact` reports enabled instruction IDs, titles and updatedAt values.
Read the complete text with `reelctl call collaboration.instructions.get
--project-id … --workspace-id …`; the result includes the snapshot revision,
project/workspace identity and only enabled instructions. Refresh context before
new work and before edits, and reread when the summary changes. No instruction
means no additional creative preference. References do not confer instruction
authority. The read command does not execute a skill or grant access to tools.
Saving in the Board makes guidance available to the next Agent read; it does not
send a chat message, interrupt work or prove the Agent followed the instruction.

## Board and project assets

The **Board** stores tasks for external agents to pull; publishing a task does
not launch an agent. Use `reelctl requirements get Q1` to read the full task,
including its execution instruction, acceptance criteria, and `references`.
Each reference persists its entity kind and ID plus an A-label/name/time snapshot;
resolve by kind and ID, since A numbers belong to the original editor session.
`workAsset` references identify saved clips or combinations in `project.workAssets`.

The right inspector defaults to Properties. Bottom Archives and Board entries
open their panels on demand; closing returns to Properties. A save point maps
to `node`, and normal saves never call `node.save`. Direct human timeline
selection opens Properties; Agent selections and updates leave the panel alone.
During historical preview, Board still targets the actual editing workspace.

Report work with `requirement.update`, using `in_progress`, `blocked` (with an
explanation in `agentNote`), or `review` (with notes and `resultMediaIds`). Agent
updates using `done` also enter `review`; the user confirms completion in the
Board. Existing completed tasks remain completed.

**Project assets** combines source media with saved clips and combinations.
Import external files, or save a named timeline selection from the same panel.
Saved clips reference their source media and retain supported edit parameters;
removing a saved clip does not delete the source. The separate **Personal library**
continues to hold cross-project materials.

Historical GUI preview permits mixed clip selection and Ctrl+C/context Copy.
After returning, Ctrl+V pastes the group at the current playhead. Copy to current
edit returns to the source editing workspace and inserts at its saved playhead.
The operation preserves fixed media versions and font bytes, uses fresh clip IDs
and one undoable batch, and rejects missing dependencies or concurrent changes
without partial insertion. It never adopts the whole save point or calls node.save.
