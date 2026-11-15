# CLI 契约一致性集成交付记录

2026-11-09（Asia/Shanghai）。规格第 6–8 节全部完成；最终必要检查无失败、无跳过。当时未提交、未创建 worktree、未安装应用、未发布。HEAD 始终为 `4f0305dc7a5b3bf9605ad5f3d29e794dd347b576`；验收对象是包含 A/B/C/D 和本轮 E 改动的未提交工作树，不能用 HEAD 单独重现。

开始前已阅读根 AGENTS.md、[实施规格](CLI-CONTRACT-CONSISTENCY-SPEC-2026-11-09.md)、用户附带的 A/B/C（含 D）回执，并核对 Git 状态和 diff。保留所有已有改动。本轮没有扩展 Assembly、字幕关系、可选模型或其他产品功能。

## 改动归属与回归索引

以下路径相对于仓库根。A/B/C/D 为接手时已有实现；本轮复跑必要回归并完成集成。

| 执行包 | 实际实现与测试文件 | 本轮验证 |
| --- | --- | --- |
| A | `packages/agent-facade/src/media/source-file.ts`（新增）、`media/path-roots.ts`、`plugin-runtime.ts`、`source-inspection.ts`、`plugins/source-ref.ts`、`plugins/frame-tools.ts`、`live-session.ts`、`session.ts`、`ops.ts`；对应 `media/source-file.test.ts`（新增）、`media/path-roots.test.ts`、`plugin-tools.test.ts`、`plugins/frame-tools.test.ts`、`live-session.test.ts`、`media-replace.test.ts` | M01–M05 与真实 FFmpeg 抽帧；E 补足真实预览、导出和重开像素 |
| B | `apps/desktop/src/main/live/host-instance.ts`、新增 `host-instance.test.ts` | D01–D03、生产 host wiring、显式 roots 覆盖；既有 `delivery.test.ts` 防逃逸和不覆盖用例通过 |
| C/D | `apps/desktop/src/reelctl/index.ts`、`commands.ts`、新增 `help.ts`；`index.test.ts`、新增 `index.process.test.ts` | C01/C02、H01/H02；本轮将 mock fixture 的 `clip.delete` 修正为真实 schema 支持的 `clip.remove` |
| E | 新增 `apps/desktop/e2e/cli-contract-consistency.e2e.ts`；扩展 `e2e/harness/cli-client.ts` | 显式 executable/entry/env；包内入口缺失直接失败；CLI 大结果目录隔离；真实双端多轨场景 |
| 文档 | `docs/AGENT-WORKSPACE.md`、`AGENT-GUIDE.md`、`COMMAND-API.md`、`README.md`、规格与本记录；`apps/desktop/e2e/README.md` | 默认分区、父根兼容、review 排除、显式覆盖、媒体版本、退出码及包内选择说明同步 |

## 调用链与证据边界

| 调用点 | 来源选择与实际验证 |
| --- | --- |
| `media.inspect` | 共享解析器选择受控副本；M01/M03/M04/M05 的错误与兼容矩阵通过。E 检查指纹匹配受控文件 stat，真实 provider 输出解码为红色 |
| `frames.extract` | ID 分支与 inspect 同源；真实 FFmpeg 解码仍为 A；`frames.contact_sheet` 直接使用这些 PNG，无新增媒体 ID schema |
| `video.compare`、`patch.apply`、image/motion/mask/propagate | A 回执的共享 `source-ref` 读取链保持；显式路径仍受原 media/artifact roots 限制。本轮未执行全部可选算法 |
| `preview.render_frame`、`visual.inspect`、比较预览 | A 的 provider 映射回归通过；E 实际时间线预览和重开预览均解码为 A。未新增比较算法像素验收 |
| `export.start`、比较参考 | 共享选择器映射受控版本；E 的真实 MP4 解码仍为 A，job 所有者与固定 projectId/workspaceId 一致 |
| live/headless 分析和音频处理 | A 的共享来源修改及相关定向测试通过；没有触发云服务或安装可选模型 |
| `media.replace` / `media.relink` | 两种严格替换输入回归通过；`media/strict-replacement.ts` 无需修改；relink 保留显式同内容文件契约 |
| B 的目录消费链 | host 从已有 workspace scopes 推导默认 video + parent roots；capabilities、任务目录和启动信息保留既有拼接。D01 覆盖真实 host/facade/job 交付链（编码与 verifier 是测试替身），E 补足默认 video 根的真实编码和验证 |

M03/M04 明确失败且不回退；M05 兼容旧媒体。EACCES/EPERM 是注入边界测试，未宣称 Windows ACL 实测。没有改写媒体来源、扩大媒体 ID 的读取权限或修改 checkpoint 契约。

## 本轮实际检查

所有命令从仓库根执行；本机使用 `corepack pnpm`。下面的数量是本轮实际结果，不引用前轮 108 项或回执中的完整 facade 数量作为新增证据。

```powershell
corepack pnpm --filter @reelterminal/agent-facade typecheck
corepack pnpm --filter @reelterminal/desktop typecheck

corepack pnpm --filter @reelterminal/agent-facade exec vitest run src/media/source-file.test.ts src/plugin-tools.test.ts src/plugins/frame-tools.test.ts src/live-session.test.ts src/media-replace.test.ts src/delivery.test.ts src/media/path-roots.test.ts src/media/path-roots.security.test.ts --maxWorkers=2
corepack pnpm --filter @reelterminal/desktop exec vitest run src/reelctl src/main/live/host-instance.test.ts src/main/live/agent-task-channels.test.ts src/main/live/agent-startup-info.test.ts src/main/live/live-session-host.test.ts --maxWorkers=2

corepack pnpm --filter @reelterminal/desktop build
corepack pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/cli-contract-consistency.e2e.ts e2e/reelctl.e2e.ts
corepack pnpm --filter @reelterminal/desktop run pack --win --x64 --config.directories.output=release/windows-cli-contract-20261109-214831
git diff --check
```

| 检查 | 通过 / 失败 / 跳过 |
| --- | --- |
| facade 定向 8 文件 | 192 / 0 / 0 |
| desktop 定向 8 文件，含所有 reelctl 和新增 host/process 文件 | 92 / 0 / 0 |
| C fixture 修正后再次运行 `exec vitest run src/reelctl --maxWorkers=2` | 56 / 0 / 0（含在上列覆盖范围中，不重复加总） |
| checkout E2E：新场景 + 原 reelctl | 5 / 0 / 0 |
| 新 unpacked 桌面 + 同包 CLI 的新场景 | 1 / 0 / 0 |
| facade、desktop 类型检查 | 最终复跑均退出 0 |
| 新 E2E 与引用 harness 的 TypeScript 检查 | 用 TypeScript API 读取 desktop tsconfig，以新 spec 为 rootNames，`getPreEmitDiagnostics` 为 0；desktop 原 typecheck 不包含 e2e，故另查 |
| 完整 build、含重建的 `run pack`、diff 检查 | 均退出 0 |

新 harness 调试期间有 7 次场景失败，均保留其独立时间戳证据，不计为通过：不支持的 `clip.delete`、误读顶层 createdIds、预览只传 width 而保留默认 height、重开快照转为大结果文件回执。最终用合法 `clip.remove`、`applied[].createdIds`、显式 320×180 和隔离回执读取解决。另修正了新测试 imports 数组的类型注解。没有为通过测试修改业务契约。最终包内场景包含 `verify.artifact.pass === true` 断言。

没有修改 web 任务目录生成，故未扩展无关 web 测试；完整 desktop build 已包含 web typecheck。不存在被依赖阻塞或跳过的核心门槛。FFmpeg/FFprobe 与渲染运行时均实际可用；构建提示缺少可选 Aurora native sidecar，既有 CPU 路径仍可用且真实导出成功。其他平台的 esbuild 可选二进制未打包，不是 Windows x64 场景的缺项。

## 新 unpacked 与同包 CLI

- 输出目录：`apps/desktop/release/windows-cli-contract-20261109-214831/`，新建且未覆盖既有包。
- 桌面：`win-unpacked\ReelTerminal.exe`，包内版本实际读取为 `1.4.0`。
- CLI：同一 EXE + `win-unpacked\resources\app.asar\dist\reelctl\index.js`，仅 CLI 子进程设置 `ELECTRON_RUN_AS_NODE=1`。Electron 的 asar-aware fs 实际检查入口可访问，缺失即失败，没有 checkout fallback。
- GUI `getStartupInfo` 实际返回同目录 `win-unpacked\reelctl.cmd`；以返回的 PowerShell 前缀实际执行 `frames extract --help`，退出 0。其余矩阵和多轨读写使用上述等价包内 Electron Node 入口。
- 构建开始：2026-11-09 21:48:31 +08:00；完成：21:49:25 +08:00。原始日志：`apps/desktop/e2e/.artifacts/cli-contract-pack-20261109-214831.log`。
- 包内 production stamp：`source_head=4f0305dc7a5b3bf9605ad5f3d29e794dd347b576`，`dirty=true`，`source_digest=e9925bae6a49f5b8d9a577a81d1bd9501d0bbb49f8e56fd3d19e830337751d18`。实际包元数据保存在 `.artifacts/cli-contract-package-metadata-20261109-214831.json`。这是构建时工作树标记；后续测试注解/断言与交付文档同步不改变已验收包的运行时代码，不能把最终文档工作树视为一个新构建。

实际包内验收命令（环境只作用于本次测试，结束后恢复）：

```powershell
$contractPreviousExe = $env:REELTERMINAL_E2E_APP_EXECUTABLE
try {
  $env:REELTERMINAL_E2E_APP_EXECUTABLE = (Resolve-Path -LiteralPath 'apps/desktop/release/windows-cli-contract-20261109-214831/win-unpacked/ReelTerminal.exe').Path
  corepack pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/cli-contract-consistency.e2e.ts
} finally {
  $env:REELTERMINAL_E2E_APP_EXECUTABLE = $contractPreviousExe
}
```

`reelctl.e2e.ts` 的 4 项只计作 checkout 验收；不能因为设置 EXE 就把它们算成包内 CLI 证据。本轮包内证据仅来自显式选择入口的新 spec。

## 多轨交付、真实进程与重开证据

最终 checkout 证据：`apps/desktop/e2e/.artifacts/cli-contract-checkout-1794232054155.json`。
最终包内证据：`apps/desktop/e2e/.artifacts/cli-contract-packaged-1794232190877.json`。
同名前缀还保留 `--assembled.png`、`--contact-sheet.png`、`--preview.png`、`--export.mp4`、`--reopened.png`。`--reopened.png` 是最终 GUI 截图，重开预览的解码断言及 RGB 记录在 JSON。证据 JSON 对机器路径做既有隐私替换，实际包路径以上文为准。endpoint/token 未进入证据。

| 项目 | 包内实际结果 |
| --- | --- |
| 固定目标 | project `32792cce-c785-438b-9822-ac2898ae13f1` / workspace `be07322e-490a-4a45-b562-b0ba6b639881` |
| 输入 | GUI 创建 Horizontal 项目；按其 1920×1080 画布生成红色 3 秒 A，真实导入；原路径改为蓝色 4 秒 B；440 Hz 旁白与 660 Hz 背景 WAV 各 3 秒；两条原生 SRT |
| M02 | 原文件采样 RGB `[0,1,255]`；inspect/抽帧指纹匹配受控文件，真实解码为红色；接触表来自相同 PNG |
| 时间线 | Video / Narration / Music 三条独立轨，每轨一个由 live store 生成 ID 的 clip，两条字幕；先 validate 再一次 apply，revision 从 3 到 4。导入是独立提交，不宣称跨导入单次原子事务 |
| C01/C02 | `call edit.validate`、`edit validate`、`video call edit.validate` 各执行成功/失败真实子进程，共 6 次；退出码分别 0/3，失败保留 `ok:true,valid:false,NOT_FOUND` conflicts、warnings、normalizedOps；每次前后完整 state/revision/history 相等 |
| H01/H02 | 不存在的隔离 endpoint、stdin 保持打开；15 个已知/文件/stdin/包装帮助请求退出 0，3 个未知路径退出 2，原始 stdout/stderr/code 留存。零 client/业务调用/依赖探测由 index 单元回归补足 |
| 交付 | 从 `video capabilities` 实际推荐根建立 `video/jobs/cli-contract/output/contract.mp4`；job `job-922e015e-526f-468a-adcc-7436cc927f5a` 属于同一固定目标，`done`、`sourceRevision=4`、`deliveryError=null`、`deliveredTo` 正确 |
| 输出验证 | `verify.artifact` 对原样 deliveredTo 返回 `pass:true`；独立 FFmpeg `-xerror` 完整解码成功，FFprobe 为 H.264/AAC、320×180、24 fps、72 帧；视频 3 秒、容器 3.008 秒；音频 RMS `0.1244010853`，非静音；0.1 秒采样 RGB `[254,25,1]`，仍为 A |
| 保存重开 | `project.save` 后关闭并重启隔离应用，通过 GUI 打开同项目并重新连接；重新读取同 project/workspace，epoch/runtime 已更新，revision=4，timeline 完全一致，三项受控文件可读；新预览 RGB `[255,24,0]`，仍为 A |

所有源 fixture 均在 harness runDir，正式项目/profile/endpoint 未被读取或更改。最终进程与 profile 按 harness 规则清理，临时 `deliveredTo` 随 runDir 清理；可交付 MP4 和图像副本保存在上述 `.artifacts`，不应继续使用临时路径。迭代发现的大结果自动落盘问题已改为 runDir 内 `cli-data`；最终测试不向用户的 CLI 结果目录写文件。

## 结束边界

第 8 节八项门槛均已完成。unpacked 验收不覆盖安装向导、升级、发布、全部可选模型、比较算法或 Windows ACL 实测。没有安装或发布，也不继续跟踪 CI/合并状态。交付后停止。
