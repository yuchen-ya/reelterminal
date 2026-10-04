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
are rejected. Input length, AST depth and node count are bounded.

Run `pnpm audit:dependencies` for the dependency security gate. The installed
`braces@3.0.3` has a committed pnpm patch rejecting brace/parenthesis nesting
above 128 levels before recursive AST walking. The gate first tests the actual
installed patch. The workspace excludes only GHSA-vfj7-8cjw-p6xm from the
version-based advisory scan because the vulnerable code is locally patched.
The registry currently has no fixed braces release. Replace the patch and exception when a
fixed upstream version becomes available. All other advisories fail the gate.
