# Legacy job usage organization audit — 2026-10-25

## Result

An indexed view of the old jobs now exists at `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index`. It references the original files at their existing paths; no legacy media was moved, copied, renamed, deleted, or written. The earlier 81-entry owner index remains untouched at `2026-10-25-legacy-artifact-index`.

The index covers 118 legacy job directories: 132,586 filesystem entries, comprising 132,569 regular files and 17 symbolic-link/Junction references. The indexed path-byte sum is 68,013,995,528 bytes (about 63.3 GiB); the 17 links count as zero bytes and their targets were not traversed.

| Usage | Entries | Regular files | Link references | Bytes |
| --- | ---: | ---: | ---: | ---: |
| source | 3,335 | 3,335 | 0 | 4,811,081,325 |
| work | 127,217 | 127,200 | 17 | 61,168,853,531 |
| project | 2,006 | 2,006 | 0 | 1,517,753,938 |
| output | 18 | 18 | 0 | 515,001,013 |
| unknown usage | 10 | 10 | 0 | 1,305,721 |

The counts measure logical paths. They do not assert physical disk de-duplication for any hard links.

## Classification rules

Usage and owner identity are recorded separately. The project/workspace IDs present on non-nested records are **job-context candidate associations repeated across that job's files**, supported by the paths in `ownership.ownerEvidencePaths`. They are not direct per-file ownership evidence, do not prove each file is referenced by or belongs to that project/workspace, and were not verified against a live project. A job with multiple candidate IDs for one field keeps that field null. Materials under a nested `jobs/` path do not inherit the parent job's IDs and remain owner-unbound. No owner is inferred from a job-directory name, and no user/product/agent origin is guessed. AI generation is expressed in `purpose`; it is not a fifth usage kind. Usage classification does not mean a business owner has confirmed the record, and it never means the record may be deleted.

`source` means an input, original, or adopted asset supported by job-specific documentation or an explicit later-manifest reference. `work` covers generated attempts, frame sequences, masks/cutouts, previews, superseded versions, scripts, caches, and execution/review evidence. `project` covers project state, manifests, specs, edit plans, and task metadata. `output` is limited to exact files that a brief, manifest, or completion record identifies as a task result. Other files under an `output/` or `delivery/` folder remain work unless their exact deliverable role is evidenced. A filename containing `final`, a large size, or a media extension is not sufficient evidence.

Each record includes a confidence value, purpose, evidence paths, original path, size, UTC modification time, and owner fields. `bindingBasis` is `job-context-evidence-not-live-verified` only when a unique project/workspace ID candidate came from the listed job-local evidence paths; otherwise it is `unknown`. `ownerEvidencePaths` names only brief/manifest/status documents that actually supplied ID values. Work records distinguish `reconstructable`, `non-reconstructable`, `unknown`, and `not-applicable`. Here, non-reconstructable means the exact historical evidence/state cannot be recreated from retained inputs; it does not say the underlying task could never be repeated. Across work entries the recorded values are: 225 reconstructable, 7,710 non-reconstructable, 60,095 unknown, and 59,187 not-applicable. The R18 render set in `2026-10-22-selene-two-attacks` is marked reconstructable because its record names the retained recipe, script, and input assets.

## Largest jobs reviewed

| Job | Total bytes | source | work | project | output | Evidence and treatment |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `2026-10-09-node-ux-fixes` | 17,679,728,565 | 0 | 17,679,728,440 | 125 | 0 | The brief covers isolated-profile development regression work. Its 11.34 GB evidence tree and 2.08 GB Windows test builds are work, not video deliverables. |
| `2026-10-16-requiem-realistic-dance` | 8,854,703,905 | 53,616,341 | 8,771,076,999 | 1,542,017 | 28,468,548 | The brief explicitly identifies the verified full-dance export; generation attempts, QA frames, and intermediate versions remain work. |
| `2026-10-06-promo-video` | 8,072,463,684 | 488,758,344 | 6,262,755,317 | 1,224,921,098 | 96,028,925 | The current V8 handoff identifies `output/promo-v8-definitive.mp4`. V3–V7 and review variants are historical work, even where an older brief revision called them current. |
| `2026-10-12-final-narration` | 2,447,437,611 | 306,476 | 2,423,426,585 | 40,506 | 23,664,044 | The final voice track is an output committed to the existing timeline. Per-phrase generation attempts and model caches are work. The brief excludes full-video export, not the requested final narration asset. |
| `2026-10-22-selene-two-attacks` | 2,350,893,476 | 7,641,993 | 2,343,222,474 | 29,009 | 0 | The job has no brief; its spec, production notes, delivery notes, and review record agree that R18 failed art review. The 2.31 GB R1–R17 output tree and R18 render/reproduction materials are work. Review MP4s and APNG previews are not promoted to outputs. |
| `2026-10-05-legacy-migration` | 2,160,044,118 | 862,831,414 | 1,297,208,211 | 4,493 | 0 | The brief and migration report distinguish retained source records from migration/test-profile work. No database was modified. |

Other large jobs, including `2026-10-03-deepseek-frame-study` (1.86 GB) and `2026-10-22-selene-attack-animation` (1.68 GB), are also fully indexed. The latter has three pending output candidates explicitly identified by its completion record; its review video remains work. The output set contains 18 exact records: 10 marked delivered based on a verified final asset record, and 8 pending review/copy/visual acceptance. A pending candidate is not presented as accepted or deployed.

| Job / output path | Delivery status | Evidence and purpose |
| --- | --- | --- |
| `2026-09-18-pelican-bonsai/output/bonsai2-showcase.mp4` | delivered | `project/manifest.json` names the final file and passing verification. |
| `2026-10-05-readme-showcase/output/desktop-screenshot.jpg` | pending | `brief.md` and `project/manifest.json` name the README screenshot; the requested `docs/assets` copy is absent in this checkout. |
| `2026-10-06-promo-video/output/promo-v8-definitive.mp4` | delivered | `brief.md` and `project/director-handoff-v8.md` identify the verified current V8 export. |
| `2026-10-09-user-workflow-a/output/一路相伴-时光相册-20s.mp4` | delivered | `brief.md` and `project/manifest.json` identify the verified A acceptance export. |
| `2026-10-09-user-workflow-b/output/B-流动时光-v2.mp4` | delivered | `brief.md` and `project/manifest.json` identify the verified B acceptance export. |
| `2026-10-12-final-narration/output/final-voiceover.wav` | delivered | `brief.md` and `project/manifest.json` identify the final voice asset committed to the timeline; full-video export was out of scope. |
| `2026-10-12-viewer-continuity/output/ReelTerminal-full-revised.mp4` | delivered | `brief.md` and `project/manifest.json` identify the verified revision-189 export. |
| `2026-10-14-audio-subtitle-align/output/宣传片-音频字幕对齐.mp4` | delivered | `brief.md` and `project/manifest.json` identify the verified aligned-video export. |
| `2026-10-14-audio-subtitle-align/output/宣传片-对齐字幕.srt` | delivered | `project/manifest.json` names the subtitle sidecar for the aligned export. |
| `2026-10-15-live-edit/output/ReelTerminal-polished-r343.mp4` | delivered | `brief.md` and `project/manifest.json` identify the revision-343 export with verification passing. |
| `2026-10-16-requiem-realistic-dance/output/安魂曲_写实舞蹈完整版_模型超分.mp4` | delivered | `brief.md` explicitly names the verified full-dance deliverable. |
| `2026-10-22-selene-attack-animation/output/attack/attack-action-107f-24fps-transparent.webm` | pending | `project/delivery.json` and `project/final-summary.json` identify an exported art candidate pending final visual acceptance and game deployment. |
| `2026-10-22-selene-attack-animation/output/skill/skill-action-107f-24fps-transparent.webm` | pending | `project/delivery.json` and `project/final-summary.json` identify an exported art candidate pending final visual acceptance and game deployment. |
| `2026-10-22-selene-attack-animation/output/Selene_两种攻击候选_107帧_透明素材.zip` | pending | `project/delivery.json` and `project/final-summary.json` identify the packaged exported art candidates; acceptance and deployment remain pending. |
| `2026-10-23-selene-anime-to-pixel/output/17_像素化工作流默认输出_25帧透明.webm` | pending | `project/delivery.json` and `evidence/final-checks.json` identify a tested transparent workflow candidate awaiting aesthetic review. |
| `2026-10-23-selene-cloud-attacks/output/attack_25帧透明.webm` | pending | `project/delivery.json` identifies a cloud-refined candidate that is not approved for production animation. |
| `2026-10-23-selene-cloud-attacks/output/skill_25帧透明.webm` | pending | `project/delivery.json` identifies a cloud-refined candidate that is not approved for production animation. |
| `2026-10-23-selene-cloud-attacks/output/云端两种攻击_关键帧与透明序列.zip` | pending | `project/delivery.json` identifies packaged cloud-refined candidates that are not approved for production animation. |

## Remaining unknown usage

Only ten entries remain usage-unknown. They are listed with exact paths and sizes in `unknown/index.jsonl`:

- `2026-09-17-gui-explore/source/`: five synthetic audio/video fixtures, 1,002,039 bytes. No brief, manifest, or helper relationship establishes their exact role.
- `2026-09-20-n07-gui-freeze/source/green_subject_4s.mp4` (8,028 bytes) and `source/red_5s.mp4` (9,507 bytes), plus `output/n07-export.mp4` (145,476 bytes) and `output/n07-gui-export.mp4` (134,910 bytes). Their names suggest a test, but no surviving task record establishes whether either export was a final result.
- `html-render/38c0795a61e8c99285ab2f2fc64355b17fd5a427665fd3fabd1f3402add027af/html-38c0795a61e8c99285ab2f2fc64355b17fd5a427665fd3fabd1f3402add027af-400x200.png` (5,761 bytes). No job-specific context establishes its role.

This is unknown **usage**, not unknown owner identity. Many classified records separately have unknown project/workspace bindings.

## Ownership coverage and protected boundaries

Among the 132,586 indexed entries, 109,398 carry a project-ID candidate, 64,447 carry a workspace-ID candidate, and 64,447 carry both. These counts measure records where a job-context ID is repeated; they are **not counts of individually verified project/file bindings**. The IDs are supported only by job-local brief/manifest paths listed in each record's `ownership.ownerEvidencePaths`, and are not live-verified. In particular, the large development/test job may contain artifacts from multiple isolated profiles, so its task-level candidate must not be read as proof that every file belongs to one project. Two jobs have ambiguous workspace IDs covering 298 entries; the workspace field remains null for those contexts. The index has no `nodeId` candidates, and origin remains unknown for every entry. A further 118 entries are nested job materials whose project/workspace IDs are left null instead of inheriting the parent job context. These identity gaps do not change a supported usage classification.

The earlier 81-entry index is excluded. The independent review tree, `app-data`, saved `.oreel` projects, shared workspace assets, and root `app-data/live-artifacts` are outside the inventory. Job evidence may contain text paths to live-artifacts, but the index never resolves those paths. Directory/file reparse points are recorded as zero-byte path references and are not traversed; this avoids following shared `node_modules` Junctions or model-cache symlinks into another job.

Read-only client checks previously observed a running desktop process with no video project open. The active project was not opened or retargeted. `project.get_state` exceeded the client response limit for a large project, and `media.list` was unavailable in that session; therefore full live-project reference reopening was not claimed. No endpoint credential was printed or written, and no live database or project state was changed.

## Validation

The Apply scan recorded and rechecked size and modification time for all 132,586 indexed filesystem entries. No entry changed, no scan issue was reported, and all 18 reviewed output paths were present. JSONL line counts match the summary exactly: source 3,335; work 127,217; project 2,006; output 18; unknown 10.

After the index was created, two independent read-back passes successfully decoded or parsed seven representative paths: a source MP4, generated work MP4, raw PNG attempt frame, project spec JSON, verified final MP4, final narration WAV, and transparent WebM candidate. These two passes verify current reachability after indexing; they are not described as pre-Apply decodes. The previous 81-entry audit separately recorded five representative media decodes before and after that earlier index.

The rollback script owns the eight standard index files plus two diagnostic staging JSONLs from an interrupted duplicate owner-metadata repair, all listed explicitly in the index summary. The retained staging directory `.owner-evidence-repair-866c1671-1c28-4650-b1ee-6a1233650d15` contains only partial `source/index.jsonl` and `work/index.jsonl` copies and is explained in the index brief. The rollback dry-run verified the index directory boundary and listed exactly these 10 files; it did not execute deletion. No legacy job file was changed. Classification does not grant deletion permission.

## Index and rerun paths

- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\source\index.jsonl`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\work\index.jsonl`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\project\index.jsonl`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\output\index.jsonl`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\unknown\index.jsonl`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\project\usage-index-summary.json`
- `E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index\work\rollback-usage-index.ps1`
- `E:\1my_projects\reelterminal\scripts\migrations\legacy-job-usage-index.ps1` (defaults to DryRun; apply requires `-Mode Apply`)
