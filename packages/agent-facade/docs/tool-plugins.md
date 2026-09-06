# Bundled Agent tool plugins

New read-only Agent tools can be added without editing transport routers,
allowlists, facade interfaces, capability maps, or session dispatch tables.
The first production plugin is `src/plugins/source-inspection.ts`.

## Authoring

1. Add a module under `src/plugins/`. Export a `definePlugin` containing one
   or more `defineTool` definitions. Each definition owns its canonical dotted
   name, description, closed input declaration, output schema, schema test
   cases, prerequisites, optional presentation, and typed `execute` function.
2. Import the plugin into `src/plugins/index.ts` and add it to
   `BUNDLED_PLUGINS`. This is the startup composition list.
3. Add behavioral tests beside the implementation. Build and restart the
   desktop application (or restart the stdio server).

The registry derives MCP names, input/output schema maps, schema corpus,
read-only classification, capability status and typed facade bindings.
Both Live and Headless execute the same plugin function. Names that collide
after dot-to-underscore conversion and duplicate plugin ids fail at startup.
Descriptions for older built-in tools are centralized in `tool-catalog.ts`,
including the existing live-mode differences; their handlers remain intact.

`ToolContext` provides a detached canonical snapshot, validated source path
resolution, the existing render provider, and configured artifact/media roots.
It does not expose mutable GUI state. `requires` describes runtime prerequisites;
execution must still validate the selected media and provider readiness.

For `presentation: "image-collection"`, return `frames[].artifact` and an
optional `contactSheet`. The transports embed PNGs through the existing bounded,
root-contained image reader. Live mode also shows those verified images in a
dismissible GUI panel. Optional `mediaName`, `startSec`, `endSec`, and
`limitations` fields supply the panel caption and review limitations. Presentation
does not alter the timeline, playhead, revision, or undo history.

## First tool: `media_inspect`

```json
{
  "mediaId": "an-imported-video-id",
  "startSec": 3,
  "endSec": 9,
  "sampleCount": 6,
  "width": 640
}
```

Times refer to the original media, including media not placed on any timeline.
Ranges must fit the source duration. Up to 12 samples are returned, each with
its source timestamp and hashed artifact reference. Each call has a unique
artifact directory, so concurrent or repeated requests cannot overwrite earlier
evidence. `expectedRevision` optionally rejects a stale project snapshot.

Rendering uses a detached single-source composition; it is never loaded into
or applied to the user's project. A missing contact-sheet provider falls back
to individual frames. Audio files are rejected explicitly. Sparse frames are
not a motion review, audio review, transcript, or semantic scene analysis.

## Current boundary

This release supports trusted, repository-bundled, read-only tools loaded at
startup. It does not load arbitrary npm packages or user scripts, implement a
plugin marketplace, hot-reload plugins, or sandbox their JavaScript. Project
mutations continue through the existing `edit.apply` transaction and its
authorization, revision and undo rules. Lifecycle hooks and independently
installable packages can be added when a concrete plugin needs them.

The acceptance test in `plugin-tools.test.ts` composes a second example plugin
with the bundled plugin without adding routes or tool-name entries.
