# Web bundle boundaries

The web build keeps route and component lazy imports as the primary loading
boundaries. Manual chunks group stable third-party packages; they do not replace
lazy imports or combine application modules into a single startup chunk.

`apps/web/vite.config.ts` defines the current vendor groups. When changing
them, inspect the production build output and check that optional editor
features remain lazy. Put optional UI behind a dynamic import rather than using
manual chunking to defer it.
