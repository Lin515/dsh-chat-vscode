# 源代码目录导读

本扩展是 `dsh web` 的自绘前端：**webview 界面是自己的，能力与数据语义与官方一致**。
四个子目录按「运行环境」划分，跨环境的共用代码单独放 `shared/`。
本文件只说明 `src/` 根下的文件与各子目录的职责；**子目录内文件的说明见各子目录自己的 `README.md`**。

| 目录 | 运行环境 | 职责 |
|---|---|---|
| `src/` 根 | 扩展宿主（VS Code 扩展进程） | 扩展入口与 webview 面板宿主 |
| `src/dsh/` | 扩展宿主（Node 环境，可用 `vscode` 与 Node API） | dsh 协议适配、会话控制器、supervisor 连接链路 → [src/dsh/README.md](dsh/README.md) |
| `src/shared/` | 宿主与 webview **两边共用**（纯函数、不碰 `vscode` 也不碰 DOM） | 视图模型类型、线上帧协议、宿主界面共用的折叠算法 → [src/shared/README.md](shared/README.md) |
| `src/supervisor/` | 独立守护进程（由扩展以 `dist/supervisor.js` 拉起，**不能 import `vscode`**） | supervisor 进程本体 → [src/supervisor/README.md](supervisor/README.md) |
| `src/webview/` | webview（浏览器环境，React，不能碰 Node） | 全部自绘界面 → [src/webview/README.md](webview/README.md) |

依赖方向：`webview → shared ← dsh`；`supervisor` 只能依赖 `dsh/` 里的纯模块。
改动界面文案先读根目录 `AGENTS.md` 的中英双语章节；协议相关先读 `docs/dsh-server-api.md`
与 `docs/dsh-compat.md`。

---

## src/ 根（扩展宿主）

- `extension.ts` — 扩展入口：注册命令、`ChatViewProvider`、配置监听、supervisor 管理器装配与停用清理。
- `chatView.ts` — 承载自绘界面的 webview 面板：只做注入带 nonce 的 CSP、加载打包产物、宿主 ↔ 界面消息转发；所有会话逻辑都在 `dsh/controller.ts`。
