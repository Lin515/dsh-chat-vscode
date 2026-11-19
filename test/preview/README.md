# test/preview/ — 预览页的独立数据

本目录只放离线预览页 `test/preview.html` 消费的数据，不进入扩展发布包。取不到时预览不合成回退。

- [pr4-host-frames.json](<pr4-host-frames.json>) — PR #4 多根工作区 / 历史范围的帧。由当前源码的 `ChatController` 在离屏 `vscode` stub 中实际发出后原样保存（`workspaceFrame`、`historyFrame`、`historyRootsFrame`、`historyDirectoryFrame`、`historyDirectoryAFrame`、`workspaceBetaFrame`、`historyBetaCurrentFrame`）。`?roots=1` 时预览页读取它，并按界面发来的 `historyScope` / `switchRoot` 推送对应已录帧；没有录到的目标不回帧，不手编。

预览入口：

- `?roots=1`：主故事 + 真实工作区 / 历史帧，可打开历史抽屉切换范围；
- `?empty=1&roots=1`：空态页，目录胶囊展开工作区根目录菜单；
- `?scope=roots|alpha|beta`：历史抽屉的起始范围（默认 `current`）；
- 默认、`?empty=1`、`?lock=1` 不加载这份帧。
