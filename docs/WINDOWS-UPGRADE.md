# Windows 1.3.1：下载、备份与升级

1.3.1 当前为本地构建，尚未上传 Release。公开下载以实际 Release 资产为准；本地包见[构建说明](RELEASE-1.3.1.md)。 / 1.3.1 is currently a local build, not a published release; use the actual release assets when available.

## 第一次使用

从项目 [v1.3.1 下载页](https://github.com/yuchen-ya/reelterminal/releases)
选择 Windows x64 安装版（EXE）或便携版（ZIP）。ZIP 必须完整解压到新目录，
再运行 `ReelTerminal.exe`；不要直接从压缩包内启动。

本版未进行代码签名，Windows 可能提示未知发布者或 SmartScreen 警告。
请核对下载来源及 `SHA256SUMS.txt`，不要为运行应用关闭系统安全设置。
如果单位电脑的策略阻止运行，请联系管理员。

## 已经使用旧版：先备份，不要先卸载

**旧版 Windows 卸载器可能移除共享的数据位置设置。1.3.1 会阻止这类安装的直接覆盖升级；
不要运行旧卸载器、删除旧安装目录，或反复尝试自动更新来绕过提示。**

1. 在旧应用的“设置 → 存储”确认数据文件夹，保存工程，然后完全退出应用。
2. 将整个数据文件夹复制到另一个独立位置，保留 `app-data`、`projects` 以及需要的
   `agent-workspace` 内容。不要只复制一个数据库文件；数据库日志和媒体附件也可能必需。
   同时备份 `%LOCALAPPDATA%\ReelTerminal` 中的 `data-root.json` 和
   `uninstall-info.ini`（如果存在）。另存的工程和数据文件夹之外的原始素材需另行备份。
3. **推荐先使用 ZIP**：将新版本完整解压到全新目录，不覆盖旧目录。确认旧应用已退出，
   再启动新目录中的应用；它通常沿用当前用户的数据位置，ZIP 并不自动隔离工程数据。
   检查数据位置、打开重要工程、核对素材和导出结果，确认正常前保留备份和旧目录。
4. 如果必须使用安装版，而安装器提示旧版无法升级，请停止安装并通过
   [Issues](https://github.com/yuchen-ya/reelterminal/issues) 寻求迁移指导。
   不要在公开反馈中上传数据库、私人素材、配置或访问凭据。

安装版迁移可能需要由熟悉 Windows 的人员备份安装登记和快捷方式，
在保留旧文件的前提下向全新目录安装。这里不提供可直接照抄的注册表删除命令；
[维护者迁移指引](WINDOWS-LEGACY-MIGRATION.md)和合成演练也不是一键升级工具。
失败或状态不明时应保留现场，不要盲目导入旧登记覆盖新的修改。

## 卸载与外部工具

1.3.1 默认卸载只移除程序，保留工程数据和数据位置设置，需要时自行检查后清理。
高级命令行参数 `--delete-app-data` 是例外，会另行清理标准 Windows AppData 配置档；
不要用它处理旧版升级问题。

部分导出和音频分析需要单独安装 FFmpeg/ffprobe；本包不附带这些程序。
本地 Qwen/SenseVoice 字幕还需 Python 和模型文件，目前使用 CPU。
可先在“设置”的环境面板检查缺少的组件。详情见[外部依赖](EXTERNAL-DEPENDENCIES.md)。

## English

Download the Windows x64 EXE or ZIP from [v1.3.1](https://github.com/yuchen-ya/reelterminal/releases).
Extract the entire ZIP into a fresh directory before running `ReelTerminal.exe`.
These builds are unsigned: verify the official source and `SHA256SUMS.txt`, and do
not disable system security. Contact your administrator if device policy blocks them.

**Unsafe legacy Windows uninstallers can remove shared data-location settings.
1.3.1 blocks direct installer upgrades from those versions. Do not run the old
uninstaller, delete the old directory, or retry automatic updates to bypass this.**

1. Find the data folder in Settings → Storage, save your projects and quit the app.
2. Copy the whole data folder to an independent backup, including `app-data`,
   `projects` and any needed `agent-workspace` contents. Do not copy just one
   database file: journals and media attachments may also be required. Back up
   `data-root.json` and `uninstall-info.ini` from `%LOCALAPPDATA%\ReelTerminal`
   if present. Back up separately saved projects and external source media too.
3. Prefer the new ZIP in a fresh directory. Quit the old app first and keep its
   files. The ZIP normally uses your existing data location; it does not isolate
   project data. Check the location, important projects, media and exports before
   removing any backup or old files.
4. If you need the EXE and the installer blocks a legacy upgrade, stop and ask for
   [migration guidance](https://github.com/yuchen-ya/reelterminal/issues). Do not
   upload databases, private media, configuration or credentials in a public issue.

An attended installer migration may need registration and shortcut backups before
installing into a new directory without running the old uninstaller. The
[maintainer procedure](WINDOWS-LEGACY-MIGRATION.md) and synthetic rehearsal are
not a general automatic-upgrade tool. Preserve evidence on failure or uncertainty;
do not blindly overwrite newer registration with an old export.

Default 1.3.1 uninstall preserves data and shared settings. The explicit
`--delete-app-data` option separately removes standard Windows AppData profiles;
it is not a migration workaround. Some export/audio tools require separately
installed FFmpeg/ffprobe. Qwen/SenseVoice captions also need Python and models
and currently run on CPU. Use the environment panel in Settings to check readiness.
