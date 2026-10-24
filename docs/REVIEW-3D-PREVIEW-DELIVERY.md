# 轻量 3D 预览器交付（G0–G3）

实施：2026-10-23，最终复验：2026-10-24 00:01（Asia/Shanghai）。当前唯一 checkout 上实施；没有提交、推送、安装或替换用户实例，没有访问用户实际模型或付费/生成 API。应用版本保持 1.3.0。原底座、A7 回调依赖修复及 browser-current-time 契约保留。

## 实际实现

- 正式内容：`packages/core/src/types/workbench.ts` 的 `WorkbenchModelContent`、`ModelObservation`、`model-view` target 与资源提取；`packages/core/src/actions/workbench-actions.ts` 的 ingest/反馈/返工/发布冻结。原模型与观察相互独立。
- 文件预检：`packages/core/src/review/glb.ts`；native 受管副本在 `apps/desktop/src/main/ipc/review-files.ts` 检查并保存 modelPreview 状态，读取/原件保留沿 `review-file-store.ts`。拒绝预览不取消资源导入。renderer 在加载前再次检查字节（覆盖包恢复和旧资源入口）。
- 资源/历史/导出：`apps/web/src/services/review-workspace/service.ts`、`model-feedback.ts`、`file-import.ts`、`comparison.ts`；`packages/core/src/review/content.ts`、`archive.ts`。模型版本、反馈/发布截图、撤销历史均保留资源引用；恢复库存有显式 archive 引用，恢复后再次导出不遗漏被更新的历史截图。
- API：`packages/agent-facade/src/{types,workbench,review,output-schemas,capabilities}.ts`。model3d 使用 resourceId/GLB MIME；现有 review.ingest/apply/steps/versions/get/handoff/export/package 链路复用。观察 schema 闭合；新 nullable 动画对象有正式 JSON Schema 发射。视频 attach 对模型禁用并解释原因。
- 视图：`apps/web/src/desktop/workbench/model-preview/runtime.ts`；`components/{ModelPreview,ModelViewerWorkspace,ModelComparison,ReviewComparison}.tsx`，由 WorkbenchPage/ReviewProcessView 接入。Three.js r182、GLTFLoader、OrbitControls、AnimationMixer 动态加载；没有 Motion 引擎实例。

旋转/平移/缩放、适应画面、五个标准轴向、浅/深背景；已有动画选择、暂停/播放及独立时间定位。默认暂停，无动画不显示空时间线。信息区有文件字节、场景/mesh/含实例三角图元、边界范围（不宣称作者实际物理单位）、预算计数和兼容性警告。

截图冻结相机、背景/preset、动画和视口，另存原生 PNG 资源；备注可标返工。同 observationId 对同版本 upsert，用户可明确新建问题。点击旧反馈加载其准确旧 GLB 并恢复观察；模型缺失仍展示已存 PNG 与加载错误。截图不成为内容修订，新模型不继承旧 mesh/面/顶点身份。恢复时按保存视口比例 letterbox，避免不同窗口比例扭曲观察。

处理步骤的模型输入/输出自动进入查看器。并排最多两个模型：独立取景、方向联动（各自尺度）、用户确认坐标一致后使用坐标相机。动画独立；无自动配准、假几何差异或动画重定向。

静态场景按需绘制，动画才运行 RAF；IntersectionObserver/document visibility 停止隐藏渲染，切页/卸载取消。加载 token/取消处理防止晚到覆盖；晚到 GLTF、部分加载失败的 mesh/纹理、ObjectURL、去重 ImageBitmap、geometry/material/skeleton、PMREM、mixer/controls/RAF 均释放。context-lost 有明确重载入口。列表使用轻量 3D 类型标记，不创建 WebGL 上下文或批量解码封面。

## G0 样例、preset 与预算依据

样例为 `packages/core/src/review/glb-fixtures.test-helper.ts` 生成的真实 GLB/PNG，原创、沿仓库 MIT 许可，无第三方资产或下载。包含基础金属/粗糙 PBR、嵌入 alpha PNG、真实 skin/joint rotation、morph weights 两动画；另有空场景、未知 required、外部 URI、展开预算异常夹具。GLB JSON/header/chunk/bufferView、嵌入 PNG/JPEG 头、accessor 展开、节点环/父子关系、required 扩展与纹理像素均先于 loader 检查。

只承诺当前验证过的核心 glTF 2.0 子集与 unlit/texture_transform/mesh_quantization/emissive_strength 四个无解码器扩展的加载策略。未知 optional 扩展显示外观警告；required 不在允许表就拒绝。Draco/Meshopt/KTX2/实例扩展不加载，无外部 URI/decoder/CDN 请求。非 mesh 或零边界明确报错。原字节照常保存和导出。

固定 preset `neutral-r182-v1`：SRGB 输出、ACESFilmic、曝光 1；本地 RoomEnvironment PMREM 强度 .6，Hemisphere 强度 1、Directional 强度 2，透视 FOV 40；DPR 上限 2，不开默认阴影/后处理、不改根变换。已检查静态、骨骼、morph 截图中的材质/透明与姿态变化。没有与 Khronos/第三方参考查看器做像素或人工一致性评测；这项未被伪称完成，也不外推真实用户模型外观。

本机实际 WebGL：ANGLE / NVIDIA GeForce RTX 5080 / D3D11；Electron 44.5.1（Chromium 152）。双视图压力样例每个 32,733,184 B、480,000 含实例三角图元、4096² RGBA PNG、保守展开计数 69,210,780 B；每视图 renderer.info 为 3 geometries / 4 textures（含环境/渲染内部纹理）。断网 browser context 下真实加载成功，记录没有 HTTP(S) 请求。六轮快速切项后计数不增长；真实 WEBGL_lose_context→重载成功，隐藏后计数停止、显示恢复，切到视频页面没有遗留模型 canvas。

根据实测收紧首版门限：48 MiB GLB、96 MiB buffers+保守 accessor 展开计数、16M 纹理像素、4096 单边、50 万含实例三角图元；节点 10000、深度 128 是结构保护。文件/几何留有限余量，纹理和三角形门限紧贴已测样例。门限不保证范围内任何模型都可加载，也不是整个 GPU 内存的精确估算。双视图加载耗时、进程 working set/private bytes 的具体采样见 budget JSON；不把包含其他 Electron 开销的 working set 当成模型显存，也不声称进程常驻内存永不增长。

## 数据与兼容性

新类型需要 `node.json` archive v2，通用文件库存 manifest 仍 v1；当前读取旧 archive v1，v1 中出现 model3d 明确拒绝；旧实现拒绝 v2 而不静默损坏。无批量重写旧节点。恢复映射模型/截图/观察 ID，旧 handoff 仅历史证据，不能恢复外部执行任务。原 GLB 导出逐字节验证；截图资源及历史 upsert 附件可重开、恢复、再次打包和按节点 GC 保留。

## 验证记录

定向测试已通过（最终包复验结果在下方补记）：

- core：`pnpm --filter @reelterminal/core test:run src/review src/actions/workbench-actions.test.ts src/actions/action-history.test.ts`，4 文件/47 项。
- web：`pnpm --filter @reelterminal/web test:run src/services/review-workspace src/stores/project/workbench-slice.test.ts src/stores/workbench-ui-store.test.ts src/desktop/workbench/feedback-identity.test.ts`，10 文件/42 项；另增加 restore→archive 保留全部历史截图库存和 purge 预览引用的定向测试。
- facade：`pnpm --filter @reelterminal/agent-facade test:run src/model3d-contract.test.ts src/jsonschema.test.ts src/output-schemas.test.ts src/capabilities.test.ts src/workbench-facade.test.ts`，5 文件/286 项。
- native：`pnpm --filter @reelterminal/desktop test:run src/main/review-file-store.test.ts src/main/review-package-store.test.ts src/main/review-export-store.test.ts src/main/review-export-store.faults.test.ts`，4 文件/17 项。
- `pnpm --filter @reelterminal/desktop run pack` 完成 renderer/main 类型检查/构建、手册、许可证及 electron-builder --dir，输出只在 `apps/desktop/release/`。

真实隔离 GUI 脚本 `apps/desktop/e2e/review-model3d.e2e.ts`（2 项）覆盖 GUI 原生导入、静态 PBR/透明、skin/morph 动画定位、真实鼠标观察、默认暂停/无修订、截图与同问题 upsert、精确 CLI handoff、真实新 GLB 返工、步骤并排/方向联动、人工采用、原/采用 GLB 字节导出、重开、节点包恢复观察、恢复后再打包、错误原件导出、快速切项、context loss/隐藏/切页与双视图压力测量。

已有回归：`review-foundation-ui.e2e.ts`、`review-foundation-process.e2e.ts`、`review-foundation-rework.e2e.ts`、`review-video-a7.e2e.ts`。保留四类内容、八步实际素材/部分返工/几何重新发布、A7 VFR/90°/非零 start_time 及有/无时间映射。全部只用 harness 临时 profile/项目/媒体，未触及用户实例。

证据位于 `apps/desktop/e2e/.artifacts/review-model3d.json`、`review-model3d-budget.json` 和同前缀 static/bone/morph/comparison/budget-pair/terminal PNG；既有回归各自前缀。命令日志为 `apps/desktop/.artifacts/model-*.txt`。证据不进入发布 ASAR。

## 范围与限制

HTML 仍仅文件/链接管理与默认浏览器打开；P7、建模/材质/骨骼编辑器、多文件 glTF、压缩解码器、自动对齐/动画映射、永久表面锚点均未扩展。截图第一版是 PNG＋观察＋备注，没有新增投射到模型表面的圈注。列表不生成逐卡 WebGL 封面（降低后台解码开销）。

实测是本机生成样例，不是用户实际模型外观评测；未覆盖不同显卡/驱动、独立设备 DPI/触控/数位板。驱动在 PBR shader 编译有浮点精度 warning，真实渲染可见；context-loss 测试有预期日志，没有把 warning 隐藏成零诊断。原生拖出沿已有正式导出副本/系统手势链，本轮验证复制落盘字节，未重新要求人工 Explorer 接收；底座之前的人工结果与当前包待人工限制不被改写。


## 最终未安装包复验（2026-10-24）

本轮范围内 G0–G3 已完成；以下以最后一次刷新包为准。

```powershell
pnpm --filter @reelterminal/desktop run pack
# passed；app.asar 最后写入 2026-10-23 23:59:09 +08:00，版本 1.3.0
$env:REELTERMINAL_E2E_APP_EXECUTABLE='E:\1my_projects\reelterminal\apps\desktop\release\win-unpacked\ReelTerminal.exe'
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-model3d.e2e.ts e2e/review-foundation-ui.e2e.ts e2e/review-foundation-process.e2e.ts e2e/review-foundation-rework.e2e.ts e2e/review-video-a7.e2e.ts
# 5 files / 6 tests passed，00:00:13 开始，55.74s
```

最终 3D 两项 21.953s（完整审阅/恢复 10.917s，样例/生命周期/预算 11.035s）。A7 11.772s、底座 UI 7.806s、process 7.166s、four-type rework 5.274s。最终压力双视图导入/打开采样 686.216ms；GPU workingSet 349652 KiB/private 920816 KiB，Tab workingSet 530516 KiB/private 424136 KiB，均是整进程采样而非独立显存测量。细节保存在最终覆盖写的 JSON，不以早先轮次数字代替这轮。

最终定向单测总计 392 项（core 47 / web 42 / facade 286 / native 17）通过；额外 service 复验为 7 files / 19 tests，含历史截图 restore→archive→purge 引用。本轮 desktop typecheck、renderer build/typecheck 通过。git diff --check 未报空白错误；保留原有 checkout 的 CRLF 提示及全部其他改动。

ASAR 检查结果 `apps/desktop/.artifacts/model-asar-check.json`：2896 项；无 `.artifacts/e2e/.env/.git/live-endpoint.json`，main/CLI 入口存在。未安装、未替换运行实例。

可运行测试包：`E:\1my_projects\reelterminal\apps\desktop\release\win-unpacked\ReelTerminal.exe`。验收到此结束；实际用户模型外观、不同设备和新版包的人工原生拖出接收仍按上述证据边界保留，不扩大到 HTML/P7 或模型编辑。
