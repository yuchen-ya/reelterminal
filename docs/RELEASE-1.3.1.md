# ReelTerminal 1.3.1

日期：2026-10-26（Asia/Shanghai）。本次目标为 Windows x64 本地安装器、
便携 ZIP 和 unpacked 应用；本次仅本地打包，未上传 GitHub Release、安装或替换用户实例。

## 变更范围

- 审阅工作台：父节点画板与分类目录、视频基准对比字段的 Core / Agent Schema /
  保存读取 / 前端映射；独立 Review 复用相同契约。节点列表、图片与视频工具、
  反馈和加载体验更新。compareWithItemId 顶层值优先，并同步到 videoPayload；
  不自动推导时间映射。
- 项目模板：以本地完整项目快照创建独立新项目，保留当前项目和历史；
  移除内置模板目录，素材面板增加外部资源链接。依赖媒体/字体仍须可用，
  不将模板称为包含全部源文件的便携备份。
- 媒体和音频：默认关闭并行视频解码、修正解码帧所有权处理、复用音频环境探测；
  原生 mesh 缓冲区初始化；Aurora 原生进程超时处理。
- 桌面：导出 IPC 参数校验、Windows 导出记录原子替换重试、保留临时访问失败的
  最近项目记录、修正标题栏拖动区域。
- 网站演示：独立静态 showcase 入口复用编辑器，浏览器本地保存演示项目；
  不是桌面端服务，不提供真实桌面导出/Agent 连接。

## 版本与文档

根项目、desktop/web/image/studio 应用和内置帮助版本更新为 1.3.1；
内部 workspace 库保留其独立版本。命令名沿用 workbench.ingest、review.ingest，
没有新增 ingestBatch/createTask/appendItems 别名。
README、用户指南、素材库说明、命令与 Agent 指南、分发与升级文档同步修订；
历史验收文件保留原版本和边界，并指向本文，不视作 1.3.1 新包验收。

## 构建与验证

应用源提交：f061a8796a56f0b06cff7519c11a6f03a8ba8f5e。
构建戳的 dirty=false、app_version=1.3.1；后续提交只更新 GUI 测试和契约/验收文档，
不改变包内应用源码。按功能分别提交审阅、模板、媒体、桌面修复、showcase、
版本文档与验证调整，没有推送或公开发布。

构建命令依次为 pnpm build:wasm、pnpm --filter @reelterminal/desktop build，
再执行 electron-builder --win nsis zip --x64 --publish never，
输出目录配置为 release/windows-1.3.1-f061a879（相对于 apps/desktop）。

输出（均位于 apps/desktop/release/windows-1.3.1-f061a879/）：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| ReelTerminal-1.3.1-x64.exe | 159375256 | 7a804b854fb88e8d99b44f15fc31c16e983b7be069bbceefeac03b54438f740c |
| ReelTerminal-1.3.1-x64.zip | 215287836 | 1a558d06820fbf6d7224e623eebaaa2d0e8f5a8ebb52098279265284f9433a32 |

目录还包含 win-unpacked/ReelTerminal.exe、SHA256SUMS.txt、latest.yml 与
安装器 blockmap。EXE ProductVersion=1.3.1.0；安装器及 unpacked EXE 的
Authenticode 状态均为 NotSigned，工具输出 signing 不等于有证书签名。
ASAR 2,898 项检查未发现 .artifacts、e2e、.env、.git 或 live-endpoint.json；
main/CLI 入口和 1.3.1 构建戳存在。没有安装、替换或重启用户实例。

本轮验证与限制：

- 全仓类型检查、showcase 独立类型检查、命名检查通过；安全测试 6 项、
  许可证测试 7 项、NSIS 安装器策略与迁移合成测试 37 项通过。
- Core 1,780 项通过（20 跳过），Agent Facade 2,739 项通过（25 跳过），
  runtime-chromium 98 项通过（2 跳过）；image、studio、creation-schema、
  creation-bindings 和 fxpkg 的本轮非跳过测试通过。
- 全仓单测初跑中 Web 为 2,059 项通过、1 项失败、7 项跳过：
  千行表格 fixture 耗时约 9 秒，超过原 5 秒限时。只将该 fixture 预算改为
  30 秒，保持断言不变，定向重跑全部 5 项通过。没有宣称原始全仓命令一次全绿。
- 桌面单测初跑 586 项通过，硬件探测 1 项超出 5 秒；以 testTimeout=30000
  单独复跑 hardware.test.ts 后通过。硬件探测依赖本机实际系统查询。
- 独立 agent-transport 补充测试为 833 项通过、4 项跳过、1 项失败。
  失败项为 schema.test.ts 中 media.cleanup.execute 的 requires explicit
  confirmation：confirmed:false 被已生成的 JSON Schema 接收，而 corpus 期望
  Schema 拒绝。对应 workspace-schemas.ts 和 verb-schema-corpus.ts 相对任务开始
  的 e1c162b1 没有变更；这是既有契约差异，未扩大本次发布任务修改它。
  运行时校验与 Schema 的差别仍须后续单独收口，不能据此宣称全仓全绿。
- 内置帮助内容修订为 1.7.5，应用版本为 1.3.1，gui-manual.test.ts 18 项通过。
- 用上述 unpacked EXE 和隔离 profile 跑 GUI：whole-template-history、
  review-navigation、review-image-loading、review-issue-actions、titlebar-drag
  五项分别通过。旧测试对分类菜单、按需展开面板的定位已同步当前界面并复跑；
  问题定位/删除、详情窄屏换行与滚动均在展开后的真实 UI 上验证。
- 证据位于 apps/desktop/e2e/.artifacts/，不进入源码提交或安装包。
  初跑与复跑日志保留在构建机临时目录 reelterminal-1.3.1-*.log。
- 当前机器缺少 creation_aurora_renderer.exe，构建脚本按既有行为跳过原生
  Aurora sidecar；不宣称验证该原生渲染器。可选原生/模型测试跳过项保持明确。
- 未走实际安装向导，未复验人工 OS 拖出接收、设备 DPI/压感和用户模型环境。
  NSIS 合成策略测试不能替代真实安装验收；旧 1.3.0 的验收不自动继承。
  没有提供新的 macOS/Linux 包或上传更新源。
