/**
 * 正文里 `@` 引用的**判定**：哪一段文字指向哪个目标（`webview/mentionLinks.ts`）。
 *
 * 与 `scripts/mentionLinksUi.test.ts` 的分工：那边钉「真渲染成按钮、悬停说明对」，
 * 这里钉判定本身——同一条文字在**有没有会话引用清单**两种情况下分别是文件还是会话、
 * 区间从哪到哪、显示文本是什么。判定错在这里就会一路错到用户手上（用户 2026-10-10
 * 报的「已经发出去的会话引用被识别成文件链接」就是判定错、渲染没错）。
 *
 * 会话引用有**两种**正文形态，两种都要钉：
 * 1. 草稿里那条还没发出去的原始 token（`@[标题](dsh-session:…)` / 裸 URI）——id 就在
 *    正文里；
 * 2. 已经发出去、落盘时被服务端折成 `@标题` 的形态——id 只在紧随消息的召回事件里，
 *    由 `MessageView.sessionRefs` 带过来。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { scanMentionLinks, readableMentionText } from "../src/webview/mentionLinks";
import type { MessageSessionRef } from "../src/shared/chat";

/** 规范 `dsh-session:` URI（负载是 id 的 UTF-8 JSON 再 base64url——与官方口径一致）。 */
const uri = (id: string): string =>
  `dsh-session:${Buffer.from(JSON.stringify(id), "utf8").toString("base64url")}`;

/** 草稿里那条规范 token。 */
const mention = (label: string, id: string): string => `@[${label}](${uri(id)})`;

/** 一条正文的判定结果（只留断言关心的三样）。 */
const spansOf = (text: string, refs?: readonly MessageSessionRef[]) =>
  scanMentionLinks(text, refs).map((span) => ({
    text: span.text,
    slice: text.slice(span.start, span.end),
    target: span.target,
  }));

// ---------- 1. 文件 / 目录：按形状与边界认 ----------

{
  assert.deepStrictEqual(
    spansOf("先看 @src/a.ts 再改别的"),
    [{ text: "@src/a.ts", slice: "@src/a.ts", target: { kind: "file", path: "src/a.ts" } }],
    "普通路径引用要认成文件",
  );
  assert.deepStrictEqual(
    spansOf("整个 @src/ 目录都看一遍")[0]?.target,
    { kind: "directory", path: "src/" },
    "结尾斜杠是目录标记",
  );
  assert.deepStrictEqual(
    spansOf('引用 @"my file.txt" 这个文件')[0]?.target,
    { kind: "file", path: "my file.txt" },
    "含空白的路径走引号形态",
  );
  assert.deepStrictEqual(spansOf("写信给 foo@bar.com"), [], "邮箱里的 @ 不是引用（前面是字母）");
  assert.deepStrictEqual(spansOf("看看 src/a.ts 就行"), [], "不带 @ 的路径不造链接");
}
console.log("mentionLinks: 文件 / 目录按形状认 ✓");

// ---------- 2. 草稿形态的会话引用：id 在正文里 ----------

{
  const token = mention("上一个会话", "s1");
  const spans = spansOf(`对比一下 ${token} 的做法`);
  assert.strictEqual(spans.length, 1, "一条 token 只出一段");
  assert.strictEqual(spans[0]?.slice, token, "区间要覆盖**整条 token**（含 base64 负载）");
  assert.strictEqual(spans[0]?.text, "@上一个会话", "显示形态折成 @标题");
  assert.deepStrictEqual(spans[0]?.target, { kind: "session", sessionId: "s1" }, "id 从负载里解出来");

  const bare = spansOf(`看 ${uri("s2")} 那条`);
  assert.deepStrictEqual(bare[0]?.target, { kind: "session", sessionId: "s2" }, "裸 URI 形态也认");

  // 负载解不开（不是 JSON 字符串）：仍然折成 `@标题` 显示，但**不做成链接**
  const broken = spansOf("@[坏引用](dsh-session:bm90anNvbg)");
  assert.strictEqual(broken[0]?.text, "@坏引用", "解不开照样做显示还原");
  assert.strictEqual(broken[0]?.target, undefined, "解不开 id 就不给目标（点了也不知道开哪条）");
  assert.strictEqual(
    broken[0]?.slice,
    "@[坏引用](dsh-session:bm90anNvbg)",
    "整条 token 仍要被吃掉，不能把 markdown 残渣留在正文里",
  );
}
console.log("mentionLinks: 草稿形态的会话引用 ✓");

// ---------- 3. 已发出的会话引用：id 只在 `sessionRefs` 里 ----------

{
  // 真实落盘形态（取自会话日志）：服务端把 token 折成 `@标题`，id 在紧随的召回事件里
  const durable = "@轨迹四项收口与逐块渲染交接 里出现了大量思考前的未知内容块节点";
  const refs: MessageSessionRef[] = [
    { label: "轨迹四项收口与逐块渲染交接", sessionId: "session-10263ccf" },
  ];
  const withRefs = spansOf(durable, refs);
  assert.strictEqual(withRefs.length, 1, "标题那一段要判出来");
  assert.strictEqual(withRefs[0]?.slice, "@轨迹四项收口与逐块渲染交接", "只吃 @标题，后面的正文一个字不动");
  assert.deepStrictEqual(
    withRefs[0]?.target,
    { kind: "session", sessionId: "session-10263ccf" },
    "**会话引用不能落成文件引用**（修复前就是这里判错）",
  );
  assert.deepStrictEqual(
    spansOf(durable)[0]?.target,
    { kind: "file", path: "轨迹四项收口与逐块渲染交接" },
    "没有召回清单时同一段文字按形状是文件引用——这正是 id 必须由宿主补回来的原因",
  );

  // 召回里只有标题、没有 id：照旧折成 `@标题`，但**不可点**，而且**不能退回去当文件**
  const labelOnly = spansOf("@上一个会话 的结论", [{ label: "上一个会话" }]);
  assert.strictEqual(labelOnly[0]?.text, "@上一个会话");
  assert.strictEqual(labelOnly[0]?.target, undefined, "没有 id 就不做成链接（也不当文件）");

  // 标题长的先认：`@会话` 是 `@会话 2` 的前缀，不能把后者的开头抢走
  const prefix: MessageSessionRef[] = [
    { label: "会话", sessionId: "short" },
    { label: "会话 2", sessionId: "long" },
  ];
  assert.deepStrictEqual(
    spansOf("@会话 2 的结论", prefix)[0]?.target,
    { kind: "session", sessionId: "long" },
    "两条标题互为前缀时认最长的（官方同样先按长的找）",
  );
  assert.deepStrictEqual(
    spansOf("@会话 的结论", prefix)[0]?.target,
    { kind: "session", sessionId: "short" },
    "短的那条照旧认自己",
  );

  // 标题里有 markdown 特殊字符：token 里服务端会转义（`\]` / `\\`），落盘正文与召回
  // 清单里都是**还原后**的原文——比对必须按字面来（拿正则拼会被这些字符咬到，
  // 它们出现在这里就是为了钉住这一点）
  assert.deepStrictEqual(
    spansOf("@修复 [bug] 的问题 的结论", [{ label: "修复 [bug] 的问题", sessionId: "s9" }])[0]?.target,
    { kind: "session", sessionId: "s9" },
    "标题里的方括号按字面比",
  );
  const withBackslash = spansOf("@a\\b 的结论", [{ label: "a\\b", sessionId: "s10" }]);
  assert.deepStrictEqual(
    withBackslash[0]?.target,
    { kind: "session", sessionId: "s10" },
    "标题里的反斜杠按字面比（不能当路径分隔符处理）",
  );
  assert.strictEqual(withBackslash[0]?.slice, "@a\\b", "区间只吃到标题末尾");

  // 传入的清单不能被就地排序（调用方的 `MessageView` 还在用同一份）
  const given: MessageSessionRef[] = [
    { label: "会话", sessionId: "short" },
    { label: "会话 2", sessionId: "long" },
  ];
  scanMentionLinks("@会话 2", given);
  assert.deepStrictEqual(
    given.map((ref) => ref.label),
    ["会话", "会话 2"],
    "判定不该改动传进来的清单顺序",
  );
}
console.log("mentionLinks: 已发出的会话引用按召回清单认 ✓");

// ---------- 4. 会话引用与文件引用并存：区间按顺序、互不重叠 ----------

{
  const text = "@上一个会话 里提到的 @src/a.ts 已经改过了";
  const spans = spansOf(text, [{ label: "上一个会话", sessionId: "s1" }]);
  assert.deepStrictEqual(
    spans.map((span) => [span.slice, span.target?.kind]),
    [["@上一个会话", "session"], ["@src/a.ts", "file"]],
    "两种引用各认各的",
  );
  let cursor = 0;
  for (const span of scanMentionLinks(text, [{ label: "上一个会话", sessionId: "s1" }])) {
    assert.ok(span.start >= cursor, "区间必须按出现顺序、互不重叠");
    cursor = span.end;
  }
}
console.log("mentionLinks: 会话与文件引用并存 ✓");

// ---------- 5. 复制 / 预览用的可读文本：折过的正文原样，token 折成 @标题 ----------

{
  const durable = "@上一个会话 的结论，见 @src/a.ts";
  assert.strictEqual(readableMentionText(durable), durable, "已经是可读形态的正文一个字都不改");
  assert.strictEqual(
    readableMentionText(`${mention("上一个会话", "s1")} 的结论`),
    "@上一个会话 的结论",
    "原始 token 折成 @标题（复制按钮与轮次大纲预览走这条）",
  );
}
console.log("mentionLinks: 可读文本还原 ✓");

console.log("\nmentionLinks: all assertions passed");
