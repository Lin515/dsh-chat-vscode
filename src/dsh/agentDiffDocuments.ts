/**
 * 「Agent 改动」对比窗口的**虚拟文档**：把两段（turn-start / turn-end）文本交给
 * VS Code 的 diff 编辑器，而不是去读工作区里那个已经被提交、可能早已变样的文件。
 *
 * 为什么不用临时文件：对比窗口里的两侧是本轮快照，不该在磁盘上留下任何东西；
 * `TextDocumentContentProvider` 是 VS Code 为这类只读内容准备的标准入口。
 * URI 上带一个递增 id，同一个文件的多轮改动各自是独立的一对文档；关闭文档时
 * 顺手删掉正文，避免长宿主里堆积字符串。
 *
 * 用户可见文案（标题、片段提示）不在这里——这里只负责内容与 URI，标题由
 * `controller.openAgentChanges` 按 VS Code 语言生成。
 */
import * as vscode from "vscode";

/** 虚拟文档的 scheme：只由本扩展注册，不会与工作区文件冲突。 */
export const AGENT_DIFF_SCHEME = "dsh-chat-agent-diff";

/** 同时保留的文档数上限（每开一次对比占两份）。超过就丢最旧的，避免无界增长。 */
const MAX_DOCUMENTS = 128;

/** 一对用于 `vscode.diff` 的 URI。 */
export interface AgentDiffDocumentPair {
  before: vscode.Uri;
  after: vscode.Uri;
}

/** 只读虚拟文档的内容表与 URI 生成。 */
export class AgentDiffDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly closed: vscode.Disposable;
  private sequence = 0;

  constructor() {
    // 对比窗口关掉后没有人还能再读这份内容；删掉它，长会话里不会越攒越多
    this.closed = vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === AGENT_DIFF_SCHEME) this.contents.delete(document.uri.toString());
    });
  }

  /**
   * 登记一份对比并返回两侧 URI。
   *
   * @param display 展示路径（用来让 VS Code 按扩展名挑语言、显示在标签上）。
   * @param before turn-start 侧文本（空串 = 文件当时不存在）。
   * @param after turn-end 侧文本（空串 = 文件当时不存在）。
   */
  create(display: string, before: string, after: string): AgentDiffDocumentPair {
    const id = ++this.sequence;
    const beforeUri = this.uriFor(display, id, "before");
    const afterUri = this.uriFor(display, id, "after");
    this.contents.set(beforeUri.toString(), before);
    this.contents.set(afterUri.toString(), after);
    // Map 按插入顺序迭代：超限时从最旧的一份开始丢
    while (this.contents.size > MAX_DOCUMENTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    return { before: beforeUri, after: afterUri };
  }

  /** 内容提供者入口：认不出的 URI 给空串（扩展重载后遗留的标签页就是这个状态）。 */
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.closed.dispose();
    this.contents.clear();
  }

  /** `display` 只取路径形态：反斜杠归一、去掉开头的分隔符，剩下的交给 `Uri.from` 编码。 */
  private uriFor(display: string, id: number, side: "before" | "after"): vscode.Uri {
    const path = display.replace(/\\/gu, "/").replace(/^\/+/u, "");
    return vscode.Uri.from({
      scheme: AGENT_DIFF_SCHEME,
      path: `/${path || "file"}`,
      query: `id=${id}&side=${side}`,
    });
  }
}
