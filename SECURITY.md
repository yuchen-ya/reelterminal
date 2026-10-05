# Security

Please report vulnerabilities privately through the repository's
[security reporting page](https://github.com/yuchen-ya/reelterminal/security/advisories/new).
If private reporting is unavailable, open an issue requesting a private contact
without including exploit details, credentials, or user data.

Include the affected version, operating system, reproduction steps, and impact.
Use synthetic projects and media in reproductions.

Security fixes target the current release and the `main` branch. Update to the
latest release before checking whether a vulnerability still applies.

Agent Access credentials authorize operations on the local editor. Keep endpoint
descriptors and tokens private. Do not attach them to issues or logs.

Motion expressions use a restricted interpreter, not a JavaScript execution
context. Arithmetic, Math helpers, animation scope references, conditional
expressions and local const/let values with return are supported. Browser and
Node globals, constructors, prototype traversal, mutation, functions and loops
are rejected. Input length, AST depth and node count are bounded. Each motion property
evaluation also shares an 8,192-operation budget, a 256-cross-reference budget
and at most 256 memo entries across referenced layers and effect controls.
Exhaustion restores the property's keyframed base value and reports an expression
error. These bounds apply per property evaluation, not to total project size.

Frame tools accept self-contained local media through an FFmpeg demuxer allowlist
and the file protocol only. HLS, concat, DASH and image-sequence playlists are
not supported; consolidate them into a standalone media file first. MOV/MP4
inputs keep external track references explicitly disabled. Non-MOV and
image-only paths exclude the MOV demuxer. An unrecognized MOV opening atom is
rejected rather than decoded without those controls. FFmpeg and ffprobe are
user-provided executables and must themselves be trusted and kept updated.

Local media containment rejects UNC, network and device namespaces before
filesystem resolution. HTML rendering rejects remote file URL authorities and
out-of-root asset paths before resolving them, and checks real-path containment
afterward. URL attributes are checked case-insensitively. Roots and local
filesystem links must remain trusted; these checks do not isolate the application
from concurrent filesystem changes or every operating-system redirect.

Run `pnpm audit:dependencies` for the dependency security gate. The installed
`braces@3.0.3` has a committed pnpm patch rejecting brace/parenthesis nesting
above 128 levels before recursive AST walking. The gate first tests the actual
installed patch. The workspace excludes only GHSA-vfj7-8cjw-p6xm from the
version-based advisory scan because the vulnerable code is locally patched.
The registry currently has no fixed braces release. Replace the patch and exception when a
fixed upstream version becomes available. All other advisories fail the gate.
