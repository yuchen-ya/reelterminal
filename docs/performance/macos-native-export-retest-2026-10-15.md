# 2026-10-15 修复后 macOS 新包：十次真实导出与五分钟空闲复测

**10次真实导出及输出验证全部通过，空闲观察实际持续300.442秒。导出期间仍有残余增长：export renderer的top MEM从791增至983 MiB，描述性斜率+18.285 MiB/次；空闲后回落到745 MiB，10个空闲采样点均为745 MiB。** 本轮未观察到空闲段继续明显增长，但没有证明反复导出的长期内存上界，不能称为已证实无泄漏。

本轮仅重新打包、校准、新包串行真实导出及空闲观察，**没有重跑R02、T03**。旧失败、旧内存数据及原发布结论保留；前序验收见[原报告](macos-2026-10-15-results.md)，修复原因和回归见[逐次导出归因](macos-export-memory-attribution-2026-10-15.md)。[机器可读结果](macos-native-export-retest-2026-10-15.json)保留逐次、逐进程数据及证据哈希。

## 被测源码和新包

- 实际源码：`a8c6925cfa067a25e347db41ba7be050b5c4757d`，构建时工作区干净，production build。包含冷引擎初始化修复`cc7e7834a52f4e1ed7a47ca84828fcb59e8dbfb0`、片段独立游标与回收修复`3088bf4f2f45233b6aa552ba0b4f9ba6a7c546b5`；本轮未改运行时代码。
- 实际应用版本**1.1.2**；原请求基准`84005f5d7f83317c11474f6eefa38dd2f76b79da`为祖先，不将此次结果标为1.1.1包通过。合成画面的旧文字“MAC 1.1.1 REAL MEDIA”只是fixture标签，版本以包元数据和构建戳为准。
- 按仓库`dist --mac dmg zip --arm64 --publish never --config.mac.notarize=false --config.mac.identity=null`构建，output为`release/macos-1.1.2-export-cursors-fixed-2026-10-15`。成功耗时77.749秒；未签名、公证或发布。
- `REELTERMINAL_E2E_APP_EXECUTABLE`指向新包`apps/desktop/release/macos-1.1.2-export-cursors-fixed-2026-10-15/mac-arm64/ReelTerminal.app/Contents/MacOS/ReelTerminal`；实际`packaged=true`、arm64，没有外部worker bundle覆盖。
- app.asar SHA-256：`5c11ff60687d0f2de0dd7df999d9586fe3251e82654297165e8fd9f0117227a0`；内嵌worker：`d8f9fdc0b724f6904bf00d3361fe7ad5af84f696576e127e8251fe1ac615aa0b`，与已验证修复的正常production worker一致。main、preload、构建戳和190个renderer文件与本次构建一致，仅空`.gitkeep`按打包规则排除。
- DMG SHA-256：`48c1cf3a077d07b0056e1c864a72bcc9d16d671b7e2c445c5fc557419a3b56c0`；ZIP：`06a46732b62a81938eb943ac7fe9020be572d174d88d722e75268cd15429da45`。包保留于上述release子目录。

环境：MacBook Air Mac14,2／Apple M2（4P+4E）／8 GiB／arm64；macOS27.0.1(26A434)，Node23.11.0，pnpm11.7.0，FFmpeg9.0.1。Electron44.5.1／Chrome152.0.7977.130；独立导出Chromium148.0.7778.96。素材由软件libx264/AAC生成；实际导出使用Chromium WebCodecs H.264/AAC，偏好prefer-hardware后no-preference，实际编码器未暴露，不能断言硬编或软编。

## 实际完成和正确性

| 项目 | 实际规模与结果 | 状态 |
| --- | --- | --- |
| 首次校准 | 锁屏，visible=true、focused=false，环境阶段失败，零导出；主体5.869秒，命令7.025秒 | 无效，保留原证据 |
| 解锁后校准 | 5个ABBA block、20/20组，隐藏窗口控制被拒绝，blocking/async控制通过；命令80.302秒 | qualified |
| GUI及前置操作 | 三份独立1080p30视频与音频，12/18/12秒；3轮约10秒播放、20轮seek/编辑/撤销/保存、历史预览并返回 | 通过 |
| 真实取消 | 已编码帧后取消，cancelled、artifact=null、目标文件不存在 | 通过 |
| 真实故障恢复 | SIGTERM所属导出browser，error、目标不存在；之后队列完成十次导出 | 通过 |
| 固定工程真实导出 | 10/10串行成功，revision=48；逐份完整解码、流/时长、动态源帧号、转场/PiP、音频校验，十份done状态落盘 | 通过 |
| 空闲观察 | 同进程完整300.442秒，10个点；每点窗口可见、队列清空；无强制GC、重启或清历史 | 完成，残余风险见下文 |
| 独立音频复核 | 十份各解码1–2秒PCM，440/880/990Hz振幅与邻频比检查 | 10/10通过 |
| R02/T03 | 按本轮范围未运行，不移用前序结果作为新包长时通过证据 | 未重测 |

真实场景命令总耗时**558.161秒**（测试主体556.642秒），含素材准备、前置、十次导出及逐份验证、完整空闲段；音频独立复核另0.792秒。重负载串行，周期OS/只读CDP观察器仅采集证据。

固定工程1920×1080@30、12秒，3条视频轨及文字、双PiP、交叉转场，绿色片段1.5x varispeed（pitchCorrection=false）。pitchCorrection=true被能力明确拒绝，原错误保留。MP4/H.264/6000kbps、AAC48kHz双声道。前置及第一份后各有一个串行真实normalize任务，第二个未注册到工程，不改变固定revision。

每份视频360帧、12.000秒；AAC和容器12.074667秒，在既有0.15秒容差内，不宣称音视频时长完全相同。逐份在2/4/6/8秒检查基底和两个PiP的源帧号，误差≤1帧（转场中点基底使用专门混色检查）；保存40张PNG，动态帧哈希不同、叠层颜色、RMS通过。另目视核对新包GUI和第十份转场帧，文字及双PiP可见。

## 逐次内存与耗时

单位MiB。MEM为macOS top MEM，RSS为ps RSS；不与Electron workingSetSize混合，GPU进程内存不等于显存。采样在每份内容验证后，耗时仅为提交到任务完成，不含后续FFmpeg验证/采样。

| 次数 | 任务秒 | 导出renderer MEM | 其RSS | Electron main MEM | GUI MEM | Electron GPU MEM | 导出browser MEM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 9.443 | 791 | 806.56 | 1810 | 1070 | 592 | 23 |
| 2 | 8.329 | 858 | 737.83 | 1868 | 1067 | 526 | 28 |
| 3 | 8.825 | 879 | 498.36 | 1843 | 1027 | 471 | 32 |
| 4 | 8.335 | 888 | 486.38 | 1857 | 1035 | 465 | 36 |
| 5 | 8.357 | 765 | 591.59 | 1877 | 1038 | 481 | 39 |
| 6 | 8.841 | 907 | 453.14 | 1837 | 1037 | 476 | 43 |
| 7 | 8.865 | 932 | 374.53 | 1842 | 1046 | 474 | 47 |
| 8 | 8.884 | 935 | 470.05 | 1834 | 1045 | 474 | 51 |
| 9 | 8.558 | 963 | 599.39 | 1859 | 1051 | 466 | 55 |
| 10 | 8.338 | 983 | 603.31 | 1887 | 1056 | 471 | 59 |

任务秒数分布（最小/中位/最大，仅描述）：

- 导出：前3次 n=3，8.329/8.825/9.443；中4次 n=4，8.335/8.599/8.865；后3次 n=3，8.338/8.558/8.884。
- 编辑/撤销/保存轮次：前7轮 n=7，3.928/4.017/4.751；中6轮 n=6，4.029/4.199/4.404；后7轮 n=7，3.918/4.012/4.089。

导出renderer首尾+192 MiB，OLS +18.285 MiB/次，前五次中位858、后五次935 MiB，第五次有回落，不能说单调增长。导出browser MEM 23→59 MiB、OLS +3.909 MiB/次，也有残余累积。导出GPU前五个MEM点32 MiB、后五个未进入top保存行，按缺测处理；ps RSS均有记录，不能以0代缺测。

Electron main=5195、GUI=5200、GPU=5196；导出browser=5883、renderer=5886、GPU=5884，十次和空闲期间PID均未变化。故障前置有意结束旧worker5271，新worker在固定十次之前建立；不把它藏作测量段内内存重置。

| 进程 | 第一份后MEM/RSS | 第十份后MEM/RSS | 最后空闲MEM/RSS | Electron workingSetSize：首/十/空闲 |
| --- | --- | --- | --- | --- |
| electron_main | 1810/170.84 | 1887/177.38 | 1811/102.53 | 170.67 / 177.08 / 102.25 |
| electron_renderer | 1070/169.03 | 1056/195.55 | 1052/80.66 | 167.72 / 195.28 / 75.27 |
| electron_gpu | 592/72.20 | 471/57.44 | 417/42.53 | 72.20 / 57.44 / 44.25 |
| export_browser | 23/76.28 | 59/55.95 | 59/49.72 | 未采到 / 未采到 / 未采到 |
| export_renderer | 791/806.56 | 983/603.31 | 745/74.98 | 未采到 / 未采到 / 未采到 |
| export_gpu | 32/56.48 | 未采到/33.27 | 未采到/32.19 | 未采到 / 未采到 / 未采到 |

## 空闲与资源保留判断

| 空闲秒 | 导出renderer MEM/RSS | main MEM | GUI MEM | main heap | GUI heap |
| --- | --- | --- | --- | --- | --- |
| 30.453 | 745/117.61 | 1811 | 1052 | 61.493 | 26.610 |
| 60.892 | 745/83.50 | 1810 | 1052 | 61.855 | 26.675 |
| 91.327 | 745/84.41 | 1811 | 1052 | 61.484 | 26.738 |
| 121.757 | 745/82.67 | 1811 | 1052 | 61.834 | 26.802 |
| 152.198 | 745/76.25 | 1812 | 1052 | 61.477 | 26.866 |
| 182.639 | 745/75.09 | 1811 | 1052 | 61.869 | 26.935 |
| 213.066 | 745/79.52 | 1810 | 1052 | 61.513 | 26.998 |
| 243.506 | 745/77.75 | 1811 | 1052 | 61.859 | 27.065 |
| 273.948 | 745/75.45 | 1811 | 1052 | 61.491 | 27.128 |
| 300.440 | 745/74.98 | 1811 | 1052 | 61.836 | 27.191 |

- **空闲段未见top MEM继续增长**：导出renderer 983→745 MiB后十点固定，OLS=0 MiB/分钟（整数MiB精度）；RSS从首个空闲点117.61降至74.98 MiB。RSS下降不能独立证明释放，因为压缩/换出也影响驻留。
- 空闲约13/253秒两份vmmap：physical footprint 745.2/745.3 MiB；shared memory均650.8 MiB、159区域。resident 38.0 MiB→约1.1 MiB，swapped 607.9→644.8 MiB，驻留下降伴随换出，共享保留未同步消失。stdout/stderr均保存，均提示PartitionAlloc无法检查、分析可能不完整，不能指定C++分配所有者。
- 导出worker空闲JS heap 8.784→8.797 MiB，小增约13.1 KiB，DOM固定1 document/23 nodes/28 listeners。只读CDP附加本身也分配对象；周期heap并非逐份精确收尾heap，无强制GC，不能将小变化直接判为产品泄漏。
- GUI heap空闲26.610→27.191 MiB，main heap在61.477–61.869 MiB波动。GUI有小幅增长，未将观察器/定时器开销、自然GC与产品保留彻底分离，未证明长期平台。Electron main及GUI最后仍保留1811/1052 MiB的top MEM，不能称全应用已回落到低占用；这些口径不能相加为独占物理内存，当前复测也未完成其底层保留归因。
- 实际actionCapacity=1000；十次及空闲期间actionUndo=18、redo=0、redoJournal=20、changeJournalEntries=104、changeJournalRevisions=48全部固定。此次固定工程导出复测，**不把18条历史称作容量饱和长测**；先前R02容量饱和证据保留，本轮未重跑。
- workspace runtimes=1，queuedWrites/pendingWrites/activeWriteDrainCount/queuedCommandCount/failedWriteCount均0；autoSave idle，无pendingRevision/scheduledSave。字体projectLeases=2、documentFaces=251。已暴露ownedBlobUrls及四类preview/motion缓存均0；allBlobUrls/decoderContexts/webWorkers未暴露，按unavailable处理。
- 同机旧记录renderer 3580→7201、空闲7014 MiB；本次未重现数GiB累积，但不是正式受控ABBA内存比较。此前主触发路径显著缓解，导出阶段仍有残余累积，长期上界未验证。

## 环境、失败及范围

解锁后22个主机采样均AC，HIDIdleTime连续递增、重置0次；正式资源采样窗口均可见，caffeinate在阶段期间保持系统/显示器唤醒。后台有远程桌面、WindowServer、Codex及OS服务；30秒离散采样中WindowServer峰45.8%、UURemoteServer24.6%、Codex renderer19.1%，不能排除更短尖峰。20个正式点均记录memory pressure level=2；swap used 4696.38→4448.44 MiB。**本轮是功能及内存诊断证据，耗时不认证为无干扰性能基线。**

首次锁屏校准失败的日志、环境快照及截图保留，用户解锁后新隔离profile重试，没有覆盖失败结果。worker观察器在result生成前有一次`owned_run_not_ready`，随后正常采样；这是未就绪状态。报告生成器曾误读独立音频结果字段（应读status，误取passed），仅后处理失败，记录保留，未修改原始结果或重跑正式测试。

本轮运行时代码未改；已有45项有意义回归及类型检查见归因报告，不以单元测试数量替代压力覆盖。未放宽阈值、减少十次负载或以模拟后端替代。本轮不清除前序R02小幅heap趋势、启动超时、原生OS采集选择器未覆盖等风险，不推断Windows结果或跨机比较绝对性能。

**发布判断：新包导出功能复测通过，五分钟空闲未见继续明显增长；仅凭本轮证据仍不足以整体放行macOS发布。** 当前包1.1.2，不能作为1.1.1二进制的通过结论。

## 原始证据和收尾

本机证据根：`apps/desktop/e2e/.artifacts/macos-native-export-10x-2026-10-15/`。

- `native-build.log`、`native-build-result.json`、`native-package-identity.json`、`packaged-downloads.json`：构建及包身份。
- `native-probe.log`/`stage-results.json`：锁屏失败；`native-probe-r2.log`/`stage-results-r2.json`：重试各阶段返回码和实际时长。
- `host-observations.jsonl`、`wake-verification-r2.json`、`wake-observations-r2.jsonl`：电源、输入、负载、唤醒；`host-summary.json`限定本轮时间范围。
- `worker-heap.jsonl`、`worker-observer-dispatch.jsonl`及两份`vmmap-*-5886-idle.txt`：worker PID/heap/DOM及完整stdout/stderr。
- `analysis.json`、`audio-verification.json`：独立复算和频率核对。
- `EVIDENCE-MANIFEST.json`：原始文件、脚本、成功与失败证据SHA-256；前序报告29个已列原始文件哈希全部复核一致。

实际场景目录：`apps/desktop/e2e/.artifacts/performance/real-media-1792047601726/`，含`result.json`、`export-resources.jsonl`、十份`export-0.mp4`至`export-9.mp4`、40张PNG、三份测试源副本、两份normalize WAV、14份`.status.json`、历史/GUI截图及脱敏日志。校准原件为`performance/probe-calibration-1792042297186.*`（失败）和`performance/probe-calibration-1792047521523.json`（qualified）。大文件仅保留本机`.artifacts`，Git保存报告、结构化摘要、路径与哈希，不宣称远端包含原视频。

成功profile由harness清理，本次应用、导出browser、monitor和caffeinate均退出核查，未关闭用户应用。包与证据保留。本轮范围结束，不再扩大重构、全量长跑、打标签或发布。
