# 多项目、工作区与版本节点

桌面应用内部保存项目目录、工作区草稿和不可变版本节点。工程文件仍是单个工作区的工程描述，不包含内部版本树。交互设计见 [VERSION-NODES-UX.md](VERSION-NODES-UX.md)。

## 启动

在当前 checkout 执行：

```powershell
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop start
node apps/desktop/dist/reelctl/index.js call capabilities.get
```

桌面命令服务启动后可读取。编辑前在时间线上方将 Agent Access 切换为可编辑。不要读取或输出 live endpoint 描述文件的内容。

## 保存与留存

保存和留存是两个动作：Ctrl+S 与自动保存只把当前编辑方案（工作区）落盘，“已保存”不代表存在版本节点。留存版本是独立动作：左上角项目菜单的“留存当前版本”、关闭应用时按偏好留存，或 Agent 的 `node.save`。首个节点自动命名“首次存档”，其后使用本地化时间戳；内容与基准相同时不会产生重复节点。保存工程文件、另存为是原有独立操作。

## GUI

状态行只有“● 当前”和“看板”，右侧检查器共用属性、存档、看板三个页签。纵向存档记录显示稳定的小色点、真实父子连线、名称和时间；单击只查看详情，双击或 Enter 只读预览，明确“从这个存档继续编辑”才采用并保护原草稿。全局预览横幅跨页签保留；更多/右键支持重命名和可撤销回收。未留存试剪不画假节点，仍在项目菜单选择。

看板是单列列表与详情，待处理项优先，已完成默认折叠；引用、结果、定位与严格候选采用保持既有契约。时间线直接选择回属性，看板定位和 Agent 更新不抢页签；跨页签、跨项目的未提交表单在当前会话保留，提交绑定实际编辑目标。

关闭前创建存档点按偏好询问、自动创建或不创建；始终先完成已接受的编辑和草稿写入，不把超时当作同意。候选仅包含本次编辑过且仍有实质变化的方案。普通滚轮纵向查看所有轨道，轨道头同步，工具栏和标尺固定；Shift+滚轮横移，Ctrl/Cmd+滚轮仍缩放。

项目切换后单条通知可点击复制 Agent 提示词，名称与目录同步，凭据不进入提示词，后台目标不改变。历史存档与当前编辑可在播放器只读对比，无画面处如实提示。详细交互见 [VERSION-NODES-UX.md](VERSION-NODES-UX.md)。
依赖缺失的节点保留工程描述并在预览中说明哪些内容无法恢复；不能把这类节点当作完整可恢复的存档。字体快照、内联图像和受控素材都参与检查。

## CLI

先读取目录或当前 GUI 上下文取得 ID，然后为工作区命令明确指定项目与工作区。revision 是工作区的提交保护条件。Agent 的常规编辑命令只持久保存工作区（连续写入合并为一次快照落盘），任何命令都不会因普通保存创建节点；`node.save` 是唯一留存入口。

```powershell
node apps/desktop/dist/reelctl/index.js call project.list
node apps/desktop/dist/reelctl/index.js context
node apps/desktop/dist/reelctl/index.js call workspace.list --project-id PROJECT_ID
node apps/desktop/dist/reelctl/index.js call project.get_state --project-id PROJECT_ID --workspace-id WORKSPACE_ID
node apps/desktop/dist/reelctl/index.js call node.save --project-id PROJECT_ID --workspace-id WORKSPACE_ID --expected-revision REVISION --name '初剪完成' --idempotency-key 'stage-rough-cut'
node apps/desktop/dist/reelctl/index.js call node.list --project-id PROJECT_ID
node apps/desktop/dist/reelctl/index.js call node.rename --project-id PROJECT_ID --node-id NODE_ID --name '客户定稿' --summary '按客户意见调整结尾'
node apps/desktop/dist/reelctl/index.js call node.restore --project-id PROJECT_ID --workspace-id WORKSPACE_ID --node-id NODE_ID --expected-revision REVISION --idempotency-key 'restore-stage'
```

`node.save` 留存版本，省略 `--name` 时自动命名，内容与基准相同则去重。`node.rename` 只修改节点名称和可选摘要，是纯元数据操作，不需要 revision 或幂等键，不产生新版本。`node.restore` 把节点应用到目标工作区（先保护脏草稿）。写命令仍需 `expectedRevision` 和 `idempotencyKey`。

用 `reelctl schema <command>` 查看命令当前参数。工作区创建、关闭、删除和恢复草稿分别使用 `workspace.create`、`workspace.close`、`workspace.delete`、`workspace.recover_draft`。素材查询使用 `node.media`、`node.compare` 和 `media.references`。

`node.list` 只读取节点关系和摘要；需要完整工程快照时使用 `node.get --project-id PROJECT_ID --node-id NODE_ID`。大型 CLI 响应可能返回 `savedTo`，该文件保留完整结果；使用 `--output-file` 可明确指定证据文件位置。

编辑请求的参数在 `arguments` 中；项目和实例保护与目标分开：

```json
{
  "arguments": {
    "projectId": "PROJECT_ID",
    "workspaceId": "WORKSPACE_ID",
    "expectedRevision": 12,
    "idempotencyKey": "title-edit-1",
    "ops": [{ "op": "text.update", "overlayId": "TEXT_ID", "text": "新的字幕" }]
  },
  "expectedProjectEpoch": "EPOCH_FROM_CONTEXT"
}
```

```powershell
node apps/desktop/dist/reelctl/index.js edit apply --file 'E:\external-job\project\edit.json'
```

同工作区的幂等键不能用于不同请求。节点留存和恢复的成功结果持久化，重放返回原提交结果，不能用其 revision 冒充当前最新状态。重启后的旧实例保护条件会冲突，需要重新读取上下文。

## 素材和任务

导入登记不可变内容。GUI 与 Agent 的替换产生新版本或采用已导入候选；旧节点仍引用旧内容。重新链接验证相同字节后更新来源位置，不能把不同内容冒充旧版本。

后台导出和分析记录固定输入描述、素材版本、参数、目标工作区和 sourceRevision。完成不自动改变时间线，也不会留存版本。重启后未完成的任务标为中断，已有输出和记录仍可查询。

`node.compare` 的顶层差异比较素材栏：`replaced` 只报告目标节点本次新增且声明替代旧版本的素材，已有版本谱系不会重复报告。`used` 比较时间线实际使用：同一片段 ID 前后的 `mediaId` 改变构成替换，不依赖素材谱系；相同素材对去重。两层的 `added`/`removed` 报告未归入替换的集合增减，旧素材仍被其他片段使用时不会报告完全移除。素材栏保留旧版本与时间线换源是独立事实。同节点比较两层均为空。

清理保留全部节点、工作区及恢复草稿、撤销与重做、任务输入、正在登记的素材和素材库保留内容。执行命令使用 `media.cleanup.plan` 返回的 `planId`：

```powershell
node apps/desktop/dist/reelctl/index.js call media.cleanup.plan --project-id PROJECT_ID
node apps/desktop/dist/reelctl/index.js call media.cleanup.execute --project-id PROJECT_ID --plan-id PLAN_ID
```

先生成并验证独立精选素材，再决定是否处理原片的全部引用。仅缩短当前时间线不会解除旧节点对长原片的依赖。

## 自测

单元测试和真实桌面验收分别执行。生成素材与证据必须位于 live `capabilities.get` 报告的外部 Agent 工作目录。

```powershell
$env:REELTERMINAL_VERSIONING_EVIDENCE_ROOT = '外部 Agent 工作目录中的本任务目录'
$env:REELTERMINAL_VERSIONING_NATIVE = '1'
pnpm --filter @reelterminal/desktop test:e2e e2e/multi-project-versioning.e2e.ts --bail=1
```

原生文件对话框自测会在该目录 `evidence/native-dialog-request.json` 写出当前要求的保存或打开路径，需通过真实 Windows 对话框完成操作。CLI 记录、截图和 A01–A16 实际结果位于 `evidence/latest-evidence-location.txt` 指向的目录。测试使用独立桌面 profile，不修改正常用户 profile。

GUI 自测按实际界面核对，关键定位与行为：

- `version-track`：空工程不出现；留存一次后出现 `version-node-<nodeId>`，悬停出现 `version-node-tooltip`（名称+日期）。Ctrl+S 不产生节点。
- `version-node-menu`：菜单固定四项 `version-menu-preview`、`version-menu-rename`（内联 `version-rename-input`，Enter 提交、Esc 取消）、`version-menu-adopt`、`version-menu-delete`；删除后出现“版本已移到回收站”并可直接撤销。
- 预览：双击节点出现“正在预览「名称」”横幅与“返回当前编辑”“从这里继续编辑”；预览中编辑被拒绝且 Ctrl+S 只提示“此版本已保存”。
- 关闭：有变化时出现“关闭前留存一个版本？”对话框（留存并关闭/直接关闭/取消 + 下次关闭时偏好）；无变化不弹框；多项目只弹一个。
- 项目切换：成功切换后出现“已切换到「名称」 [复制 Agent 提示词]”通知，复制内容不含凭据；原后台任务目标不变。
