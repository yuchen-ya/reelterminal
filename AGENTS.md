# Agent instructions for ReelTerminal

## Distinguish software development from video production

Determine the workflow from the user's requested deliverable. Code inspection,
bug fixes, UI changes, regression tests, builds, and packaging are software
development tasks, even when they involve playback, export, or video fixtures.

For software development:

- Follow the repository's normal development scripts and package-specific
  build/test configuration. Source, tests, fixtures, and development helpers
  belong in their normal repository locations; temporary validation files may
  use the test harness's temporary directories.
- Desktop packages, installers, and unpacked application binaries belong in
  `apps/desktop/release/`, the configured electron-builder output directory.
  Do not redirect them to `mediaImport.recommendedRoot` or a video Agent's
  `jobs/` directory unless the user explicitly requests that destination.
- Reading code, editing source, running unit tests, building, and packaging do
  not require probing the live desktop, enabling Agent Access, or launching
  the user's project. GUI regression tests may use an isolated desktop/profile
  through the existing test harness.
- `docs/AGENT-WORKSPACE.md` and the video-creation workflows in
  `docs/AGENT-GUIDE.md` describe Agents using the product to make videos. Do
  not apply those workflow or output-location rules to normal development.
  When a test actually uses a live Agent API, its credential and media-import
  access contracts still apply to that API call; they do not change the build
  or packaging destination.

The external video workspace rules below apply to media-production tasks,
not to software development. Credential handling and preservation of the
user's open project apply whenever those resources are accessed.

## Video-production tasks: generated media stays outside the source tree

For user-requested video demos, video evaluations, user videos, and other
media-production deliverables, first call
`reelctl call capabilities.get` against the live desktop. Use
`mediaImport.recommendedRoot/jobs/<YYYY-MM-DD>-<short-slug>/` and follow
[`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md).

User-facing video creation defaults to the live desktop workflow. If
`~/.reelterminal/live-endpoint.json` is absent (the legacy
`~/.openreel/live-endpoint.json` location is still discovered when the
canonical file is not there), launch/prepare the ReelTerminal GUI
and enable Agent Access; do not silently switch to headless. Headless is only
for an explicit headless request or a task that does not require GUI-visible
collaboration.

If a live project is already open, keep its format and existing state unless the
user explicitly requests a new project or different settings. The open project
is user context, not an Agent default to replace.

The live endpoint descriptor is a credential, not diagnostic output. Never
`cat`, print, log, paste, or return `~/.reelterminal/live-endpoint.json` (or a
discovered legacy `~/.openreel/live-endpoint.json`) or its token.
Read it only inside the connector/client process and send the token directly in
the loopback Authorization header. File existence alone does not prove the
endpoint is live; probe it without echoing credentials. An unreachable file is
stale state, so launch/prepare the GUI and let the desktop host replace it.

Do not create task folders, generated media, recording frames, helper scripts,
or deliverable videos at repository root or inside source directories. Git
should contain product source and documentation, not an Agent's job contents.

## Use one source checkout

The sole development checkout is the repository workspace that contains this
AGENTS.md file. Work in this checkout, including delegated source-code tasks.
Do not create another checkout or Git worktree unless the user explicitly
requests one. Video-production deliverables still belong in the external
Agent workspace described above (see
[`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md)); software-development
outputs follow the development rules above.
