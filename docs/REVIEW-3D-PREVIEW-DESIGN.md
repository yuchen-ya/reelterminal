# 审阅工作台轻量 3D 预览器：调研与实施设计

日期：2026-10-23。状态：调研设计，未实施。独立于正在进行的 A7 验收，不把本方案自动加入该执行会话。HTML 仍只管理附件/链接并用默认浏览器打开，不实现嵌入容器。

## 1. 结论和范围

采用仓库已有 Three.js 0.182.x 和官方 GLTFLoader/OrbitControls/AnimationMixer，新增独立的 ModelPreview 视图。用户在同一审阅节点里查看模型、播放已有动画、保存观察截图与反馈、采用或导出。模型生成、转换、修正继续由外部 Agent/工具完成。

第一版包含：自包含 GLB 2.0、默认场景、旋转/平移/缩放/适应画面、标准视角、材质显示、已有动画选择/播放/暂停/时间拖动、观察截图、版本对照、正式原件导出。

不做：建模、雕刻、变换手柄、骨骼/材质编辑、复杂场景树、物理模拟、AR、CAD 测量、模型自动修复、3D 点云/高斯泼溅、任意 JS/HTML 执行。线框、骨架调试、表面锚点标注也不属于第一版门禁；真实需要后再加。

## 2. 调研比较

| 项目/能力 | 可借鉴点 | 本项目决定 |
|---|---|---|
| Google model-viewer | 成熟的相机交互、自动取景、动画选择与播放；能快速做模型展示 | 可行备选，但会增加新依赖和组件桥接。现有 Three.js 已安装，版本对照/快照与工作台共用状态更适合小型本地组件 |
| donmccurdy/three-gltf-viewer | 基于 Three.js 的本地 glTF 拖放查看器 | 参考加载、取景和错误呈现思路；不整体嵌入其应用或参数面板 |
| Khronos glTF Sample Viewer | glTF/PBR 参考实现和格式兼容检查用途 | 用样例做材质与动画对照；不引入另一套渲染器，也不声称像素一致 |
| 仓库 MotionThreeRenderer | 已有 GLTFLoader、动画 mixer、环境光与渲染释放代码 | 复用已有依赖/必要独立函数；不实例化整个 Motion 引擎 |

源码核对：`packages/core/src/motion/motion-three-renderer.ts` 的 fetchModel 使用 loadAsync，catch 后返回 null；loadModel 默认归一化、克隆并缓存，与 Motion 场景/特效生命周期耦合。直接复用类会把编辑器状态和隐式失败引入审阅，不符合轻量目标。

检查本地 `node_modules/.pnpm/three@0.182.0/node_modules/three/examples/jsm/loaders/GLTFLoader.js`，不能把官网最新版支持的扩展列表当成当前版本能力。无需为本功能升级 Three.js。

## 3. 文件契约：先单文件闭环

- 新类型命名 `model3d`，不能伪装成 image/video；内容绑定真实 FileResource。GLB MIME 为 model/gltf-binary，仍需验证文件头/version/长度与 JSON chunk，不靠扩展名识别。
- 首版只接受没有外部依赖的 GLB。GLB 本身仍可能有外部纹理 URI；导入检查所有 buffer/image URI，外部路径/网络引用拒绝预览并明确缺失依赖，不发起隐式网络访问。
- 基础 glTF 2.0 PBR、嵌入 PNG/JPEG 纹理、skinning/morph、已有动画作为首版样例范围；required 扩展逐项检查。Draco/Meshopt/KTX2 暂不承诺：缺解码器给明确提示，请 Agent 提供无压缩预览 GLB。若真实样例必须依赖压缩，另包本地解码器及许可再加相应用例，不使用 CDN。
- 未知 required 扩展拒绝；未知 optional 扩展允许显示兼容性提示，不宣称外观完全保真。
- FBX/OBJ/Blend/USD 等文件不在首版原生查看范围。若工作台附件能力允许保留它们，可作为源附件关联 Agent 转换出的 GLB，GLB 为明确的派生条目；原件导出不能悄悄变成 GLB。多文件 glTF 资源包留后续，不引入转换器安装流程。
- 参数、文件 extras 和标签作为数据展示，不执行插件或代码。文件读取继续走现有资源权限/受管路径，不给 renderer 任意 filesystem 路径。

## 4. 用户交互

中间查看器取代图片/视频区域，外围节点、步骤、问题、决定、导出保持。网格列表显示静态封面，不为每张卡片创建 WebGL 上下文。

顶部只放“适应画面、视角、背景、截图反馈”；底部有动画时显示片段下拉、播放、时间条和当前秒数。无动画不显示空时间线。默认暂停在初始姿态，不自动旋转、不自动播放。

鼠标左键拖动环绕、右键拖动平移、滚轮缩放；触控对应 OrbitControls 默认手势。首次提示可关闭。标准视角显示前/后/左/右/顶；说明是约定轴向，不自动判断角色脸朝哪边。选模型自带相机或多场景不是首版必需。

默认透视相机，通过边界调整 camera/target/near/far；不修改资产根变换、不重写实际尺寸。提供固定中性环境与浅/深背景，关闭默认装饰性阴影/后处理；保持 glTF 材质 alpha/unlit 语义。曝光、色调映射和输出色彩空间作为固定 viewer preset 记录，不在 UI 放一排调参滑块。其默认数值通过 r182 样例比对确定后固定并版本化。

信息折叠区显示文件大小、场景数、mesh 数、三角形数（明确为三角图元，实例数另计）、动画列表、模型包围盒。不能把未知作者单位宣称为精准物理尺寸；显示 glTF 单位约定与测得范围。空场景、只有非 mesh 图元、零大小边界必须给出可理解提示。

## 5. 反馈和版本对照

第一版用“截图＋观察状态＋备注”，不承诺点击表面永久粘附的 3D 标记。点击截图反馈时暂停并冻结：item/version/resourceId、camera position/quaternion/target/FOV/near/far、背景/渲染 preset、动画 index/name/time、视口宽高。快照生成后可沿用二维截图圈注，不把圈注投射回模型表面。

截图是有来源的反馈附件，不是模型新版本。新增 `model-view` target，绑定观察快照与具体内容版本；使用现有 confirmed feedback、原子提交、撤销、handoff 守卫。快照图资源由反馈/交接保留引用，不可缓存清理掉。只转相机/播放不产生内容修订、历史或处理步骤。

点击已保存问题恢复该版本和观察状态；模型缺失就展示快照和缺失提示。新版本不自动沿用旧 node/mesh/vertex 身份；不会因名字相同就认为问题已解决。

步骤中的 GLB 输入/输出自动使用该查看器；没有步骤记录不推断流程。第一版并排最多两个模型：默认各自适应画面，可显式“联动方向”（同观察旋转，各自取景尺度）或“相同坐标相机”（只在用户确认坐标一致时）。界面说明两者差别；不提供假几何差异图、自动配准或像素滑杆。

两边动画默认独立播放；同名不代表同动作。不做自动时间映射，用户分别定位即可。为了简单，先实现静态对照和独立时间定位，不增加动画重定向。

## 6. 渲染生命周期与稳定性

React ModelViewerWorkspace 管理 UI；小型 model-preview-runtime 管理 Three.js 对象，接口仅 load/render/resize/setView/setAnimation/capture/dispose。无需通用插件框架，也不把 runtime 塞进 core 数据模型。

动态导入 Three.js/loader，仅选中模型或打开对比时加载。静态场景按需渲染；动画和相机阻尼时申请帧，结束/隐藏/切页停止。单视图 1 个 renderer，对比最多 2 个；列表封面串行生成，旧条目卸载释放。

加载采用 generation token：快速切 A→B 后迟到 A 结果不得覆盖 B，迟到对象仍须释放。记录 loading/ready/unsupported/error/context-lost 状态，禁止 broad catch 返回空白。WebGL context loss 显示重载预览入口，已保存内容/反馈不受影响。

集中释放去重后的 geometry/material/texture、环境 render target、mixer/action 缓存、ObjectURL、控件监听和 RAF。ImageBitmap 明确 close（存在且由该实例持有时）；不得因共享纹理重复关闭另一个实例资源。按需截图渲染后读取，避免永久 preserveDrawingBuffer 带来的内存代价。

资源预算先以原生实测确定：G0 记录目标显卡的常用模型、较大纹理和双视图峰值；形成首版文件/解码几何/纹理像素上限，并在解码前做可计算的界限检查。越界仍可保留/导出原文件，但拒绝或明确请求较轻预览副本；不自动降模改变原件。不能只检查 GLB 文件大小防止解码内存膨胀。

## 7. 与现有底座的接入点

| 位置 | 必需变更 |
|---|---|
| `packages/core/src/types/workbench.ts` | content type 增加 model3d，明确 resource 引用；新 model-view feedback target、版本快照 |
| `packages/core/src/review/types.ts` | 可选模型探测元数据及观察状态；不复用 image 的宽高必填 metadata |
| core workbench actions / review reducers | ingest、content.update/rework 类型一致、target 校验、快照冻结及资源引用 |
| `apps/web/src/services/review-workspace/service.ts` | 当前 image/video 分支改成明确资源提取函数，覆盖模型；导出/版本/包恢复/GC 全链路，避免漏引用 |
| workbench controller / types / 页面路由 | 模型筛选、GLB 导入、视图分派、问题快照；保留旧四类兼容 |
| `ReviewProcessView.tsx` | 模型阶段输入/输出与两侧对照；继承精确版本导出 |
| agent-facade schema/catalog | 正式 review.ingest/get/content.update/rework/handoff 契约增加 model3d；context/capabilities 明确支持格式 |
| export/node-package parser | 原 GLB 字节保真；模型及截图引用都入包；新包版本识别，旧 reader 对不支持类型明确拒绝 |

已有模型能力不应自动进入 video 项目导入（视频 media.type 不支持模型）；“添加到视频项目”对 model3d 禁用并说明。需要视频时 Agent 另提交渲染视频，不隐式转换。

CLI 继续一个 review 接口，不新增独立 3D 服务或编辑命令。首版 Agent 提交 GLB、来源与步骤即可；GUI 观察反馈通过既有 handoff 读取。不实现任意 camera scripting API。

数据版本必须显式设计：旧项目/节点仍可读取，不批量重写历史；新增类型需要 node-package 能力/版本标识，不能保留旧 schema 却假设老客户端认识。实施前确定当前包版本并做双向兼容/明确拒绝测试。

## 8. 实施顺序与验收

### G0：加载与样例验证

读当前正在开发的 review 源码并协调文件所有权。用已安装 Three.js 建最小隔离试验：静态 PBR/透明纹理、skinned animation、morph、空模型、未知 required 扩展、外部 URI。断网验证所有支持模型加载，不访问 CDN。用 Khronos 样例与参考查看器目视比对材质/动画，仅记录差异不要求跨引擎像素一致。确定预算与固定 viewer preset；下载样例记录来源及逐文件许可，不整仓打包样例。

### G1：正式内容链

model3d schema→ingest/资源→版本→导出/恢复→引用/GC。先打通真实文件与 API，再挂查看器。测试原件导出摘要一致、旧四类型读取和新类型明确拒绝行为。

### G2：轻量视图

加载、取景、控制、动画、错误、资源释放；测试真实旋转/缩放/暂停定位，快速切项不串模型，反复打开关闭无累积 renderer/texture 引用。内存看稳定趋势，不以进程 working set 永不增长作为不现实断言。隐藏后停渲染、重开内容不丢。

### G3：审阅与步骤闭环

保存观察反馈→发布→CLI 读回精确资源/版本/相机/动画时间/截图→Agent 回流新 GLB→对照→采用→拖出。测试两次截图同一 issue upsert、撤销原子性、旧版观察不误用于新版，快照与包恢复后仍可重现。

验收以用户自己的实际模型至少一个作为最后外观检查（用户提供时才访问）；在此前使用许可明确的夹具。所有测试使用隔离项目/profile，不安装替换用户应用、不运行生成模型或付费 API。本设计不授权执行 G0–G3，也不改变当前 A7 工作范围。

## 9. 参考来源（2026-10-23 查阅）

- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)：glTF 加载、压缩解码器显式配置和 ImageBitmap 释放注意事项；支持范围最终以仓库 r182 为准。
- [model-viewer 相机交互](https://modelviewer.dev/examples/stagingandcameras/)：取景、环绕、平移与复位设计。
- [model-viewer 动画示例](https://modelviewer.dev/examples/animation/)：动画选择、播放、时间控制的成熟交互参考。
- [donmccurdy/three-gltf-viewer](https://github.com/donmccurdy/three-gltf-viewer)：本地 glTF 模型查看器路线。
- [Khronos glTF Sample Viewer](https://github.com/KhronosGroup/glTF-Sample-Viewer)：格式/PBR 参考实现；不是本项目新增运行依赖。

以上为文档/源码调研，未执行第三方查看器的真人操作评测，未声称已经验证本仓库模型预览功能。
