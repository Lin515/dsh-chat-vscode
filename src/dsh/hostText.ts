import * as vscode from "vscode";

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
 */
export function resolveForVsCode(text: string): string {
  if (!text.includes("@")) return text;
  return text
    .split("\n")
    .map((line) => resolveMarker(line))
    .join("\n");
}

function resolveMarker(text: string): string {
  if (!text.startsWith("@")) return text;
  const [key, ...rest] = text.slice(1).split(":");
  const arg = rest.join(":");
  switch (key) {
    case "authNeedsToken":
      return vscode.l10n.t(
        "The external DSH server requires an access token: click “Enter token” and paste the token printed by dsh web (or run “DSH: Enter Access Token” from the Command Palette).",
      );
    case "authTokenRejected":
      return vscode.l10n.t(
        "The server requires authentication and the token obtained automatically was rejected. Restart it with “DSH: Restart Server” from the Command Palette.",
      );
    case "serverSpawnFailed":
      return vscode.l10n.t("Could not start the dsh process: {0}", arg);
    case "serverNotReady":
      return vscode.l10n.t(
        "The background server did not become ready (the rendezvous file has no address or token yet). Try “Restart Server”, or check the logs.",
      );
    case "serverUnreachable":
      return vscode.l10n.t(
        "Cannot reach the DSH server at {0} yet (retrying until it answers or you stop connecting). Make sure dsh web is running there.",
        arg,
      );
    // 这一对会经「DSH: 显示诊断信息」的 `Detail:` 那一行外溢到 VS Code 原生弹窗，
    // 所以也要在这里登记（否则用户看到的是裸 `@serverNotRunning`）
    case "serverNotRunning":
      return vscode.l10n.t("The DSH server is not running. Click “Start server” to launch one.");
    case "serverStopped":
      return vscode.l10n.t("The DSH server has been stopped.");
    case "serverLogTail":
      return vscode.l10n.t("Log tail:\n{0}", arg);
    default:
      return text;
  }
}
