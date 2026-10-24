# AI 素材工作台：同类项目调研与复用决策

状态：设计调研，未实施。调研日期：2026-10-20。

2026-10-21 范围修订：用户将产品收敛为图片、文字、数据、视频的批量快速处理器。
本文件保留原调研证据，不声称重新验证外部项目。涉及模块描述、运行队列、自动传播、
默认版本采用和音频扩展的旧决策不再是首版实施要求；以最新
[设计](AI-MATERIAL-WORKBENCH-DESIGN.md)和[交互方案](AI-MATERIAL-WORKBENCH-INTERACTION.md)为准。
原调研没有系统评估语料编辑或表格清洗组件，不能据此声称这两项已有现成可嵌入实现。

配套文档：[第一版设计](AI-MATERIAL-WORKBENCH-DESIGN.md)、
[待执行任务清单](AI-MATERIAL-WORKBENCH-TASKS.md)。

本次只阅读官方文档、公开源码与本仓库源码，没有安装依赖、启动外部项目、
运行模型或修改用户媒体。源码快照用于复查设计依据，不代表选定这些版本作为依赖。
下文把观察事实、可借鉴模式与本项目决策分别说明；没有声称功能已经集成或验收。

## 1. 调研问题与结论

研究对象按真实需求选择，而不是罗列生成工具：

| 问题 | 研究对象 | 本项目采取的方式 |
| --- | --- | --- |
| 画布、蒙版怎样成为生成输入？ | Krita AI Diffusion | 借鉴选区上下文与结果应用流程，继续使用外部 ComfyUI |
| 已有节点如何变成可调用模块？ | ComfyUI 原生 API、Krita 自定义工作流 | 复用 API 图与已有客户端，增加薄输入输出说明 |
| AI 初步打标如何交给人确认？ | Label Studio | 分离提议与人工决定，保留关联 ID |
| 视频区域、单帧蒙版如何表达？ | CVAT | 分清单帧形状与跨帧轨迹，不默认插值或传播 |
| 数位笔是否需要自造绘画引擎？ | Pointer Events、perfect-freehand | 平台事件与 Canvas 优先；必要时引入小型笔迹库 |
| 如何控制项目复杂度？ | ReelTerminal 现有契约 | 复用任务、素材、历史、CLI，保持 Agent 外部运行 |

决定：第一版只增加人的精确操作与交接记录，不新增节点编辑器、模型管理器、
完整标注服务或常驻 Agent。外部系统已经提供的执行能力通过现有接口调用。

## 2. Krita AI Diffusion：借鉴接口与交互，不搬绘画软件

### 观察

官方 [Custom Graphs](https://docs.interstice.cloud/custom-graph/) 描述：
自定义 ComfyUI 图可交换画布、图层、选区和蒙版，并把重要参数暴露在 Krita 中；
选区上下文包含裁剪范围。因此“通用节点后台 + 少量面向使用者的输入”已有直接先例。

实际阅读的源码固定于
`828b70c33c5c97f326e03170cd693beef798231e`：

- [model/custom_workflow.py](https://github.com/Acly/krita-ai-diffusion/blob/828b70c33c5c97f326e03170cd693beef798231e/ai_diffusion/model/custom_workflow.py)：
  `CustomWorkflow`、`WorkflowCollection` 区分 document/remote/local 工作流来源，
  使用节点输入信息导入图。不是让每个工作流重新开发一个完整工具窗口。
- [model/jobs.py](https://github.com/Acly/krita-ai-diffusion/blob/828b70c33c5c97f326e03170cd693beef798231e/ai_diffusion/model/jobs.py)：
  `JobParams` 记录范围和区域，`Job` 保存执行状态，结果使用情况另行记录；
  `JobQueue` 管理文档中的任务与结果选择。

### 采用与边界

采用“源版本 + 明确区域 + 参数 + 候选”的交接方式，并区分运行完成与采用结果。
不复制其 Python/Qt 文档模型，不复制完整生成 UI，不要求安装其专用节点才能用工作台。
Selene 现有 API 图已经可由 Agent 调用，先增加具名输入映射即可。

ROI 裁剪后必须返回原图坐标变换，禁止直接按预览尺寸回贴。第一版优先交付全尺寸
蒙版与补丁，裁剪仅由确实需要它的模块显式声明。

## 3. ComfyUI：原生执行接口已经足够

### 观察

官方 [Server Routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
列出 `/prompt`、`/history/{prompt_id}`、`/queue`、`/ws`、`/object_info` 与上传接口。
提交返回任务标识，节点元数据可以查询，不需要为每张图都新建 HTTP 服务。

官方 [Server Messages](https://docs.comfy.org/development/comfyui-server/comms_messages)
进一步区分执行消息；`executed` 是节点返回 UI 输出时的消息，不能单独当成整个任务完成。
`/interrupt` 的路由描述针对当前执行，不能假设为一个任意外部任务提供安全的按 ID 取消。

### 采用与边界

- 优先复用用户已有 ComfyUI MCP／客户端；确实缺少时才写薄适配器。
- API 图保持为 ComfyUI 资产。模块描述只映射具名输入到已知节点字段，并说明输出角色。
- `runId` 与外部 `prompt_id` 分开；取得实际历史和产物后才回报完成。
- 节点进度不直接折算为准确的全任务百分比。未知进度显示阶段与已知值。
- 不因返回了任务 ID 就声称可以取消；只对已确认属于本任务、且后端支持的操作提供取消。
- 不把工作流 JSON 当作 UI 工作流与 API 图之间无条件兼容的格式；包装时明确采用哪一种。

本项目不重写调度、缓存、节点发现或 GPU 管理。模块登记是保存描述，不启动服务，
不运行图，不下载模型。外部脚本与凭据仍由 Agent 所在环境管理。

## 4. Label Studio：提议和人工标注必须分开

### 观察

官方开源文档 [Pre-annotations](https://labelstud.io/guide/predictions)
使用独立的 `predictions` 数据承载预标注，包含模型版本与结构化结果。
[Labeling results](https://docs.humansignal.com/guide/labeling.html)
说明区域 ID 可连接模型结果与后续人工标注；这里仅借鉴数据语义，不依赖 Enterprise 审核功能。

阅读了固定提交
[tasks/models.py](https://github.com/HumanSignal/label-studio/blob/3f02905bb66b1542ed462662abc61dac47204c1d/label_studio/tasks/models.py)：
`Prediction` 保存 `result`、`score`、`model_version`；
`Annotation` 另有 `result`、`completed_by`、`parent_prediction`。
这使修改后的答案仍可追溯原提议，而不是用人工答案覆盖模型输出。

### 采用与边界

工作台采用 `proposalId + target + suggestedValue`，人工决定另存
`accepted / edited / rejected` 与最终值；置信度可缺省，不能伪造统一评分。
标签编辑、片段边界修改后仍关联原提议。

不部署 Django 标注服务、不引入多租户、多人派单、训练管线或完整 XML 标注配置语言。
已有素材库 `tags` 保留；新审核记录补足“谁建议、谁确认、确认了哪一版”的信息。
将来确需 Label Studio 交换时增加边界转换，不把其整个内部格式作为本项目存储模型。

## 5. CVAT：单帧形状与视频轨迹是不同对象

### 观察

官方 [Brush annotation](https://docs.cvat.ai/docs/annotation/manual-annotation/shapes/annotation-with-brush-tool/)
是画笔标注入口；旧版官方说明仍可参考
[v2.3 brush guide](https://docs.cvat.ai/v2.3.0/docs/manual/advanced/annotation-with-brush-tool/)。
本次新版页面未提供可提取正文，因此具体实现结论来自以下源码，而非猜测最新版 UI。

固定提交 `172ea51a2ffc11adb08b1c9fb757282d142cd810`：

- [mask-shape.ts](https://github.com/cvat-ai/cvat/blob/172ea51a2ffc11adb08b1c9fb757282d142cd810/cvat-core/src/annotations-objects/mask-shape.ts)：
  蒙版形状有自身边界与序列化。
- [track.ts](https://github.com/cvat-ai/cvat/blob/172ea51a2ffc11adb08b1c9fb757282d142cd810/cvat-core/src/annotations-objects/track.ts)：
  按帧保存形状，查找相邻关键帧，并具有独立的插值与属性更新逻辑。

### 采用与边界

只借鉴对象边界：一帧上的区域不能自动变成整段视频的区域。
首版保存单帧／明确帧列表的蒙版，以及独立的视频时间区间标签。
跨帧跟踪交给已有 `motion.track`、`patch.propagate` 或外部模块，返回后仍待审核。

不嵌入 CVAT 全栈，不移植轨迹插值系统。需要长期对象跟踪、复杂遮挡和多对象标注时，
先评估外部 CVAT 工作流及结果导入，而不是默认扩建本地画布。

## 6. 压感笔迹：小库可复用，完整画板不必引入

官方 [PointerEvent.pressure](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pressure)
提供设备压力值。实际设备是否传入有效变化仍需 Windows/Electron 真机验收。

[perfect-freehand](https://github.com/steveruizok/perfect-freehand)
是 TypeScript 笔迹轮廓库，提供真实压力输入和关闭模拟压力的选项。
固定源码
[getStroke.ts](https://github.com/steveruizok/perfect-freehand/blob/176e00f2399f4969e1b0965c5921d96a3e50ce9f/packages/perfect-freehand/src/getStroke.ts)
显示其职责为从输入点生成笔迹轮廓，渲染由调用方完成。
它不负责素材版本、像素编辑、撤销或蒙版语义。

决策：

1. 复用浏览器 Pointer Events、Canvas 2D、仓库现有视口变换。
2. 不手写新的压感平滑／轮廓算法。若原生简单笔迹不能满足真机验收，
   优先评估 `perfect-freehand`，仅引入所需笔迹能力。
3. 像素修补模式保持硬边和源像素定位，不能强行套用平滑笔迹。
4. 当前未安装该依赖，未选择其发布版本；正式引入时固定版本并更新第三方清单。

## 7. 本仓库的直接复用证据

| 已检查位置 | 现有职责 | 对设计的约束 |
| --- | --- | --- |
| [design-principles.md](design-principles.md) | 外部 Agent；同一项目的 GUI/CLI | 不增加聊天客户端或隐式 Agent 启动 |
| [material/types.ts](../packages/core/src/material/types.ts) | `tags`、用户笔记与 AI 摘要分离、记录 revision | 不复制一份素材库；不覆盖人写的笔记 |
| [requirement.ts](../packages/core/src/types/requirement.ts) | 任务、参考、结果素材、分析记录 | 扩展任务目标，不另造看板后端 |
| [review-range.ts](../packages/core/src/types/review-range.ts) | 现有范围是 timeline 坐标 | 新增源素材目标；旧时间线审阅不能重解释 |
| [media-production.ts](../packages/core/src/types/media-production.ts) | 声明式生产步骤和候选状态 | 不把声明升级为实际执行证明 |
| [requirements-slice.ts](../apps/web/src/stores/project/requirements-slice.ts) | 任务通过 Action 提交 | GUI/CLI 继续共用持久化与撤销边界 |
| [command-catalog.ts](../packages/agent-facade/src/command-catalog.ts) | 命令输入输出、effect 与 retry 描述 | 新入口进入同一目录，不另建隐藏接口 |
| [MotionCreatorApp.tsx](../apps/web/src/motion/MotionCreatorApp.tsx) | 进入时创建 Motion 项目／合成 | 新工作台不能直接换名继续挂载此入口 |

现有 [帧审阅](MEDIA-REVIEW-WORKFLOWS.md)、[蒙版工具](MASK-PROPAGATION.md)、
[生产管理](PRODUCTION-MANAGEMENT.md)、[音频分析](MATERIAL-ANALYSIS.md)
可以复用，但本次没有对本机运行时做能力探测；文档存在不等于本机后端已就绪。

## 8. 复用方式的选择与排除

| 候选方式 | 结论 | 原因 |
| --- | --- | --- |
| 直接使用 ComfyUI API 图和现有客户端 | 第一版采用 | 已满足生成和节点组合需求 |
| 复用 ReelTerminal 任务、素材、历史与媒体工具 | 第一版采用 | 保持单一事实源和现有用户习惯 |
| 小型笔迹库 | 按真实手感评估 | 避免重写轮廓算法，不带入整个编辑器 |
| 嵌入 Krita AI Diffusion | 不采用 | 其运行模型是 Krita 插件，不能直接替代 React 工作台 |
| 嵌入完整 Label Studio / CVAT | 不采用 | 引入独立服务、存储和任务体系，首版需求不需要 |
| 为每个 ComfyUI 节点新建一个 API 服务 | 不采用 | 原生 API 已有，增加部署与维护成本 |
| 新建通用 DAG／自动重试执行平台 | 不采用 | 执行已由 Agent 与外部工具承担 |

本次没有复制第三方实现代码。后续若引入依赖或移植代码，应针对具体文件与版本核对
许可证和分发要求；“可以借鉴交互”不代表“可以直接复制代码”。
这一步属于依赖选型验收，不把整个实现计划扩成一次许可证改造。

## 9. 尚需通过实现验证的事项

- Windows 实际数位板的压力、缩放落点、擦除与撤销手感。
- 原预览组件能抽取多少源素材播放能力；不预先承诺可以整块搬用。
- 用户现有 ComfyUI 客户端是否提供任务归属明确的取消；不靠接口名字推断。
- PNG 序列作为成组素材的保留与预览映射；现有单文件媒体入口不能冒充已经支持。
- 完成标注确认后，跨项目素材库的标签投影必须显式执行，不能伪称跨数据库原子提交。

这些都是任务清单中的待办。调研结论不代替实际接口验证、测试或用户验收。
