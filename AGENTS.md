# Agent instructions for ReelTerminal

These rules govern Agents working in this source checkout, including source-based
adaptation work. They do not require users of the packaged app to maintain a
source checkout or follow repository development output conventions.

## Distinguish software development from video production

Choose the workflow from the requested deliverable. Code inspection, bug fixes,
UI changes, regression tests, builds and packaging are software development,
even when they involve playback, export or synthetic video fixtures.

For software development:

- Follow normal repository scripts and package-specific build/test configuration.
  Keep source, tests, fixtures and development helpers in their normal locations;
  disposable validation files may use the test harness's temporary directories.
- Desktop packages, installers and unpacked application binaries belong in
  `apps/desktop/release/`, the configured electron-builder output directory.
  Do not redirect them to a media-production workspace unless explicitly requested.
- Reading/editing source, unit tests, builds and packaging do not require probing
  the live desktop, enabling Agent write access or opening the user's project.
  GUI regressions use isolated projects/profiles through the existing harness;
  see [`apps/desktop/e2e/README.md`](apps/desktop/e2e/README.md).
- The video workspace rules below and video-creation workflows in
  [`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md) apply to media production, not normal
  development. Tests that actually call a live API still obey its credential,
  target-identity and media-import contracts; these do not change build outputs.

## Project history boundaries

Whole-project replacement must call `ProjectState.loadProject`
(`apps/web/src/stores/project/lifecycle-slice.ts`) after confirmation. Successful
replacement starts fresh action/recipe undo and redo plus an empty redo journal;
cancellation preserves content and history. Fresh entity IDs are not a substitute:
built-in templates share track IDs and recipe snapshots include overlay state.
Persisted edits publish through `createProjectStore`'s default `set`/`setState`
boundary or a recorded commit with its explicit branch envelope. Reserve `rawSet`
for replay, lifecycle/recovery, compensation and transient Motion previews.
Order action/recipe commits with `ActionHistory.nextSequence`, not timestamps;
use `breakGroup` at external-edit boundaries while preserving owner-scoped gesture
handles and ordinary adjacent-update grouping. 3D setters retain their existing
non-undoable contract; injected engine-restoration faults remain a separate issue.

Use [`docs/archive/history-boundary-fix-2026-10-15.md`](docs/archive/history-boundary-fix-2026-10-15.md)
for commands, evidence limits and the exact regression index: template component,
store boundary/order, recipe and Motion preview tests; core `action-history.test.ts`;
and isolated desktop `template-history.e2e.ts` / `whole-template-history.e2e.ts`.
In GUI regressions, send history shortcuts to a focusable timeline control when
leaving text forms; mouse clicks alone do not guarantee input blur on every platform.

## Live desktop access and user context

Use live desktop collaboration by default for user-facing video creation. Do not
silently substitute headless execution because a connection is unavailable;
headless is for an explicit request or work that does not require GUI-visible
collaboration. First establish that the task needs live access and that the
current user authorization covers the intended reads, edits and access changes.
An absent endpoint does not authorize enabling Agent write access. If that access
is needed and has not been authorized, ask the user to enable it; do not request
it again when current authorization already covers it.

Use the running installation's copied startup prompt and
[`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md) /
[`docs/COMMAND-API.md`](docs/COMMAND-API.md) for connection and CLI details.
An open GUI project normally exposes the service read-only; editable access is a
separate control. Use `reelctl status` and `reelctl context --compact` through the
client, not raw descriptor output. Before creating production files, read
`reelctl call capabilities.get` for the active media roots.

A missing descriptor or one failed probe is not proof that an app instance is
stale. Distinguish startup in progress, connection refusal, temporary blocking,
timeout, authentication failure and a changed session/target. Check existing
instance state without disturbing the user's project, allow bounded read-only
retries where appropriate, and re-read connection information through the client
when needed. Authentication or permission errors are not reasons to retry edits
blindly. Do not delete descriptors, restart or repeatedly launch user instances
because of a single failed connection. Prepare or launch a GUI only when diagnosis
and the current task authorization justify it, preserving any existing instance.

The endpoint descriptor is a credential. Never print, log, paste or return
`~/.reelterminal/live-endpoint.json`, a discovered legacy
`~/.openreel/live-endpoint.json`, or its token. The client discovers the legacy
location when the canonical file is absent. Read credentials only inside the
connector/client and send the token directly in the loopback Authorization header.
File existence alone does not establish liveness or authorized edit access.

With multiple projects/workspaces, resolve the requested target explicitly.
Read context identity and the current command catalog/schema. Bind related reads
and edits to the same explicit `projectId` and `workspaceId` where supported;
verify job ownership against that target for follow-up. Do not add unsupported
arguments. Use the revision, epoch and workspace-instance guards that the command
supports.
A GUI selection/switch must not silently retarget the task. On a conflict or
changed identity, re-resolve the intended target; ask when it remains ambiguous.
Keep an open project's format, content, media and existing state unless the user
explicitly requests a new project, replacement or different settings.

## Video-production files stay outside the source tree

Use the live capability result's
`mediaImport.recommendedRoot/jobs/<YYYY-MM-DD>-<short-slug>/` for production media,
frames, helper scripts, evidence and deliverables. Do not create these at repository
root or inside source directories. Follow
[`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md) for job layout, import roots,
headless mapping and delivery verification. Never commit job contents or overwrite
the user's source media or another job. Software-development outputs follow the
separate rules above.

## One checkout and coordinated source edits

The sole development checkout is the workspace containing this file, including
for delegated source work. Do not create another checkout or Git worktree without
an explicit user request. Before editing, inspect Git status/diffs and relevant
active work. Preserve other people's uncommitted changes and evidence; do not
reset, overwrite or discard them to simplify the task. If edits overlap, coordinate
before changing the same files. Keep writes to the same module serial and do not
start concurrent write sessions against it.

## CLI capability extension contract

The existing command catalog and parameter/edit-operation schemas are the single
source of truth for CLI contracts. Define each capability with a stable ID,
purpose, supported targets, activation rule (including user-explicit activation
where needed), command and required operation membership, and a short workflow.
Reuse command schemas, effects, permissions, dependencies and retry contracts;
do not copy schemas or maintain another independent command inventory.

Generate tools, describe/help/alias discovery and command UI information from
these shared definitions. Adding a capability should normally change its
definition, executor and behavior tests, without changing the startup prompt or
adding business-specific branches to the generic CLI. Keep algorithm backends
inside their capability rather than presenting them as top-level capabilities.
Use a static capability registry unless current requirements demand more; do
not introduce a plugin marketplace, hot-loading system or SDK speculatively.

Catalog queries must remain cheap: do not initialize models or GPUs or probe the
whole environment to describe registered tools. Probe the required dependency
when execution needs it, and distinguish unprobed from unavailable. Discovery
and activation rules do not grant permission to read or edit user content.

Check meaningful contracts: aliases are unique; members, handlers and schemas
exist; scopes and authority match; generated contracts are callable; retired
commands are not advertised as available; selective queries omit unrelated
schemas. Test observable discovery and execution behavior rather than copying
the implementation into assertions. Preserve the private free-board boundary:
capability registration does not create an Agent content access path.
