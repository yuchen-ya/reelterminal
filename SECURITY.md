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

The desktop `app://reelterminal/review-media/<uuid>` protocol resolves registered
resources by UUID for the trusted renderer; it does not enforce review-node
ownership. Agent media commands enforce that boundary before resolving bytes:
`review.media.inspect` and `review.frames.extract` use `ReviewService.freezeExport`
to check the explicit target, node revision and retained resource/version.
Private free-board resources become Agent-readable only through the user's
explicit export to a review node. Do not treat a resource UUID or this renderer
protocol as an independently authorized Agent content API.

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
installed patch. GHSA-vfj7-8cjw-p6xm is excluded from the version-based scan
because the vulnerable code is locally patched.

The installed Node entry point of `sprintf-js@1.1.3`, used through
`global-agent` → `roarr`, also has a committed pnpm patch. Numeric `e`/`f`
precision is bounded to 0–100 and `g` to 1–100 before calling Number formatting
methods; valid formats, including explicit zero precision, keep their behavior.
The gate tests the installed dependency through the actual ONNX dependency
chain, including an asynchronous child process with oversized precision values.
GHSA-hp3w-g68c-fv3c is excluded only with this tested mitigation. See the
[upstream disclosure](https://github.com/alexei/sprintf.js/issues/237) and
[pending upstream fix](https://github.com/alexei/sprintf.js/pull/239).

Neither package has a fixed registry release as of 2026-10-14. Replace each
patch and its exception when an appropriate fixed upstream version is available.
All other advisories fail the gate. These exceptions are not a claim that the
registry reports zero advisories.
