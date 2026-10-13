/**
 * `@path` **引用文本**的规则（对齐官方 `formatFileMention`）。
 *
 * 引用只有一个落点：**正文**（界面在 `@` 候选里选中时插、宿主把目录插成 `@dir/`）。
 * 早先还有一条「引用芯片」线——附件列表里的一条，发送时由 `composeWithReferences`
 * 拼到正文之前——自 `@` 改成写正文 token 之后就没有生产方了，2026-09-21 连同它一起
 * 删掉（见 docs/design-attachments.md）。所以这个文件只剩 mention 文本本身的断言。
 *
 * 官方两条路（见 docs/design-attachments.md「引用与快照」与 `dsh/references.ts` 的文件头）：
 * 1. `@path` 引用：只发路径 token，目录以结尾 `/` 标记；
 * 2. 文件上传：拿 `receiptId`，随 prompt 作为 `{type:'file', receiptId}` 发出。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { formatFileMention } from "../src/dsh/references";
import {
  displaySessionMentions,
  isBrowseQuery,
  mentionPathOf,
  referenceSessionIdOf,
} from "../src/shared/mentions";

// ---------- 1. mention 文本：目录补尾斜杠、分隔符统一成 `/` ----------
//
// 分隔符归一与「引号成对」是**刻意偏离官方**的两条（用户 2026-09-21 口径，理由写在
// `src/shared/mentions.ts` 的文件头）：官方保留调用方给的反斜杠、且目录只写开引号。
{
  assert.strictEqual(formatFileMention("src/dsh/controller.ts"), "@src/dsh/controller.ts");
  // 目录补结尾斜杠——系统提示段用它区分「这是目录，要内容就 list」
  assert.strictEqual(formatFileMention("src/dsh", "directory"), "@src/dsh/");
  // 已带尾斜杠时不重复追加（`@dir//` 语义不变但很难看；
  // 官方那行是无条件拼接，因为它的调用方从不传带尾斜杠的路径）
  assert.strictEqual(formatFileMention("src/dsh/", "directory"), "@src/dsh/");
  // **反斜杠统一换成 `/`**（偏离官方）：Windows 侧 `path.relative()` 给的是 `\`，
  // 而 `@` 引用是正斜杠语法，混着写会得到 `@src\webview/`（用户报的正是它）
  assert.strictEqual(formatFileMention("src\\dsh\\", "directory"), "@src/dsh/", "目录：反斜杠归一 + 尾斜杠只留一个");
  assert.strictEqual(formatFileMention("src\\dsh\\adapter.ts"), "@src/dsh/adapter.ts", "文件同样归一（两处产生方要一致）");
  assert.strictEqual(formatFileMention("D:\\dev\\app\\a.ts"), "@D:/dev/app/a.ts", "绝对路径也归一");
  // **文件**不补斜杠，哪怕路径以斜杠结尾也不动它
  assert.strictEqual(formatFileMention("src/dsh/", "file"), "@src/dsh/");
}
console.log("references: 普通路径与目录的 mention（分隔符归一 / 不重复补斜杠） ✓");

// ---------- 2. 含空白的路径：引号**成对**（目录也一样） ----------
//
// 官方对目录只写开引号（`@"dir/`，为了「未闭合还能继续往下打字」）。用户 2026-09-21
// 报「引进带空格目录时，只有头部有引号、尾部没有」：那个未闭合形态一旦被发出去就是
// 半截 token。而带空格的路径本来就没法用触发词继续下钻（查询按空白切段），
// 所以官方的理由在这里不成立，改成成对引号。
{
  assert.strictEqual(formatFileMention("my file.txt"), '@"my file.txt"');
  assert.strictEqual(formatFileMention("my dir", "directory"), '@"my dir/"');
  assert.ok(
    formatFileMention("my dir", "directory")!.endsWith('/"'),
    "目录的 mention 也要闭合引号（尾斜杠在引号**内**，目录标记不能丢）",
  );
  assert.strictEqual(formatFileMention("my\\dir with space", "directory"), '@"my/dir with space/"', "归一与引号一起生效");
  assert.ok(!formatFileMention("plain.ts")!.includes('"'), "无空格的路径不加引号");
}
console.log("references: 含空白路径加引号（目录也成对） ✓");

// ---------- 3. 含控制字符或 `"` 的路径无法引用 ----------

{
  assert.strictEqual(formatFileMention('has"quote.ts'), undefined, "含引号无法转义，拒绝");
  assert.strictEqual(formatFileMention("has\u0000nul.ts"), undefined);
  assert.strictEqual(formatFileMention("has\nnewline.ts"), undefined);
  assert.strictEqual(formatFileMention("ok/path.ts"), "@ok/path.ts", "正常路径不受影响");
}
console.log("references: 含控制字符/引号的路径拒绝引用 ✓");

// ---------- 4. 对话引用 mention 的**显示**形态（`@标题`） ----------
//
// 用户 2026-09-15 加了「`@` 可以引用对话」。插进正文的是官方那条规范 token
// （`@[标题](dsh-session:…)`）——它是给服务端看的；落盘的 durable 事件里仍是原始
// token（服务端只给模型那一份副本做替换），转写要自己折成 `@标题`，否则用户会在
// 自己的消息里看到一长串带 base64 会话 id 的东西。
{
  const token = "@[修复连接超时](dsh-session:eyJpZCI6IjAxSiJ9)";
  assert.strictEqual(displaySessionMentions(token), "@修复连接超时");
  assert.strictEqual(
    displaySessionMentions(`看看这个 ${token} 的结论`),
    "看看这个 @修复连接超时 的结论",
    "正文里的其它部分一个字节都不动",
  );
  assert.strictEqual(
    displaySessionMentions(`${token}\n${token}`),
    "@修复连接超时\n@修复连接超时",
    "多个引用逐个还原",
  );
  // 标题里的转义（`\[` / `\\`）按官方 unescape 规则还原
  assert.strictEqual(displaySessionMentions("@[a\\[b\\]](dsh-session:x)"), "@a[b]");
  // 不是对话引用的方括号文本、裸 http 链接、普通 @path 一律不动
  for (const raw of ["@[不是引用](https://x)", "@src/dsh/controller.ts", "看 [这里](a.md)", "@[x](other:y)"]) {
    assert.strictEqual(displaySessionMentions(raw), raw, `${raw} 不该被改动`);
  }
}
console.log("references: 对话引用的显示形态（@标题）✓");

// ---------- 5. 查询块的**语义**：浏览入口 / 行号区间 / 对话引用 token ----------
//
// 这三个纯函数是「这一块已经能引用到内容吗」那条产品口径（用户 2026-10-11）的判据
// 前半截：宿主拿它们把块分成三类（`controller.mentionResolves`），界面拿
// `isBrowseQuery` 决定要不要等宿主那一次判定。链路断言见
// `scripts/mentionResolve.test.ts`。
{
  // 浏览入口 = 裸 `@`（空查询）或以 `/` / `\` 结尾的路径：那种形态的意思是「进去看
  // 这一层」，目录在不在都要能进去，所以永远弹列表、不做存在性判定。
  for (const query of ["", "src/", "src\\webview\\", "my dir/"]) {
    assert.strictEqual(isBrowseQuery(query), true, `"${query}" 是浏览入口`);
  }
  // 其余一律是「检索块」：会话 id / 名字片段、不带尾分隔符的路径，都要过判定
  for (const query of ["session-4be424ed", "web", "src/webview", "a.ts#L12", "[标题](dsh-session:InMxIg)"]) {
    assert.strictEqual(isBrowseQuery(query), false, `"${query}" 不是浏览入口（要做存在性判定）`);
  }

  // 行号区间是 `formatFileMentionWithLines` 附在**末尾**的产物：判「这个文件在不在」
  // 之前必须去掉它，否则查的是一个不存在的名字（用户点名的那一条）
  assert.strictEqual(mentionPathOf("src/a.ts#L12"), "src/a.ts");
  assert.strictEqual(mentionPathOf("src/a.ts#L12-L40"), "src/a.ts");
  assert.strictEqual(mentionPathOf("src/a.ts"), "src/a.ts", "没有行号就原样");
  assert.strictEqual(mentionPathOf("#L12"), "", "只剩行号 → 空路径（调用方按「判不出」处理）");
  assert.strictEqual(mentionPathOf("a#L1b.ts"), "a#L1b.ts", "行号必须整个在末尾才算（`#L1` 后面还有字就不是它）");

  // 对话引用 token：整块匹配，解得出会话 id 才算
  const uri = `dsh-session:${Buffer.from(JSON.stringify("s1"), "utf8").toString("base64url")}`;
  assert.strictEqual(referenceSessionIdOf(`[修复连接超时](${uri})`), "s1", "规范 token 解出会话 id");
  assert.strictEqual(referenceSessionIdOf(uri), "s1", "裸 `dsh-session:…` 同样是对话引用（用户手写 / 粘进来的形态）");
  // **裸会话 id 不是对话引用**：那不是服务端认的形态，打进去仍然是在检索会话
  // （用户 2026-10-11 报的现场就是它的候选列表不弹了）
  for (const raw of [
    "session-4be424ed-3f46-4c23-ad68-9a4fd33f3d6d",
    `前缀 [标题](${uri})`,
    `[标题](${uri}) 后缀`,
    "[标题](https://x)",
    "dsh-session:",
    "dsh-session:!!!",
    // 负载解出来不是字符串（官方 `decodeSessionReferenceUri` 同判据）
    "dsh-session:eyJpZCI6IjAxSiJ9",
  ]) {
    assert.strictEqual(referenceSessionIdOf(raw), undefined, `"${raw}" 不是对话引用 token`);
  }
}
console.log("references: 查询块的语义（浏览入口 / 行号区间 / 对话引用 token） ✓");

console.log("\nreferences: all assertions passed");
