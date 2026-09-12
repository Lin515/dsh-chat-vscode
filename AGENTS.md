# 项目 AI 文档（DSH Chat）

> 本文件是**本仓库所有 AI 会话的强制约束**。项目内约定优先于用户级 `~/.dsh/AGENTS.md`。
> 改代码前先读这一份；与它冲突的改动一律先问用户。

## 最高优先级：任何改动都必须考虑中英双语

**这是硬规则，不是建议。** 本项目从第一天就是双语的：VS Code 扩展商店面向全球，
用户里有中文也有英文用户。任何一次改动，只要**新增/修改了用户能看到的文字**，
就必须同时准备好中英两套。

### 三条链路，各自的语言来源不同

| 载体 | 语言来源 | 放哪里 |
|---|---|---|
| **webview 界面**（聊天区、输入框、面板、目标条…） | `dshChat.language` 设置（`auto` 跟随 VS Code 显示语言） | `src/webview/texts.ts` 的 `zh` / `en` 两个字典 |
| **VS Code 原生 UI**（通知、输入框标题、错误弹窗、命令名、配置项描述） | **VS Code 自己的显示语言**（与上面的设置无关） | `package.nls.json`（英文，源语言）/ `package.nls.zh-cn.json`（中文） |
| **宿主 → webview 的文案**（toast、连接说明、错误详情） | 由 webview 决定 | 见下方「`@key` 标记」 |

### 硬性检查项（每次改动都要过一遍）

1. **不在宿主里写死用户可见的中文**。宿主侧（`src/dsh/`、`src/extension.ts`）的
   注释用中文没问题，但**要显示给用户的文字**必须走下面两条之一：
   - 交给 webview 渲染的 → 用 `@key` 标记；
   - 交给 VS Code 自己弹出的 → 用 `vscode.l10n.t(...)`，并在
     `l10n/bundle.l10n.zh-cn.json` 里加译文。
2. **加了 `@key` 就必须补齐三个地方**，缺一个界面就会显示成原始 key：
   - `src/webview/texts.ts` 的 `Texts` 接口；
   - 同文件的 `zh` 与 `en` **两个**字典（TS 会强制，别绕过去）；
   - 同文件 `resolveText()` 的 `switch`（带参数的 key 必须在这里拆参数）。
3. **加了 VS Code 命令或配置项**，必须在 `package.nls.json`（英文）与
   `package.nls.zh-cn.json`（中文）里各加一条，`package.json` 里写 `%key%`。
4. **文案不要拼字符串**。中文与英文的语序不同，`"已清理 " + n + " 个进程"` 翻不准。
   带变量的文案写成 `(n) => ...` 形式的函数（见 `texts.ts` 里 `imagePathsInserted`
   这类），或 `@key:arg` 标记 + 词典里的函数。
5. **新增界面元素先想「英文下会不会溢出」**。英文通常比中文长 1.5~2 倍：
   - 按钮/胶囊/标签一律 `white-space: nowrap` + `text-overflow: ellipsis`，
     不要靠固定宽度；
   - 一行里多个元素的布局不能依赖中文字数（用 flex/grid，不要用「大概这么宽」）；
   - 这条在**窄侧栏**下最容易出事——改动后自己用 `npm run preview` 看一眼。

### `@key` 标记：宿主怎么把文案交给界面

宿主不知道用户选了哪种语言，所以它只传**语言中立的标记**：

```ts
this.emit({ type: "toast", level: "warn", text: "@uploadIncomplete:report.pdf" });
```

界面侧由 `resolveText()` 翻译；不以 `@` 开头的文本原样显示（模型/服务端的原始报错
就是这类，**不要**去翻译它们）。

现有标记见 `src/webview/texts.ts` 的 `resolveText()`——**加新标记时同步加 case**，
否则用户会看到 `@yourNewKey`。`scripts/i18n.test.ts` 会检查每个标记在两种语言下
都能解析出内容（不会原样返回）。

## 与官方 dsh web 前端保持一致

本扩展是 `dsh web` 的**自绘前端**，不是它的复刻：界面按 Continue 的设计取向走，
但**能力与数据语义必须与官方一致**。判断某一处该怎么实现时：

1. 先读官方类型声明 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包>\lib\types\**\*.d.ts`
   （短、可读，是契约）；
2. 再回 `lib/client.js` grep 确认实现（直接读动辄几百 KB，很痛苦）；
3. 有疑问就写探针实测，**不要按猜测的形状写代码**。

`docs/audit-summary.md` 记录了逐条对照的结论与证据等级，动相关代码前先看它。
已经踩过的两个坑（`goal` 投影的嵌套形状、`plan` 投影的 `pending` 字段）都源于
「没读契约、按猜测的形状写」。

## 构建与验证

- **一律用 `build` 工具跑构建/测试**。`pwsh` 沙箱下 esbuild 会 `spawn EPERM`、
  探针写 `~/.dsh` 会 `EPERM`。
- 标准命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`；
  端到端探针：`node build/command-e2e.mjs`、`node build/queue-continue-probe.mjs`。
- **新增测试必须登记到 `esbuild.scripts.mjs` 的 `entries`**，否则 `npm test`
  静默不跑（runner 只发现 `build/*.test.mjs`）。
- 改动界面后跑 `npm run preview` 看一眼：`test/preview.html` 的夹具覆盖了
  各种节点形态。**夹具数据必须来自真实输出**，不要编。

## 代码约定

- **注释与文档用中文**（本仓库既有风格）；标识符用英文。
- **界面文案一律走词典**，不在组件里写死中文字符串。
- **安全谓词按肯定证据写**（`=== true`），不按否定证据写（`!== false`）——
  见 `processRegistry.isKillable` 的教训：拿不到证据时应当**不动**，而不是动手。
- **进程查询一律异步**（`await`），同步的 `spawnSync` 会冻住扩展宿主约 1.5 秒。
- **宿主 → webview 的帧是 JSON 过的**（实测扩展宿主里的 `r8()` 就是
  `JSON.stringify`）：**值为 `undefined` 的键会被整条丢掉**，所以「清空某个字段」
  必须发 `null`（宿主侧走 `jsonSafeFrame`，界面侧 `mergeWirePatch` 折回
  「键不存在」）。漏掉这一步的症状是**清空指令静默失效**——用户 2026-09-12 报的
  「进行中的目标清不掉、切会话也一直在」就是它：服务端早已 `Goal cleared.`，
  界面纹丝不动。细则见 `src/shared/wire.ts`，回归断言在 `scripts/wire.test.ts`。

## git

- commit **一律用中文描述**（用户全局规则）。
- **未经用户明确说「提交」不得 commit**；改完留在工作区等确认。
