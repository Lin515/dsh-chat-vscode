/** 官方高亮经生产组件的 DOM 回归；供独立 jsdom realm 与真实 Chromium 共用。 */
import { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ToolCallView } from "../src/shared/chat";
import { CodeBlock } from "../src/webview/components/CodeBlock";
import { CodeText } from "../src/webview/components/HighlightedText";
import { ToolRow } from "../src/webview/components/Rows";
import { highlightCode } from "../src/webview/markdown/highlight";

export async function run(): Promise<{ checks: number; surfaces: number }> {
  let checks = 0;
  const check = (value: unknown, message: string): void => {
    checks += 1;
    if (!value) throw new Error(message);
  };
  const host = document.createElement("div");
  // CodeText 的生产调用方是 pre / pre-wrap 阅读区；独立测试也保留同一空白语义。
  host.style.whiteSpace = "pre-wrap";
  document.body.append(host);
  const root = createRoot(host);
  const render = (node: ReactNode): void => { flushSync(() => root.render(node)); };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  async function eventually(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) { check(true, message); return; }
      await tick();
    }
    check(false, message);
  }
  const tokens = (): number => host.querySelectorAll(".md-code-token").length;
  const clearSelection = (): void => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  };
  try {
    const code = 'const n: number = 42;\r\n\tconsole.log("hello");\r\n';
    render(<CodeBlock lang="ts" code={code} phase="streaming" />);
    check(tokens() === 0, "正文流式保持纯文");
    render(<CodeBlock lang="ts" code={code} phase="settled" />);
    await eventually(() => tokens() > 0, "正文完成态使用官方高亮");
    check(host.querySelector("code")?.textContent === code, "正文 CRLF / tab / EOF 原样");
    const block = host.querySelector(".code-block");
    render(<CodeBlock lang="TypeScript" code={code} phase="settled" />);
    check(host.querySelector(".code-block") === block, "别名变化不重建代码卡");

    // 选区覆盖纯文时，官方结果不能替换已选 Text；释放后才安装 span。
    const ruby = 'def greet(name)\n  "hello #{name}"\nend\n';
    render(<CodeText text={ruby} lang="ruby" active={false} />);
    const plain = host.querySelector("span")!;
    const text = plain.firstChild;
    const range = document.createRange();
    range.selectNodeContents(plain);
    window.getSelection()?.addRange(range);
    const selectedText = window.getSelection()?.toString();
    check(range.toString() === ruby, "Range 覆盖完整源码");
    document.dispatchEvent(new Event("selectionchange"));
    render(<CodeText text={ruby} lang="ruby" active />);
    check(await highlightCode(ruby, "ruby") !== null, "官方非启动语法异步就绪");
    await tick();
    check(tokens() === 0 && plain.firstChild === text, "选区存在时不替换 Text 节点");
    // 浏览器 Selection.toString 可能省略末尾视觉换行；比较增强前后，不重定义原生复制。
    check(window.getSelection()?.toString() === selectedText, "选区全文保留");
    clearSelection();
    await eventually(() => tokens() > 0, "选区释放后应用最新结果");
    check(plain.textContent === ruby, "懒加载高亮前后内容相等");

    render(<CodeText text="const stale = 1" lang="ts" active />);
    render(<CodeText text="latest plain text" lang="unknown-language" active />);
    await tick();
    check(host.textContent === "latest plain text" && tokens() === 0, "迟到结果不得写入新源码或未知语言");

    // read 形状与内容来自 toolCard.test.ts 已记录的真实 meta；其他面沿用 ToolRow 形状。
    const base = { title: "", detail: "src/a.ts", status: "ok" as const };
    const fixtures: ToolCallView[] = [
      { ...base, id: "read", name: "read", card: {
        kind: "read", label: "src/pendingInteraction.ts", lang: "typescript", totalLines: 55,
        lines: [
          { number: 1, text: 'import type { ApprovalView } from "../shared/chat";' },
          { number: 2, text: "" },
          { number: 3, text: "export function pendingInteractionOf() {}" },
        ],
      } },
      { ...base, id: "write", name: "write", filePath: "src/a.ts", input: JSON.stringify({ file_path: "src/a.ts", content: code }) },
      { ...base, id: "edit", name: "edit", filePath: "src/a.ts", diff: [{ path: "src/a.ts", added: 1, removed: 1, lines: [
        { kind: "context", text: "/* comment" }, { kind: "del", text: "old line" },
        { kind: "add", text: "new line" }, { kind: "context", text: "*/ const n = 42;" },
      ] }] },
      { ...base, id: "workflow", name: "workflow", input: JSON.stringify({ script: code, task: "offline" }) },
      { ...base, id: "inspect", name: "cordis_inspect_list", input: '{"providers":true}', output: '{"providers":[],"count":42}' },
    ];
    for (const tool of fixtures) {
      // key 隔离各工具，而不是复用前一个 ToolRow 的组件内状态。
      render(<ToolRow key={tool.id} tool={tool} diffLayout="unified" node={{ open: true, openedWhileActive: false, setOpen: () => {} }} />);
      const before = host.textContent;
      await eventually(() => tokens() > 0, `${tool.name} 工具面实际使用官方高亮`);
      check(host.textContent === before, `${tool.name} 着色不改变工具全文`);
      const token = host.querySelector<HTMLElement>(".md-code-token")!;
      check(token.style.color.includes("--md-code-"), `${tool.name} 使用宿主受控主题映射`);
    }
    return { checks, surfaces: fixtures.length + 1 };
  } finally {
    clearSelection();
    flushSync(() => root.unmount());
    host.remove();
  }
}
