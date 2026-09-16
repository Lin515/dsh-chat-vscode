/**
 * 工具卡的数据推导（官方 `models/` 下各 `card-model` 与 `tool-call-model` 的等价物）。
 *
 * 用户 2026-09-16 报的现场：「工具不需要显示出 agent 的完整具体输入内容，重在可读性
 * 和渲染输出内容，请和 Web 端保持一致；读取、搜索等工具和 Web 端不一致」。
 * 本文件钉的就是这条链路的**判据**：
 *
 * 1. 哪些工具、什么条件下**给卡片**（给了卡片界面就不渲染 IN/OUT，参数 JSON 不再出现）；
 * 2. 卡片里的数据必须来自**权威元数据**（`tool/result.meta`）——形状不合就退回通用
 *    IN/OUT，绝不画一张内容残缺的卡；
 * 3. 摘要口径（官方 `deriveSummary`）：`queries` 数组拼接、变体字段表、参数里第一个
 *    非空字符串、原始参数首行。
 *
 * 夹具形状来自**真实会话日志**（`~/.dsh/sessions/` 下的 `session.v3.jsonl.zstd` 扫出来的
 * 实际 `tool/result.meta`，见文件末尾的取证说明），不是编的。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import type { ToolCardView } from "../src/shared/chat";
import { deriveToolSummary, todoProgressOf, toolCardOf } from "../src/shared/toolCard";

/** 结算成功的一条工具结果（真实形状：内容块恰好一个 text）。 */
function settled(
  name: string,
  args: unknown,
  options: { meta?: unknown; output?: string; content?: unknown; isError?: boolean; exitCode?: number; signal?: string } = {},
) {
  const output = options.output ?? "";
  return toolCardOf({
    name,
    argsRaw: JSON.stringify(args),
    output,
    content: options.content ?? [{ type: "text", text: output }],
    meta: options.meta,
    exitCode: options.exitCode,
    signal: options.signal,
    isError: options.isError === true,
    interrupted: false,
    settled: true,
  });
}

// ---------- 1. read：行号 + 内容来自 meta.lines（官方 readCardModel） ----------
{
  const meta = {
    path: "D:\\dev\\dsh-chat\\src\\webview\\pendingInteraction.ts",
    offset: 1,
    lines: [
      { number: 1, text: 'import type { ApprovalView } from "../shared/chat";' },
      { number: 2, text: "" },
      { number: 3, text: "export function pendingInteractionOf() {}" },
    ],
    totalLines: 55,
    lang: "typescript",
  };
  const card = settled("read", { file_path: meta.path }, { meta });
  assert.ok(card && card.kind === "read", "有 meta 就要给读取卡");
  assert.strictEqual(card.label, meta.path, "卡片标签是文件路径");
  assert.deepStrictEqual(card.lines, meta.lines, "行号与正文原样来自 meta（工具是权威）");
  assert.strictEqual(card.totalLines, 55, "总行数用于「显示 X / Y 行」");
  assert.strictEqual(card.lang, "typescript", "语言给语法高亮用");

  // meta 缺失 / 形状不对 → 退回通用 IN/OUT（宁可难看，也不要画半截内容）
  assert.strictEqual(settled("read", { file_path: meta.path }), undefined, "没有 meta 就不给卡");
  assert.strictEqual(
    settled("read", { file_path: meta.path }, { meta: { ...meta, lines: [{ number: 3, text: "x" }, { number: 2, text: "y" }] } }),
    undefined,
    "行号必须严格递增（官方 readMeta 的校验）",
  );
  assert.strictEqual(
    settled("read", { file_path: meta.path }, { meta: { ...meta, totalLines: 2 } }),
    undefined,
    "行号不能越过 totalLines",
  );
  // 读取出错：结果里的报错才是内容，卡片会给错印象
  assert.strictEqual(
    settled("read", { file_path: meta.path }, { meta, isError: true, output: "ENOENT" }),
    undefined,
    "错误的读取不给卡（官方 readCardModel 同样要求 !isError）",
  );
  // 参数里 offset 不是 ≥1 的整数（模型乱给）→ 官方 validReadCall 直接否决
  assert.strictEqual(
    settled("read", { file_path: meta.path, offset: 0 }, { meta }),
    undefined,
    "offset 必须是 ≥1 的整数",
  );
}

// ---------- 2. grep：命中按文件分组 + 截断说明（官方 searchCardModel） ----------
{
  // 真实 meta（本地日志里 grep "question|Question" 的结果，路径是 Windows 反斜杠）
  const meta = {
    shape: "matches",
    total: 134,
    truncated: false,
    files: [
      {
        path: "src\\extension.ts",
        matches: [{ lineNumber: 322, line: '        event.affectsConfiguration("dshChat.questionBatch")' }],
      },
      {
        path: "src\\webview\\questionFlow.ts",
        matches: [
          { lineNumber: 1, line: 'import type { QuestionItemView } from "../shared/chat";' },
          { lineNumber: 4, line: " * 问卷（`ask_user_question`）的展示口径：**一次展开**还是**依次问答**。" },
        ],
      },
    ],
  };
  const card = settled("grep", { pattern: "question|Question", include: "*.ts", path: "D:\\dev\\dsh-chat\\src" }, {
    meta,
    output: "src\\extension.ts:322: ...",
  });
  assert.ok(card && card.kind === "search" && card.shape === "matches", "grep 命中要给搜索卡");
  assert.strictEqual(card.total, 134);
  assert.strictEqual(card.files.length, 2, "两个文件两条文件头");
  assert.strictEqual(card.files[1].matches[0].lineNumber, 1);
  assert.strictEqual(card.recovery, undefined, "没截断就不带 recovery");

  // 截断时正文里那条「完整结果在哪」的说明要一并给出（官方 recovery）
  const truncated = settled("grep", { pattern: "x" }, { meta: { ...meta, truncated: true }, output: "（完整结果已写入文件）" });
  assert.ok(truncated && truncated.kind === "search");
  assert.strictEqual(truncated.truncated, true);
  assert.strictEqual(truncated.recovery, "（完整结果已写入文件）");

  // include 带顶层逗号 / `!` 开头 → 官方 validInclude 否决（走通用路径）
  assert.strictEqual(settled("grep", { pattern: "x", include: "a,b" }, { meta }), undefined, "逗号分隔的 include 不合法");
  assert.strictEqual(settled("grep", { pattern: "x", include: "!*.md" }, { meta }), undefined, "`!` 开头不合法");
  // 形状对不上就退回通用路径
  assert.strictEqual(settled("grep", { pattern: "x" }, { meta: { shape: "paths", paths: [], total: 0, truncated: false } }), undefined, "grep 只认 matches 形状");
}

// ---------- 3. glob：路径列表（官方同名分支） ----------
{
  const meta = { shape: "paths", paths: ["src\\webview\\main.tsx", "src\\shared\\chat.ts"], total: 2, truncated: false };
  const card = settled("glob", { pattern: "src/**/*.ts*" }, { meta });
  assert.ok(card && card.kind === "search" && card.shape === "paths", "glob 给路径卡");
  assert.deepStrictEqual(card.paths, meta.paths, "路径原样透出（省略由界面做）");
  assert.strictEqual(card.total, 2);
  // glob 的 pattern 不能为空（官方 validSearchCall）
  assert.strictEqual(settled("glob", { pattern: "  " }, { meta }), undefined, "空 pattern 不合法");
}

// ---------- 4. 终端：运行中就给卡；结算后只在「一次性命令」上给（官方 shellCall） ----------
{
  const meta = undefined;
  const running = toolCardOf({
    name: "pwsh",
    argsRaw: JSON.stringify({ command: "Get-Location; git status", description: "Show repo state" }),
    isError: false,
    interrupted: false,
    settled: false,
  });
  assert.ok(running && running.kind === "terminal", "运行中的 pwsh 就该有终端卡（官方 running 分支）");
  assert.strictEqual(running.running, true);
  assert.strictEqual(running.output, "", "运行中没有输出");
  assert.strictEqual(running.command, "Get-Location; git status");

  const done = settled(
    "pwsh",
    { command: "git status --short", description: "Show repo state" },
    { meta, output: " M src/foo.ts", exitCode: 0 },
  );
  assert.ok(done && done.kind === "terminal", "有 description 的一次性命令：结算后仍是终端卡");
  assert.strictEqual(done.running, undefined, "结算后不是 running");
  assert.strictEqual(done.output, " M src/foo.ts");
  assert.strictEqual(done.exitCode, 0);

  // **没有 description ⇒ 官方的持久 shell 路径**：结算后没有唯一退出状态，退回通用 IN/OUT
  assert.strictEqual(
    settled("pwsh", { command: "cd /tmp" }, { meta, output: "ok" }),
    undefined,
    "没有 description 的调用按持久 shell 处理（官方 shellCall 的 persistent:true）",
  );
  // 后台命令、出错、spill 提示都不给终端卡
  assert.strictEqual(
    settled("pwsh", { command: "npm run dev", description: "dev", run_in_background: true }, { meta, output: "" }),
    undefined,
    "后台命令没有前台退出状态",
  );
  assert.strictEqual(settled("pwsh", { command: "x", description: "x" }, { meta, output: "boom", isError: true }), undefined, "出错退回通用路径");
  assert.strictEqual(
    settled("pwsh", { command: "x", description: "x" }, { meta, output: "截断的正文\n\n(Some 12 bytes omitted. Full formatted result stored at: D:\\tmp\\x.txt. Read it with the read tool.)" }),
    undefined,
    "spill 预览里退出标记可能被页脚顶掉，不能推断退出码",
  );
  // 提权字段必须成对合法（官方 validEscalationFields）
  assert.strictEqual(
    settled("pwsh", { command: "x", description: "x", sandbox_permissions: "workspace-write" }, { meta, output: "" }),
    undefined,
    "只给 sandbox_permissions 不给 justification 不合法",
  );
  assert.ok(
    settled("pwsh", { command: "x", description: "x", sandbox_permissions: "workspace-write", justification: "需要写文件" }, { meta, output: "ok" }),
    "成对合法时照常给终端卡",
  );
}

// ---------- 5. 网页：搜索给答案 + 来源，获取给 URL + 状态码 ----------
{
  const searchMeta = {
    truncated: false,
    sources: [
      { url: "https://code.visualstudio.com/api/references/contribution-points", title: "Contribution Points" },
      { url: "https://example.com/plain", snippet: "没有标题时显示主机名" },
    ],
  };
  const search = settled("web_search", { queries: ["vscode icon", "svg mask"] }, { meta: searchMeta, output: "…" });
  assert.ok(search && search.kind === "web_search", "web_search 给网页卡");
  assert.strictEqual(search.sources.length, 2);
  assert.strictEqual(search.truncated, false);

  const withAnswer = settled("web_search", { queries: ["q"] }, { meta: { ...searchMeta, answer: "答案是 X" }, output: "…" });
  assert.ok(withAnswer && withAnswer.kind === "web_search");
  assert.strictEqual(withAnswer.answer, "答案是 X", "答案进卡片（界面按 markdown 渲染）");

  const fetch = settled("web_fetch", { url: "https://example.com/a" }, {
    meta: { url: "https://example.com/a", statusCode: 200, truncated: false },
    output: "正文",
  });
  assert.ok(fetch && fetch.kind === "web_fetch", "web_fetch 给网页卡");
  assert.strictEqual(fetch.statusCode, 200);

  assert.strictEqual(settled("web_search", { queries: [] }, { meta: searchMeta }), undefined, "空 queries 不合法");
  assert.strictEqual(settled("web_fetch", { url: " " }, { meta: {} }), undefined, "空 url 不合法");
  assert.strictEqual(settled("web_fetch", { url: "https://x" }, { meta: { url: "https://x", statusCode: "200", truncated: false } }), undefined, "状态码必须是整数");
}

// ---------- 6. run_code：参数里的 code 直接当正文（官方 formatToolBody 的 code 分支） ----------
{
  const card = toolCardOf({
    name: "run_code",
    argsRaw: JSON.stringify({ description: "算一下", code: "return 1 + 1;" }),
    isError: false,
    interrupted: false,
    settled: false,
  });
  assert.ok(card && card.kind === "code", "run_code 给代码卡");
  assert.strictEqual(card.code, "return 1 + 1;");
  assert.strictEqual(settled("run_code", { code: "" }), undefined, "空 code 不给卡");
}

// ---------- 7. 摘要口径（官方 deriveSummary） ----------
{
  // web_search 的参数是 queries 数组：官方把它们拼起来当摘要
  assert.strictEqual(
    deriveToolSummary("web_search", JSON.stringify({ queries: ["a", "b"] })),
    "a, b",
    "queries 数组拼接（此前本扩展在这里什么都取不到，搜索行只有标题没有内容）",
  );
  // 变体字段表：bash 优先 description
  assert.strictEqual(
    deriveToolSummary("pwsh", JSON.stringify({ command: "git status", description: "Show repo state" })),
    "Show repo state",
    "bash 变体优先 description（官方 SUMMARY_KEYS.bash）",
  );
  // 未知工具：参数里第一个非空字符串 → 原始参数首行
  assert.strictEqual(deriveToolSummary("mcp__x__find", JSON.stringify({ query: "memory", limit: 5 })), "memory");
  assert.strictEqual(deriveToolSummary("unknown_tool", '{"n":1}'), '{"n":1}', "没有字符串参数时退回原始参数首行");
  // 多行值只取首行
  assert.strictEqual(deriveToolSummary("read", JSON.stringify({ file_path: "a\nb" })), "a");
}

// ---------- 8. todo_write：进度数字（官方 TodoRow 的 planSummary） ----------
{
  const progress = todoProgressOf(
    JSON.stringify({
      todos: [
        { content: "第一件", status: "completed" },
        { content: "正在做的", status: "in_progress" },
        { content: "另一件在做的", status: "in_progress" },
        { content: "还没做", status: "pending" },
      ],
    }),
  );
  assert.deepStrictEqual(progress, { done: 1, total: 4, active: "正在做的", extra: 1 }, "进度 + 当前项 + 其余条数");
  assert.strictEqual(todoProgressOf(JSON.stringify({ todos: [] })), undefined, "空清单不给摘要");
  assert.strictEqual(todoProgressOf("半截"), undefined, "半截 JSON 不给摘要");
}

// 夹具取证：`scripts/tmpMetaScan.ts` 扫过本机 265 份真实会话日志，上面 read / grep /
// glob / web_search / web_fetch / edit / write 的 meta 字段与取值都来自那些样本
// （例如 grep 的 `{shape:"matches", files:[{path, matches:[{lineNumber,line}]}]}`、
// read 的 `{path, offset, lines:[{number,text}], totalLines}`）。探针用完即删。
console.log("toolCard: 工具卡判据（读取 / 搜索 / 终端 / 网页 / 代码 / 摘要 / 待办） ✓");
console.log("\ntoolCard: all assertions passed");
