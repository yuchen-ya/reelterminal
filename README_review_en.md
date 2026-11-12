<div align="center">

[← Video Editor Home](README_en.md) &nbsp;·&nbsp; **🧪 Review Workspace (English)** | [简体中文](README_review.md)

# ReelTerminal · Review Workspace & Free Boards
### Real folders, goal-driven human review and private boards

[Why Review Workspace](#why-review-workspace) · [Workspace Tabs](#workspace-tabs) · [Review Tasks](#review-tasks) · [Free Boards](#free-boards) · [Agent CLI](#agent-cli-and-repair-workflow) · [Documentation](#documentation)

</div>

> [!IMPORTANT]
> **Experimental Module**  
> Review Workspace runs independently without an open video project. Integration with video editing remains limited. This module is still evolving, and its UI and commands may change.

---

## Why Review Workspace

Generated assets often need several rounds of **curation, comparison and repair**:

* **Scattered multimodal batches:** a single generation run can produce dozens of candidate images, storyboards, Markdown corpora, tabular data, video takes, and 3D GLB models. Comparing versions across folders or chat logs quickly becomes unmanageable.
* **Localized defects need surgical repair:** when a generated image has a minor artifact or a video clip has a few bad frames, annotating the region, painting a repair layer, or capturing an exact frame is far faster than regenerating the entire batch.
* **Organize material on Free Boards:** arrange reference images, documents and video on one canvas, capture regions, and save independent files or region snapshots.

---

## Workspace Tabs

Real task folders and free boards share sortable tabs. Open an existing folder, or use New task to create one under the active data directory. Closing a tab does not delete its files; recent tasks can be reopened. Renaming, moving and copying directory entries operates on real files, so confirm the destination.

## Review Tasks

- **Image overview and explicit batch decisions:** image-first tasks support filtering, filename search, natural sorting, multiple selection and Shift ranges. Keep, rework or discard the explicit selection, or confirm keeping the remaining pending images. Each save supports up to 1,000 items and is never silently split. Batch undo and redo preserve newer decisions and criteria changes rather than overwriting them.
- **On-demand inspection and note reuse:** thumbnails load near the visible grid; open the inspector to zoom into original pixels. Reusing a recent note only fills a draft and still requires an explicit decision. These batch actions belong to current folder tasks and do not restore the retired standalone batch entry.
- **Separate file management and review:** inspect, organize, move and copy files in the directory. Enter the task workbench to review units against a goal; copying a file does not approve its content.
- **Human decisions:** inspect text, images, video frames or regions and record keep, discard, rework and notes. Decisions and drafts live in the task folder's .reelterminal directory. Discarding does not delete originals.
- **Goal and criteria:** set a task goal and inspect source relationships and current analysis. Model suggestions do not replace human judgment; adopting or deactivating scoped criteria requires an explicit action.
- **Optional built-in models:** configure your endpoint and key, then explicitly authorize the task/source scope before text is sent. Manual review works without authorization. External Agents do not receive the key. Bundled MobileSAM region segmentation runs locally on the CPU.
- **Save recovery:** an uncertain result retains input and pauses related writes. Reconcile that decision first: do not replay a committed decision; explicitly retry only after confirming no commit. Persistent sharing or permission failures remain visible.
- **Delivery:** preview the scope before exporting selected and explicitly approved text, regions or original files. An original containing multiple units exposes mixed decisions in the preview; approving one unit does not approve the entire original.

Experimental independent batch review is retired: creating or opening batch tasks, restoring their tabs, and the old review.* command entry are no longer supported. Existing stored data is not deleted or migrated automatically. Put source files in real folders for current review. For an open video project, the management menu on the right of Open / Manage still opens its original project workbench, separately from folder tasks. Review does not automatically arrange a timeline.

---

## Free Boards

Free Boards provide mixed-media layout, local repair and capture output on a white canvas:

- **7 Mixed-Media Input Types on One Canvas:**
  - Drag or paste **images, plain text (`.txt`/`.log`), videos, 3D GLB models, Markdown (`.md`), local HTML (`.html`/`.htm`)**, or standalone **HTTP/S URLs** (created as web containers).
  - Capture the current video frame or 3D GLB viewpoint directly onto the board as an independent image; crop, rotate 90°, flip, or pixel-repair images in place.
- **Managed Document Assets & Isolated Native Browsing:**
  - Markdown imports retain only actually referenced local assets within the document directory and support source editing and relative-link navigation.
  - Local HTML generates an initial viewport PNG via an isolated Chromium view (loading only managed local assets with network disabled). Web URL containers display their link until you click **Enter browse**, which opens a fixed-area Chromium view (no Node/preload access) where you can navigate and **Capture current viewport & return to board**.
- **Region Freeze PNG & Single-File Drag-Out:**
  - **Region capture** supports rectangular, polygon and freehand selections, adjustable polygon vertices and optional transparency. Output a PNG to **drag out to Explorer/Finder, copy to clipboard, save to disk, or append to the board**.
- **File output and independent snapshots:**
  - Dragging content within the canvas moves its layout. To drag out a system file, select the content, choose **Single file: drag out / save**, then drag the output panel’s **Drag out file** button.
  - Single-file output creates an independent file snapshot. Later board edits do not change saved files. The experimental review-node export entry has been removed.

See 📖 **[Free Boards Guide (docs/HUMAN-BOARDS.zh-CN.md)](docs/HUMAN-BOARDS.zh-CN.md)** for full details.

---

## Agent CLI and Repair Workflow

External video-editing Agents connect using the startup command copied from the application, then discover current contracts through tools and describe. Bind targets and revisions explicitly; switching tabs grants no access to other content.

Human decisions, drafts and model keys for current folder tasks use desktop-internal interfaces; equivalent external Agent commands are not available. The experimental review.* batch protocol is retired and does not operate folder tasks. Private free boards remain separate: only explicitly exported snapshots become deliverable content. See the [external Agent guide](docs/AGENT-GUIDE.md).

---

## Documentation

- 🎨 [**Free Boards Guide (Chinese)**](docs/HUMAN-BOARDS.zh-CN.md) — 7 media types, Markdown/HTML/web browsing, pixel repair, region PNG freeze, and explicit single-file output.
- [**Command API**](docs/COMMAND-API.md) — video-project commands, capability discovery, and retired-interface guidance.
- 📖 [**Desktop User Guide · Review Workspace**](docs/USER-GUIDE.md#审阅工作台与自由画板) — current folder tasks, human review, save recovery and help.
