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
/**
 * 编辑器调用记录（离线断言用）。
 *
 * `openAttachment` 的「打开」是**编辑器侧**的动作，桩里没有真编辑器，只能把调用记下来
 * 供断言：`openTextDocument` + `showTextDocument` 是**文本**那条路（图片等二进制走不通，
 * 真机会抛「文件似乎是二进制文件」），`vscode.open` 命令是**二进制/图片**那条路
 * （VS Code 自己挑编辑器）。以前这里一律抛异常，于是「点开了没有」在离线根本断言不了。
 */
export const editorCalls = {
  opened: [] as string[],
  shown: [] as string[],
  /** `vscode.open` 命令的目标（图片等二进制走这条）。 */
  openedViaCommand: [] as string[],
  reset(): void {
    editorCalls.opened.length = 0;
    editorCalls.shown.length = 0;
    editorCalls.openedViaCommand.length = 0;
  },
};

export const window = {
  activeTextEditor: undefined,
  // 编辑区标签组：「在编辑器中打开」的落点判定（`editorColumn.test.ts`）要读它。
  // 默认没有分组 = 空窗口，落到 `ViewColumn.Beside`（新开一个分组）
  tabGroups: { all: [] as unknown[], activeTabGroup: undefined as unknown },
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  showTextDocument: async (document: { uri?: { fsPath?: string } }) => {
    editorCalls.shown.push(document?.uri?.fsPath ?? "");
    return undefined;
  },
};

/** 只用得到这两个符号值；其余档位这条链路碰不到。 */
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => config,
  fs: { stat: async () => { throw new Error("stub: fs.stat"); } },
  openTextDocument: async (uri: { fsPath?: string }) => {
    // 真机上二进制（图片、压缩包……）在这里就抛：「文件似乎是二进制文件，不能作为文本
    // 打开」。桩里按扩展名复刻这一条，好让「二进制要改走 `vscode.open`」成为可断言的行为
    // ——2026-10-13 用户报「单击没有反应」正是踩在这里。
    if (/\.(png|jpe?g|gif|webp|bmp|ico|zip|bin|exe|pdf)$/i.test(uri?.fsPath ?? "")) {
      throw new Error("stub: 文件似乎是二进制文件，不能作为文本打开");
    }
    editorCalls.opened.push(uri?.fsPath ?? "");
    // `revealLine` 要读 `lineCount`：给一份最小文档，别让「打开」这条路在桩里就断掉
    return { uri, lineCount: 1 };
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
/**
 * `executeCommand` 的**全部**调用记录（按调用顺序）。
 *
 * 离线断言「命令接线」用（例如「查看消息通知」在没有活动窗口时唤起主侧栏：
 * `dshChat.view.focus`）。只追加、不改既有行为，各测试自己清空。
 */
export const executedCommands: string[] = [];
export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    executedCommands.push(command);
    // 只记「打开」这条：图片等二进制经 `vscode.open` 交给 VS Code 自己挑编辑器
    if (command === "vscode.open") {
      const uri = args[0] as { fsPath?: string } | undefined;
      editorCalls.openedViaCommand.push(uri?.fsPath ?? "");
    }
    return undefined;
  },
  registerCommand: () => new DisposableLike(),
};
export const extensions = { getExtension: () => undefined };
