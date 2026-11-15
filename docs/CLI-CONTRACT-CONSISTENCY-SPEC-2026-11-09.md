# ReelTerminal Agent 执行契约一致性修复规格

本轮修复同一媒体 ID 的读取版本、默认视频交付目录、编辑校验退出码和离线命令帮助。复用现有 facade、命令目录、权限边界和编辑事务，不新增编辑引擎或资产体系。

状态：2026-11-09 集成验收完成（当时未提交）。第 8 节门槛已通过；实际命令、包内入口、证据及覆盖边界见 [集成交付记录](CLI-CONTRACT-CONSISTENCY-ACCEPTANCE-2026-11-09.md)。本文保留原实施规格，历史基准结果不计作本轮通过证据。

源码基准：`4f0305dc7a5b3bf9605ad5f3d29e794dd347b576`，核对日期 2026-11-09。前一轮在此基准上完成 9 个文件、108 项定向测试及隔离复现；该结果不覆盖本规格要求的新回归，也不代表 `52f21382` 打包产物通过验收。实施者开始前重新检查 HEAD、Git 状态和相关 diff，保留其他人的改动。

## 1. 范围与完成条件

| 执行包 | 优先级 | 交付结果 |
| --- | --- | --- |
| A 媒体版本与错误分类 | P0 | 同一媒体版本读取受控副本；副本不可用明确失败；保留路径保护 |
| B 视频工作目录 | P0 | 默认视频推荐目录可用于交付；旧任务目录继续可用；review 分区默认不获得视频交付权限 |
| C 校验退出码 | P0 | `edit.validate` 的 `valid:false` 退出 3，`valid:true` 退出 0，JSON 保持原样 |
| D 离线命令帮助 | P1，本轮完成 | 嵌套命令 `--help`、`-h` 与 `help <command>` 共用现有帮助生成器，不访问桌面服务 |
| E 集成与包内验收 | 合并门槛 | 用现有 API 完成隔离多轨编辑、导出、验证、保存与重开；验证包内 CLI 的真实进程行为 |

本轮不开发 Timeline Assembly 命令、Assembly 外部编排产品、`audio.asset.*`、TTS 后端、旁白字幕关系模型或自动时长适配策略。上述方向不作为本轮合并前置条件。

所有开发遵守根目录 [AGENTS.md](../AGENTS.md)。只使用当前 checkout；没有额外授权不创建 worktree，不自动提交、推送、安装或发布。GUI 验证使用 [现有隔离 harness](../apps/desktop/e2e/README.md)，不接触用户正在使用的项目、profile 或 endpoint。软件构建和 unpacked 包继续输出到 `apps/desktop/release/` 范围。

## 2. 执行包 A 媒体版本与错误分类

### 2.1 根因与修改位置

[`plugin-runtime.ts`](../packages/agent-facade/src/plugin-runtime.ts) 的 `resolveMediaPath` 当前只读取 `originalUrl`。`media.inspect` 和 `frames.extract` 的媒体 ID 分支均经过这里；实时预览、导出则优先使用 `contentUrl`。

| 文件 | 本轮职责 |
| --- | --- |
| `packages/agent-facade/src/plugin-runtime.ts` | 修复媒体 ID 到文件的选择与诊断；未知媒体 ID 与无文件后端分开处理 |
| `packages/agent-facade/src/source-inspection.ts` | 保持原有范围校验、revision 和源文件变化检查；验证其指纹对应实际受控文件 |
| `packages/agent-facade/src/plugins/frame-tools.ts` | 核对 ID 与显式路径分支；保留路径输入的 media/artifact roots 规则 |
| `packages/agent-facade/src/plugins/source-ref.ts` | 核对共享 ID 分支和路径错误传播，不维护另一份版本选择规则 |
| `packages/agent-facade/src/live-session.ts` | 审计分析、音频处理、比较参考、预览和导出的文件选择；保留已有大小及目标守卫 |
| `packages/agent-facade/src/session.ts` | 审计 headless 已有可达读路径；支持的媒体记录采用相同选择规则 |
| `packages/agent-facade/src/ops.ts`、`src/media/strict-replacement.ts` | 核对严格替换中原版本和候选版本的选择；保留替换、relink 的既有语义 |
| `packages/agent-facade/src/media/path-roots.ts` | 在确有需要时补充文件系统错误原因；保持原有 realpath 和包含关系判断 |

路径表中 `src/media/strict-replacement.ts` 相对于 `packages/agent-facade/`。新增文件仅限有多个真实调用点需要的小型选择/解析函数及其行为测试；不建立 resolver 类层次或可插拔存储系统。

### 2.2 必须实现的选择规则

1. 在本次固定目标的项目快照中查找媒体记录。未知 ID 返回 `NOT_FOUND`，不得通过扫描磁盘补全。
2. `contentUrl` 字段已设置时，只选择这个受控版本。空值格式错误也不能触发降级；只有字段未设置时才按旧媒体处理。
3. 旧媒体没有 `contentUrl` 时，选择 `originalUrl`。两者均无文件后端时明确返回不支持文件读取，保留 Blob/GUI-only 媒体的能力边界。
4. 对选定路径执行该调用边界已有的绝对路径、真实路径、允许根、文件类型和大小检查。检查失败后不尝试另一个版本。
5. 成功后把同一个已选定文件用于探测、抽帧或渲染。不得用受控版本的元数据搭配原始路径上的另一份内容。

导入写入位置可参考 [`media-slice.ts`](../apps/web/src/stores/project/media-slice.ts) 和 [`media-storage.ts`](../apps/web/src/services/media-storage.ts)。它们保留来源路径并写入受控副本，本轮不通过改写 `originalUrl`、重写来源信息或迁移媒体 ID 来修复读取。

“统一”指统一来源选择和失败行为，不要求把所有调用改造成一个拥有所有权限的解析器。特别是，不能拿实时渲染现有的 `stat` 检查替代插件的 media roots 校验，也不能给 ID 分支顺手添加 artifact root 权限。headless 的 checkpoint 仍按现有持久化契约处理；不为不可达的输入扩展 checkpoint schema。

### 2.3 调用链审计清单

实施回执逐行记录“调用点、实际来源选择、是否修改、对应验证”。

| 读取类别 | 必查入口 | 验收方式 |
| --- | --- | --- |
| 原媒体视觉检查 | `media.inspect` | 指纹与渲染输入均来自受控副本 |
| 原媒体抽帧 | `frames.extract` | 真实抽帧像素来自受控副本 |
| 比较、修复候选 | `video.compare`、`patch.apply`，以及使用 `source-ref.ts` 的 image/motion/mask/propagate 工具 | 审计共享解析与实际调用，不要求为本次修复安装可选模型或执行全部算法 |
| 时间线画面 | `preview.render_frame`、`visual.inspect`、比较预览 | provider 收到受控来源；最终 E2E 检查实际画面 |
| 导出 | `export.start` 的媒体映射、比较参考 | 最终输出含受控版本画面 |
| 分析、音频处理 | live/headless 的分析与音频文件选择 | 同一受控优先规则；不触发与本轮无关的云服务或模型 |
| 版本维护 | `media.replace` 的两种输入方式及严格校验；`media.relink` | 替换仍创建/采用明确版本；relink 仍验证用户显式提供的同内容文件 |

`frames.contact_sheet` 接受的是帧图片路径，不接受媒体 ID。它的验收是使用 M02 正确抽出的帧生成接触表，并保留路径保护；不要为它新增媒体 ID schema。review 命令继续使用任务拥有的资源引用，不借本轮统一解析增加私有 Free Board 内容入口。

### 2.4 错误契约

复用 [`errors.ts`](../packages/agent-facade/src/errors.ts) 的现有顶层 code，以 `error.details` 提供可判别原因。下面的 `reason` 和 `sourceKind` 是本轮拟新增的诊断字段，不是当前实现已经支持的字段。

| 情况 | 顶层 code | `details.reason` |
| --- | --- | --- |
| 项目中不存在媒体 ID | `NOT_FOUND` | `media_not_found` |
| 选定文件不存在，文件系统报告 ENOENT/ENOTDIR | `NOT_FOUND` | `source_missing` |
| 真实路径越出允许根，或路径策略禁止 | `INVALID_PARAMS` | `outside_roots` |
| 文件系统明确报告 EACCES/EPERM，或已知读取不可用 | `INVALID_PARAMS` | `source_unreadable` |
| 路径指向目录等非普通文件 | `INVALID_PARAMS` | `not_file` |
| 无本地文件后端 | `UNSUPPORTED` | `file_backing_unavailable` |
| 无法确定原因的真实路径解析失败 | `INVALID_PARAMS` | `unresolvable` |

有媒体上下文时补充 `mediaId` 和 `sourceKind: "controlled" | "original"`。受控文件丢失用 `source_missing` 加 `sourceKind: "controlled"` 表达版本不可用，消息说明没有回退；不要创建第二套媒体错误体系。现有显式路径字段和诊断上下文能保留的继续保留。

`FORBIDDEN` 继续表示 Agent 会话授权不足，不复用于“路径不在允许根”。不能从现有 `unresolvable` 结果臆测是丢失还是权限错误；需要区分时保留原始文件系统错误码。仅捕获本轮能够转换的错误，未知内部错误继续向上传播。不要吞错、重试编辑、扩大 roots 或建议关闭安全校验。

### 2.5 回归用例

| 编号 | 场景与可观察断言 |
| --- | --- |
| M01 | 原文件删除，受控副本存在；`media.inspect` 与 `frames.extract(mediaId)` 成功，工程内容/revision 不变 |
| M02 | 导入受控版本 A 后，把原路径改成视觉可区分的 B；两个检查操作仍读取 A，时间线预览/导出也读取 A；源检查指纹匹配 A |
| M03 | 受控副本丢失、原文件仍可读；明确失败并标明受控来源，不调用渲染/解码器读取原文件 |
| M04 | 受控路径位于允许根外，或通过链接逃逸；拒绝，不回退到合法的原文件 |
| M05 | 旧媒体未设置 `contentUrl`；合法 `originalUrl` 可用；不存在或无文件后端按错误契约失败 |

在 `plugin-tools.test.ts`、`plugins/frame-tools.test.ts`、`live-session.test.ts`、`media-replace.test.ts` 和既有 path-roots 测试中按职责扩展。M01–M05 的解析矩阵可以参数化；不要在每个工具中复制全部矩阵。为共享读取链保留一次真实 FFmpeg 的 M02，不能只断言 helper 返回路径。

M02 至少有一组原文件与受控副本时长不同的反例，同时用不同画面验证实际读到的内容。读取指纹使用现有 `size/lastModified` 和实际源文件事实；无需在每次读取新增全文件哈希。真实像素检验使用项目已有解码工具。权限异常可在明确的文件系统边界注入 EACCES/EPERM，标明其为注入证据，不能伪称 Windows ACL 实测。

## 3. 执行包 B 视频工作目录

### 3.1 固定本轮目录决策

复用 [`host-instance.ts`](../apps/desktop/src/main/live/host-instance.ts) 的 `agentWorkspaceRoot()` 和 `agentWorkspaceScopes()`。不增加平行的 partition registry，不新增 `jobRoot/outputDir/deliveryRoot` 响应字段，不迁移既有任务文件。

| 默认入口 | 保持/修复后的含义 |
| --- | --- |
| 普通 `capabilities.get`、现有 GUI 媒体任务根 | 保留父目录 `agent-workspace` 的既有推荐语义 |
| `video capabilities` | 保留 `agent-workspace/video` 为视频推荐根 |
| `review capabilities` | 保留 `agent-workspace/review` 为 review 推荐根；不因此授予视频导出权限 |
| 默认视频 `deliveryRoots` | 加入同一次分区解析得到的 video root，并保留父目录以兼容既有 `jobs/` 任务 |

这是修复冲突所需的最小变化：两种视频任务布局都有准确的交付规则，旧布局不用移动。保留 `delivery.ts` 的严格 `<deliveryRoot>/jobs/<slug>/output/<name>.mp4` 结构，不改成“父根下任意后代均可写”。

`REELTERMINAL_LIVE_DELIVERY_ROOTS` 显式覆盖继续作为交付权限边界，不自动追加默认根。`REELTERMINAL_LIVE_MEDIA_ROOTS` 仍是独立的读取配置；媒体可读不等于可以交付。自定义覆盖排除推荐工作根时，以 `export.details.deliveryRoots` 为准，文档明确选择实际交付根，不宣称默认目录保证适用于任意人工覆盖组合。

### 3.2 修改与审计位置

- `apps/desktop/src/main/live/host-instance.ts`：默认交付根从已有分区结果推导；保留覆盖配置和受控媒体根。
- `packages/agent-facade/src/live-session.ts` 的 `discoveryContext`、`capabilities.ts`：核对 scoped 推荐根及实际交付根输出，不复制路径拼接规则。
- `apps/desktop/src/main/live/agent-task-channels.ts`、web `services/agent-media-tasks/task-record-utils.ts`：核对根到任务输出目录的拼接；已有布局正确则保留，只补契约验证。
- `apps/desktop/src/main/ipc/live.ts`、`live/agent-startup-info.ts`：审计 GUI 返回的容器根与复制启动命令。启动 target、安装前缀和当前单行提示语义不变；目录从能力接口发现。
- `docs/AGENT-WORKSPACE.md`、`AGENT-GUIDE.md`、`COMMAND-API.md`：同步默认分区、旧任务兼容及显式覆盖的说明，不改写历史验收记录。

### 3.3 回归用例

| 编号 | 场景与断言 |
| --- | --- |
| D01 | 从真实 host wiring 获取 `video capabilities`，按返回 recommendedRoot 建立 job/output，`export.start` 接受并最终交付；`verify.artifact` 接受原样 `deliveredTo`；普通推荐根的旧布局也继续成功 |
| D02 | 默认配置将视频 destinationPath 指向 `review/jobs/<slug>/output`；返回拒绝，不创建导出任务，不写入文件 |
| D03 | 合法 job/output 经符号链接或 Windows junction 指向根外；拒绝且外部目录未写入 |

继续运行 `delivery.test.ts` 中已有的重复目标、悬空链接、错误层级、无交付根、copy 竞态和不覆盖用例，不复制同义测试。对显式 delivery roots 覆盖补充一条回归，确认没有被默认 video root 偷偷扩权。

D01 必须覆盖生产 host wiring。只在测试中手工传入“正确 roots”无法发现本次缺陷。可在 Electron 边界 mock 下直接测 `host-instance.ts`；若必须抽取逻辑，只提取被生产实际使用的小型纯函数。新增测试文件可命名为 `host-instance.test.ts`，无需建立配置框架。

## 4. 执行包 C 编辑校验退出码

修改 [`apps/desktop/src/reelctl/index.ts`](../apps/desktop/src/reelctl/index.ts) 的结果退出码判定和对应调用点。将规范命令名传给判断：仅在命令为 `edit.validate` 且结果为 `ok:true/value.valid:false` 时退出 3。不能把任意命令返回的 `valid:false` 都解释为执行失败。

保留 facade 的 `{ok:true,value:{valid:false,...}}`，保留 conflicts、warnings、normalizedOps 和其他 JSON 字段；不把请求成功改成 API 错误。泛型 `call`、兼容别名 `edit validate`、`video call edit.validate` 经规范化后必须一致。现有业务失败、连接失败和参数错误的退出规则不在本轮统一重构。

| 编号 | 场景与断言 |
| --- | --- |
| C01 | 合法编辑计划：`valid:true`，进程退出 0；工程/revision/历史不变 |
| C02 | 格式合法但删除不存在的 clip：`valid:false`，JSON 包含 `NOT_FOUND` conflict，进程退出 3；不执行 apply |

在 `src/reelctl/index.test.ts` 覆盖两个入口和成功/失败分支；用真实子进程补充退出码验收。格式错误产生的 `ok:false` 不能代替 C02。当前 E2E `connectExternalAgent` 会接受退出 0/3 并仅返回解析后的 JSON；因此单独通过它调用，不能证明 OS 退出码正确。

## 5. 执行包 D 离线命令帮助

### 5.1 分发规则

在 `runReelctl` 进入业务参数、文件/stdin 读取、环境命令或 client 调用之前处理帮助。复用 `COMMAND_ALIASES`、`resolveCommandName`、本地命令目录/`describeCommand` 和 `commandHelp`，按 live 契约生成帮助，不新增手工维护的 facade 命令列表。

必须支持：

```text
reelctl --help
reelctl frames extract --help
reelctl frames extract -h
reelctl edit validate --help
reelctl media inspect --help
reelctl call frames.extract --help
reelctl video call media.inspect --help
reelctl review frames capture --help
reelctl help frames extract
```

帮助输出保留 canonical invocation、兼容别名及现有 input schema；`help <command>` 同时改为离线。`schema` 继续保留读取 live 目录的既有语义，不顺手改成离线 schema。离线帮助不宣称桌面版本、依赖或授权当前可用。

帮助识别只处理 argv 的命令帮助选项，不扫描 JSON、请求文件内容或 stdin。不能把字段值中的 `--help` 文本当作帮助开关。解析沿用已有命令路径与别名，支持多级路径；不要建立新的通用 shell parser。`-h` 也不得落入位置参数或业务请求。

本地包装命令如 `tools/start/status/environment` 的帮助使用现有本地用法及能力定义；不能为了显示帮助运行环境探测、读取模型配置或连接端点。空命令帮助使用 `REELCTL_HELP`。

未知命令的 `--help/-h` 返回参数错误 2，指出未知路径，并给出由现有别名/目录生成的可用入口或 `tools/help` 指引；不能返回成功的顶层帮助掩盖拼写错误。未知命令也不访问 endpoint。

### 5.2 验收

| 编号 | 场景与断言 |
| --- | --- |
| H01 | 上述已知命令矩阵退出 0，定位到正确 schema；不要求目标/revision；不读取请求文件/stdin；不调用 status/catalog/catalogEntry/start/command 或环境探测 |
| H02 | 未知嵌套路径与未知 canonical verb 请求帮助，退出 2，有错误和发现指引，无业务请求和网络访问 |

扩展 `src/reelctl/index.test.ts`。已有测试用 fake live catalog 供 `help` 查询，需要改为证明零 client 调用，不能只维持旧 mock 断言。独立进程测试将 endpoint 路径指向本测试不存在的文件；帮助仍成功。测试使用实际子进程退出码，而不是仅检查函数返回值。

## 6. 执行包 E 多轨与打包验收

### 6.1 隔离集成场景

新增一个聚焦的 `apps/desktop/e2e/cli-contract-consistency.e2e.ts`，复用现有 launch、UI 和 CLI harness。没有既有等价覆盖时才新增断言；不重新建设测试 runner。

1. 启动隔离 profile，通过 GUI 创建测试项目并在测试 UI 中授权编辑。固定 projectId/workspaceId，读取实际 command schema 和 revision。
2. 使用生成的短视频 A、短旁白 WAV、背景音 WAV 和少量 SRT。视频采用明确的纯色或编号画面，音频包含可识别的非静音测试信号。所有源文件属于 harness runDir。
3. 通过真实 `media.import` 导入。把原视频路径替换成不同画面 B，保持受控 A；通过 `media.inspect` 和 `frames.extract` 检查 A，并生成接触表。
4. 使用当前 `track.add/clip.add/subtitle.importSrt` 生成 Video/Narration/Music 独立轨道和原生字幕。用 `edit.validate` 预演、`edit.apply` 一次提交时间线编辑，检查返回 ID 和 fresh revision。live `clip.add` 不手写不支持的 clipId。
5. 分别执行一个失败和一个成功的真实 `edit.validate` 子进程，记录退出码和原始 JSON；两者均不修改工程。
6. 读取 `video capabilities` 的推荐根，按其布局创建输出目录。调用现有预览与 `export.start`；跟踪同一目标的 job，检查 `done`、`deliveredTo`、`deliveryError`，再调用 `verify.artifact`。
7. 用现有 FFprobe/FFmpeg 工具独立确认实际文件可完整解码，分辨率/时长符合这个短 fixture，存在视频与音频流、音频非静音；抽取已知时刻验证画面仍为 A。独立 FFmpeg 在这里是验收工具，不能代替 ReelTerminal 组装或导出。
8. 保存节点/工程，关闭并重开测试应用。通过客户端重新解析同一个项目/工作区，不复用失效 epoch/runtime；检查轨道、clip、字幕、受控媒体可用性，并预览或抽帧确认仍为 A。

素材导入与时间线编辑是不同提交。不能称本场景为“跨导入、跨时间线的单次原子事务”。无需规定视频必须 60–90 秒；几秒的可区分 fixture 足以覆盖本轮契约。若测试缺必要渲染依赖，记录缺项；核心合并场景未运行不得记为通过。

### 6.2 验证实际包内 CLI

必须区分两项证据：启动打包版桌面，与调用包内 CLI。当前 `e2e/harness/paths.ts` 的 `REELCTL_PATH` 固定为 checkout 的 `dist/reelctl/index.js`；仅设置 `REELTERMINAL_E2E_APP_EXECUTABLE` 不会切换这个 CLI。

先正常构建并打出新的 unpacked 包，使用 `apps/desktop/release/` 下唯一的新输出目录，不覆盖既有包。对包内 `reelctl.cmd` 或等价的包内 Electron Node 入口执行 H01/H02/C01/C02 和上述多轨场景。Windows 入口实际位于：

```text
<unpacked>/ReelTerminal.exe
<unpacked>/resources/app.asar/dist/reelctl/index.js
```

程序自带 [`resources/bin/reelctl.cmd`](../apps/desktop/resources/bin/reelctl.cmd) 使用 `ELECTRON_RUN_AS_NODE=1` 调用该包内入口。优先验证 GUI 返回的实际启动前缀，避免假定启动器复制位置。

如需复用 harness，可给测试 CLI 启动增加一个显式参数传入“可执行文件、入口参数、环境”；只扩展当前真实需求，默认行为保持。新增 `cli-contract-consistency.e2e.ts` 在设置 `REELTERMINAL_E2E_APP_EXECUTABLE` 时，从该 EXE 所在目录解析包内入口并显式传给 CLI 启动器；包内文件缺失立即失败。只对 CLI 子进程设置 `ELECTRON_RUN_AS_NODE=1`，不能让它影响桌面进程启动。不得静默 fallback 到 checkout 的 CLI；记录测试实际使用的 EXE、包内入口和包路径。

包内回归只能使用隔离 endpoint/profile。不要打印 descriptor 或 token。unpacked 验收不等于安装向导验收，本轮不要求安装或发布。

## 7. 检查命令与实施记录

在仓库根目录执行。以下是修复完成后的检查入口，本规格编写阶段没有重新执行它们。

```powershell
pnpm --filter @reelterminal/agent-facade typecheck
pnpm --filter @reelterminal/desktop typecheck

pnpm --filter @reelterminal/agent-facade exec vitest run src/plugin-tools.test.ts src/plugins/frame-tools.test.ts src/live-session.test.ts src/media-replace.test.ts src/delivery.test.ts src/media/path-roots.test.ts src/media/path-roots.security.test.ts --maxWorkers=2
pnpm --filter @reelterminal/desktop exec vitest run src/reelctl/index.test.ts src/main/live/agent-task-channels.test.ts src/main/live/agent-startup-info.test.ts src/main/live/live-session-host.test.ts --maxWorkers=2

pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/cli-contract-consistency.e2e.ts e2e/reelctl.e2e.ts
git diff --check
```

新增的媒体选择、host wiring 或 CLI 子进程测试文件必须加入实际命令，不能遗漏。若修改 web 的任务目录生成，追加对应现有测试与 web typecheck；没有相关改动不扩展到无关模型或硬件测试。

打包遵循 [`apps/desktop/DISTRIBUTION.md`](../apps/desktop/DISTRIBUTION.md)，通过 `run pack` 明确调用已有脚本。Windows x64 可使用以下命令；新增 E2E 必须先按 6.2 实现包内 CLI 选择。

```powershell
$contractBuildStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$contractPackageOutput = "release/windows-cli-contract-$contractBuildStamp"
$contractPackagePath = Join-Path (Get-Location).Path "apps/desktop/$contractPackageOutput"
if (Test-Path -LiteralPath $contractPackagePath) { throw 'Package output already exists' }
pnpm --filter @reelterminal/desktop run pack --win --x64 "--config.directories.output=$contractPackageOutput"
if ($LASTEXITCODE -ne 0) { throw 'Desktop pack failed' }
$contractExePath = (Resolve-Path -LiteralPath (Join-Path $contractPackagePath 'win-unpacked/ReelTerminal.exe')).Path
$contractPreviousExe = $env:REELTERMINAL_E2E_APP_EXECUTABLE
try {
  $env:REELTERMINAL_E2E_APP_EXECUTABLE = $contractExePath
  pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/cli-contract-consistency.e2e.ts
  if ($LASTEXITCODE -ne 0) { throw 'Packaged contract acceptance failed' }
} finally {
  $env:REELTERMINAL_E2E_APP_EXECUTABLE = $contractPreviousExe
}
```

实际解析后的输出目录必须位于 `apps/desktop/release/`，有唯一后缀。不要把含占位路径的命令或仅切换 EXE 的命令记为包内双端回归通过。

按 A、B、C、D、E 顺序实施，先让相应回归在基准上暴露问题，再修复并运行必要检查。修改同一模块保持串行。本轮无需子智能体；若用户另行授权委派，继续遵守唯一 checkout 和文件写入协调规则。

实施回执至少包含：源码基准与修复后 revision/未提交状态、每个执行包的实际改动文件、M/D/C/H 用例所在文件、调用链审计结果、执行命令与通过/失败/跳过数量、包路径与实际 CLI 入口、多轨导出/重开证据。M02 记录受控与原文件的可区分内容及实际观察结果；C/H 记录真实退出码。已有前轮 108 项结果不能作为本轮新增用例证据。

只有用户要求提交时才创建提交；若创建，按执行包拆分并记录对应测试。无需为本轮引入新的 provenance 数据库或提交自动化。

## 8. 合并门槛与停止条件

- [x] M01–M05 通过；M02 包含真实解码，预览/导出与检查读取同一受控版本。
- [x] 受控副本丢失或越权明确失败；旧媒体兼容成功；没有静默降级或媒体来源改写。
- [x] D01–D03 通过；生产 host 默认 wiring 被覆盖；既有交付不覆盖和显式覆盖配置测试仍通过。
- [x] C01/C02 的两个主要调用入口及真实子进程退出码正确；API JSON 结构不变。
- [x] H01/H02 离线通过，`--help/-h` 没有业务请求、文件/stdin 读取或依赖探测。
- [x] 已有 API 完成真实隔离多轨组装、交付、独立文件验证、保存和重开。
- [x] 新 unpacked 桌面与同一包内 CLI 通过回归；明确记录未覆盖安装/发布。
- [x] 必要类型检查、定向测试、构建和 `git diff --check` 通过，文档与实际默认目录一致。

所有必需交付物和上述检查完成即结束。某项被依赖阻塞时准确记录未完成的门槛，不以 skip 代替通过。没有额外请求不持续监控 CI、安装包或合并状态，不顺手开发 Assembly、字幕关系或其他产品增强。
