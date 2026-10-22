/** 会话引用的显示、编辑失效、完整标题重匹配和真实补全写回；纯离线，不发模型消息。 */
import assert from "node:assert/strict";
import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerSessionDraft } from "../src/webview/composerSessionDraft";
import { dictionaryFor } from "../src/webview/texts";
import type { SessionRefView } from "../src/shared/chat";

const posted: { type: string; text?: string }[] = [];
(globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (frame: typeof posted[number]) => posted.push(frame) });
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (run: () => void) => { run(); return 1; };
const { findTrigger, replaceToken, rankCandidates, useComposerCompletion } = await import("../src/webview/composerCompletion");
const token = (label: string, id: string) => `@[${label.replace(/[\\\[\]]/gu, "\\$&")}](dsh-session:${Buffer.from(JSON.stringify(id)).toString("base64url")})`;
const model = (raw: string) => { const draft = new ComposerSessionDraft(); draft.sync(raw, "owner"); return draft; };
const target = (id: string) => ({ kind: "session", sessionId: id });

// 中文 / 英文、空白、转义、内部 @ 和分隔符：只有已确认格式才折叠。
for (const title of ["测试，请告诉我这是哪个项目", "English session title", "[标题] \\ @内部 / 路径", "", "跨行\n标题"]) {
  const raw = `前文 ${token(title, "会话-id")} 后文 @src/a.ts`;
  const draft = model(raw);
  assert.equal(draft.text, `前文 @${title} 后文 @src/a.ts`);
  assert.equal(draft.raw, raw);
  assert.equal(draft.segments().map((segment) => segment.text).join(""), draft.text);
  for (let at = 4; at <= 4 + title.length; at += 1) {
    assert.deepEqual(draft.targetAt(at), target("会话-id"));
    assert.equal(findTrigger(draft.text, at, draft), undefined, "完整绑定的标题内不弹补全");
  }
}
for (const raw of ["@[未绑定](dsh-session:%%%%)", "@[普通](https://example.com)", "@普通标题", "dsh-session:abc"]) {
  assert.equal(model(raw).text, raw, "不凭相似形状折叠或创建绑定");
}

// 命令扫描不得进入会话标题，目标和镜像必须使用同一套区间。
{
  const draft = model(`${token("含 /plan 的标题", "s1")} 正文 /plan /audit /virtual`);
  const commands = [
    { name: "plan", description: "" },
    { name: "audit", description: "", skill: true, skillPath: "skills/audit/SKILL.md" },
    { name: "virtual", description: "", skill: true },
  ];
  assert.deepEqual(draft.targetAt(draft.text.indexOf("/plan") + 2, commands), target("s1"));
  assert.deepEqual(draft.targetAt(draft.text.lastIndexOf("/plan") + 2, commands), { kind: "command", name: "plan" });
  assert.deepEqual(draft.targetAt(draft.text.indexOf("/audit") + 2, commands), { kind: "file", path: "skills/audit/SKILL.md" });
  assert.equal(draft.targetAt(draft.text.indexOf("/virtual") + 2, commands), undefined);
  const segments = draft.segments(commands);
  assert.equal(segments.map((segment) => segment.text).join(""), draft.text);
  assert.deepEqual(segments.filter((segment) => segment.highlighted).map((segment) => [segment.text, segment.link]), [
    ["/plan", true], ["/audit", true], ["/virtual", false],
  ]);
}

// 同名会话按每一次出现分别绑定；改正文、插前缀、插普通文本不丢失身份。
{
  const a = token("同名 title", "a");
  const b = token("同名 title", "b");
  const draft = model(`${a} 与 ${b} 后文`);
  const next = draft.write(`开头 ${draft.text}`, 3);
  assert.equal(next.raw, `开头 ${a} 与 ${b} 后文`);
  assert.deepEqual(draft.targetAt(5), target("a"));
  const second = draft.text.lastIndexOf("@");
  assert.deepEqual(draft.targetAt(second + 5), target("b"));
  draft.write(draft.text.replace("后文", "正文已变"), draft.text.length);
  assert.equal(draft.raw, `开头 ${a} 与 ${b} 正文已变`);
  draft.write(draft.text.replace("同名 title", "新名 title"), 5);
  assert.equal(draft.raw, `开头 @新名 title 与 ${b} 正文已变`);
  assert.equal(draft.targetAt(5), undefined, "编辑后不得跳到旧会话或误当成文件");
  assert.deepEqual(draft.targetAt(draft.text.lastIndexOf("@") + 2), target("b"));
  const query = findTrigger(draft.text, 8, draft);
  assert.equal(query?.query, "新名 title", "失效块查询必须保留完整英文空白标题");
  draft.sync(draft.raw, "owner");
  assert.equal(findTrigger(draft.text, 8, draft)?.query, "新名 title", "持久化回声不得丢失标题区间");
  draft.write(draft.text.replace("新名 title", "同名 title"), 8);
  assert.equal(draft.targetAt(5), undefined, "改回原名也不复活旧身份");
}

// 输入选区可确定重复字符中编辑的是哪一个；重输同一标题同样丢弃身份。
{
  const draft = model(token("aaa", "old"));
  draft.write("@aaaa", 2, { start: 1, end: 1 });
  assert.equal(draft.raw, "@aaaa");
  assert.equal(draft.targetAt(2), undefined);
  const same = model(token("title with spaces", "old"));
  same.write(same.text, 18, { start: 1, end: 18 });
  assert.equal(same.raw, same.text, "选中重输同标题不是未编辑");
  assert.equal(same.queryAt(10)?.query, "title with spaces");
}

// 块末尾继续写标题会失效；空白分隔正文不失效；前缀删除和全删不残留绑定。
{
  const draft = model(token("title", "old"));
  draft.write("@title 正文", 9);
  assert.equal(draft.raw, `${token("title", "old")} 正文`);
  draft.write("@titleX 正文", 7);
  assert.equal(draft.raw, "@titleX 正文");
  assert.equal(draft.queryAt(7)?.query, "titleX");
  draft.write("titleX 正文", 0);
  assert.equal(draft.queryAt(3), undefined);
  draft.write("", 0);
  assert.equal(draft.raw, "");
}

// 粘贴多枚 token 后坐标 / 光标全部在可见域；再次插入时保持既有绑定。
{
  const draft = model("");
  const raw = `${token("first title", "a")} ${token("second title", "b")} @src/a.ts`;
  const written = draft.write(raw, raw.length);
  assert.equal(written.text, "@first title @second title @src/a.ts");
  assert.equal(written.caret, written.text.length);
  assert.equal(written.raw, raw);
  assert.deepEqual(draft.targetAt(4), target("a"));
  assert.deepEqual(draft.targetAt(17), target("b"));
  assert.deepEqual(draft.targetAt(draft.text.length), { kind: "file", path: "src/a.ts" });
  const middle = draft.text.indexOf(" ") + 1;
  const inserted = token("inserted", "c");
  // 选在引用后的分隔处而不是标题内部。
  const split = draft.text.indexOf(" @second");
  draft.write(draft.text.slice(0, split) + ` ${inserted}` + draft.text.slice(split), split + inserted.length + 1, { start: split, end: split });
  assert.equal(draft.raw, `${token("first title", "a")} ${inserted} ${token("second title", "b")} @src/a.ts`);
  assert.deepEqual(draft.targetAt(draft.text.indexOf("@second") + 4), target("b"));
  assert.ok(middle > 0);
}

// 完整标题查询不会因空格或斜杠被截断，也不会返回文件 / 按 cwd、id 匹配的候选。
{
  const draft = model(`${token("my title/", "old")} 正文`);
  draft.write("@new title/ 正文", 7);
  const trigger = findTrigger(draft.text, 7, draft);
  assert.ok(trigger);
  assert.equal(trigger.query, "new title/");
  assert.equal(trigger.sessionOnly, true);
  const sessions: SessionRefView[] = [
    { sessionId: "new", label: "New title/ details", mention: token("New title/ details", "new") },
    { sessionId: "new title/", label: "unrelated", mention: token("unrelated", "wrong") },
  ];
  assert.deepEqual(rankCandidates(trigger, [], [{ path: "new title/", kind: "directory" }], sessions), [sessions[0]]);
  const replaced = replaceToken(draft.text, trigger, sessions[0].mention);
  const next = draft.write(replaced.text, replaced.caret);
  assert.equal(next.text, "@New title/ details 正文");
  assert.equal(next.raw, `${sessions[0].mention} 正文`);
  assert.equal(next.caret, "@New title/ details".length);
  assert.deepEqual(draft.targetAt(5), target("new"));
}

// 切会话、清草稿、队列取回：从外部原始草稿重建，不让上一个会话的区间串线。
{
  const draft = model(token("a title", "a"));
  draft.sync(token("b title", "b"), "other");
  assert.equal(draft.text, "@b title");
  assert.deepEqual(draft.targetAt(4), target("b"));
  draft.sync("", "other");
  assert.deepEqual(draft.segments(), []);
  draft.sync(token("a title", "a"), "owner");
  assert.deepEqual(draft.targetAt(4), target("a"));
}

// **同一个会话**的空草稿也要清得动。
//
// 这一档与上面那条的区别是 `owner` **不变**：宿主把同一会话的草稿清空（发送成功后的
// `commitDraft`）时送来的就是 `("", 同一个 id)`。早先的判据只看「原始串有没有变」，而
// 用户新插入的 token 在 `write` 里还没绑定成块（`raw` 停在上一份）时，那句 return 会让
// 输入框停在旧文字上，宿主却已经认为它是空的。
{
  const draft = model("");
  // 用户直接敲 / 粘贴一段正文：`raw` 还没跟着更新（真实链路上它由下一次 `sync` 定稿）
  draft.write("刚打的一段话", 6);
  assert.equal(draft.text, "刚打的一段话", "前置：输入框里有字");

  draft.sync("", "owner"); // 同一个 owner、一份空草稿
  assert.equal(draft.text, "", "同 id 空快照必须清掉输入框（不能因为原始串相同就提前返回）");
  assert.equal(draft.raw, "");
  assert.deepEqual(draft.segments(), []);

  // 队列取回 / 切回来：再给一份非空草稿要能重建
  draft.sync(token("Other title", "other"), "owner");
  assert.equal(draft.text, "@Other title");
  assert.deepEqual(draft.targetAt(4), target("other"));
}

// 真 hook 的 Enter 选中和 onChange：写回、持久化仍发确定性 token，光标在显示域。
for (const locale of ["zh", "en"] as const) {
  const draft = model(token("Old title", "old"));
  draft.write("@New title", 6);
  const row: SessionRefView = { sessionId: "new", label: "New title", mention: token("New title", "new") };
  let sessionRows: SessionRefView[] = [row];
  const writes: string[] = [];
  const node = { value: draft.text, selectionStart: 6, focus() {}, setSelectionRange(start: number) { this.selectionStart = start; } };
  let completion: ReturnType<typeof useComposerCompletion> | undefined;
  function Probe() {
    completion = useComposerCompletion({
      draft: draft.text, caret: 6, sessionDraft: draft, commands: [],
      fileRefs: { query: "New title", items: [], sessions: sessionRows, resolved: true },
      texts: dictionaryFor(locale), onDraft: (text) => writes.push(text),
      textareaRef: { current: node as unknown as HTMLTextAreaElement },
    });
    return null;
  }
  const originalError = console.error;
  console.error = (...args) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) originalError(...args); };
  try {
    sessionRows = [];
    renderToStaticMarkup(createElement(Probe));
    const emptyHtml = renderToStaticMarkup(completion?.popover);
    const texts = dictionaryFor(locale);
    assert.ok(emptyHtml.includes(texts.mentionSessionsEmpty), "完整标题无匹配时使用中英文会话空态，不误报为文件");
    assert.ok(emptyHtml.includes(texts.mentionSessions), "空态分组仍是对话");
    assert.ok(emptyHtml.includes(texts.mentionSessionsHint), "会话候选不显示目录导航提示");
    sessionRows = [row];
    renderToStaticMarkup(createElement(Probe));
  } finally { console.error = originalError; }
  assert.ok(completion);
  assert.ok(completion.popover, "旧 resolved:true 不得抑制编辑后的标题候选");
  const html = renderToStaticMarkup(completion.popover);
  assert.ok(html.includes("New title"));
  completion.textareaProps.onKeyDown?.({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {}, currentTarget: node } as unknown as KeyboardEvent<HTMLTextAreaElement>);
  assert.equal(writes.at(-1), row.mention);
  assert.equal(posted.at(-1)?.text, row.mention);
  assert.equal(draft.text, "@New title");
  assert.equal(node.selectionStart, draft.text.length);
  node.value = "@New titles";
  node.selectionStart = node.value.length;
  completion.textareaProps.onChange?.({ target: node } as never);
  assert.equal(writes.at(-1), node.value);
  assert.equal(draft.targetAt(3), undefined);
  assert.equal(posted.at(-1)?.text, node.value);
}
console.log("composerSessionDraft: 标题显示、原始格式写回、编辑失效、重匹配与 Ctrl 目标 ✓");
