# Agent instructions for ReelTerminal

## Generated video work never belongs in the source tree

For demos, evaluations, user videos, and other media-creation tasks, first call
the live `capabilities_get` tool. Use
`mediaImport.recommendedRoot/jobs/<YYYY-MM-DD>-<short-slug>/` and follow
[`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md).

User-facing video creation defaults to the live desktop workflow. If
`~/.reelterminal/live-endpoint.json` is absent (the legacy
`~/.openreel/live-endpoint.json` location is still discovered when the
canonical file is not there), launch/prepare the ReelTerminal GUI
and enable Agent Session; do not silently switch to headless. Headless is only
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

When only changing ReelTerminal's source code, this workspace rule does not
move normal fixtures or tests out of their package-specific locations.

## Use one source checkout

The sole development checkout is the repository workspace that contains this
AGENTS.md file. Work in this checkout, including delegated source-code tasks.
Do not create another checkout or Git worktree unless the user explicitly
requests one. Generated media still belongs in the external Agent workspace
described above (see [`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md)).
