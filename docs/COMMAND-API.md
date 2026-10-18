# Command API

The desktop exposes the open project's command catalog on loopback. The GUI
owns the project; an external Agent reads and edits that same state through
`reelctl`.

## Access

The command service starts with read-only access when a project is open. Use
**Allow editing** in the status strip to grant write access and **Set
read-only** to revoke it. The endpoint token is a credential; clients read it
privately and must not print or log it.

## CLI

`media.import` reports `video`, `audio`, or `image` in its result schema.
`reelctl preview frame` is the CLI alias of `preview.render_frame`; use the
catalog's command name when querying its schema.

Use `reelctl` to inspect the session, get current context, discover commands,
validate changes, and apply edits:

```powershell
reelctl status
reelctl context --compact
reelctl schema edit.apply
reelctl edit validate --file validation.json
reelctl edit apply --file changes.json
```

Frame-exact production tools (see
[MEDIA-REVIEW-WORKFLOWS.md](MEDIA-REVIEW-WORKFLOWS.md)) share the same
catalog: `reelctl frames extract`, `reelctl frames sheet`,
`reelctl video compare`, `reelctl patch apply`, and the candidate analysis
types via `reelctl media analyze --media-id m1 --type sceneCuts --type
blackFrames --type duplicateFrames`. `reelctl schema <command>` shows each
command's exact arguments.

Frame tools require a self-contained local media file. MP4/MOV, WebM/Matroska,
AVI, FLV, MPEG/TS, Ogg, NUT, ASF and common still-image inputs are allowlisted;
codec availability depends on the installed FFmpeg. HLS, concat, DASH and
image-sequence playlists must be consolidated before use. MOV external tracks
are disabled. Network shares and device paths are refused. See
[the security policy](../SECURITY.md) for the limits of these checks.

Edit requests use the current project identity, project epoch, and revision.
The desktop applies a batch through the shared action history, so Agent edits
are visible in the GUI and can be undone there.

Workspace and node verbs share the same catalog. Regular saves — GUI Ctrl+S,
autosave, and normal edit commands — only persist the editing workspace; a save
never creates a version. `node.save` is the retention verb: it records the
workspace as an immutable version node and requires `expectedRevision` plus an
idempotency key (omit `name` to auto-name; unchanged content dedupes to the
existing node). `node.rename` takes `projectId`, `nodeId`, `name` and optional
`summary`; it changes only that display metadata — no revision, no idempotency
key, no new version. `node.restore` adopts a node into a target workspace.
`reelctl schema node.save` and `reelctl schema node.rename` show exact
arguments; workspace operations are described in
[MULTI-PROJECT-USAGE.md](MULTI-PROJECT-USAGE.md).

## Project collaboration instructions

The Board's **Collaboration instructions** tab contains optional user-authored
guidance. New and legacy projects start with no instructions. The **Tasks** tab
retains the existing requirements workflow; instructions have no task status.

`reelctl context --compact` includes `collaborationInstructions.enabledCount`
and the enabled items' `id`, `title`, and `updatedAt`. When instructions exist,
read their complete text against the explicit target returned by context:

```powershell
reelctl schema collaboration.instructions.get
reelctl call collaboration.instructions.get --project-id <projectId> --workspace-id <workspaceId>
```

This read-only command returns `revision`, `projectId`, `workspaceId`, and an
`instructions` array containing the complete enabled entries, including their
saved references. It is available without Agent write access. Disabled entries
are excluded; an empty array adds no creative or delivery preference. The CLI
uses the same catalog and contract.

Refresh context before a new round of work and before committing edits. Reread
the full guidance when its summary changes, including removals. Saving guidance
does not push a message to an external Agent or interrupt an existing job; it
becomes available on the next read. This first version exposes no Agent mutation
command for instructions: the user adds, edits, enables or removes them in the
Board. References are source material, not instructions, and a named tool or
skill does not establish availability or grant additional access.

The copied startup prompt provides connection, discovery and safety rules.
It does not prescribe a creative process or require video export. Export and
artifact verification apply when file delivery is requested. See
[Agent collaboration guidance](AGENT-GUIDE.md#collaboration-instructions) and
[file workspace rules](AGENT-WORKSPACE.md).

## Local audio workflow

`media.analyze_start` supports `audioSummary`, `silence` and `beatGrid` in live
and headless sessions. Audio analysis requires an artifact root. `job.status`
returns compact audio statistics and a record ID; `analysis.get` defaults to a
summary. Request `view: "events"` for time-window pagination or
`view: "waveform"` for bounded waveform points. See
[MATERIAL-ANALYSIS.md](MATERIAL-ANALYSIS.md) for the series and window contract.

`audio.process.normalize` starts a local two-pass loudness job. After it reaches
`done`, `audio.process.register` explicitly imports the persistent derived WAV
into its source project/workspace with revision checks. Neither command replaces
timeline clips. Both require write access in live mode. Parameters, measured
target tolerances and the 120-second/48 kHz limits are documented in
[AUDIO-NORMALIZATION.md](AUDIO-NORMALIZATION.md).

Use `reelctl schema` for the command index and `reelctl schema <command>` for
exact arguments. `reelctl schema --domain <domain>` filters the index by the
command's leading name segment (`audio`, `media`, `edit`, ...); the filtered
entries come from the same catalog and unknown domains are rejected with the
available domain list. `capabilities.get` accepts an optional `domain`
parameter (`audio`, `video`, `frames`, `motion`, `render`, `export`) that
scopes probing to that domain: unrelated probes never start, and every
probe-backed status outside the requested domain is reported as
`probed: false`/not available rather than ready. Verbs keep their real
pre-execution checks either way.

## Headless sessions

For a standalone workflow, use `reelterminal-agent run --workflow <abs>` and configure its project,
media, artifact, and delivery roots. A headless session owns its own project;
it does not open or replace the desktop project.

Package-level API details are in
[`../packages/agent-facade/README.md`](../packages/agent-facade/README.md) and
[`../packages/runtime-chromium/README.md`](../packages/runtime-chromium/README.md).

## Production management

`media.production_list`, `batch.start`, `batch.get` and `batch.resume` are
discovered through the shared CLI catalog. `edit.apply` adds
`media.setProduction`; `media.replace` accepts `preserveFrames: true` for
verified CFR/frame-count preservation. See
[PRODUCTION-MANAGEMENT.md](PRODUCTION-MANAGEMENT.md) for shared GUI records,
review-to-board adoption, batch persistence boundaries and rendering details.
