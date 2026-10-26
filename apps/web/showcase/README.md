# Official-site video editing demo

Build from `apps/web` with `pnpm exec vite build --config vite.showcase.config.ts`.
Check types with `pnpm exec tsc --noEmit --project tsconfig.showcase.json`.
Output is `dist-showcase/`; the sibling official-site project's
`scripts/build-demo.mjs` builds and copies it into `public/demo/`.

The entry in `src/showcase/` mounts the production `EditPage`, `Preview`,
`DesktopInspector`, `DesktopTitleBar`, project switcher, export settings,
settings and help. It uses the production project/workspace stores and version
archive interface. No parallel editor layout, preview player or reordered
inspector is maintained for the website.

Sample assets and edits are stored locally in the visitor's browser through the
existing IndexedDB media/workspace services. The initial project has one real
archive node; visitors can edit, undo, retain versions and preview them. The
project switcher's new-project action offers to restore the sample after
confirmation. The standard help tour remains available on demand, but does not
automatically interrupt the website demo.

The static entry omits DesktopApp bootstrap, native IPC, Agent connections,
review workspace, service worker, autosave bootstrap and model/export engine
initialization. Import, Agent connection and the export execution callback show
a desktop-only notice. The actual export settings UI is retained. Preview uses
the production browser-native media path; rendering runs on the visitor's device.
Leaving the visible website section or backgrounding the tab pauses playback.

`public/media/sample.mp4` is an eight-second recording of the official site's
actual `PretextBackground` formula stream and crystal animation, with silent AAC
audio. It is editable footage, not an Agent action replay. To regenerate it,
start the sibling site's dev server, open `/scripts/render-background.html`,
record eight seconds and download `reelterminal-background.webm`. The development
page imports the original React component and is excluded from the production
site build. Then convert the downloaded recording from `apps/web` (FFmpeg required):

```powershell
ffmpeg -i /path/to/reelterminal-background.webm -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 8 -vf "scale=1280:720,fps=24,tpad=stop_mode=clone:stop=1" -c:v libx264 -pix_fmt yuv420p -crf 26 -preset slow -c:a aac -b:a 32k -movflags +faststart -y showcase/public/media/sample.mp4
ffmpeg -i showcase/public/media/sample.mp4 -frames:v 1 -q:v 4 -y showcase/public/media/poster.jpg
foreach ($timestamp in @(0, 2, 4, 6)) {
  ffmpeg -ss $timestamp -i showcase/public/media/sample.mp4 -frames:v 1 -vf "scale=320:180" -q:v 4 -y "showcase/public/media/filmstrip-$timestamp.jpg"
}
```

Increment `SHOWCASE_PROJECT_ID` when replacing assets, preserving older local
sample projects and their edits instead of rewriting immutable media IDs.

The logo is copied from `docs/assets/logo.png`. No private source media is used.
Only static files are deployed; no ReelTerminal, Node, FFmpeg or model service
runs on the website server.
