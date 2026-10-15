<div align="center">

[English](README_en.md) | **简体中文**

<img src="docs/assets/logo.png" alt="ReelTerminal Logo" width="100" height="100" style="border-radius: 20px;" />

# ReelTerminal

### 面向 AI 视频生产的人机协同视频剪辑器
**生成发生在任何地方，成片交付在这里。**  
*Generate anywhere; finish here.*

<p align="center">
  <a href="https://github.com/yuchen-ya/reelterminal/releases"><img src="https://img.shields.io/github/v/release/yuchen-ya/reelterminal?style=flat-square&amp;color=10B981" alt="Version" /></a>
  <a href="docs/EXTERNAL-DEPENDENCIES.md"><img src="https://img.shields.io/badge/Privacy-Local--First-059669?style=flat-square" alt="Local First" /></a>
  <a href="apps/desktop/DISTRIBUTION.md#build"><img src="https://img.shields.io/badge/Source%20platforms-Windows%20%7C%20macOS%20%7C%20Linux-64748B?style=flat-square" alt="Source platforms" /></a>
  <a href="https://github.com/yuchen-ya/reelterminal/issues"><img src="https://img.shields.io/badge/Feedback-Issues%20Welcome-3B82F6?style=flat-square" alt="Feedback" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-475569?style=flat-square" alt="License" /></a>
</p>

[**🚀 快速开始**](#-快速开始-quick-start) • [**✨ 核心特点**](#-核心特点-core-features) • [**🏗️ 架构概览**](#-系统架构-architecture) • [**💬 交流与反馈**](#-交流与反馈-feedback) • [**📚 详细文档**](docs/)

</div>

---

## 💡 为什么做 ReelTerminal？

当下各类视频生成模型极大地降低了素材创作门槛，但在**碎片化的生成片段**与**最终想要的完整成片**之间，仍有很多繁琐的手工活：

* **素材零散**：生成的视频往往只有几秒，需要精准的拼接、调速、转场以及音画对位。
* **局部坏帧与瑕疵**：AI 生成的帧容易偶发闪烁、局部变形或伪影，若整段重新抽卡成本很高，更需要“定点修补”。
* **缺乏顺手的 AI 协同环境**：传统剪辑软件对大模型助手来说并不友好；而普通的脚本批处理又看不到画面、无法交互和撤销。

**ReelTerminal 试图提供一个平滑的折中解法：**  
保留现代剪辑器直观的画布和时间线，创作者可以在桌面端随手拖拽微调；同时让你的 AI 助手（Cursor、Claude、Antigravity 等）能直接操作工程时间线——**你主导创作和最终取舍，AI 负责批量与结构化处理；双方共享工程状态、编辑历史、版本存档和画面对比。**

![ReelTerminal 中文桌面界面：宣传片工程、R 片段引用标记、素材库、多轨时间线与存档树](docs/assets/desktop-screenshot.png)

*真实宣传片工程截图：保留便于人与 Agent 沟通的 R 片段引用标记，并展示素材库、多轨时间线和版本存档树。*

---

## ✨ 核心特点 (Core Features)

| 🤖 **面向 AI 助手协同设计** | 🎯 **逐帧审查与局部修补** |
| :--- | :--- |
| 为 AI 辅助剪辑定制了严谨的时间线接口，支持原子批处理、CAS 乐观锁与防重复提交，帮助 AI 助手可靠地执行复杂剪辑并检测冲突。内置双语操作手册供 Agent 按需检索，减少对界面操作的猜测。 | 使用 **0-based 解码帧索引** 与真实 PTS 时间戳定位画面，支持帧提取、接触表、区域补丁及对比。配置本地 OpenCV 后可使用光流跟踪与掩码工具。 |
| 🌿 **不可变版本节点与画面对比** | 🔒 **本地优先与受控素材存储** |
| 工作区保存与版本留存分开：保存当前编辑，或建立存档点用于只读预览、画面对比和后续采用。每个工作区保有独立状态，创作者决定是否采用 Agent 的试剪结果。 | 工程、素材缓存、编解码和渲染在本机处理，素材通过哈希引用与受控存储管理。模型、字体下载及可选在线服务按配置联网，外部 AI 助手由用户自行选择。 |

---

## 🚀 快速开始 (Quick Start)

### 方式一：直接使用（推荐 · 无需任何开发配置）

```mermaid
flowchart LR
    A["1. 下载安装包<br>(Releases)"] --> B["2. 打开应用<br>点击「复制启动提示词」"] --> C["3. 粘贴给 AI 助手<br>(Cursor / Claude / 等)"] --> D["4. 指定工程与权限<br>开始协同剪辑"]
```

1. 前往 **[Releases 页面](https://github.com/yuchen-ya/reelterminal/releases)**，选择适合自己系统和架构的安装包。
2. 打开视频工程。需要助手修改工程时，在时间线上方将协作权限切换为 **`可编辑`**；可随时切回只读。
3. 在通知中点击 **「复制启动提示词」**，把内容发给具有本机 CLI 或 MCP 工具能力的 AI 助手。
4. 提示词包含本次安装的命令路径与协作规则。让助手确认目标工程、工作区和权限，再开始编辑；你继续在同一界面查看、调整和决定最终结果。

当前下载提供 **Windows x64 安装器/便携 ZIP** 和 **macOS Apple Silicon（arm64）DMG/ZIP**。具体附件、架构、签名和校验信息以 [Releases](https://github.com/yuchen-ya/reelterminal/releases) 为准。Windows ZIP 需完整解压后运行 `ReelTerminal.exe`。Windows 包未代码签名，可能显示未知发布者；Mac 包未进行 Developer ID 签名或公证，系统可能阻止直接打开。

**源码与安装包分别维护。** 本页介绍当前仓库的功能与用法；下载包包含的功能、修复和使用限制以对应 Release 说明为准，源码更新不会自动更新已安装应用。

使用发布包时，原生导出请先写入新文件名并验证结果后再替换已有文件；应用整工程模板前请保留工程副本，避免跨替换回放先前的撤销/重做。3D 属性修改不单独记录撤销步骤，重要阶段可保留存档点。大工程和长时间编辑可能占用较多内存。

部分导出、媒体分析和逐帧工具需要本机可用的 FFmpeg/ffprobe；OpenCV 工具另需含 `cv2`、`numpy` 的 Python。依赖和联网行为见[外部依赖说明](docs/EXTERNAL-DEPENDENCIES.md)。

---

### 方式二：开发者源码构建与启动

使用 Node.js 22.13.0 或更新版本，以及仓库固定的 pnpm 11.7.0。以下示例通过 Corepack 调用 pnpm：

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal

corepack pnpm install --frozen-lockfile
corepack pnpm build:wasm
corepack pnpm --filter @reelterminal/desktop build
corepack pnpm --filter @reelterminal/desktop start

# 可选：启动浏览器开发服务器
corepack pnpm dev
```

开发检查和可选工具配置见 [CONTRIBUTING.md](CONTRIBUTING.md)，打包命令见[桌面构建说明](apps/desktop/DISTRIBUTION.md#build)。

---

## 🏗️ 系统架构 (Architecture)

```mermaid
flowchart TD
    subgraph Clients [" 交互终端 (Dual Interfaces) "]
        GUI["🖥️ Desktop GUI (Electron + React)"]
        Agent["🤖 外部 AI 助手 (Cursor / Claude / CLI)"]
    end

    subgraph Facade [" 控制门面 (Control Facade) "]
        Bridge["CLI / MCP · 本机 Command API"]
        Guard["Revision 乐观锁 (CAS) & 幂等事务"]
    end

    subgraph Core [" 核心引擎 (Core Engine) "]
        Store["每个工作区的 Project Store<br>GUI / Agent 共享状态与编辑历史"]
    end

    subgraph Runtime [" 本地运行时 (Local Runtime) "]
        Render["Chromium & WebCodecs 渲染"]
        Tools["可选本地工具<br>FFmpeg / OpenCV"]
    end

    GUI <-->|"界面操作与状态订阅"| Store
    Agent --> Bridge --> Guard --> Store
    Store --> Runtime
```

---

## 💬 交流与反馈 (Feedback)

ReelTerminal 面向需要整理、修补并交付 AI 视频的创作者，由独立开发者维护。欢迎反馈真实创作中的问题和需求。

可以通过 Issues 反馈：
- 遇到了 bug 或奇怪的交互体验？
- 有某个剪辑工作流特别希望得到支持？
- 对时间线或 AI 协作交互有更好的想法？

欢迎在 **[GitHub Issues](https://github.com/yuchen-ya/reelterminal/issues)** 附上操作步骤和必要的脱敏信息；安全问题请使用 [SECURITY.md](SECURITY.md) 中的私密报告渠道。

---

## 📚 详细文档 (Documentations)

使用指南、开发说明与发行信息：

- 📖 [**桌面端用户手册**](docs/USER-GUIDE.md) — 桌面端安装、界面导览与常用操作。
- 🌿 [**多项目与版本节点指南**](docs/MULTI-PROJECT-USAGE.md) — 紧凑版本轨道、保存与留存分离（Save vs Retain）、只读预览与画面对比。
- 📐 [**版本节点交互规范**](docs/VERSION-NODES-UX.md) — 存档树、采用（Adopt）、回收与冲突保护设计准则。
- 🤖 [**外部 Agent 协作指南**](docs/AGENT-GUIDE.md) — 权限机制、CLI 详解与进阶接口。
- 🗂️ [**任务工作区规程**](docs/AGENT-WORKSPACE.md) — 独立工作目录规程与落盘准则。
- ⚙️ [**Command API 规范**](docs/COMMAND-API.md) — 命令目录、Schema 校验与并发控制。
- 🎞️ [**媒体审查与修复流**](docs/MEDIA-REVIEW-WORKFLOWS.md) — 逐帧提取、接触表与光流运动追踪。
- 🎨 [**色彩管理白皮书 (SDR)**](docs/COLOR.md) — BT.709 与 BT.601 颜色转换规范。
- 🌐 [**外部依赖与联网行为**](docs/EXTERNAL-DEPENDENCIES.md) — 本地工具、资源下载及可选在线服务。
- 📦 [**发行与更新说明**](https://github.com/yuchen-ya/reelterminal/releases) — 安装包、修复范围、签名与校验信息。

---

## ⚖️ 开源协议与鸣谢 (License & Attribution)

* 本项目核心代码基于 [MIT License](LICENSE) 开源发布。
* 本项目继承并改造自 Augustus Otu 及贡献者开源的 MIT 协议项目 [OpenReel](https://github.com/Augustus-Otu/openreel)，原始版权声明予以完整保留。
* 第三方组件、字体与模型授权审查详情请参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
