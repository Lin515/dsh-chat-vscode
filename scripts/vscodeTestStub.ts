/**
 * vscode API 的离线 stub：只给 `subagentSwitch.test.ts` 用——那条测试要驱动**真的**
 * `ChatController`（它 `import * as vscode from "vscode"`，离线起不了实例）。
 *
 * esbuild.scripts.mjs 用 `alias` 把裸说明符 `vscode` 指到本文件：不 import vscode
 * 的测试条目完全不受影响，仍然打真包。这里只覆盖该场景会碰到的面（构造、订阅、
 * 配置读取、连接快照），没覆盖到的调用会在测试里以 TypeError 暴露，按需补。
 */

class DisposableLike {
  constructor(private readonly cb?: () => void) {}
  dispose(): void {
    this.cb?.();
  }
}

const config = { get: () => undefined, has: () => false, update: async () => undefined };

export const Disposable = DisposableLike;
export const l10n = { t: (s: string) => s };
export const env = {
  language: "zh-cn",
  clipboard: { writeText: async () => undefined },
  openExternal: async () => true,
};
export const window = {
  activeTextEditor: undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  showTextDocument: async () => undefined,
};
export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => config,
  fs: { stat: async () => { throw new Error("stub: fs.stat"); } },
  openTextDocument: async () => {
    throw new Error("stub: openTextDocument");
  },
  onDidChangeWorkspaceFolders: () => new DisposableLike(),
  onDidChangeConfiguration: () => new DisposableLike(),
  applyEdit: async () => true,
};
export const Uri = Object.assign(
  (v: string) => ({ fsPath: v }),
  {
    file: (v: string) => ({ fsPath: v, scheme: "file" }),
    parse: (v: string) => ({ fsPath: v }),
    joinPath: (...parts: { fsPath: string }[]) => parts[0],
  },
);
export function Position(line: number, character: number) {
  this.line = line;
  this.character = character;
}
export function Range(start: unknown, end: unknown) {
  this.start = start;
  this.end = end;
}
export const commands = { executeCommand: async () => undefined, registerCommand: () => new DisposableLike() };
export const extensions = { getExtension: () => undefined };
