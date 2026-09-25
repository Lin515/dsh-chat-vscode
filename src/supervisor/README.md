# src/supervisor/ — 独立守护进程

运行环境：独立守护进程（由扩展以 `dist/supervisor.js` 拉起，**不能 import `vscode`**）。
上一层的说明见 [../README.md](../README.md)。

- `main.ts` — supervisor 进程本体：持有 `dsh web` 子进程、接受扩展连接、空闲按端口杀 dsh 整棵树并清场、dsh 崩了按需重拉。只依赖 `dsh/` 里的纯模块，不碰 `vscode`。
