# 2026-10-15 逐次真实导出内存归因

已先复核既有十次导出、vmmap 和空闲段，再做小规模定向复现。主要触发点已定位并局部修复：**冷启动未初始化导致逐帧随机解码，以及同素材的不同片段共用一个顺序游标导致反复回跳**。异常主要在视频解码／逐帧合成阶段形成，编码／mux 收尾后仍以 native/shared memory 保留；不是历史条目或 JS heap 数 GiB 增长。

原始被测提交为 `92f8f75335f5281334797c15541e59b493358db4`，应用版本1.1.2；本次分析父提交为 `e17f5003e97cc4c0c601cbcc0652216e95c739e0`，初始修复提交为 `cc7e7834a52f4e1ed7a47ca84828fcb59e8dbfb0`，游标回收补充提交为 `3088bf4f2f45233b6aa552ba0b4f9ba6a7c546b5`。最后定向运行的三个产品源码文件哈希已逐一核对到游标回收补充提交。实际构建、阶段记录和计数见[机器可读摘要](macos-export-memory-attribution-2026-10-15.json)。

## 已有证据先得到的结论

- 旧 `real-media-1792006839220` 十次成功导出的 renderer top MEM依次为3580、4079、4497、4749、5143、5534、5920、6420、6700、7201 MiB。历史、工程revision和队列不随这十次改变。
- 首个空闲采样降187 MiB至7014 MiB，此后近5分钟保持。worker JS heap在结束／空闲时约9.3 MiB；不是数GiB的JS对象累计。
- 旧vmmap空闲记录中shared memory约8.4G虚拟、6.7G换出、4254个区域。PartitionAlloc分析不完整，不能从摘要直接指定C++保留对象。
- 旧采样在整次导出及内容验证后；第一份还跨越播放、编辑、取消及故障恢复。因此旧记录只能定位到进程和native/shared口径，不能单独区分解码／合成／编码／收尾。未删除旧证据或修改原判定。

## 定向复现及阶段定位

复用原三份合成1080p30 H.264/AAC视频及固定12秒工程，不重新生成素材。四个配置各在独立worker中连续导出两次，**每个配置内不重启、不强制GC**，随后同进程空闲30秒。包含三轨、文字、转场和1.5x varispeed；输出仍为1920×1080@30 H.264/AAC。总共8次成功真实导出，没有重跑R02、T03或全量压力套件。

观察器只包装真实方法，在hydrate、音频、选定视频帧、backend finalize及export finally边界暂停采样；不换模拟后端。记录webcodec构造／close、游标重置、WeakRef存活、CDP heap、macOS top、ps RSS及vmmap。采样和WeakRef观察会影响时序／GC，因此**只用于归因，不是性能成绩或正式ABBA比较**。

| 配置 | 第1次收尾renderer MEM MiB | 第2次收尾 | 空闲30秒 | 累计VideoDecoder创建数（含探针1个） | 两次累计回跳重置 | 命令总秒数（含采样／验证／空闲） |
| --- | --- | --- | --- | --- | --- | --- |
| unmodified runtime, lifecycle instrumentation | 3768 | 4121 | 4086 | 1082 → 1272 | 未采样 | 310.986 |
| initialize media engine only | 1121 | 1423 | 1343 | 191 → 381 | 374 | 221.712 |
| initialize media engine + clip stream cursors | 795 | 851 | 610 | 5 → 9 | 0 | 67.046 |
| both fixes + retire inactive auxiliary cursors | 804 | 854 | 608 | 5 → 9 | 0 | 68.635 |

每个收尾点VideoDecoder的close次数都与创建次数相同。加入游标回收的最终两次仍有50 MiB收尾差值，不能叫零增长；空闲后608 MiB也不是零原生保留。top MEM包含压缩／共享记账，不等于RSS，不相加为独占物理内存，也不当作显存。

未修复运行的音频结束约104 MiB，第90视频帧约1495 MiB，第360帧约3869 MiB；finalize／finally后仍约3768 MiB。首轮1082个VideoDecoder中包含探针1个，实际导出创建1081个，且exportDecoders始终为0，直接对应冷启动逐帧回退。

只修冷启动后，每次记录187次回跳，保存的回跳样本均来自同一蓝色文件：例如先读5.9秒，再读0秒。上层蓝色片段与转场／背景蓝色片段共用mediaId而读取不同源时刻，反复销毁／重建顺序迭代器。第二轮又创建190个VideoDecoder，renderer共享区域从286增至477。未修复运行第二轮共享区域2512→2702，恰增加190个；这种对应关系支持解码器反复创建是主要触发路径，**并非已取得Chromium底层分配所有权证明**。

两处修复后，每次只创建4个实际片段解码流，回跳为0；最终回收补充组的两个收尾共享区域为104／111，空闲110。对应shared memory约536.3／550.3／542.4 MiB，仍有显著原生占用，未验证长期上界，不能声称已证明长期无泄漏。

## 修复及验证

1. ExportEngine在预建顺序解码器前显式初始化MediaBunnyEngine，避免异常被吞后首轮退回逐帧随机解码。
2. VideoEngine向导出读取传递clip ID；ExportFrameDecoder对实际触达的不同片段延迟创建独立游标，首片段复用原游标，辅助游标不再被当前帧使用时及时dispose，其余随导出decoder统一dispose；嵌套合成只在外层帧结束后回收。没有为工程所有片段预先创建解码器，没有改历史上限／生产阈值或增加worker重启。
3. 新增冷引擎首帧和同素材交错偏移读取的回归；两项在缺少相应修复时实际失败，恢复修复后通过。原有合法回跳、顺序解码、导出与特效回归共45项通过，core/runtime类型检查通过。
4. 修复后两份真实输出均完整FFmpeg解码、H.264/AAC流及360帧核对通过；2秒和8秒的背景／蓝色PiP／绿色1.5x PiP共每份6个帧号，误差不超过1帧，确认独立游标未串源／串时刻。
5. 已按仓库脚本重新构建正常production worker `apps/desktop/dist/browser-entry.mjs`，不是模拟实现。本次没有重新打包macOS `.app`；既有release目录中的旧包仍对应先前被测版本，不把它称为包含此次修复。

## 证据与范围

本机证据根为 `apps/desktop/e2e/.artifacts/export-attribution-2026-10-15/`：

- `retained-evidence-analysis.json`：旧记录复核。
- `run-3/`、`cold-init-fixed/`、`clip-stream-fixed/`、`bounded-stream-fixed/`：四组`phase-memory.jsonl`、逐阶段vmmap、两份输出、退出与控制台记录；最终组另存实际诊断bundle、测试源码及产品源码哈希。
- `run-3/vmmap-full-idle-96950.txt`：全量映射，共2432个2048K共享区域等；单独保留，不从虚拟地址空间大小推算实际占用。
- `cold-init-regression-before.log`、`stream-cursor-regression-before.log`及after／typecheck日志：失败再通过的回归证据。
- `CLEANUP.json`：所属24个浏览器进程已全部退出，只删除本次失败准备留下的空临时目录，保留全部成功／失败证据。

两次准备错误（诊断变量重名、错误probe方法名）均为工具问题、零导出，原日志保留。早期诊断结果曾错误硬编码`no_production_code_change=true`；对已修复配置该字段不准确，已原样保留并以execution中的patch说明及实际源码／bundle哈希纠正，最终定向运行已使用修正后的字段。定向vmmap摘要在命令成功时没有单独保留stderr，故“未看到PartitionAlloc警告”不能解释为分析完整；全量映射及旧vmmap的工具限制仍保留，未来采集已改为同时保存stdout/stderr。

**此次定位并修复的是造成大规模解码器重建的两条产品路径，尚未定位Chromium具体C++对象／共享页的底层保留机制。** 两次修复后短跑不能替代十次新包导出或长时验收；此前R02低速趋势、启动超时和OS采集未覆盖项也没有由本次消除。因此不改写原始报告为通过，不自动放行发布；本次按定向归因范围结束，不重复全量长跑、不打标签或发布Release。

后续已另行完成[包含修复的新macOS包十次真实导出和五分钟空闲复测](macos-native-export-retest-2026-10-15.md)，被测源码为`a8c6925cfa067a25e347db41ba7be050b5c4757d`。10/10输出通过，空闲实际300.442秒；renderer收尾MEM为791→983 MiB，空闲745 MiB保持，仍有导出阶段残余增长。本报告上文“未重新打包”指归因阶段本身，后续打包身份、逐次数据与限制以新报告为准，未覆盖旧证据或更改原归因记录。
