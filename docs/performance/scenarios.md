# Performance regression fixtures

The desktop E2E harness builds deterministic P2 fixtures through
`apps/desktop/e2e/performance/fixtures.ts`. Each manifest records the scenario
and version, seed, normalized parameters, expected semantics, asset identities
and SHA-256 values, required capabilities, operation count, and time budget.
Fixture manifests contain no wall-clock generation timestamp; the same
scenario, seed, and parameters therefore produce the same manifest. Record
fixture generation time separately from the measured interaction window.

Call `createPerformanceFixture` before app launch, then pass its assets and
`materializePerformanceFixtureAssets` a new directory under the system temp
directory. The helper refuses paths outside that directory. Never put generated
assets in the repository or in a user's media workspace. The returned
`project` uses the production core `Project` shape. The accompanying `records`
contains `projects`, `workspaces`, `nodes`, and `nodeSummaries` rows matching
WorkspaceManager's IndexedDB v3 key paths, so E2E can seed the isolated profile
through IndexedDB before measuring app startup. The first image and text clips
in T01/T02 start at zero and remain visible for at least five seconds. Each
fixture exposes stable target IDs and a center-pixel RGB marker; H01/H02 use a
target node frame with a different marker from the workspace's current frame.
Image contents are deterministic 320×180 PNG color cards. Each card uses a
small geometric palette and a stable center marker. Image asset content is
base64 encoded with `encoding: "base64"`; its byte length and SHA-256 describe
the decoded PNG bytes. The seed rows leave `MediaItem.blob` null; the renderer
seeder should match each media ID to its fixture asset and attach
`new Blob([Buffer.from(asset.content, asset.encoding)], { type: asset.mediaType
})` before writing the rows, so normal hydration sees usable raster bytes.
Font structure assets use UTF-8 content and retain `encoding: "utf8"`. There
are no copied user projects, IDs, fonts, subtitles, or media.

## Scenarios

| ID | Fixture | Expected operations | Budget | Required capabilities |
| --- | --- | ---: | ---: | --- |
| T01 | 50 clips: 25 synthetic PNG image clips and 25 text clips on two tracks | 100 | 60 s | Workspace DB v3, synthetic image media, timeline text clips |
| T02 | 35–50 clips split as evenly as possible between image and text, plus a 32 or 64 MiB font-structure data URL | 2 separate gesture runs | 120 s | Workspace DB v3, synthetic image media, timeline text clips, font structure storage |
| H01 | Fixed small node snapshots in a four-way tree of 10, 100, or 1,000 nodes | 2 | 30 s | Workspace DB v3, node tree snapshot, stable node target, synthetic PNG media |
| H02 | One node referencing a 32 or 64 MiB font-structure payload | 2 | 60 s | Workspace DB v3, node tree snapshot, font structure storage, synthetic PNG media |
| P01 | Two image clips and one text clip: target at 0 s for 1 s, control at 6 s for 1 s; move, trim, move, flush save, isolated relaunch readback | 5 | 30 s | Workspace DB v3, synthetic image media, save flush, isolated relaunch |

T01's 100-operation budget is intended for the dedicated distribution run. A
PR smoke run can select a smaller number in its runner and must report the
actual count; it must not present a 25-operation run as a 100-sample P99.
T02's image and text gestures are independent runs so their measurements remain
separable. Its default is 40 clips, with validated values from 35 to 50.
For both T scenarios, the first image/text target starts at 0 and lasts 5
seconds; all later clips start at or after 6 seconds. The text target is placed
away from the center pixel probe.

H01 uses stable IDs derived from the seed. Its target ID stays fixed as the
node count changes, so the measured open can address the target directly
without first walking the entire tree. Each node carries only a small fixed
scalar snapshot; the tree shape and links account for the scale increase. Its
target node and current workspace have different synthetic PNG frames, and the
manifest carries the expected RGB value and center probe coordinate to catch a
stale canvas.

P01's `gesturePlan` gives the three ordered edits and the final durable
`startTime` and `duration`. The target and control images carry distinct center
markers. After the final move, seek to the control clip at 6.25 s and verify its
marker, then seek back to the target at 4.25 s and verify the target marker.
Both checks use known clip content and make no assumption about how a blank gap
is cleared. A passing runner must flush the save after pointer-up, relaunch
against the same isolated profile, and compare the stored clip with that final
state.

P01 sets the actual timeline zoom range slider to 85% during warmup, targeting
about 100 px/s regardless of the initial fit-to-window scale. It then derives
gesture pixel deltas from the resulting timeline geometry.

## Font structure payload limits

T02 and H02 place a deterministic opaque URL string in the test-only
`performanceFixture.syntheticFontStructure.dataUrlStructure` project extension
to exercise project clone, serialization, and storage cost. This field is
outside the production `Project` schema and bypasses `renderFonts` and
`FontFace`, so node preview remains usable. The raw field is preserved in the
active project during the hot gesture. Because this extension is outside the
production document schema, T02 does not assume save/reload retention; its
runner must verify the payload after hydration and skip with an explicit reason
if the bytes are absent before measurement. P01 covers the real durable save
contract. The structure URL prefix is `data:font/woff2;base64,`, but the
payload is deterministic filler and does **not** encode WOFF2 bytes; the
decoded data has no WOFF2 signature.

The manifest declares
`fontPayloadLocation: "performanceFixture.syntheticFontStructure.dataUrlStructure"`
and `fontDecodeSupported: false`. These fixtures do not claim to measure
`renderFonts` validation, `FontFace` install, or real font preview. Keep browser
font decode benchmarks on a separately licensed, SHA-verified real-font
fixture; if that asset is unavailable, report the decode leg as unsupported.

The selected 32 or 64 MiB size is the exact UTF-8 size of the complete data URL,
including its prefix. The manifest records that byte count and the asset hash.
The result should report this structural payload separately from decoded font
bytes; decoded font bytes are unsupported and therefore unavailable for these
scenarios. Do not silently shrink the payload if a run cannot accept it.

## Use and verification

The fixture module is data generation only. It does not launch Electron, open a
project, perform input, measure interaction time, or access the user's media.
The E2E caller must create the isolated run directory, build and materialize
the fixture before launching its window, and keep that setup time outside the
interaction measurement.

Run the fixture contract tests with:

```powershell
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/harness/performance/fixtures.test.ts
```
