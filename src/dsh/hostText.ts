import * as vscode from "vscode";
import { englishSource, VSCODE_FACING_MARKERS } from "../webview/messages";

/**
 * 把宿主产生的 `@key` / `@key:arg` 标记翻成 **VS Code 原生 UI** 用的文本。
 *
 * 标记的正牌解析方是 webview 的词典（`src/webview/texts.ts`，按 `dshChat.language`
 * 选语言）。但有些文案**两头都要用**：连接失败的原因既进 `connectionDetail`
 * 交给 webview 渲染，也会经 `reportError` → `showErrorMessage` 出现在 VS Code
 * 的通知里。通知跟随的是 **VS Code 自己的显示语言**，而且宿主不能直接 import
 * webview 的词典（那边依赖 React）。
 *
 * 所以这里只覆盖「可能外溢到 VS Code」的那些 key，用 `vscode.l10n.t` 取 VS Code
 * 当前语言的译文（英文原文即 key，中文在 `l10n/bundle.l10n.zh-cn.json`）。
 * 不认识的文本原样返回——模型 / 服务端的原始报错就是这么过的，不要翻译它们。
 *
 * 多行文本按行解析：连接失败条是「原因 + 遗留锁提示 + 日志尾部」拼起来的，
 * 每一行各自是一个标记，夹在中间的日志原文保持不动。
 *
 * **哪些 key 要翻不在这里手抄**：见下面的 `VSCODE_FACING_MARKERS`——它是
 * **消息表里标了 `vscode: true` 的那些键**（唯一的登记处仍是 `messages.ts`）。
 * 这一层的完整性由 `scripts/i18n.test.ts` 断言：
 * ① 这套 key ⊆ 消息表的键；② 本文件的 `LOCALIZED` 恰好覆盖这套 key；
 * ③ 每条的英文源串在 `l10n/bundle.l10n.zh-cn.json` 里都有**不同**的中文译文。
 */
export function resolveForVsCode(text: string): string {
  if (!text.includes("@")) return text;
  return text
    .split("\n")
    .map((line) => resolveMarker(line))
    .join("\n");
}

/**
 * VS Code 原生 UI 面向的标记 = 消息表里 `vscode: true` 的那些键。
 *
 * 清单在 `src/webview/messages.ts`（那里能被离线测试读到，本文件依赖 `vscode`）。
 * `scripts/i18n.test.ts` 会核对这份集合与下面的 `LOCALIZED` 完全一致：
 * 表里新标一条 `vscode: true` 却忘了在这儿加处理，测试立刻炸（而不是等用户
 * 在某条通知里看到裸 `@key`）。
 */
export { VSCODE_FACING_MARKERS };

interface Handler {
  /** `vscode.l10n.t` 的 key —— **英文源串**（不是自定义 id）。 */
  key: string;
  /** 要不要把标记的参数填进 `{0}`。 */
  arg?: boolean;
}

/**
 * 每个 VS Code 面向标记的 `l10n` key（英文源串即消息表里那一条的 `en`）。
 *
 * 取值直接来自消息表：**英文只有一份**，webview 的英文界面与 VS Code 的英文通知
 * 从此是同一句话（从前两份手抄的英文已经漂了：`serverNotReady` 一边写
 * 「Restart Server」一边写「Restart Internal DSH」）。
 * 中文仍由 `l10n/bundle.l10n.zh-cn.json` 提供（那是 VS Code 自己的 l10n 机制，
 * 与界面词典的中文未必逐字相同，不合并）。
 */
const LOCALIZED: Record<string, Handler> = {
  authNeedsToken: { key: englishSource("authNeedsToken") },
  authTokenRejected: { key: englishSource("authTokenRejected") },
  serverSpawnFailed: { key: englishSource("serverSpawnFailed"), arg: true },
  serverNotReady: { key: englishSource("serverNotReady") },
  serverUnreachable: { key: englishSource("serverUnreachable"), arg: true },
  serverLogTail: { key: englishSource("serverLogTail"), arg: true },
};

function resolveMarker(text: string): string {
  if (!text.startsWith("@")) return text;
  // 与 `texts.ts` 的 `resolveMarker` 同一口径：冒号只切第一段当 key，其余是参数
  const parts = text.slice(1).split(":");
  const handler = Object.hasOwn(LOCALIZED, parts[0]) ? LOCALIZED[parts[0]] : undefined;
  if (!handler) return text;
  const arg = parts.length > 1 ? parts.slice(1).join(":") : "";
  return handler.arg ? vscode.l10n.t(handler.key, arg) : vscode.l10n.t(handler.key);
}
