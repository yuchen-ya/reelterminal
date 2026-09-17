# ReelTerminal Agent workspace

Video tasks produce large, related files. ReelTerminal gives every task one
self-contained job directory outside the source repository so another Agent or
the user can understand, move, archive, or delete it as a unit.

## Find the root; do not guess it

In a live desktop session, call `capabilities_get` before creating files. Use:

```text
capabilities_get.mediaImport.recommendedRoot
```

The default desktop root is `ReelTerminal Agent Workspace` under the operating
system's Videos folder. The app creates its `jobs/` and `shared/` directories.
An environment override may change the path, so an Agent must use the reported
absolute path rather than hard-code `~/Movies`, `~/Videos`, or a repository
path. The reported `mediaRoots` remain the authoritative import allowlist.

## One task, one directory

Create a filesystem-safe job name:

```text
<recommendedRoot>/jobs/<YYYY-MM-DD>-<short-slug>/
```

If that name already exists and is not the task being resumed, append `-v2`,
`-v3`, and so on. Never merge unrelated attempts. Create this layout:

```text
brief.md                 interpreted request, constraints, target duration
source/                  user-provided originals; never overwrite
generated/               generated video, image, voice, music, subtitles
work/                    scripts, raw frames, proxies, caches, retry renders
project/                 checkpoints, workflows, manifests, edit metadata
output/                  final verified deliverables only
evidence/                preview frames, contact sheets, verification reports
```

Reusable, user-approved assets such as logos, fonts, and brand audio may go in
`<recommendedRoot>/shared/`. Record their absolute source paths in the job's
`brief.md`; do not silently mutate shared assets.

One exception is cast by the product itself: a voiceover/music task handed
over by the desktop GUI arrives as a prompt marked
`[ReelTerminal 任务 openreel-task:<requestId>]` and precasts the job
directory `jobs/<taskId>/output/` (a product-minted `amt_…` id, no date
slug). For such a job, use the precast directory exactly as given — no
date-slug rename, no brief.md, no standard subfolders — do not call
`media_import` (the product imports the artifact), and reply with the
one-line receipt the prompt specifies; see
[`AGENT-GUIDE.md`](AGENT-GUIDE.md) for the receipt contract. Everything
else on this page keeps applying to self-initiated jobs.

## Operating rules

1. Write `brief.md` before generation. A short user prompt is sufficient; the
   Agent records its concrete interpretation without asking for tool steps.
2. Generate or copy all importable media into `source/` or `generated/`, then
   pass absolute paths to `media_import` — except a product-cast
   `openreel-task:` hand-off, where the prompt forbids `media_import` and
   the product imports the artifact itself (see the exception above).
3. Keep helper code and disposable bulk data in `work/`, never at repository
   root or inside `apps/`, `packages/`, or `docs/`.
4. Use `preview_render_frame` and `visual_inspect`; place retained inspection
   evidence in `evidence/`.
5. Export through ReelTerminal, wait for completion, run `verify_artifact`, and
   only then copy or name the delivery in `output/`. Alternatively pass
   `export.start`'s `destinationPath` (`<recommendedRoot>/jobs/<slug>/output/<name>.mp4`)
   to deliver the verified artifact copy directly — it never overwrites, and
   `job_status` reports `deliveredTo`/`deliveryError`.
6. A successful task ends with a concise `project/manifest.json` listing the
   final file, duration, dimensions, verification result, and source paths.
7. Never commit job contents to Git. Never delete another job, `source/`,
   `shared/`, or delivered `output/` without an explicit user request.

Temporary system directories are acceptable only for disposable process state;
anything needed to reproduce, inspect, or deliver the edit belongs in the job.

## Headless mapping

For `agent-video serve` or `run`, map the three containment classes into the
same job:

```text
OPENREEL_AVE_MEDIA_ROOTS=<job>/source:<job>/generated
OPENREEL_AVE_ARTIFACT_ROOT=<job>/work/artifacts
OPENREEL_AVE_PROJECT_ROOTS=<job>/project
OPENREEL_AVE_DELIVERY_ROOTS=<recommendedRoot>   # optional: enables export.start destinationPath
```

Use the platform path delimiter (`:` on macOS/Linux, `;` on Windows). After a
successful verification, place the human-facing copy in `<job>/output/` and
record it in `project/manifest.json`.
