/**
 * **vendor 进来那几份官方纯决策模块**的离线断言（零 token，读源码 + 纯函数）。
 *
 * 钉的是「搬进来之后还是官方那套口径」——这些口径都是**手工搬运会漂**的地方：
 * 预览投影的解析语法（换 marked 近似版就变）、`recordId` 的回退链（用序号当身份
 * 会在前插历史后串行）、搜索的**分词 AND** 与字段表（整串子串比较会漏）、
 * 时间线的并发区间（首尾相接会把域拉长）、适配层的字段去向（宿主字段要合成成官方
 * 形状，不得透传成官方没有的列）。
 *
 * 官方的实现体在 `src/vendor/`，**不要在断言里重写一份实现**：这里比的是
 * 「输入端 → 输出端」，官方升级时这份断言会先红，正好是重新 diff 的提示。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractMarkdownPlainText } from "../src/vendor/ui-primitives/markdown/plain-text";
import { codeProgram, PTC_TOOL_NAME } from "../src/vendor/ui-trajectory/code-program";
import { applySplice } from "../src/vendor/ui-trajectory/inbox-state";
import { trajectoryPreviewText } from "../src/vendor/ui-trajectory/trajectory-preview";
import { trajectoryRecordId } from "../src/vendor/ui-trajectory/trajectory-record";
import { TrajectorySearchIndex } from "../src/vendor/ui-trajectory/trajectory-search-index";
import { deriveTrajectoryTimeline } from "../src/vendor/ui-trajectory/timeline";
import type { TrajectoryCellProps } from "../src/vendor/ui-trajectory/trajectory-record";
import type { TrajectoryTurnModel } from "../src/vendor/ui-trajectory/trajectory-turn-model";
import { vendorCell } from "../src/webview/trajectoryVendor";
import type { TrajectoryCell, TrajectoryToolSchema } from "../src/shared/trajectory";

/**
 * 取一次搜索的命中集合。官方实现用 `null` 表达「空查询 / 索引不可用」，而本文件每个查询
 * 都应当有结果——用肯定断言把「本该有结果却拿到 null」变成带消息的失败，而不是让
 * `[...null]` 在运行期抛一个与用例无关的 TypeError。
 */
function searchHits(index: TrajectorySearchIndex, query: string): ReadonlySet<string> {
  const found = index.search(query);
  assert.ok(found !== null, `查询「${query}」应当返回命中集合，而不是 null`);
  return found;
}

// ---------- 1. 预览投影：同一套 mdast 语法，剥掉记号、留 alt、有界截断 ----------
{
  // 表现层记号去掉、代码留源文本、链接留标签、图片留 alt（官方 `plain-text.ts` 的口径）
  assert.strictEqual(
    trajectoryPreviewText("# 标题\n\n**粗体** 与 `代码`"),
    "标题 粗体 与 代码",
  );
  assert.strictEqual(
    trajectoryPreviewText("[标签](https://example.com/x) 与 ![替代文字](./a.png)"),
    "标签 与 替代文字",
  );
  assert.strictEqual(trajectoryPreviewText("```\nconst a = 1\n```"), "const a = 1");
  // 裸 HTML 原样保留（官方注释明说「raw HTML stays literal」）
  assert.strictEqual(trajectoryPreviewText("<div>原样</div>"), "<div>原样</div>");

  // 上限：源 2048 / 输出 512，任一环节截断过就补省略号
  const long = "字".repeat(900);
  const preview = trajectoryPreviewText(long);
  assert.strictEqual(preview.length, 513, "512 字符 + 省略号");
  assert.ok(preview.endsWith("…"));
  const overSource = `${"a".repeat(2100)}`;
  assert.ok(
    trajectoryPreviewText(overSource).endsWith("…"),
    "源超过 2048 字符也算截断（官方那个 `source.length < text.length` 分支）",
  );
  assert.strictEqual(
    trajectoryPreviewText("短文本"),
    "短文本",
    "没截断过就不加省略号",
  );

  // 换行压平成空格（一行预览）
  assert.strictEqual(trajectoryPreviewText("第一行\n\n第二行"), "第一行 第二行");

  // 这张表是**mdast 语法**跑出来的，不是 marked：列表/表格/围栏代码的分派与官方一致
  // （表格行在投影里以制表符分列，最后那一步压平空白会把它变成空格）
  assert.strictEqual(
    trajectoryPreviewText("| a | b |\n| - | - |\n| 1 | 2 |"),
    "a b 1 2",
  );
  assert.strictEqual(extractMarkdownPlainText("## 小标题", { mode: "first-line" }), "小标题");
}

// ---------- 2. 本地图片语法恢复：带空格的本地路径要变成图片（留 alt） ----------
{
  // `recoverLocalImages` 的判据：单图片段落 + 未转义 + 本地路径 + **路径里有空格** + 图片扩展名
  assert.strictEqual(
    trajectoryPreviewText("![截图](C:\\我的 文件\\a.png)"),
    "截图",
  );
  assert.strictEqual(
    trajectoryPreviewText("![截图](C:\\我的 文件\\a.txt)"),
    "![截图](C:\\我的 文件\\a.txt)",
    "非图片扩展名不恢复——保持字面原文（与上游 classifyFileType 的 image 档一致）",
  );
}

// ---------- 3. 语法臂只搬了 Gfm 那一支（省略 math 是刻意的） ----------
{
  const source = readFileSync(
    join(process.cwd(), "src", "vendor", "ui-primitives", "markdown", "parse.ts"),
    "utf8",
  );
  assert.ok(/export function parseGfm\(/.test(source), "流式臂（预览投影用的就是它）");
  assert.ok(
    !/parseGfmWithMath/.test(source.replace(/\/\*\*[\s\S]*?\*\//gu, "")),
    "结算臂（math）没有搬——轨迹的消费方零引用它；要搬就整支搬（含 math 依赖），不许只搬一半",
  );
  assert.ok(
    /micromark-extension-gfm/.test(source),
    "GFM 扩展在（官方预览与渲染器共用同一套语法）",
  );
}

// ---------- 4. 记录身份：前插历史之后必须稳定 ----------
{
  const cell: TrajectoryCellProps = { index: 7, kind: "user", text: "x", timeSeconds: null, sourceSeq: 42 };
  const id = trajectoryRecordId(cell);
  assert.strictEqual(id, "user\u0000seq\u000042");
  assert.strictEqual(
    trajectoryRecordId({ ...cell, index: 99 }),
    id,
    "编号平移（往前加载一页历史）之后身份不变——「调用折叠」的状态键靠它",
  );
  assert.strictEqual(
    trajectoryRecordId({ index: 1, kind: "tool", text: "", timeSeconds: null, callId: "c9" }),
    "tool\u0000call\u0000c9",
    "有 callId 时优先用调用身份（回退链第二级）",
  );
  assert.strictEqual(
    trajectoryRecordId({ index: 1, kind: "tool", text: "", timeSeconds: null, recordId: "给定" }),
    "给定",
    "上游给了 recordId 就直接用（回退链第一级）",
  );
  assert.strictEqual(
    trajectoryRecordId({ index: 3, kind: "system", text: "", timeSeconds: null }),
    "system\u0000index\u00003",
    "什么都没有时才退回序号（夹具兜底）",
  );
}

// ---------- 5. 搜索索引：分词 AND + 稳定身份 + requestOnly 不索引 ----------
{
  const turn = (cells: TrajectoryCellProps[]): TrajectoryTurnModel[] => [
    { turn: 0, groups: [{ title: "", cells }] },
  ];
  const cells: TrajectoryCellProps[] = [
    { index: 1, kind: "user", text: "", previewMarkdown: "帮我看看 auth 模块", timeSeconds: null, sourceSeq: 1 },
    { index: 2, kind: "message", text: "", outputDetail: "auth 模块在 src/auth.ts", timeSeconds: null, sourceSeq: 2 },
    { index: 3, kind: "tool", text: "read", previewMarkdown: '{"file_path":"src/other.ts"}', timeSeconds: null, callId: "c1" },
    { index: 4, kind: "message", text: "", timeSeconds: null, requestOnly: true, sourceSeq: 4 },
    // 工具目录变更那行：工具名只在 `sourceBlocks` 里（官方单条变更时**只有**这条路径
    // 能搜到工具名——`text` 是本地化文案、`inputDetail` 只给多条形）
    {
      index: 5,
      kind: "context",
      text: "",
      timeSeconds: 0,
      sourceSeq: 5,
      sourceBlocks: [{ type: "tool-addition", content: "list_mcp_resources" }],
    },
  ];
  const index = new TrajectorySearchIndex();
  const layouts = [turn(cells)];
  assert.strictEqual(index.update(layouts), true, "首次建索引");
  assert.strictEqual(
    index.update(layouts),
    false,
    "同一份引用不重复建（界面侧靠 useMemo 保住这个引用，避免每渲染重解析预览）",
  );

  assert.strictEqual(index.search("   "), null, "空查询返回 null（不是空集合）");
  // 分词 AND：两个词必须都命中**同一条**记录
  assert.deepStrictEqual(
    [...searchHits(index, "auth 模块")].sort(),
    ["message\u0000seq\u00002", "user\u0000seq\u00001"],
    "两个词都在同一条里才算命中（整串子串比较会漏掉这里的两条）",
  );
  assert.deepStrictEqual([...searchHits(index, "auth 不存在")], [], "有一个词不命中就不算");
  // 大小写用 toLocaleLowerCase 折叠
  assert.strictEqual(searchHits(index, "AUTH").size, 2);
  // 字面 kind（官方索引 `tool` / `assistant` 这样的**原值**，不是本地化标签）
  assert.deepStrictEqual([...searchHits(index, "user")], ["user\u0000seq\u00001"], "kind 原值进索引");
  assert.deepStrictEqual(
    [...searchHits(index, "tool")].sort(),
    ["context\u0000seq\u00005", "tool\u0000call\u0000c1"],
    "kind 与块内容的词都算命中（`tool-addition` 里也含 `tool`）",
  );
  // `previewMarkdown` 走预览投影后再入库（所以按投影后的词也能搜到）
  assert.deepStrictEqual([...searchHits(index, "file_path")], ["tool\u0000call\u0000c1"]);
  // requestOnly 行不索引
  assert.strictEqual(searchHits(index, "4").size, 0, "requestOnly 行不进索引");
  // 块级字段（`sourceBlocks` 的 type / content / callId / toolName）
  assert.deepStrictEqual(
    [...searchHits(index, "list_mcp_resources")],
    ["context\u0000seq\u00005"],
    "工具目录变更行按 `sourceBlocks` 里的工具名搜得到",
  );
  assert.deepStrictEqual([...searchHits(index, "tool-addition")], ["context\u0000seq\u00005"], "块类型也可搜");

  // 身份稳定：编号平移之后还是同一条命中
  const shifted = cells.map((cell) => ({ ...cell, index: cell.index + 100 }));
  index.update([turn(shifted)]);
  assert.deepStrictEqual(
    [...searchHits(index, "auth 模块")].sort(),
    ["message\u0000seq\u00002", "user\u0000seq\u00001"],
    "命中仍按事件身份给出（序号平移不影响）",
  );
}

// ---------- 5b. 搜索面上那两类「宿主新采集的输入」真的可搜 ----------
//
// 这一段钉的是 2026-10-04 那次采集的**目的**：官方字段表里 `schemaDetail` 与块级
// `content` 是两条独立的搜索路径，宿主不采它们，这两类词在索引里就永远搜不到。
// 断言只走 vendor 的 `recordSources()`（不重写实现），所以它同时是「上游改字段表」的哨兵。
{
  const turn = (cells: TrajectoryCellProps[]): TrajectoryTurnModel[] => [
    { turn: 0, groups: [{ title: "", cells }] },
  ];
  const cells: TrajectoryCellProps[] = [
    {
      index: 1,
      kind: "tool",
      text: "read",
      timeSeconds: null,
      callId: "c1",
      // 调用时记下的 schema（宿主 `schemaDetailOf()` 的产物形状：JSON 文本）
      schemaDetail: JSON.stringify(
        { name: "read", description: "读取工作区文件", parameters: { properties: { file_path: {} } } },
        null,
        2,
      ),    },
    {
      index: 2,
      kind: "message",
      text: "",
      timeSeconds: null,
      sourceSeq: 2,
      // 助手行的原始块：工具调用块的 name / arguments 在 content 里（序列化后的块）
      //
      // 这里的参数名刻意与上面 schema 的 `file_path` **不重叠**：两边都命中时断言就
      // 分不清是走的哪条路径了（第一版就踩了这个，`file_path` 同时命中两条记录）。
      sourceBlocks: [
        { type: "text", content: "我来改一下" },
        { type: "tool-call", content: '{\n  "name": "edit",\n  "arguments": "{\\"target_file\\":\\"src/config.ts\\"}"\n}' },
        { type: "thinking", content: "先看看配置" },
      ],
    },
  ];
  const index = new TrajectorySearchIndex();
  index.update([turn(cells)]);

  // schemaDetail：工具名 / 描述 / 参数名都能搜到（官方 `recordSources()` 直接吃这一整段）
  assert.deepStrictEqual(
    [...searchHits(index, "读取工作区文件")],
    ["tool\u0000call\u0000c1"],
    "schemaDetail 的**描述**可搜（宿主采集 schema 的主要收益）",
  );
  assert.deepStrictEqual(
    [...searchHits(index, "file_path")],
    ["tool\u0000call\u0000c1"],
    "schemaDetail 的**参数名**可搜",
  );  // sourceBlocks：块类型与序列化进 content 的工具参数
  assert.deepStrictEqual(
    [...searchHits(index, "edit")],
    ["message\u0000seq\u00002"],
    "助手行工具调用块的**工具名**可搜（它在 `sourceBlocks[].content` 里，不在 text/previewMarkdown）",
  );
  assert.deepStrictEqual(
    [...searchHits(index, "src/config.ts")],
    ["message\u0000seq\u00002"],
    "工具调用的**参数**可搜",
  );
  assert.deepStrictEqual(
    [...searchHits(index, "thinking")],
    ["message\u0000seq\u00002"],
    "块类型（`thinking`）也进索引",
  );
  // 两个词来自**不同**字段时仍要同时命中（AND 不跨字段就是另一条记录了）
  assert.deepStrictEqual(
    [...searchHits(index, "edit src/config.ts")],
    ["message\u0000seq\u00002"],
    "同一条记录的块级字段之间按 AND 组合",
  );
  assert.deepStrictEqual(
    [...searchHits(index, "读取工作区文件 edit")],
    [],
    "跨记录的两个词不算命中（AND 是记录内的）",
  );
}

console.log("\ntrajectory-vendor: 搜索索引的输入侧字段 ✓");

// ---------- 6. 时间线：等宽 / 耗时（并发保持重叠）/ 按真实时刻 ----------
{
  const at = (seconds: number) => 1_700_000_000_000 + seconds * 1000;
  const turns: TrajectoryTurnModel[] = [{
    turn: 0,
    groups: [{
      title: "",
      cells: [
        { index: 1, kind: "user", text: "", timeSeconds: 0, startedAt: at(0) },
        { index: 2, kind: "message", text: "", timeSeconds: 4, startedAt: at(0) },
        { index: 3, kind: "tool", text: "", timeSeconds: 1, startedAt: at(1) },
      ],
    }],
  }];
  const sequence = deriveTrajectoryTimeline(turns, "sequence");
  assert.ok(sequence);
  assert.deepStrictEqual(sequence.spans.map((span) => [span.start, span.end]), [[0, 1], [1, 2], [2, 3]]);
  assert.deepStrictEqual(sequence.turnBoundaries, [{ turn: 0, time: 0 }]);
  assert.deepStrictEqual(sequence.spans.map((span) => span.lane), [0, 1, 2]);

  // 耗时：扣掉空闲（1→4 秒那段没有记录，不该占宽度），并发的那条落在父区间内
  const duration = deriveTrajectoryTimeline(turns, "duration");
  assert.ok(duration);
  assert.strictEqual(duration.start, at(0));
  assert.strictEqual(duration.end, at(4), "域被压缩到记录实际覆盖的范围");
  const tool = duration.spans.find((span) => span.index === 3);
  const message = duration.spans.find((span) => span.index === 2);
  assert.ok(tool && message);
  assert.ok(tool.start >= message.start && tool.end <= message.end, "并发区间保持重叠（不首尾相接）");

  // 实际时间：保留空闲
  const actual = deriveTrajectoryTimeline(turns, "actual");
  assert.ok(actual);
  assert.strictEqual(actual.start, at(0));
  assert.strictEqual(actual.end, at(4));
  // 与 `duration` 的差别在于**空闲占不占宽度**：域一样，但动过的那 1 秒里
  // `actual` 把工具条摆在它真实开始的位置（at(1)），`duration` 把它压在 at(0)+1s 的里面
  const actualTool = actual.spans.find((span) => span.index === 3);
  assert.ok(actualTool);
  assert.strictEqual(actualTool.start, at(1), "实际时间保留真实开始时刻");
  assert.strictEqual(tool.start, at(0) + 1000, "扣掉空闲之后，工具条紧接在起点之后");

  // 按真实时刻：宽度归零
  const time = deriveTrajectoryTimeline(turns, "time");
  assert.ok(time);
  assert.ok(time.spans.every((span) => span.end === span.start));

  // 缺 startedAt 的记录不进线；一条都没有时整份模型是 null
  assert.strictEqual(
    deriveTrajectoryTimeline([{ turn: 0, groups: [{ title: "", cells: [{ index: 1, kind: "message", text: "", timeSeconds: null }] }] }], "time"),
    null,
  );
  assert.strictEqual(deriveTrajectoryTimeline([], "sequence"), null);
}

// ---------- 7. inbox 状态机：谁进「本次领取」集合 ----------
//
// 这一段钉的是 steering 分类的**唯一判据**（官方 `trajectory-inbox-next-step`）。
// 最容易搬错的一处是「领取时进集合的是**被移除**的那批 id，不是 inserted 的那批」：
// 实测本机 442 份日志里 2406 次领取、每次移除 1~M 条，把这批搞反会让几乎所有人发
// 消息都被归成 steering（85%），而界面上两者长得一模一样，只有断言能拦住。
{
  const id = (value: string) => ({ id: value });
  const push = (start: number, inserted: readonly string[], extra: { outcome?: "canceled" } = {}) =>
    ({ start, inserted: inserted.map(id), ...extra });
  const claim = (start: number, removedCount: number, inserted: readonly string[] = []) =>
    ({ start, removedCount, inserted: inserted.map(id) });

  // 空起点（窗口从会话中间开始、或还没收到任何 splice）——领取取不到东西就是空集合
  const empty = applySplice(undefined, claim(0, 1));
  assert.deepStrictEqual([...empty.currentClaimed], [], "空 pending 上领取，集合为空（不抛错、不臆造）");

  // 入队两条 → 领取第一条 → 领取的是**被移除**的那条
  let state = applySplice(undefined, push(0, ["a", "b"]));
  assert.deepStrictEqual([...state.currentClaimed], [], "入队（removedCount 缺省 = 0）不改领取集合");
  state = applySplice(state, claim(0, 1, ["c"]));
  assert.deepStrictEqual([...state.currentClaimed], ["a"], "领取集合装的是被移除的那批 id");

  // 上一步的 pending 必须是 [c, b]（a 被领走、c 插在位置 0）——再领一次位置 1 取出 b
  state = applySplice(state, claim(1, 1));
  assert.deepStrictEqual([...state.currentClaimed], ["b"], "materialize 按记录的位次重放 splice 链");

  // 之后又入队 b：`withoutInserted()` 把它从领取集合里摘掉（同一条消息被重新排队）
  state = applySplice(state, push(0, ["b"]));
  assert.deepStrictEqual([...state.currentClaimed], [], "重新入队的 id 会退出领取集合");

  // `outcome: 'canceled'` 的帧**不是领取**（官方判据 `outcome !== 'canceled'`）：
  // 它照入队处理，且不许改写领取集合
  const before = applySplice(state, claim(0, 1, ["x"]));
  const canceled = applySplice(before, { ...push(0, ["y"]), outcome: "canceled", removedCount: 1 });
  assert.deepStrictEqual(
    [...canceled.currentClaimed],
    [...before.currentClaimed],
    "取消的领取不清空、也不改写「本次领取」（它只是队列被改动了一次）",
  );
}

// ---------- 8. PTC（`run_code`）：从录制的参数与调用时 schema 里读程序 ----------
//
// 这一段是官方 `tests/code-program.client.spec.ts` 的等价断言（逐条对着那份单测写），
// 本机**没有任何真实样本**——440 份会话日志、5.7 万个工具行里 `run_code` 一次都没出现，
// 所以这是这一刀唯一的防线，每条分支都得钉住。
//
// 关键词判据（官方原文）：源码与语言**都不猜**。语言只看调用时那份 schema 里
// `parameters.properties.code.description`——TypeScript 与 Python **只出现一个**才定语言，
// 两个都出现（或都不出现）一律 `undefined`。拿源码内容猜语言会在这里红。
{
  const cell = (): TrajectoryCellProps => ({
    index: 1,
    kind: "tool",
    toolName: PTC_TOOL_NAME,
    text: `${PTC_TOOL_NAME} · {}`,
    timeSeconds: 1,
    inputDetail: JSON.stringify({ code: "return 42\n", description: "Compute the answer" }),
  });
  const schemaOf = (description: string) =>
    JSON.stringify({ parameters: { properties: { code: { description } } } });

  // 程序与参数原文逐字保留
  assert.deepStrictEqual(codeProgram(cell()), {
    rawInput: cell().inputDetail,
    source: "return 42\n",
    description: "Compute the answer",
    arguments: { code: "return 42\n", description: "Compute the answer" },
    language: undefined,
  }, "没有 schema 时语言是 undefined，源码与参数原样");

  // 语言只看 schema 里那句参数描述
  assert.strictEqual(
    codeProgram({ ...cell(), schemaDetail: schemaOf("The program: the body of an async TypeScript function.") })?.language,
    "typescript",
  );
  assert.strictEqual(
    codeProgram({ ...cell(), schemaDetail: schemaOf("The program: the body of an async Python function.") })?.language,
    "python",
  );
  assert.strictEqual(
    codeProgram({ ...cell(), schemaDetail: schemaOf("A TypeScript or Python program.") })?.language,
    undefined,
    "两个都提到 → 不猜（官方判据是 typescript === python 就放弃）",
  );
  assert.strictEqual(
    codeProgram({ ...cell(), schemaDetail: schemaOf("An executable program.") })?.language,
    undefined,
  );
  for (const schemaDetail of [undefined, "{", "{}", "null", "[]"]) {
    assert.strictEqual(
      codeProgram({ ...cell(), ...(schemaDetail === undefined ? {} : { schemaDetail }) })?.language,
      undefined,
      `认不出或坏掉的 schema 一律不给语言：${String(schemaDetail)}`,
    );
  }

  // 描述缺失 / 空白 → 回落成源码第一行非空内容（**去掉首尾空白**）
  const source = "\n  const x = 1\nreturn x\n";
  for (const description of [undefined, "", "   "]) {
    const raw = JSON.stringify({ code: source, description });
    const program = codeProgram({ ...cell(), inputDetail: raw });
    assert.ok(program, `描述不可用时仍是程序：${JSON.stringify(description)}`);
    assert.strictEqual(program.source, source, "源码原样");
    assert.strictEqual(program.description, "const x = 1", "描述回落成源码第一行非空内容");
    assert.strictEqual(program.rawInput, raw, "原始参数文本原样");
    // `JSON.stringify({description: undefined})` 会把那个键整条丢掉——参数对象如实反映
    assert.deepStrictEqual(
      program.arguments,
      description === undefined ? { code: source } : { code: source, description },
    );
  }

  // 空源码与未知参数键照旧保留（原始 JSON 那一栏要看得到它们）
  assert.deepStrictEqual(
    codeProgram({ ...cell(), inputDetail: '{"code":"","extra":true}' }),
    { rawInput: '{"code":"","extra":true}', source: "", description: "", arguments: { code: "", extra: true }, language: undefined },
  );

  // 参数不完整 / 形状不对 → 整条不生效
  for (const inputDetail of [undefined, "{", "[]", "null", "42", "{}", '{"code":42}', '{"code":"x","description":[]}']) {
    const value = cell();
    if (inputDetail === undefined) delete value.inputDetail;
    else value.inputDetail = inputDetail;
    assert.strictEqual(codeProgram(value), undefined, `不支持或残缺的参数不生效：${String(inputDetail)}`);
  }

  // 判据吃的是**录制的工具元数据**，不是显示文本
  assert.strictEqual(codeProgram({ ...cell(), text: "Execute program" })?.source, "return 42\n");
  const withoutName = cell();
  delete withoutName.toolName;
  assert.strictEqual(codeProgram(withoutName), undefined, "没记下工具名就不认");
  const rawInput = ' { "code": "return 42" }\n';
  assert.strictEqual(codeProgram({ ...cell(), inputDetail: rawInput })?.rawInput, rawInput, "原始参数文本原样留着");

  // 别的工具、非工具行都不特化；子工具行同样生效
  assert.strictEqual(codeProgram({ ...cell(), kind: "message" }), undefined);
  assert.strictEqual(codeProgram({ ...cell(), toolName: "run_code_extra" }), undefined);
  assert.strictEqual(codeProgram({ ...cell(), kind: "subtool" })?.source, "return 42\n");
}

// ---------- 9. 适配层：宿主字段不许透传成 vendor 列（S01） ----------
//
// 官方 `TrajectoryCellProps` 是 32 列。本扩展的账本多出来的是**宿主语义**（`emptySummary` /
// `promptChange` / `status` / `previousPromptTools`…），它们要么由界面自己取，要么在适配层
// 合成成官方形状——**不能**原样透传成一个官方没有的键：那样上游同步时这一列会一直冒充
// 「上游字段」，而 vendor 的纯决策（折叠 / 搜索）根本不读它。
{
  const tools: TrajectoryToolSchema[] = [
    { name: "old_tool_unique", description: "被替换掉的那一份目录里的工具" },
  ];
  const hostCell: TrajectoryCell = {
    index: 1,
    kind: "system",
    turn: 1,
    seq: 7,
    time: 1_700_000_000_000,
    text: "系统提示词",
    timeSeconds: 0,
    startedAt: 1_700_000_000_000,
    previousSystemPromptDetail: "改动前的系统提示词",
    previousPromptTools: tools,
  };

  const vendored = vendorCell(hostCell);
  assert.ok(
    !Object.hasOwn(vendored, "previousPromptTools"),
    "vendor 形状不得带宿主字段 `previousPromptTools`（官方 32 列，多一列就是宿主污染）",
  );
  assert.deepStrictEqual(
    vendored.previousPromptDetail,
    { system: "改动前的系统提示词", tools },
    "被替换掉的那一份要按官方的 `{system, tools}` 快照合成，工具那一半不能丢",
  );

  // 只有工具那一半（这次更新前没有 system 文本）时也要合成，不能整份丢掉
  const toolsOnly: TrajectoryCell = { ...hostCell };
  delete toolsOnly.previousSystemPromptDetail;
  assert.deepStrictEqual(vendorCell(toolsOnly).previousPromptDetail, { tools });

  // 空数组是**有值**（「上一次的目录是空的」）：保留 `tools: []`，既不吞掉也不改判成缺席
  assert.deepStrictEqual(
    vendorCell({ ...hostCell, previousPromptTools: [] }).previousPromptDetail,
    { system: "改动前的系统提示词", tools: [] },
    "空目录要原样保留（否则「工具被全部删掉」这一行会显示成没有目录）",
  );

  // 两份都没有时不造一个空快照（官方那一列是可选）
  const noPrevious: TrajectoryCell = { ...hostCell };
  delete noPrevious.previousSystemPromptDetail;
  delete noPrevious.previousPromptTools;
  assert.ok(
    !Object.hasOwn(vendorCell(noPrevious), "previousPromptDetail"),
    "没有改动前的快照就不该合成一个空对象",
  );

  // 界面「对照」页签读的是**宿主**那一列（`Trajectory.tsx` 取 `cell.previousPromptTools`），
  // 所以合成之后宿主字段本身照旧保留；适配层只是不再把它当官方列透传。
  assert.strictEqual(hostCell.previousPromptTools, tools, "宿主字段本身不动");
}

console.log("\ntrajectory-vendor: PTC 代码程序的读取（官方单测等价断言） ✓");

console.log("\ntrajectory-vendor: all assertions passed");
