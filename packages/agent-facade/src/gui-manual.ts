/**
 * The help.* verb contract and the structured GUI manual it serves.
 *
 * The manual is shipped, curated, bilingual (zh/en) static data describing
 * the editor's screens: how to reach each one, when it is visible, the
 * common steps inside it, its keyboard-shortcut references, and its honest
 * limitations. It exists so an external Agent can answer "how do I rename a
 * clip / mute a track / capture a work asset / save a preset / start a
 * voiceover task" WITHOUT reading product source. Content is data, so both
 * live and headless sessions answer from the same module.
 *
 * Maintenance rules for editors of this file:
 *  - Every fact must be verifiable in the running UI. The `@source` comment
 *    on each screen cites the owning component (file:line at the time the
 *    entry was last verified) for the next maintainer — the citations are
 *    maintenance metadata, never user-facing content.
 *  - `shortcutIds` reference the shared shortcut registry
 *    (apps/web/src/services/keyboard-shortcuts.ts) by stable id. Key
 *    bindings are deliberately NOT copied here: bindings are user-remappable
 *    state (with editor presets), so the manual carries references and the
 *    GUI's Settings → Shortcuts panel / "?" overlay remains the live truth.
 *  - The effects screen's closed-set limitation enumerates the engine's
 *    effect types. EFFECT_DEFINITIONS (packages/core/src/types/effects.ts)
 *    is the true source — core preset validation whitelists against it —
 *    and gui-manual.test.ts fails when this copy drifts from that set.
 *  - `screenshot` carries a real capture (data URL delivered from
 *    ./gui-manual-screenshots). Absent means the help.describe answer says
 *    "pending"; screens must never describe a screenshot that does not exist.
 *  - Nothing here may claim a capability that does not exist. Limitations
 *    are part of the content.
 */
import { FacadeError } from "./errors";
import { GUI_MANUAL_SCREENSHOTS } from "./gui-manual-screenshots";
import {
  isNonEmptyString,
  type ObjectSchema,
} from "./validate";

export const HELP_VERBS = [
  "help.list_screens",
  "help.describe",
  "help.search",
] as const;

export type HelpVerb = (typeof HELP_VERBS)[number];

/**
 * Version of the manual CONTENT (bumps when screen content changes), kept
 * next to the app version it documents. The desktop application version is
 * the version source the live endpoint already advertises
 * (`app.getVersion()` from apps/desktop/package.json); the constant below is
 * mirrored to it and the equality is enforced by gui-manual.test.ts, so a
 * version bump that outdates the manual fails tests instead of silently
 * drifting. FACADE_VERSION (types.ts) remains the facade protocol version —
 * the manual binds to the APP, not only the facade.
 */
export const GUI_MANUAL_CONTENT_VERSION = "1.3.0" as const;
export const GUI_MANUAL_APP_VERSION = "1.0.0-alpha.10" as const;
export const GUI_MANUAL_LANGUAGES = ["zh", "en"] as const;

/** Agent-facing payload limits for the help verbs. */
export const HELP_LIBRARY_LIMITS = {
  maxQueryLength: 100,
  maxSearchResults: 20,
} as const;

/* ------------------------------ content ------------------------------ */

export interface ManualLocalizedText {
  /** Simplified Chinese copy. */
  readonly zh: string;
  /** English copy. */
  readonly en: string;
}

export interface ManualScreen {
  /** Stable screen id (query key for help.describe). */
  readonly id: string;
  readonly title: ManualLocalizedText;
  /** One sentence: what this screen is for. */
  readonly summary: ManualLocalizedText;
  /** Ordered path describing how to REACH the screen. */
  readonly entry: readonly ManualLocalizedText[];
  /** When the screen/entry is visible (omit: always visible). */
  readonly visibility?: ManualLocalizedText;
  /** Common steps inside the screen. */
  readonly steps?: readonly ManualLocalizedText[];
  /** References into the shared shortcut registry (ids only, never keys). */
  readonly shortcutIds?: readonly string[];
  /** Honest limitations, known gaps, and gating. */
  readonly limitations?: readonly ManualLocalizedText[];
  /** Extra zh/en search keywords beyond the copy above. */
  readonly keywords?: readonly string[];
  /**
   * Reserved for real screenshots (data-URL or packaged asset reference).
   * Never set it to a placeholder — an absent field is reported honestly as
   * "screenshot pending".
   */
  readonly screenshot?: string;
}

/** Capability block reported by capabilities.get. */
export interface ManualCapability {
  readonly available: true;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly languages: readonly (typeof GUI_MANUAL_LANGUAGES)[number][];
  readonly screenCount: number;
  /** Delivery state of the reserved screenshot assets. */
  readonly screenshots: "reserved-not-delivered" | "delivered";
}

export const GUI_MANUAL_SCREENS: readonly ManualScreen[] = [
  {
    id: "quick-start",
    title: { zh: "快速开始", en: "Quick Start" },
    // @source apps/web/src/desktop/start/DesktopStartScreen.tsx
    // @source apps/web/src/desktop/editor/DesktopHelpDialog.tsx
    summary: {
      zh: "先完成一条短视频：新建 → 导入 → 剪辑 → 保存 → 导出。不需要连接智能体。",
      en: "Finish a short video first: create → import → edit → save → export. An Agent connection is optional.",
    },
    entry: [
      { zh: "Windows 安装版：安装后打开 ReelTerminal。便携版：解压完整 ZIP 后，打开目录内的 ReelTerminal.exe；不要只复制 EXE。", en: "Windows installer: install and open ReelTerminal. Portable build: extract the entire ZIP and open ReelTerminal.exe inside it; keep its supporting files together." },
      { zh: "首页选择“视频编辑器”，再点击横屏（16:9）、竖屏（9:16）或方形（1:1）。动画制作使用“动态图形创作”，它是另一个工作区。", en: "On the start screen, choose Video Editor, then Horizontal (16:9), Vertical (9:16), or Square (1:1). Motion Creator is a separate workspace for animation." },
    ],
    steps: [
      { zh: "导入：点击左侧素材面板的“导入”，选择本地视频、音频或图片。素材出现在列表后，拖到下方时间线。导入素材不会自动放到轨道上。", en: "Import: use Import in the left media panel to choose local video, audio, or images. Drag an imported item onto the timeline; importing alone does not place it on a track." },
      { zh: "剪辑：拖动片段调整位置，拖动两端修剪长度。把播放头移到切点，选中片段后按 S 分割；选中不要的部分后按 Delete。", en: "Edit: drag a clip to move it and drag its edges to trim. Move the playhead to a cut, select the clip, and press S to split; select unwanted parts and press Delete." },
      { zh: "检查：点击播放器下方的播放按钮，或按空格播放/暂停。选中片段后，在右侧检查器调整变换、音量或效果；先确认片段已选中。", en: "Review: use the player Play button or Space to play/pause. Select a clip before adjusting its transform, volume, or effects in the right inspector." },
      { zh: "保存：默认快捷键 Ctrl+S（Mac 为 Cmd+S）立即保存到本机项目存储，之后从首页“最近项目”继续编辑。导出视频用于播放或分享；本机存储和自动保存不能替代文件备份。", en: "Save: the default Ctrl+S (Cmd+S on Mac) immediately saves to local project storage; reopen it from Recent on the start screen. Exported video is for playback or sharing; local storage and autosave do not replace a file backup." },
      { zh: "导出：点击顶栏“导出”，先选择一个预设，或切到“自定义”保留 MP4 和项目画面参数，再点“开始导出”选择保存位置。未选预设时按钮会禁用。完成后打开输出文件，检查画面、声音和结尾。", en: "Export: click Export, choose a preset or switch to Custom to keep MP4 and the project's frame settings, then Start Export and choose a destination. Start Export is disabled until a preset is selected in Presets mode. Check the finished picture, sound, and ending." },
      { zh: "可选：需要智能体协助时，先打开项目，再在状态栏点击“允许编辑”；右键素材或片段可添加引用，再次右键可移除。参考对比在播放器工具栏的“对比”里，默认不遮挡画面。", en: "Optional: open a project, then use Allow editing in the status strip for Agent edits. Right-click media or clips to add a reference and right-click again to remove it. Reference comparison lives under Compare in the player toolbar." },
    ],
    shortcutIds: ["playback.playPause", "editing.split", "editing.undo", "file.save", "file.export"],
    limitations: [
      { zh: "快捷键可在“设置 → 快捷键”中更改；本页操作键是默认值。不知道从哪里开始时，先点“界面导览”。", en: "Bindings can be changed in Settings → Shortcuts; keys above are defaults. Use the interface tour to find the main controls." },
      { zh: "素材丢失：优先检查原文件是否被移动、外接盘是否断开。导出失败：先检查时间线里有片段、保存目录可写，再查看错误提示。不要通过清空整个数据目录处理启动问题。", en: "Missing media: check whether source files moved or an external drive disconnected. Export failure: check that the timeline has clips and the destination is writable, then read the error message. Do not erase the entire data folder to troubleshoot startup." },
    ],
    keywords: ["start", "beginner", "install", "portable", "save", "quickstart", "新手", "安装", "便携", "上手", "保存"],
  },
  {
    id: "motion-quick-start",
    title: { zh: "动态图形入门", en: "Motion Quick Start" },
    // @source apps/web/src/motion/MotionCreatorApp.tsx
    // @source apps/web/src/motion/components/MotionStartPanel.tsx
    // @source apps/web/src/motion/MotionCreatorShell.tsx
    summary: { zh: "从一个文字或形状图层开始制作短动画；普通视频剪辑请切换到“视频编辑”。", en: "Start a short animation with one text or shape layer. Use Video Editing for ordinary footage editing." },
    entry: [
      { zh: "首页选择“动态图形创作”和画面比例，或在打开的项目上方切换到“动态图形”。场景准备完成后进入图层工作区。", en: "Choose Motion Creator and a frame format on the start screen, or switch to Motion Design above an open project. The scene opens in the layer workspace when ready." },
    ],
    steps: [
      { zh: "先用起始面板中的“文字”或“形状”添加一个图层；也可以从“模板”选择现有场景。", en: "Use Text or Shape in the start panel to add one layer, or choose a scene from Templates." },
      { zh: "选中图层，在右侧属性面板修改文字、位置、尺寸或颜色。", en: "Select the layer and edit its text, position, size, or color in the right Properties panel." },
      { zh: "用“预设”尝试入场或退场动画，再移动下方时间线的播放头检查不同时间的效果。", en: "Try an entrance or exit from Presets, then move the timeline playhead to inspect the animation over time." },
      { zh: "使用当前场景的导出入口生成 MP4。动态图形的图层时间线与视频编辑时间线不同，切换工作区不会把场景自动剪成普通视频片段。", en: "Use the current scene's export entry to produce MP4. Motion layers and the video editing timeline are separate; switching workspaces does not automatically turn a scene into a footage clip." },
    ],
    keywords: ["motion", "animation", "layers", "动态图形", "动画", "图层"],
  },
  {
    id: "project-switcher",
    title: { zh: "项目切换器与项目改名", en: "Project Switcher & Renaming" },
    // @source apps/web/src/desktop/shell/DesktopProjectNameControl.tsx (desktop title bar)
    // @source apps/web/src/desktop/shell/DesktopTitleBar.tsx
    // @source apps/web/src/components/editor/Toolbar.tsx (web toolbar center)
    // @source apps/web/src/components/editor/ProjectSwitcher.tsx:40,120,232
    summary: {
      zh: "项目名称控件提供改名、新建、切换与恢复：桌面应用在窗口标题栏，浏览器版在编辑器顶栏。",
      en: "The project-name control renames, creates, switches, and recovers projects: in the desktop title bar, or on the editor toolbar in the browser build.",
    },
    entry: [
      {
        zh: "桌面应用：窗口标题栏品牌区右侧的项目名称输入框与切换按钮，项目打开时始终可见可点。",
        en: "Desktop app: the project-name field and switch button to the right of the title-bar brand; visible and clickable whenever a project is open.",
      },
      {
        zh: "网页（浏览器）版：编辑器顶栏中央的项目名称输入框与切换按钮。",
        en: "Browser (web) build: the project-name field and switch button at the center of the editor toolbar.",
      },
    ],
    steps: [
      {
        zh: "改名：直接在项目名称输入框输入新名称，回车或点击别处提交，Esc 取消；输入框旁的铅笔按钮可聚焦并全选名称。切换器内也有重命名入口。",
        en: "Rename: type the new name straight into the project-name field; Enter or clicking elsewhere commits, Escape cancels; the pencil button beside it focuses and selects the name. The switcher offers a rename entry too.",
      },
      {
        zh: "新建项目：切换器里的新建入口会以新项目替换当前打开的项目。",
        en: "New project: the switcher's new-project entry replaces the currently open project with a fresh one.",
      },
      {
        zh: "切换项目：从已保存项目列表中选择另一个项目。",
        en: "Switch: pick another project from the saved-projects list.",
      },
      {
        zh: "恢复：从自动保存快照恢复未预期的丢失。",
        en: "Recover: restore from an autosave snapshot after an unexpected loss.",
      },
    ],
    limitations: [
      {
        zh: "改名只改变项目显示名和之后导出/保存的建议名，不会重命名已存在的项目文件。",
        en: "Renaming changes the display name and future suggested export/save names; it never renames an existing project file.",
      },
    ],
    keywords: ["project", "rename", "switcher", "autosave", "title bar", "项目", "改名", "切换", "自动保存", "标题栏"],
  },
  {
    id: "settings-dialog",
    title: { zh: "设置对话框", en: "Settings Dialog" },
    // @source apps/web/src/components/editor/EditorActionRail.tsx:195
    // @source apps/web/src/components/editor/settings/SettingsDialog.tsx:11,51-55
    summary: {
      zh: "集中存放常规偏好与快捷键设置两个页签的设置对话框。",
      en: "A settings dialog with a General tab and a Shortcuts tab.",
    },
    entry: [
      {
        zh: "桌面版：窗口顶栏“设置”。浏览器版：左侧工具条“更多”菜单 → 设置。",
        en: "Desktop: Settings in the title bar. Browser: the action rail's More menu → Settings.",
      },
    ],
    steps: [
      {
        zh: "常规页签：界面语言（中文/English）等偏好。",
        en: "General tab: interface language (中文/English) and related preferences.",
      },
      {
        zh: "快捷键页签：查看、重映射和应用快捷键预设（见 keyboard-shortcuts 界面）。",
        en: "Shortcuts tab: view, remap, and apply shortcut presets (see the keyboard-shortcuts screen).",
      },
    ],
    keywords: ["settings", "preferences", "language", "设置", "偏好", "语言"],
  },
  {
    id: "keyboard-shortcuts",
    title: { zh: "键盘快捷键", en: "Keyboard Shortcuts" },
    // @source apps/web/src/components/editor/settings/KeyboardShortcutsPanel.tsx
    // @source apps/web/src/components/editor/KeyboardShortcutsOverlay.tsx
    // @source apps/web/src/hooks/useKeyboardShortcuts.ts:24,329
    // @source apps/web/src/services/keyboard-shortcuts.ts:91-422,424-474
    summary: {
      zh: "按 \"?\" 打开快捷键浮层；设置对话框的快捷键页签可查看、重映射与应用编辑器预设。",
      en: "Press \"?\" for the shortcuts overlay; the Settings dialog's Shortcuts tab views, remaps, and applies editor presets.",
    },
    entry: [
      {
        zh: "在编辑器中直接按 \"?\"（焦点不在输入框时）。",
        en: "Press \"?\" in the editor (when focus is not in a text field).",
      },
      {
        zh: "设置对话框 → 快捷键页签；左侧工具条\"更多\"菜单也有快捷键入口。",
        en: "Settings dialog → Shortcuts tab; the action rail's More menu also has a shortcuts entry.",
      },
    ],
    steps: [
      {
        zh: "按分类浏览：播放、编辑、选择、时间线、视图、文件、工具。",
        en: "Browse by category: playback, editing, selection, timeline, view, file, tools.",
      },
      {
        zh: "重映射单个快捷键；与现有绑定冲突时该修改会被拒绝而不是覆盖。",
        en: "Remap a single shortcut; a conflicting binding is rejected rather than overwritten.",
      },
      {
        zh: "应用整组预设：ReelTerminal 默认、CapCut、Premiere、Final Cut Pro、DaVinci Resolve。",
        en: "Apply a whole preset: ReelTerminal Default, CapCut, Adobe Premiere, Final Cut Pro, DaVinci Resolve.",
      },
      {
        zh: "一键恢复全部默认绑定。",
        en: "Reset all bindings back to defaults in one action.",
      },
    ],
    shortcutIds: ["view.showShortcuts", "playback.playPause", "editing.undo", "editing.redo", "file.save", "file.export"],
    limitations: [
      {
        zh: "焦点在文本输入框或可编辑区域时快捷键不触发。",
        en: "Shortcuts are ignored while focus is in a text input or content-editable area.",
      },
      {
        zh: "绑定按 \"cmd/ctrl 等价\"匹配，在 Windows/Linux 上显示为 Ctrl 组合键。",
        en: "cmd and ctrl match identically; on Windows/Linux the same binding displays as the Ctrl combo.",
      },
      {
        zh: "自定义绑定保存在本机浏览器存储，不随项目文件走。",
        en: "Custom bindings persist in local browser storage, not inside project files.",
      },
    ],
    keywords: ["shortcut", "keyboard", "keymap", "preset", "快捷键", "按键", "预设"],
    screenshot: GUI_MANUAL_SCREENSHOTS["keyboard-shortcuts"],
  },
  {
    id: "timeline",
    title: { zh: "时间线", en: "Timeline" },
    // @source apps/web/src/components/editor/Timeline.tsx:227-230,277-278,459-499
    summary: {
      zh: "底部时间线负责排布轨道与片段：缩放、适配全部、分割修剪、吸附与轨道管理都在这里。",
      en: "The bottom timeline arranges tracks and clips: zoom, fit-to-view, split/trim, snapping, and track management live here.",
    },
    entry: [
      { zh: "编辑器底部区域，始终可见。", en: "The bottom area of the editor; always visible." },
    ],
    steps: [
      {
        zh: "缩放：时间线工具条上的放大/缩小控件，或默认的 Cmd/Ctrl+= 与 Cmd/Ctrl+-。",
        en: "Zoom: the timeline toolbar's zoom in/out controls, or the default Cmd/Ctrl+= and Cmd/Ctrl+-.",
      },
      {
        zh: "适配全部：工具条上的适配按钮（首次打开也会自动适配一次），或默认的 Cmd/Ctrl+0。",
        en: "Fit all: the toolbar's fit button (first open also auto-fits once), or the default Cmd/Ctrl+0.",
      },
      {
        zh: "分割与修剪：默认键 S 在播放头分割，Q/W 修剪片段头/尾到播放头。",
        en: "Split & trim: by default S splits at the playhead; Q/W trim the clip's start/end to the playhead.",
      },
      {
        zh: "吸附：默认键 N 或时间线上的吸附开关，控制拖动时是否吸到片段边缘/播放头。",
        en: "Snapping: N by default, or the timeline's snap toggle, controls whether drags snap to clip edges/playhead.",
      },
      {
        zh: "轨道：时间线上可添加轨道；删除轨道需内嵌确认，轨道上的片段会被移除，可通过撤销恢复。",
        en: "Tracks: add tracks from the timeline; deleting a track asks for an inline confirmation — its clips are removed and undo restores them.",
      },
    ],
    shortcutIds: [
      "timeline.zoomIn",
      "timeline.zoomOut",
      "timeline.fitTimeline",
      "timeline.toggleSnap",
      "editing.split",
      "editing.trimStart",
      "editing.trimEnd",
      "editing.rippleDelete",
      "editing.delete",
    ],
    keywords: ["timeline", "zoom", "fit", "snap", "split", "trim", "track", "时间线", "缩放", "适配", "吸附", "分割", "修剪", "轨道"],
    screenshot: GUI_MANUAL_SCREENSHOTS["timeline"],
  },
  {
    id: "track-headers",
    title: { zh: "轨道头控制（静音/独奏/隐藏/锁定）", en: "Track Headers (Mute/Solo/Hide/Lock)" },
    // @source apps/web/src/components/editor/timeline/TrackHeader.tsx:34-37,57-68,237-262
    summary: {
      zh: "每条轨道左端的轨道头提供隐藏画面、静音、独奏、锁定与删除轨道控制。",
      en: "Each track's left-end header provides hide, mute, solo, lock, and delete-track controls.",
    },
    entry: [
      { zh: "时间线上每条轨道左侧的窄条区域。", en: "The narrow strip at the left of every track in the timeline." },
    ],
    steps: [
      { zh: "眼睛图标：隐藏/显示该轨画面（仅影响画面，不影响声音）。", en: "Eye icon: hide/show the track's picture (picture only, never sound)." },
      { zh: "喇叭图标：静音/取消静音该轨声音。", en: "Speaker icon: mute/unmute the track's audio." },
      { zh: "S 按钮：独奏——有任一独奏轨时，其它轨的声音被压制。", en: "S button: solo — while any track is soloed, all other tracks are silenced." },
      { zh: "锁图标：锁定轨道防止误编辑；垃圾桶：删除轨道。", en: "Lock icon: lock the track against edits; trash icon: delete the track." },
    ],
    limitations: [
      {
        zh: "视频轨可携带内嵌音频，因此视频轨同样提供静音/独奏；独奏压制同时作用于预览与导出混音。",
        en: "Video tracks can carry embedded audio, so they offer mute/solo too; solo suppression applies to both the preview and the export mix.",
      },
      {
        zh: "轨道变暗只表示\"画面被隐藏\"；声音状态以喇叭控件为准。",
        en: "A dimmed track means \"picture hidden\"; audio state is shown by the speaker control.",
      },
    ],
    keywords: ["track", "mute", "solo", "hide", "lock", "轨道", "静音", "独奏", "隐藏", "锁定"],
  },
  {
    id: "media-panel",
    title: { zh: "项目媒体面板", en: "Project Media Panel" },
    // @source apps/web/src/components/editor/AssetsPanel.tsx:83-155(tabs),236,250-322(F2/rename),700-807(import),738(short-id)
    summary: {
      zh: "\"媒体\"标签存放本项目导入的视频、音频与图像，支持改名（F2）与拖入时间线。",
      en: "The Media tab holds this project's imported video, audio, and images, with rename (F2) and drag-to-timeline.",
    },
    entry: [
      { zh: "编辑器左侧面板 → \"媒体\" 标签。", en: "Left panel in the editor → the Media tab." },
    ],
    steps: [
      { zh: "导入：面板顶部的导入控件选择本地文件；录制控件也在此区域。", en: "Import: the panel-top import control picks local files; recording controls share this area." },
      { zh: "使用：把媒体卡片拖到时间线成为片段。", en: "Use: drag a media card onto the timeline to make a clip." },
      { zh: "改名：选中后按 F2（默认），或右键选\"重命名\"，或双击名称，输入后回车确认。", en: "Rename: select and press F2 (the default), right-click → Rename, or double-click the name; Enter commits." },
    ],
    limitations: [
      {
        zh: "改名只改变项目内的显示名，从不改动源文件；清空名称的提交会被拒绝。",
        en: "Renaming only changes the in-project display name, never the source file; an empty name is rejected.",
      },
      {
        zh: "同名的媒体条目会自动获得一个短 ID 后缀以便区分。",
        en: "Media items with identical names automatically get a short id suffix to stay distinguishable.",
      },
    ],
    keywords: ["media", "import", "rename", "F2", "媒体", "导入", "改名", "重命名"],
  },
  {
    id: "work-assets",
    title: { zh: "工作素材", en: "Work Assets" },
    // @source apps/web/src/components/editor/timeline/ClipContextMenu.tsx:20,184-189(capture)
    // @source apps/web/src/components/editor/panels/WorkAssetsTab.tsx:152-156,219-237,266,312,355-361(missingSource/instantiate)
    // @source apps/web/src/components/editor/AssetsPanel.tsx(media card menu: workAssets.saveToWork)
    // @source packages/core/src/work-assets/capture.ts(captureWorkAssetFromMedia)
    summary: {
      zh: "\"工作素材\"标签存放项目内可复用的片段与素材捕捉：从片段或媒体卡捕捉、加入时间线、拖回复用。",
      en: "The Work Assets tab stores reusable in-project clip and media captures: capture from a clip or media card, add to the timeline, drag back to reuse.",
    },
    entry: [
      { zh: "编辑器左侧面板 → \"工作素材\" 标签。", en: "Left panel in the editor → the Work Assets tab." },
      {
        zh: "捕捉入口：时间线上右键一个片段 → 捕捉为工作素材；或在\"媒体\"标签右键媒体卡 → 保存到工作素材（无需先上时间线）。",
        en: "Capture entries: right-click a timeline clip → capture as a work asset; or right-click a media card in the Media tab → save to work assets (no timeline detour needed).",
      },
    ],
    steps: [
      {
        zh: "捕捉：右键片段捕捉为工作素材；不被当前引擎支持的参数会被如实列出，捕捉仍然发生但记录留空。",
        en: "Capture: right-click a clip to capture it; parameters the engine cannot carry are listed honestly and the capture still happens with those left out.",
      },
      {
        zh: "加入时间线：卡片上的\"加入时间线\"按钮，或直接把卡片拖回时间线。",
        en: "Add to timeline: the card's add-to-timeline button, or drag the card back onto the timeline.",
      },
      {
        zh: "列表按最新捕捉排序，且不依赖片段是否仍存在。",
        en: "The list sorts newest capture first and does not depend on the source clip still existing.",
      },
    ],
    limitations: [
      {
        zh: "工作素材是项目级的可复用捕捉，区别于用户级素材库（跨项目）。",
        en: "Work assets are project-scoped reusable captures — distinct from the user-level material library (cross-project).",
      },
      {
        zh: "从媒体卡直接捕捉的素材携带默认参数（无特效、无关键帧）；需要保留参数的捕捉请从时间线片段执行。",
        en: "Captures made directly from a media card carry default clip parameters (no effects, no keyframes); capture from a timeline clip to preserve parameters.",
      },
      {
        zh: "源文件缺失时卡片显示缺失警示，加入时间线被禁用，但条目本身保留。",
        en: "When the source file is missing, the card shows a missing-source warning and adding to the timeline is disabled, but the entry itself is kept.",
      },
    ],
    keywords: ["work asset", "capture", "missingSource", "工作素材", "捕捉", "复用", "缺失"],
    screenshot: GUI_MANUAL_SCREENSHOTS["work-assets"],
  },
  {
    id: "material-library",
    title: { zh: "素材库（用户级）", en: "Material Library (User-Level)" },
    // @source apps/web/src/components/editor/AssetsPanel.tsx:51-52,325-337(saveToLibrary)
    // @source apps/web/src/components/editor/material/MaterialLibraryPanel.tsx
    summary: {
      zh: "\"素材库\"标签是跨项目的用户级素材收藏：媒体、片段、链接与方法，可保存项目媒体进去。",
      en: "The Library tab is the user's cross-project collection: media, segments, links, and methods; project media can be saved into it.",
    },
    entry: [
      { zh: "编辑器左侧面板 → \"素材库\" 标签。", en: "Left panel in the editor → the Library tab." },
      {
        zh: "保存入口：项目媒体卡片菜单 → 保存到素材库。",
        en: "Save entry: a project-media card's menu → Save to library.",
      },
    ],
    steps: [
      { zh: "浏览与搜索用户级素材（标题、标签、备注等）。", en: "Browse and search the user's materials (title, tags, notes, ...)." },
      { zh: "把项目媒体保存为素材；保存引用原文件，不移动不复制内容。", en: "Save project media as a material; saving references the original file without moving or copying it." },
      { zh: "打开素材查看明细（来源、备注、AI 摘要与用户备注是分开的字段）。", en: "Open a material for details (provenance; AI summary and user notes are separate fields)." },
    ],
    limitations: [
      {
        zh: "素材库独立于打开的项目（用户状态）；与项目\"媒体\"标签和\"工作素材\"标签是三回事。",
        en: "The library is user state, independent of the open project; it is distinct from the project's Media tab and Work Assets tab.",
      },
      {
        zh: "连接的外部 Agent 通过 material.* 工具读写同一个库；用户备注不对 Agent 开放写入。",
        en: "A connected external agent reads/writes the same library through the material.* tools; user notes are not agent-writable.",
      },
    ],
    keywords: ["material", "library", "save to library", "素材库", "收藏", "素材"],
  },
  {
    id: "text-presets",
    title: { zh: "文字预设（内置与自定义）", en: "Text Presets (Built-in & Custom)" },
    // @source apps/web/src/components/editor/panels/TextPresetsPanel.tsx:225-229,423-429,504-507
    // @source apps/web/src/components/editor/panels/text-style-presets.ts
    summary: {
      zh: "\"文字\"标签提供内置标题样式库，并可把选中文本片段的样式保存为自定义预设。",
      en: "The Text tab offers built-in title styles and can save a selected text clip's style as a custom preset.",
    },
    entry: [
      { zh: "编辑器左侧面板 → \"文字\" 标签。", en: "Left panel in the editor → the Text tab." },
    ],
    steps: [
      { zh: "内置样式：点击样式卡从默认样式新建文本，或应用到选中的文本片段。", en: "Built-in styles: click a style card to create text from it, or apply it to a selected text clip." },
      {
        zh: "保存自定义预设：选中一个文本片段，用\"从选中保存\"入口经命名对话框保存当前样式。",
        en: "Save a custom preset: select a text clip and use the save-from-selection entry; a name dialog commits the current style.",
      },
      { zh: "自定义预设支持重命名与删除；删除不影响已应用过它的文本。", en: "Custom presets can be renamed and removed; removal never affects text already built from them." },
    ],
    limitations: [
      {
        zh: "自定义预设保存在本机（浏览器 IndexedDB），跨项目可用；样式字段按白名单校验，未知字段会被拒绝而不是静默丢弃。",
        en: "Custom presets persist locally (browser IndexedDB) and are available across projects; style fields are whitelist-validated — unknown fields are rejected, never silently dropped.",
      },
    ],
    keywords: ["text", "title", "preset", "style", "文字", "标题", "预设", "样式"],
  },
  {
    id: "effects-transitions",
    title: { zh: "效果与转场（内置与自定义预设）", en: "Effects & Transitions (Built-in & Custom Presets)" },
    // @source apps/web/src/components/editor/panels/EffectsTransitionsPanel.tsx:32,36-37,1477-1507,1604
    // @source apps/web/src/components/editor/panels/effect-transition-preset-controllers.ts:75,211
    // @source apps/web/src/components/editor/panels/preset-name-dialog.tsx:9
    summary: {
      zh: "\"效果\"与\"转场\"标签提供内置卡片，可把效果或转场参数保存为自定义预设并再次应用。",
      en: "The Effects and Transitions tabs offer built-in cards and can save an effect or transition parameters as a custom preset to reapply later.",
    },
    entry: [
      { zh: "编辑器左侧面板 → \"效果\" / \"转场\" 标签。", en: "Left panel in the editor → the Effects / Transitions tab." },
    ],
    steps: [
      { zh: "内置效果/转场卡片拖到片段（效果）或切点（转场）上应用。", en: "Drag a built-in effect card onto a clip (effects) or a built-in transition card onto a cut (transitions)." },
      { zh: "保存自定义效果预设：在检查器效果页签对单个效果用\"保存效果为预设\"按钮经命名对话框保存（每次保存一个效果；单个预设载荷可含 1–8 个效果）。", en: "Save a custom effect preset: in the inspector's effects tab, save one effect via its Save effect as preset button and the name dialog (one effect per save; a single preset payload may hold 1-8 effects)." },
      { zh: "保存自定义转场预设：在选中切点上把转场类型与参数存为预设。", en: "Save a custom transition preset: store the transition type and parameters from a selected cut." },
      { zh: "自定义预设卡片双击（或右键）应用；支持重命名与删除。", en: "Apply a custom preset by double-click (or context menu); rename and remove are supported." },
    ],
    limitations: [
      {
        zh: "效果预设只覆盖片段视频效果栈，且是封闭集合（模糊、阴影、发光、亮度、对比度、饱和度、色相/饱和度、色彩平衡、曲线、运动模糊、径向模糊、晕影、胶片颗粒、色差、灰度、深褐色、反相、锐化、颗粒、色温、色调、影调共 22 类）；音频效果不能进效果预设。色键保存在片段的独立键控设置中、着色器效果的参数取决于所选 shader，二者不能存为效果预设。",
        en: "Effect presets cover the clip VIDEO effect stack only, a closed set of 22 engine types (blur, shadow, glow, brightness, contrast, saturation, hue-saturation, color-balance, curves, motion-blur, radial-blur, vignette, film-grain, chromatic-aberration, grayscale, sepia, invert, sharpen, grain, temperature, tint, tonal); audio effects cannot join an effect preset. Chroma key lives in the clip's dedicated keying settings and a shader effect's parameters depend on the selected shader, so neither can be saved as an effect preset.",
      },
      {
        zh: "未知效果类型在保存时被拒绝；自定义预设保存在本机，跨项目可用。",
        en: "Unknown effect types are rejected at save time; custom presets persist locally and are available across projects.",
      },
    ],
    keywords: ["effect", "transition", "preset", "shadow", "glow", "motion blur", "效果", "转场", "预设", "阴影", "发光", "运动模糊"],
  },
  {
    id: "inspector",
    title: { zh: "检查器（右侧属性面板）", en: "Inspector (Right Properties Panel)" },
    // @source apps/web/src/components/editor/InspectorPanel.tsx:59-66,1052-1110
    // @source apps/web/src/components/editor/inspector/clip-tabs.config.ts(TABS_BY_CLIP_TYPE)
    summary: {
      zh: "选中时间线片段后在右侧检查器编辑其属性，页签随片段类型变化。",
      en: "Select a timeline clip and edit its properties in the right inspector; the tabs follow the clip type.",
    },
    entry: [
      { zh: "点击时间线上的任一片段 → 右侧检查器。", en: "Click any clip in the timeline → the inspector on the right." },
    ],
    steps: [
      {
        zh: "页签按类型出现：视频=变换/色彩/效果/音频/速度/动画/AI；图像=视频减音频类；音频=音频/AI；文本/图形=变换/样式/效果/动画。",
        en: "Tabs by type: video = transform/color/effects/audio/speed/animate/AI; image = the video set minus audio; audio = audio/AI; text/graphics = transform/style/effects/animate.",
      },
      {
        zh: "动画页签与各属性的关键帧控件做关键帧动画（位置、缩放、旋转、不透明度等）。",
        en: "The Animate tab and per-property keyframe controls animate position, scale, rotation, opacity, and more.",
      },
      {
        zh: "音频页签提供静音剪切、节拍同步、降噪、闪避等本地音频工具；AI 页签提供本地自动字幕等。",
        en: "The Audio tab hosts local audio tools (silence cut, beat sync, noise reduction, ducking); the AI tab hosts local auto-captions and more.",
      },
    ],
    limitations: [
      {
        zh: "没有选中片段时检查器为空。",
        en: "With no clip selected the inspector is empty.",
      },
      {
        zh: "AI 页签中的云端功能（云转写、精彩片段）可在构建中关闭；关闭时按钮禁用并显示说明，本地自动字幕不受该开关影响。",
        en: "Cloud features in the AI tab (cloud transcription, highlights) can be disabled at build time; when disabled the buttons show disabled with an explanation, and local auto-captions are unaffected by that switch.",
      },
    ],
    keywords: ["inspector", "properties", "keyframe", "tabs", "检查器", "属性", "关键帧", "页签"],
  },
  {
    id: "audio-mixer",
    title: { zh: "音频混台", en: "Audio Mixer" },
    // @source apps/web/src/components/audio-mixer/AudioMixer.tsx:118-132(voiceover/music entry)
    // @source apps/web/src/components/editor/EditorInterface.tsx:500-505
    // @source apps/web/src/components/editor/EditorActionRail.tsx:153-156
    summary: {
      zh: "音频混台以通道条管理各轨道音量与静音，并提供配音/音乐任务的入口按钮。",
      en: "The audio mixer manages per-track level and mute through channel strips and hosts the voiceover/music task entry button.",
    },
    entry: [
      {
        zh: "编辑器左侧工具条 → 音频混台按钮（面板开关，再次点击关闭）。",
        en: "The action rail's Audio Mixer button (toggles the panel; click again to close).",
      },
    ],
    steps: [
      { zh: "每条轨道一个通道条，调节该轨音量与静音。", en: "One channel strip per track adjusts that track's level and mute." },
      {
        zh: "混台中的\"配音/音乐\"入口按钮打开配音与音乐任务对话框。",
        en: "The mixer's voiceover/music entry button opens the voiceover & music task dialog.",
      },
    ],
    keywords: ["mixer", "audio", "channel", "volume", "混台", "混音", "音量", "通道"],
  },
  {
    id: "voiceover-music-tasks",
    title: { zh: "配音与音乐任务", en: "Voiceover & Music Tasks" },
    // @source apps/web/src/components/editor/dialogs/AgentMediaTaskDialog.tsx
    // @source apps/web/src/components/audio-mixer/AudioMixer.tsx:118-132
    // @source apps/web/src/components/editor/EditorActionRail.tsx:211
    // @source apps/web/src/services/agent-media-tasks/types.ts:20-30
    summary: {
      zh: "这里保留旧版配音与音乐任务记录、试听和素材导入入口；新任务提交与重试暂时停用。",
      en: "This screen preserves saved voiceover/music records, previews, and imports; new submission and retry are paused.",
    },
    entry: [
      { zh: "浏览器版音频混台中的“配音/音乐任务”入口；桌面状态栏已移除此入口，旧记录仍保留。", en: "Voiceover / Music Tasks in the browser audio mixer. The desktop status-strip entry has been removed; existing records are retained." },
    ],
    visibility: {
      zh: "任务历史始终可查看；只有目标项目打开时才能试听或导入对应项目的素材。",
      en: "Task history is always available; preview and import require the task's target project to be open.",
    },
    steps: [
      { zh: "查看排队、已提交、生成中、待导入、完成、失败和已取消的旧任务记录。", en: "Review saved tasks in queued, submitted, running, awaiting_import, done, error, or cancelled states." },
      { zh: "待导入产物可以导入；已完成产物可以试听并插入目标时间线。", en: "Import waiting artifacts, and preview or insert completed artifacts into the target timeline." },
      { zh: "可以取消仍处于活动状态的旧任务；取消只更新本地记录。", en: "You can cancel a previously active task; this only updates its local record." },
    ],
    limitations: [
      {
        zh: "配音 / 音乐新任务提交与重试暂时停用，待独立任务机制完成后恢复；已有记录和产物会保留。",
        en: "New voiceover/music submission and retry are paused until generation has an independent task mechanism; saved records and artifacts are preserved.",
      },
      {
        zh: "试听仅在目标项目处于打开状态时可用（产物媒体属于该项目时才能预览）。",
        en: "Auditioning is only available while the target project is open (the result media belongs to that project).",
      },
    ],
    keywords: ["voiceover", "tts", "music", "task", "cancel", "audition", "insert", "配音", "音乐", "任务", "取消", "试听", "插入"],
  },
  {
    id: "agent-access",
    title: { zh: "Agent Access 状态", en: "Agent Access Status" },
    // @source apps/web/src/desktop/editor/CollabStatusBar.tsx
    summary: {
      zh: "显示桌面命令接口的可用状态、只读 / 可写权限与当前操作。ReelTerminal 不管理 Agent 登录或对话。",
      en: "Shows desktop command-service availability, read-only or read/write access, and the active operation. ReelTerminal does not manage Agent sign-in or conversations.",
    },
    entry: [
      { zh: "桌面编辑器时间线正上方的状态栏。", en: "The status strip directly above the desktop timeline." },
    ],
    steps: [
      { zh: "打开项目后，命令接口自动可用；默认只读。点击“允许编辑”授予修改权限，点击“设为只读”收回修改权限。", en: "The command service becomes available when a project is open and starts read-only. Allow editing grants write access; Set read-only revokes it." },
      { zh: "状态栏显示当前访问为只读或可写，并在命令运行时显示操作名称。", en: "The strip shows read-only or read/write access and the active command while one is running." },
      { zh: "Agent 通过 reelctl CLI 访问当前打开的项目；需要时可查询 schema 和上下文。", en: "Agents use the reelctl CLI to access the open project and can query schemas and context as needed." },
    ],
    limitations: [
      {
        zh: "ReelTerminal 不安装、登录或检测 Agent，也不管理对话、历史记录和上下文压缩。",
        en: "ReelTerminal does not install, sign in, or detect Agents, and does not manage conversations, history, or context compression.",
      },
    ],
    keywords: ["agent", "access", "CLI", "command", "Agent Access", "访问", "命令", "智能体"],
  },
  {
    id: "action-history",
    title: { zh: "操作历史", en: "Action History" },
    // @source apps/web/src/components/editor/EditorActionRail.tsx:141
    // @source apps/web/src/components/editor/inspector/HistoryPanel.tsx
    summary: {
      zh: "历史面板列出可撤销的操作记录，是撤销/重做的可视化入口。",
      en: "The history panel lists undoable operations — the visual front end of undo/redo.",
    },
    entry: [
      { zh: "编辑器左侧工具条 → 历史按钮。", en: "The action rail's History button." },
    ],
    steps: [
      { zh: "查看最近的操作摘要（含 Agent 与人工的编辑）。", en: "Review recent operation summaries (both agent and human edits)." },
      { zh: "撤销/重做也可用快捷键（默认 Cmd/Ctrl+Z 与 Cmd/Ctrl+Shift+Z）。", en: "Undo/redo also have shortcuts (default Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z)." },
    ],
    shortcutIds: ["editing.undo", "editing.redo"],
    keywords: ["history", "undo", "redo", "历史", "撤销", "重做"],
  },
  {
    id: "search",
    title: { zh: "搜索", en: "Search" },
    // @source apps/web/src/components/editor/EditorActionRail.tsx:118-120,244
    // @source apps/web/src/components/editor/SearchModal.tsx:39-60,247-262
    summary: {
      zh: "搜索框按关键词直达编辑器功能与操作入口，结果按当前选中的片段类型过滤。",
      en: "Search jumps straight to editor features and actions by keyword; results filter by the currently selected clip types.",
    },
    entry: [
      { zh: "浏览器版左侧工具条 → 搜索按钮。桌面版可以用“帮助”中的搜索查找说明，但该搜索不直接执行编辑操作。", en: "Browser: the action rail's Search button. Desktop: Help search finds instructions and does not execute editing actions." },
    ],
    steps: [
      { zh: "输入关键词（如 \"背景移除\"、\"文字属性\"）列出匹配的功能项。", en: "Type keywords (e.g. \"background removal\", \"text properties\") to list matching feature entries." },
      { zh: "选择结果跳转/打开对应功能入口。", en: "Pick a result to jump to or open the feature." },
    ],
    limitations: [
      {
        zh: "搜索范围是编辑器功能与操作入口（含关键词别名），不是项目内容全文检索。",
        en: "The scope is editor features and action entries (with keyword aliases), not a full-text search of project content.",
      },
    ],
    keywords: ["search", "find", "command", "搜索", "查找"],
  },
  {
    id: "export",
    title: { zh: "导出", en: "Export" },
    // @source apps/web/src/components/editor/Toolbar.tsx:476,504-589,611
    // @source apps/web/src/components/editor/ExportDialog.tsx:65(web ProRes/alpha warning)
    summary: {
      zh: "桌面版顶栏“导出”打开完整设置对话框，确认参数后生成本地视频文件。浏览器版另有快速导出与预设菜单。",
      en: "Desktop Export opens the full settings dialog and creates a local video after you confirm parameters. The browser build also provides quick export and preset menus.",
    },
    entry: [
      { zh: "编辑器顶栏右侧的\"导出\"按钮（快捷键 Cmd/Ctrl+E 打开导出）。", en: "The Export button at the right of the top toolbar (Cmd/Ctrl+E opens export)." },
      { zh: "桌面版直接打开设置对话框。浏览器版的“导出选项”菜单列出预设，“自定义导出…”打开完整设置。", en: "Desktop opens the settings dialog directly. Browser Export options lists presets; Custom export… opens full settings." },
    ],
    steps: [
      { zh: "桌面版：先选预设，或切换“自定义”使用 MP4 与项目参数，再点“开始导出”选择保存位置。预设模式未选择预设时不能开始。浏览器版直接点“导出”可快速生成 MP4。", en: "Desktop: choose a preset, or switch to Custom for MP4 and the project's settings, then Start Export and choose a destination. Presets mode requires a selected preset. Browser: clicking Export can produce an MP4 directly." },
      { zh: "自定义导出：在对话框中设置分辨率、帧率等完整参数（含 AI 画质放大选项）后开始导出。", en: "Custom export: set full parameters (resolution, frame rate, and an AI upscaling option) in the dialog, then start." },
      { zh: "导出是后台任务，可随时取消；完成后得到本地视频文件。", en: "Exporting is a background job that can be cancelled; the finished video lands as a local file." },
    ],
    shortcutIds: ["file.export"],
    limitations: [
      {
        zh: "网页（浏览器）导出不支持 ProRes 与 alpha 通道，需要桌面应用；网页导出会以 H.264 编码且不带透明度。",
        en: "Browser export cannot produce ProRes or alpha (desktop app required); web export encodes H.264 without transparency.",
      },
      {
        zh: "\"AI 画质放大\"是导出期的上采样处理，依赖 WebGPU；环境不支持时按降级路径继续。",
        en: "\"AI upscaling\" is an export-time upscaling pass that relies on WebGPU; unsupported environments continue on a fallback path.",
      },
    ],
    keywords: ["export", "render", "mp4", "prores", "upscale", "导出", "渲染", "放大"],
  },
  {
    id: "editor-tours",
    title: { zh: "编辑器导览", en: "Editor Tours" },
    // @source apps/web/src/components/editor/EditorActionRail.tsx:217,225
    // @source apps/web/src/components/editor/tour/tour-steps.ts:10-76
    // @source apps/web/src/components/editor/tour/mograph-tour-steps.ts:11-128
    summary: {
      zh: "桌面版首次进入视频编辑器会显示分步导览；之后可在“帮助 → 快速开始”重新打开。浏览器版保留布局与动画/效果导览。",
      en: "Desktop shows a tour on first entering the video editor; reopen it from Help → Quick Start. The browser build also retains layout and animation/effects tours.",
    },
    entry: [
      { zh: "桌面版：打开视频项目 → 顶栏“帮助” → 快速开始 → 界面导览。浏览器版：左侧“更多”菜单 → 编辑器导览 / 动画与效果导览。", en: "Desktop: open a video project → Help → Quick Start → Interface tour. Browser: action rail More → Editor Tour / Animation & Effects Tour." },
    ],
    steps: [
      {
        zh: "编辑器导览：左侧工具与媒体、下方时间线、中间预览、右侧检查器的布局 walk-through。",
        en: "Editor tour: a walk-through of the left tools/media, bottom timeline, center preview, and right inspector.",
      },
      {
        zh: "动画导览：关键帧（检查器与时间线）、曲线编辑、运动路径、粒子与文字动画。",
        en: "Animation tour: keyframes (inspector and timeline), the graph editor, motion paths, particles, and text animations.",
      },
    ],
    limitations: [
      {
        zh: "导览完成标记保存在本机浏览器存储；清空站点数据后导览可能再次出现。",
        en: "Tour completion markers persist in local browser storage; clearing site data can bring the tours back.",
      },
    ],
    keywords: ["tour", "onboarding", "guide", "animation tour", "导览", "引导", "新手"],
  },
];

/* ------------------------------ queries ------------------------------ */

/** help.list_screens takes no parameters (closed empty schema). */
export type ManualListScreensParams = Record<string, never>;

export interface ManualDescribeParams {
  /** A screen id from help.list_screens. */
  readonly screenId: string;
}

export interface ManualSearchParams {
  /** zh/en keyword: non-empty after trim, at most 100 characters. */
  readonly query: string;
}

/** Manual index entry (help.list_screens item): identity + one-liners only. */
export interface ManualScreenSummary {
  readonly id: string;
  readonly title: ManualLocalizedText;
  readonly summary: ManualLocalizedText;
  readonly hasScreenshot: boolean;
}

export interface ManualIndexMeta {
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly languages: readonly (typeof GUI_MANUAL_LANGUAGES)[number][];
  readonly screenshots: ManualCapability["screenshots"];
}

export interface ManualListScreensResult {
  readonly manual: ManualIndexMeta;
  readonly total: number;
  readonly screens: readonly ManualScreenSummary[];
}

export interface ManualDescribeResult {
  readonly manual: ManualIndexMeta;
  /** "available" when the screen carries a delivered screenshot, else "pending". */
  readonly screenshotStatus: "pending" | "available";
  readonly screen: ManualScreen;
}

export interface ManualSearchHit {
  readonly id: string;
  readonly title: ManualLocalizedText;
  readonly summary: ManualLocalizedText;
}

export interface ManualSearchResult {
  readonly manual: ManualIndexMeta;
  readonly query: string;
  readonly total: number;
  readonly hits: readonly ManualSearchHit[];
}

const manualIndexMeta = (): ManualIndexMeta => ({
  contentVersion: GUI_MANUAL_CONTENT_VERSION,
  appVersion: GUI_MANUAL_APP_VERSION,
  languages: GUI_MANUAL_LANGUAGES,
  screenshots: GUI_MANUAL_SCREENS.some((screen) => screen.screenshot !== undefined)
    ? "delivered"
    : "reserved-not-delivered",
});

/** help.list_screens: the whole index, one line per screen. */
export function listManualScreens(): ManualListScreensResult {
  return {
    manual: manualIndexMeta(),
    total: GUI_MANUAL_SCREENS.length,
    screens: GUI_MANUAL_SCREENS.map((screen) => ({
      id: screen.id,
      title: screen.title,
      summary: screen.summary,
      hasScreenshot: screen.screenshot !== undefined,
    })),
  };
}

function localizedTextMatches(text: ManualLocalizedText, needle: string): boolean {
  return (
    text.zh.toLowerCase().includes(needle) ||
    text.en.toLowerCase().includes(needle)
  );
}

function screenMatches(screen: ManualScreen, needle: string): boolean {
  if (screen.id.toLowerCase().includes(needle)) return true;
  if (localizedTextMatches(screen.title, needle)) return true;
  if (localizedTextMatches(screen.summary, needle)) return true;
  if (screen.entry.some((step) => localizedTextMatches(step, needle))) return true;
  if (screen.steps?.some((step) => localizedTextMatches(step, needle))) return true;
  if (screen.limitations?.some((limit) => localizedTextMatches(limit, needle))) return true;
  if (screen.visibility && localizedTextMatches(screen.visibility, needle)) return true;
  if (screen.shortcutIds?.some((id) => id.toLowerCase().includes(needle))) return true;
  if (screen.keywords?.some((keyword) => keyword.toLowerCase().includes(needle))) return true;
  return false;
}

/**
 * help.search: case-insensitive zh/en keyword match over the whole manual,
 * returned as restrained hits (never the full page bodies).
 */
export function searchManualScreens(query: string): ManualSearchResult {
  const needle = query.trim().toLowerCase();
  const matches = GUI_MANUAL_SCREENS.filter((screen) => screenMatches(screen, needle));
  return {
    manual: manualIndexMeta(),
    query,
    total: matches.length,
    hits: matches.slice(0, HELP_LIBRARY_LIMITS.maxSearchResults).map((screen) => ({
      id: screen.id,
      title: screen.title,
      summary: screen.summary,
    })),
  };
}

/* ------------------------------ schemas ------------------------------ */

export const HELP_LIST_SCREENS_SCHEMA: ObjectSchema = {};

export const HELP_DESCRIBE_SCHEMA: ObjectSchema = {
  screenId: {
    check: isNonEmptyString,
    describe: "a screen id from help.list_screens (e.g. \"timeline\", \"media-panel\")",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const HELP_SEARCH_SCHEMA: ObjectSchema = {
  query: {
    check: (v) =>
      isNonEmptyString(v) &&
      (v as string).trim().length > 0 &&
      (v as string).length <= HELP_LIBRARY_LIMITS.maxQueryLength,
    describe: `a keyword of 1..${HELP_LIBRARY_LIMITS.maxQueryLength} characters; matched against zh/en titles, summaries, entries, steps, limitations, shortcut ids and keywords`,
    required: true,
    emits: {
      kind: "leaf",
      schema: { type: "string", minLength: 1, maxLength: HELP_LIBRARY_LIMITS.maxQueryLength },
    },
  },
};

/* --------------------------- session bodies --------------------------- */

/**
 * Shared boundary predicate (the preset-verbs pattern): true when the id is
 * in the manual. The session body and the transports' runtime mirrors share
 * this predicate so neither can drift from the actual id lookup.
 */
export function isKnownManualScreenId(screenId: string): boolean {
  return GUI_MANUAL_SCREENS.some((screen) => screen.id === screenId);
}

/**
 * help.describe body shared by both session kinds: one screen, restrained —
 * never the whole manual. An unknown id is an honest INVALID_PARAMS that
 * points back at the index, and a screen without a screenshot asset reports
 * "pending" instead of inventing one.
 */
export function describeManualScreen(screenId: string): ManualDescribeResult {
  const screen = GUI_MANUAL_SCREENS.find((candidate) => candidate.id === screenId);
  if (!screen) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `help.describe: unknown screenId "${screenId}"; call help.list_screens for the index (${GUI_MANUAL_SCREENS.length} screens)`,
    );
  }
  return {
    manual: manualIndexMeta(),
    screenshotStatus: screen.screenshot !== undefined ? "available" : "pending",
    screen,
  };
}
