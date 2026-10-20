# ReelTerminal 本地补充验收 — 2026-10-20

> 后续状态：用户已授权修复；B1/B2 已在源码和本地开发构建修复并通过真实模型复测，见文末“授权修复与复测”。下方保留修复前的验收事实，原安装包仍为修复前版本。

## 结论

本轮完成 Windows 本地补充验收，发现 **2 项字幕发布阻塞**，未改产品代码：

1. Qwen 显式指定中文时，对齐收到 `language=None`，真实字幕生成失败。
2. Windows Python `-I` 模式下 stdin 使用 GBK，SenseVoice 中文转录传给 Qwen 对齐器时损坏，真实词级字幕链失败。

Qwen 自动语言、SenseVoice 分析记录导入字幕、Demucs 分离、隔离安装后的编辑/保存/重开/真实导出、两个候选锁用例和短性能场景通过。各项通过只覆盖下述具体路径，不代表全部发行验收完成。没有同机同条件旧基线，不宣称无性能退化。

## 版本与安装包身份

- 开始时主目录 `main` 干净，SHA `f4344feac3fc95816df1d8b2fdfae449393fa773`，是测试提交的祖先，落后 20 个提交。
- 用户随后授权合并测试路线，执行 `git merge --ff-only test/hosted-1.2.4-20261019`；主目录 `main` 现在为 `270f0cae8006a4ed96da9a13b2139dc49a79d3ff`。没有额外 merge commit，没有推送。
- 远端测试分支核对为同一 SHA；远端 main `9a08255d…` 是更早历史，不是更新进度。
- 之后所有执行均在主目录。旧 `.worktrees/hosted-1.2.4-20261019` 只保留历史证据，不再承担开发/测试写入。
- 本轮结果均记录实际 SHA 和 **dirty=true**：新增验收脚本/测试，产品跟踪文件没有改动。构建时新增项为 agent-facade 真实模型测试和 `scripts/local-acceptance/`；导出计时测试与本报告在构建后新增。安装包内构建身份保留构建当时的 dirty digest，不能描述为干净发行包。
- 主目录旧构建标记为 `142a7b96…`，测试目录旧构建标记为 `12a77cb5… / dirty`，均未冒充当前版本使用。主目录旧 dist、web dist 和 GUI 证据备份在本轮 `preexisting/`。

安装包：`apps/desktop/release/local-acceptance-270f0cae-20261020/ReelTerminal-1.2.4-x64.exe`

| 项目 | 实测身份 |
| --- | --- |
| 版本 / 架构 | 1.2.4 / Windows x64，Electron 44.5.1 |
| 大小 | 158,903,719 bytes |
| SHA-256 | `b5be6cb6a7bb57f74feb249f9bb6abe8a914c0af4ab19b6708b6a8c9c1ff8784` |
| 签名 | NotSigned；构建日志的 signing 阶段不能当作有效签名证明 |
| 包内 source_head | `270f0cae8006a4ed96da9a13b2139dc49a79d3ff` |
| 包内 dirty | true |
| 安装方式 | NSIS `/S /CURRENTUSER /D=<独立验收目录>`，退出 0，5.21 秒 |
| 实际安装目录 | 上述 release 子目录下的 `installed/` |

安装前未发现 ReelTerminal 卸载登记或运行实例。没有覆盖正式安装，没有卸载、清理用户数据或更改系统权限。隔离安装会留下其自身当前用户安装登记/快捷方式；本轮不自动卸载。安装后的测试均使用 harness 私有用户数据、endpoint 和合成工程。未使用用户 live endpoint。

## 环境、模型与资源口径

- Windows 11 x64；Ryzen 7 9700X，8 核/16 线程；约 61.7 GiB 内存。
- RTX 5080，16,303 MiB 显存，驱动 616.92。
- 初始 C/D/E 盘余量约 69.6 / 557.6 / 493.5 GiB。结束约 69.5 / 557.6 / 492.1 GiB，以 `environment-summary.json` 为准。
- 浏览器、ComfyUI、聊天程序、动态壁纸等后台进程保持运行。初始整卡显存约 2.4 GiB，结束采样 2681 MiB / 4% GPU utilization；不能把差值归因于被测应用。
- 全部模型及解释器复用现有安装，没有安装/升级 Python 包，没有下载模型、调用收费 API 或云 GPU。构建器使用本机 Electron/NSIS 工具缓存；没有执行依赖升级。
- 保留材料约 225,666,097 bytes（含旧证据备份）；release 目录合计约 1,323,355,195 bytes。它们不是进程运行时峰值。

| 路径 | 真实模型与后端 | 环境版本 |
| --- | --- | --- |
| SenseVoice 分析 | `iic/SenseVoiceSmall`，936,291,369 B，代码钉住 SHA `833ca2dc…204a3ea`；FunASR/PyTorch，CPU；时间戳来源为外部 Silero VAD | funasr 1.3.1、modelscope 1.34.0、torch 2.10.0+cu128、soundfile 0.13.1、numpy 1.26.4 |
| SenseVoice GUI 字幕 | 同一 SenseVoice ASR + Qwen ForcedAligner；CPU；与上面的 VAD 句级导入是不同链路 | ASR 环境同上，aligner 环境同 Qwen |
| Qwen 字幕 | `Qwen/Qwen3-ASR-1.7B-hf` + `Qwen/Qwen3-ForcedAligner-0.6B-hf`，4,076,193,080 / 1,835,545,960 B；Transformers，CPU float32 | transformers 5.20.1、torch 2.14.1+cpu、soundfile 0.14.0、numpy 2.5.4、librosa 1.0.0 |
| Demucs | `adefossez/HTDemucs` 的 `htdemucs`，`955717e8.safetensors`，84,025,440 B，代码钉住 SHA `d9fa1413…17576dd`；CUDA | demucs 4.1.0、torch 2.9.1+cu128、soundfile 0.14.0、numpy 1.26.4 |

Qwen 本地文件未提供已核实的上游 revision pin，本报告不编造模型提交版本。SenseVoice/Demucs 的固定权重校验由产品真实调用路径执行。HF 快照中的 Demucs 是符号链接，链接 Length=0 不代表权重为空，实际 blob 已读并加载。

Qwen/SenseVoice 字幕只测试当前支持的 CPU 路径；没有强行启用 Qwen GPU、其他同名模型、DeepFilterNet 或额外推理后端。

资源采样由 `scripts/local-acceptance/measure.py` 每约 0.75 秒加一次 nvidia-smi 开销采样。RSS 是进程树之和，包含共享页重复计算；可能漏掉瞬时峰值。GPU 指标是整卡，含后台程序，不是本应用专属显存。CPU 表中是系统峰值，不是本应用独占 CPU。每轮结束等待约 1 秒后检查已观察子进程；所有完成轮次 survivor 列表为空。没有进行操作系统缓存清空。

## 逐项实测清单

原始日志及 JSON 均在仓库内 `.cache/local-acceptance-20261020/`，下表文件名相对此目录。

| 项目 | 结果与范围 | 总墙钟秒 / 采样树 RSS 峰值 MiB | 证据 |
| --- | --- | --- | --- |
| SenseVoice 真实分析链 | 2 项通过：worker 中文输出；Silero→分析记录→字幕导入，验证字幕非空/中文及 provenance | 33.02 / 3753.6 | `sensevoice-real-first.*` |
| Qwen 指定 zh | **失败**：`Word alignment does not support detected language: None` | 29.44 / 8881.4 | `qwen-real.*` |
| SenseVoice 词级字幕 | **失败**：`utf-8 codec can't encode ... surrogates not allowed` | 29.17 / 4440.9 | `sensevoice-captions.*` |
| Qwen 自动语言 | 初次/再次真实 ASR+对齐通过，分别 27.39/22.74 秒；有效中文、单调且范围内时间戳 | 整组 60.33 / 8850.9 | `qwen-auto-and-cleanup.*`、`qwen-auto-captions.json` |
| Qwen 取消/错误 | 5 秒后取消；缺失输入拒绝；整组结束无残留。后续安装版 Qwen 再次成功。取消发生在 worker 运行期，未证明位于具体算子内部 | 同上 | `qwen-cancel-failure.json` |
| SenseVoice 生命周期 | 已收到模型加载后的 transcribe progress 后取消；缺失输入失败；再次推理恢复并识别“圆周率” | 24.48 / 3670.1 | `sensevoice-lifecycle-metrics.*`、`sensevoice-lifecycle-lifecycle.json` |
| Demucs 应用链 | vocals/instrumental 两次任务通过；真实处理产物契约为 48kHz、双声道、240000 samples | 33.91 / 1798.3 | `demucs-real.*` |
| Demucs 19 秒混音 | 四轨 44.1kHz 双声道，有限数值、相同长度；vocals 非静音；重建相对 L2 误差 0.03998 | 4.24 / 1475.5 | `demucs-quality-*`、`demucs-stems/` |
| Demucs 生命周期 | 模型加载后 separate progress 取消、缺输入失败、再运行恢复四轨 | 8.30 / 1670.1 | `demucs-lifecycle*`、`demucs-recovery/` |
| 当前源码构建 / NSIS 打包 | 均通过，独立 release 子目录 | 34.98 / 2417.5；32.45 / 1203.0 | `build-desktop.*`、`package-nsis.*` |
| 实际安装 / 包内资源 | 安装退出 0；安装包内 SHA/dirty核对；六个 Python worker 和 icon.png 存在 | 安装 5.21 | `installation.json`、`installed-identity.json` |
| 安装版真实字幕 GUI | 通过：导入19秒音频、Qwen默认自动语言、生成四条字幕、单次撤销保留音频 | 39.91 / 9846.4 | `installed-local-captions.*`；原GUI证据已保存到 `installed-caption-gui/` |
| 安装版编辑/保存/重开/导出 | 定向两项通过；包括分割/撤销/保存、重启后素材存在、真实导出并完整解码 | 33.86 / 1976.8 | `installed-edit-save-export.*` |
| 安装版固定工程重复导出 | 1920×1080、30fps、5秒、单图像；H.264/yuv420p；两次完整解码，均68378B | 实际导出 3.84 / 3.09；整轮13.03 / 1410.0 | `installed-export-*`、`first-export.mp4`、`repeat-export.mp4` |
| Windows 输出锁 | 单次通过；锁住目标后拒绝替换，旧内容不变且可完整解码 | 2.61 / 319.8 | `windows-output-lock.*` |
| Chromium 页面锁 | 单次通过；排队预览快速失败，持锁结束后渲染恢复 | 5.81 / 857.2 | `chromium-page-lock.*` |

语音素材来自已有合成中文双人 TTS 真值样本，截取前19秒；未使用私人录音。Qwen/SenseVoice 都把“陶”识别成“桃”，因此这里的“有效文本”不是零识别错误或正式准确率认证。Demucs 混音使用合成语音+固定音调，不代表真实复杂音乐的分离质量；保留音轨可进一步试听。Demucs worker 测得推理 0.757 秒、加载0.304秒、PyTorch显存分配峰值594 MiB；整卡采样峰值3646 MiB，不混为同一指标。

安装截图确认应用界面标识和字幕时间线。未单独验证 Windows 原生任务栏/Alt-Tab 图标；资源文件存在不是完整原生图标验收。安装向导交互未测（本轮为静默安装），升级兼容未测（没有已核验旧安装包/旧版本隔离工程），macOS 未测。没有把解包目录启动当作真实安装。

定向 `-t` 运行产生的“skipped”是此次未选择的同文件用例，例如导出锁7项、onboarding/reelctl 4项；这些与历史14项 opt-in 跳过不是同一列表，不计通过。

## 两项问题的复现与最小修复建议

### B1 — Qwen 显式语言丢失（发布阻塞）

在隔离音频配置中提供上述 Qwen 模型，调用：

```text
transcribeCaptionFile(speech19s, 19, "zh", signal, "qwen")
```

实测失败原文见 `qwen-real.log`。同素材 `language="auto"` 两次通过，安装版 GUI 默认自动语言也通过。

只读根因：Transformers 5.20.1 `apply_transcription_request` 把 `language Chinese<asr_text>` 放入输入 prefill。产品 `caption_models.py` 只解码新增 token，显式语言模式续写正文不含语言前缀，parser 因而返回 `language=None`。产品原样保存该值后，aligner 的语言白名单拒绝。

最小方案：构造 segment 时，解析语言为空且请求语言明确不是 `auto`，使用调用者已选择的语言；自动语言模式保持严格校验，不一律默认中文。增加显式语言的真实/契约回归。**本轮未实施。**

### B2 — Windows worker stdin 编码不匹配（发布阻塞）

同素材调用 SenseVoice 字幕链，ASR 中文输出进入 Qwen aligner 后失败。分析记录→VAD句级字幕导入可通过，不能替代此词级链。

轻量协议复现实测（不加载模型）保存在 `windows-stdin-probe.json`：

- `python -I`，即使设置 `PYTHONIOENCODING=utf-8`，stdin 仍 `gbk / surrogateescape`，中文 JSON 被损坏并出现孤立 surrogate。
- `python -I -X utf8` 读取同一字节流得到正确中文。

根因证据：Node 写 UTF-8 JSON；`-I` 忽略 `PYTHON*` 环境变量；worker 只重配 stdout/stderr，没有设置 stdin。最小方案是在读取 JSON 前显式设 stdin UTF-8/strict，或为 Python 加 `-X utf8`；保留 `-I`。**本轮未实施。**

## 性能短测

正式 P2 工具拒绝指定安装版 executable，因此以下为主目录 **production bundles + Electron runtime**，不是安装版数据。包内源码 SHA相同，但测量形态明确分开。三个 preflight 拒绝日志保留：指定安装版路径不支持、`cold-process` 不是合法选项、T01不支持cold profile；均发生在负载前，不是产品运行失败。随后使用工具支持的选项，没有更改门槛或超时。

| 场景 | 固定条件 | 当前测量 |
| --- | --- | --- |
| T01 warm | seed42，25图像+25文本、2轨；每类5次操作 | 拖动校验中位286.935ms；裁剪296.545ms；滚动57.16ms；zoom53.07ms；seek+内容验证100.49ms |
| P01 warm | 固定2图像+1文本、移动/裁剪/保存/隔离重启回读 | 持久化内容通过；save flush一次17.46ms；移动中位255.82ms（10次）、裁剪254.91ms（5次） |
| H01 fresh-profile | 10节点，2次新进程/新profile，OS缓存未清 | 历史首次进入并验证内容1324.48 / 1412.96ms |
| H01 warm | 同10节点，3次操作 | 85.385 / 94.475 / 96.455ms |
| R01 short | 10轮edit/undo/redo，固定媒体/节点 | 内容验证中位351.1ms；资源返回和保存队列排空断言通过 |

以上是包含驱动/状态/内容验证的操作时间，不是裸输入到显示器扫描输出的延迟。产品 trace 的 `actualPresented` 不支持；探针未完成ABBA校准。样本仅用于短测，p95/p99为空；无同条件基线。H01的冷/热操作定义不同，不能把差值解释成统一“冷启动速度提升”。

对应 P2 JSON 在 `apps/desktop/e2e/.artifacts/performance/`：

- `t01-1792480275978-0-0.result.json`
- `p01-1792480287605-0-0.result.json`
- `h01-1792480354580-0-0.cold-summary.result.json`（及两个 constituent）
- `h01-1792480406203-0-0.result.json`
- `r01-1792480423219-0.result.json`

Qwen自动语言整轮系统CPU峰值100%，进程树RSS8850.9MiB；安装版字幕整轮9846.4MiB。不能据此推断其他后台应用没有贡献CPU占用。每轮资源峰值、耗时、采样和限制集中在 `metrics-summary.json` 与各轮原始JSON。没有重跑500轮或30分钟长测，没有长时泄漏结论。

## 历史14个GUI跳过项

旧工作区 `.cache/hosted-artifacts/270-electron/` 有270的截图/JSON，但本地未找到完整测试总数摘要。完整可读汇总 `hosted-preparation/70ca-final-results.json` 属于 **70ca893历史提交**，记录每平台130通过/0失败/14跳过；不能提升为270本轮的整套通过证据。以下名称与当前源码 gate 核对，全部按条件覆盖解释。

| 文件（相对 apps/desktop/e2e）/ 完整测试名称 | 跳过条件、影响及本轮结果 |
| --- | --- |
| `local-captions.e2e.ts` — human generates local captions and undoes the entire batch | 缺CONFIG或WAV；本轮已在实际安装版补测通过，Qwen auto限定。 |
| `preview-copy.e2e.ts` — historical mixed clips copy to current editing with fixed media, relative times and one undo | 缺HEVC_SOURCE；要求原始验收素材，本轮未提供，不冒用其他素材证明历史复现。 |
| `paused-inspector-history.e2e.ts` — copied acceptance project keeps paused pixels through inspector actions and renders real history | CLONE_DIR与PROJECT_ID均缺时跳过，运行还需完整副本/job root；缺隔离验收工程，未测。 |
| `paused-project-switch.e2e.ts` — a paused original HEVC frame returns at the same playhead after switching through an empty project | 缺HEVC_SOURCE；原素材暂停像素复现未测。 |
| `preview-large-project-performance.e2e.ts` — measures a real canvas drag with 1,000 CLI-created text clips | E2E_PREVIEW_PERF未启用；千片段未测，仅本轮50片段短测。 |
| `performance/scenarios.e2e.ts` — runs requested scenarios with owned profiles and report-only evidence | 缺PERFORMANCE_OPTIONS；本轮T01/P01/H01和R01子集通过，不代表全部场景。 |
| `performance/resource-soak.e2e.ts` — fixed resources return after editing and history preview | 缺RESOURCE_SOAK_OPTIONS；通过同底层R01的10轮短测，长soak未重跑。 |
| `performance/release-recording-stress.e2e.ts` — ten real 1080p MediaRecorder cycles with synthetic capture acquisition | RELEASE_FEATURE需recording且非native；本轮未启用十轮录制长测。 |
| 同上 — native macOS display capture of only the owned test window | recording+native capture；当前Windows不适用，需Mac实机。 |
| `performance/release-audio-stress.e2e.ts` — real audio full-event reads, stable records and normalized asset lifecycle | RELEASE_FEATURE需audio；本轮短音频真实模型不替代此压力测试。 |
| `performance/release-assets-stress.e2e.ts` — large asset/node browsing and atomic subtitle imports | RELEASE_FEATURE需assets；大资产压力未重跑。 |
| `performance/real-media-stress.e2e.ts` — three independent 1080p sources, edit/play/seek/history and ten serial real exports | REAL_MEDIA_STRESS未启用；本轮固定图像两次导出不替代多源十轮。 |
| `performance/probe-calibration.e2e.ts` — detects blocking, distinguishes async waiting, and measures five ABBA blocks | PERFORMANCE_CALIBRATION未启用；探针精度校准未测。 |
| `performance/playback-av.e2e.ts` — writes verified production decode, commit, scheduling, and timestamp evidence | PLAYBACK_AV_E2E=1且配置包含A01；音画播放时间戳场景未测。 |

这些主要是选择性门控、缺少指定素材和测试成本边界，不能统称“平台不适用”，更不能算通过。当前可安全启用的真实字幕和短性能/资源项目已补；未默认扩展长压力负载。

## 锁超时证据与边界

当前只分别单跑一次 `export-file-protection` 的Windows目标文件锁和 `page-lock` 的Chromium页面队列锁，均通过，没有放宽断言或超时。

未找到用户所述270同提交“首败超时→重试通过”的原始日志，因此原因未定。旧10月15日 `production-batches` rename/EPERM、旧page-lock通过日志和历史Electron `0x80000003` 启动退出是不同事件，不能移花接木解释此次问题。旧证据全部保留。

源码观察：Windows文件锁helper允许10秒获取锁，清理通过关闭stdin并等进程close；harness按文件串行、私有profile、等待Electron退出后清理。当前观察没有进程泄漏证据，但不排除历史调度/资源竞争；缺首次失败诊断不能归因。

## 复现入口

在主目录运行。`RUN` 指向 `.cache/local-acceptance-20261020`；`audio-config.json` 是本轮隔离配置，内含本机路径，仅保留本地，不上传。解释器/模型位置从本机现有配置取得。新脚本不写共享模型配置。

```powershell
$run = Join-Path (Get-Location) '.cache/local-acceptance-20261020'
$env:REELTERMINAL_AUDIO_CONFIG = Join-Path $run 'audio-config.json'
$env:REELTERMINAL_LOCAL_ACCEPTANCE_DIR = $run
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
# 设置 qwen / sensevoice；language=zh 重现B1/B2，qwen+auto为通过路径。
$env:REELTERMINAL_LOCAL_ACCEPTANCE_ENGINE = 'qwen'
$env:REELTERMINAL_LOCAL_ACCEPTANCE_LANGUAGE = 'zh'
pnpm --filter @reelterminal/agent-facade exec vitest run src/local-acceptance-real.test.ts -t 'real captions' --maxWorkers=1
# 生命周期：engine=sensevoice-lifecycle 或 demucs。
pnpm --filter @reelterminal/agent-facade exec vitest run src/local-acceptance-real.test.ts -t 'real loaded model' --maxWorkers=1
node scripts/local-acceptance/protocol-probe.mjs $run
```

SenseVoice/Demucs 原有 real tests 还需要显式门控变量，具体解释器、模型目录、WAV/cache参数及每次精确命令均在对应 metrics JSON `command` 字段与测试头注释。采样执行方式：

```text
<现有带psutil的Python> scripts/local-acceptance/measure.py --output <新结果.json> --timeout <秒> -- <单条命令>
```

GUI 使用 `REELTERMINAL_E2E_APP_EXECUTABLE=<独立安装目录>/ReelTerminal.exe`。真实字幕再设 `REELTERMINAL_CAPTION_E2E_CONFIG` 和 `REELTERMINAL_CAPTION_E2E_WAV`。固定导出测试还需FFMPEG/FFPROBE路径，并使用**新的证据目录**，避免覆盖已留MP4（测试明确拒绝既有同名输出）。

```text
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/local-captions.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/onboarding.e2e.ts e2e/reelctl.e2e.ts -t "first-time user|persist through save and reopen"
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/local-acceptance-export.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run test/export-file-protection.test.ts -t "preserves an existing target when Windows prevents the final replacement"
pnpm --filter @reelterminal/runtime-chromium exec vitest run src/page-lock.test.ts
```

性能精确成功命令：

```text
node scripts/performance/run.mjs --suite quick --scenario T01,P01 --samples 5 --repeats 1 --cache warm --serial --report-only --run-timeout-seconds 120
node scripts/performance/run.mjs --suite quick --scenario H01 --node-count 10 --repeats 1 --cache fresh-profile --cold-launches 2 --serial --report-only --run-timeout-seconds 90
node scripts/performance/run.mjs --suite quick --scenario H01 --node-count 10 --repeats 1 --cache warm --samples 3 --serial --report-only --run-timeout-seconds 90
node scripts/performance/run.mjs --suite quick --scenario R01 --edit-rounds 10 --repeats 1 --serial --report-only --run-timeout-seconds 90
```

P2需要移除安装版override且当前源码与production stamp匹配。本报告/后加测试使当前dirty digest不同于测量时，重跑前按正常构建脚本生成新的身份，不能伪造旧stamp或沿用本轮数字。

## 发布判定与后续

- **发布阻塞：B1、B2。** 应分别最小修复并复测显式语言及中文对齐边界；本轮没有授权实施产品修改，故保留方案。
- **发行验收未完成：** 安装向导交互、升级旧工程兼容、原生Windows窗口图标、macOS安装/Dock/权限。需在适当环境补，不以Windows代替Mac。
- **证据待补：** 历史锁首次失败与同SHA重试的原始日志；当前单次通过不关闭偶发问题。
- **后续质量/性能项目：** 同机基线、ABBA探针校准、复杂音乐分离质量、多语种/长音频/多源视频压力。当前数字不要求自动扩展长测。
- 未提交、暂存、推送、合并PR、打tag或发布；唯一Git历史操作是用户明确要求的本地fast-forward。没有上传音频、模型、日志或含个人路径的配置/报告。

## 授权修复与复测 — 同日后续

用户随后要求直接修复。仅修改两处产品逻辑：

- `packages/agent-facade/python/audio_models.py`：在读请求前明确将 stdin 配为 UTF-8/strict，保留 `-I` 隔离模式。
- `packages/agent-facade/python/caption_models.py`：解析结果没有语言时，使用显式请求语言的已有映射；`auto` 不映射到任意默认语言，仍使用模型检测结果。

在 `audio-models-runner.test.ts` 新增真实worker中文请求回归，无需模型：通过未知任务错误响应校验中文跨stdin/stdout协议完整保留。原有真实模型验收脚本用于修复前后同素材比较，没有使用mock代替推理。

新证据目录为 `.cache/local-caption-fix-20261020/`；修复前的全部日志仍保留。HEAD仍为270f0cae，dirty=true包含以上修复，未提交。开发构建的 source_digest 为 `85c396a5843efa495835ac66818e3e7cf55b076934362e8071d540812e210990`，完整身份见新目录 `build-identity.json`。

| 定向复测 | 结果 | 证据 |
| --- | --- | --- |
| Qwen显式zh，19秒中文 | 首次26.31秒、再次22.40秒通过；文本和词级时间戳有效；取消、缺输入失败检查通过 | `qwen-zh-fixed.*`、`qwen-zh-captions.json` |
| SenseVoice→Qwen词级对齐，19秒中文 | 首次26.13秒、再次25.07秒通过；每次5条字幕、61个word项，时间戳单调且范围内 | `sensevoice-zh-fixed.*`、`sensevoice-zh-captions.json` |
| 三组定向回归 | audio-models-runner、qwen-captions、caption-transcription：23/23通过 | `targeted-regressions.*` |
| 当前desktop生产构建 | 通过，29.16秒 | `build-desktop-fixed.*` |
| 当前开发构建真实GUI | 默认Qwen自动语言生成字幕、整批撤销并保留源音频通过；整轮37.47秒 | `gui-qwen-auto-fixed.*`、当前GUI `.artifacts/local-captions*` |

本次所有采样轮次结束均未观察到子进程残留。Qwen/SenseVoice整轮RSS采样峰值分别8851.6/4454.7MiB，GUI轮次9834.5MiB；沿用前文采样局限，不作为性能改进结论。

**B1/B2在源码与当前开发构建中已解除。** 上一轮的NSIS包和隔离安装未重打包/覆盖，仍保留为修复前证据，不能据此声称安装发行版已经包含修复。其余未测发行项及历史锁首次失败证据缺口不变。没有扩大到其他功能、重构、全套测试或发布。
