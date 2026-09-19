/**
 * 右侧轮次横条的数据层（`src/webview/turnRail.ts`）。
 *
 * 横条的刻度 = **turnOutline 投影 ∪ 已加载窗口**，合并规则必须与官方
 * `dsh-client-ui-chat` 的 `turn-rail-items.ts` 同口径：
 *
 * 1. 大纲铺底：每一轮一枚刻点（未加载 → `unloaded`，带 `turn/start` 的 seq）；
 * 2. 已加载窗口覆盖：从消息流折出「该轮第一条用户消息 = 锚点」（官方
 *    `user ?? loaded[0]`），预览取窗口自己的、空了退回大纲那份；
 * 3. 插话切分的第二段助手消息（`a:<turn>:<n>`）**不**给下一轮当锚点——
 *    它上方的用户消息是同轮插话（这是最容易写错的一条，专门断言）；
 * 4. 承重字段（turn/seq）损坏的大纲条目整条丢弃，预览损坏退空串；
 * 5. 合并时内容相同的项保引用稳定（流式期间 memo 不空转）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageView } from "../src/shared/chat";
import {
  anchorTurnIndex,
  mergeTurnRailItems,
  sameTurnRailItem,
  userPromptCount,
} from "../src/webview/turnRail";
import { reuseTurnRailItems } from "../src/webview/turnRailNav";

const user = (id: string, text: string): MessageView => ({
  id,
  role: "user",
  ts: 0,
  text,
  segments: [],
});

const assistant = (id: string, texts: string[]): MessageView => ({
  id,
  role: "assistant",
  ts: 0,
  segments: texts.map((text, index) => ({ kind: "text", id: `${id}-t${index}`, text })),
});

/** 最常见的形态：每轮一条用户消息 + 一条助手消息（纯文本）。 */
const simpleHistory: MessageView[] = [
  user("u:1", "第一轮的提问"),
  assistant("a:0", ["第一轮的回答"]),
  user("u:9", "第二轮的提问，比第一轮长得多得多得多得多得多得多得多得多得多"),
  assistant("a:1", ["第二轮的回答"]),
];

// ---------- 1. 大纲铺底：窗口外的轮次也有刻点，且是 unloaded ----------
{
  const outline = [
    { turn: 0, seq: 0, prompt: "", response: "" },
    { turn: 1, seq: 12, prompt: "", response: "" },
    { turn: 2, seq: 24, prompt: "窗口外的第三轮", response: "" },
  ];
  const items = mergeTurnRailItems(simpleHistory, outline);
  assert.strictEqual(items.length, 3, "大纲里的每一轮都要有刻点");
  assert.deepStrictEqual(
    items.map((item) => item.anchor.kind),
    ["loaded", "loaded", "unloaded"],
    "窗口内的轮次覆盖为 loaded，窗口外的保持 unloaded",
  );
  assert.deepStrictEqual(items[2].anchor, { kind: "unloaded", seq: 24 });
  assert.strictEqual(items[2].prompt, "窗口外的第三轮", "未加载轮次的预览来自大纲");
  // 升序：官方的梯子按轮号排
  assert.deepStrictEqual(
    items.map((item) => item.turn),
    [0, 1, 2],
  );
}
console.log("turnRail: 大纲铺底、窗口覆盖、升序 ✓");

// ---------- 2. 锚点归属：一条用户消息跟着它下方那条助手消息 ----------
{
  const items = mergeTurnRailItems(simpleHistory, undefined);
  assert.deepStrictEqual(items[0].anchor, { kind: "loaded", messageId: "u:1" });
  assert.deepStrictEqual(items[1].anchor, { kind: "loaded", messageId: "u:9" });
  // 锚点行就是滚动目标：索引要能从 messageId 反查轮号
  const index = anchorTurnIndex(items);
  assert.strictEqual(index.get("u:1"), 0);
  assert.strictEqual(index.get("u:9"), 1);
  assert.strictEqual(index.size, 2, "unloaded 锚点不进索引");
}
console.log("turnRail: 用户消息锚定到所属轮 ✓");

// ---------- 3. 插话切分：a:<turn>:<n> 上方的用户消息属于同一轮 ----------
//
// 会话日志的真实形态（见 dsh/adapter.ts 的插话切分）：运行中插话追加到末尾，
// 后续生成进 a:<turn>:2。这条插话**不能**被下一轮认成自己的提问。
{
  const messages: MessageView[] = [
    user("u:1", "第一轮的提问"),
    assistant("a:0", ["第一轮的回答"]),
    user("u:2", "运行中插的一句话"),
    assistant("a:0:2", ["插话后的续写"]),
    user("u:3", "第二轮的提问"),
    assistant("a:1", ["第二轮的回答"]),
  ];
  const items = mergeTurnRailItems(messages, [
    { turn: 0, seq: 0, prompt: "", response: "" },
    { turn: 1, seq: 12, prompt: "", response: "" },
  ]);
  assert.strictEqual(items.length, 2, "插话段不产生新刻点");
  assert.deepStrictEqual(items[0].anchor, { kind: "loaded", messageId: "u:1" });
  assert.deepStrictEqual(items[1].anchor, { kind: "loaded", messageId: "u:3" },
    "下一轮的锚点是自己的提问，不是上一轮的插话");
}
console.log("turnRail: 插话消息不被下一轮认领 ✓");

// ---------- 4. 预览：窗口自己的优先、空了退回大纲；响应取最后一段正文 ----------
{
  const items = mergeTurnRailItems(simpleHistory, [
    { turn: 0, seq: 0, prompt: "大纲里的旧预览", response: "大纲里的旧响应" },
    { turn: 1, seq: 12, prompt: "", response: "" },
  ]);
  assert.strictEqual(items[0].prompt, "第一轮的提问", "已加载窗口的预览优先");
  assert.strictEqual(items[0].response, "第一轮的回答");
  const longPrompt = "请把启动逻辑收敛到一个入口里，" + "顺带补上回归测试与说明文档。".repeat(3);
  assert.ok(longPrompt.length > 50, "夹具本身要超过预览上限（现在是 " + String(longPrompt.length) + "）");
  const longTurn = mergeTurnRailItems([user("u:1", longPrompt), assistant("a:0", ["好"])], undefined);
  assert.strictEqual(longTurn[0].prompt, longPrompt.replace(/\s+/g, " ").slice(0, 49) + "…",
    "提示词预览超长时截到 49 字 + 省略号（与官方 preview() 同口径）");
  assert.strictEqual(longTurn[0].prompt.length, 50, "截断后的总长不超过 50");

  // 整轮没有正文的助手消息：响应预览退回大纲那份，不能是「上一轮的」
  const silentTurn: MessageView[] = [user("u:1", "问"), assistant("a:0", [])];
  const withOutline = mergeTurnRailItems(silentTurn, [
    { turn: 0, seq: 0, prompt: "", response: "大纲记得它说过什么" },
  ]);
  assert.strictEqual(withOutline[0].response, "大纲记得它说过什么");

  // 多段正文（中途正文 + 最终回答）：响应预览取**最后一段**（官方 findLast）
  const multiPart: MessageView[] = [
    user("u:1", "问"),
    assistant("a:0", ["中途的话", "最终回答"]),
  ];
  assert.strictEqual(mergeTurnRailItems(multiPart, undefined)[0].response, "最终回答");
}
console.log("turnRail: 预览的来源与上限 ✓");

// ---------- 5. 容忍度：承重字段损坏的大纲条目整条丢弃 ----------
{
  const items = mergeTurnRailItems(simpleHistory, [
    // 已加载的轮 0/1 先被大纲确认（真实会话里它们一定有 turn/start）
    { turn: 0, seq: 0, prompt: "", response: "" },
    { turn: 1, seq: 12, prompt: "", response: "" },
    { turn: -1, seq: 0, prompt: "负轮号", response: "" },
    { turn: 5, seq: -2, prompt: "负 seq", response: "" },
    { turn: 6, seq: Number.NaN, prompt: "非安全整数", response: "" },
    { turn: 7, seq: 1.5, prompt: "小数 seq", response: "" },
    // 预览字段不是字符串（服务端抽风时）：退成空串，轮次照样可按序号导航
    { turn: 8, seq: 48, prompt: "只有这条活着", response: null as unknown as string },
  ]);
  // simpleHistory 自己带着轮 0/1（loaded），加幸存的轮 8，共 3 枚刻点
  assert.strictEqual(items.length, 3, "4 条损坏的大纲条目被丢弃");
  assert.deepStrictEqual(
    items.map((item) => item.turn),
    [0, 1, 8],
  );
  assert.strictEqual(items[2].turn, 8);
  assert.strictEqual(items[2].prompt, "只有这条活着");
  assert.strictEqual(items[2].response, "", "预览字段类型不对退化成空串，不影响可导航");
}
console.log("turnRail: 损坏条目整条丢弃、可导航性不受影响 ✓");

// ---------- 6. 无大纲（老服务端没挂投影）→ 只显示已加载轮次 ----------
{
  const items = mergeTurnRailItems(simpleHistory, undefined);
  assert.strictEqual(items.length, 2);
  assert.ok(items.every((item) => item.anchor.kind === "loaded"));
  // 没有任何轮次（空会话）→ 空数组（横条整个不渲染）
  assert.deepStrictEqual(mergeTurnRailItems([], undefined), []);
}
console.log("turnRail: 无投影回退已加载轮次、空会话为空 ✓");

// ---------- 7. 引用稳定：内容相同的项复用旧引用（reuseTurnRailItems） ----------
//
// 流式期间每个 token 都换消息数组；不保引用的话 memo 过的横条每个 token 都重渲染。
{
  const first = mergeTurnRailItems(simpleHistory, undefined);
  const streamed: MessageView[] = [
    ...simpleHistory.slice(0, -1),
    { ...assistant("a:1", ["第二轮的回答"]), streaming: true, segments: [{ kind: "text", id: "t", text: "第二轮的回答还在变" }] },
  ];
  const second = reuseTurnRailItems(first, mergeTurnRailItems(streamed, undefined));
  assert.strictEqual(second[0], first[0], "没变的轮次必须复用旧引用");
  assert.notStrictEqual(second[1], first[1], "预览真变了的轮次换新对象");

  // 什么都没变时整个数组都复用（外层 useMemo 的比较靠它短路）
  const untouched = reuseTurnRailItems(first, mergeTurnRailItems(simpleHistory, undefined));
  assert.strictEqual(untouched, first, "输入没变要返回**旧数组本身**");

  // 「内容相同」的判定本身：sameTurnRailItem 是复用的判据
  const sameInputAgain = mergeTurnRailItems(simpleHistory, undefined);
  assert.ok(first.every((item, i) => sameTurnRailItem(item, sameInputAgain[i])));
  assert.ok(!sameTurnRailItem(first[0], first[1]), "不同轮次的内容判定为不同");
}
console.log("turnRail: 相同内容保引用稳定（流式不空转） ✓");

// ---------- 8. 没有用户消息的轮次：锚点兜底落到该轮第一条助手消息 ----------
//
// 官方口径 `user ?? loaded[0]`：纯注入触发的轮（比如 goal 驱动的自动轮）没有
// 用户消息，也要有一枚能跳的刻点。
{
  const messages: MessageView[] = [
    assistant("a:0", ["自动轮的回答"]),
    user("u:1", "第二轮的提问"),
    assistant("a:1", ["第二轮的回答"]),
  ];
  const items = mergeTurnRailItems(messages, undefined);
  assert.deepStrictEqual(items[0].anchor, { kind: "loaded", messageId: "a:0" });
}
console.log("turnRail: 无用户消息的轮次锚到助手消息 ✓");

// ---------- 9. 幻影轮 0 被挡掉：大纲是轮次边界的权威 ----------
//
// 用户 2026-09-18 报的 bug：「即便用户只发了一次消息也有第0轮」。
//
// 根因在本地消息流这一侧：服务端**从 1 起**编轮号（harness 自家投影 spec 的第一轮
// 就是 `turn/start {turn: 1}`），而适配器的 `ensureAssistantMessage` 用
// `currentTurn ?? 0` 兜底——首个 `turn/start` 之前到达的**斜杠命令行**（`command/run`
// → `upsertCommandRun`）或**系统提示词注入**（`system/message` → `pushInjected`）会
// 拼出一条 id 为 `a:0` 的助手消息。它不是一轮，只是「第一轮之前的内容」。
//
// 判据：每个**真实**轮都有 `turn/start` ⟹ 都在 `turnOutline` 里；已加载轮次必须被
// 大纲确认，本地拼出来的 `a:0` 于是整轮消失。一条消息的会话因此只剩 1 枚刻点，
// 显示判据（用户消息 ≥ 2）再把它整个收起来。
{
  // 一条用户消息的真实会话：先有注入/命令行拼出的 a:0，再有真正的第 1 轮
  const messages: MessageView[] = [
    assistant("a:0", []),
    user("u:1", "把这两个文件的启动逻辑合并到一个入口"),
    assistant("a:1", ["我看了两个文件…"]),
  ];
  const outline = [
    { turn: 1, seq: 3, prompt: "把这两个文件的启动逻辑合并到一个入口", response: "我看了两个文件…" },
  ];
  const items = mergeTurnRailItems(messages, outline);
  assert.strictEqual(items.length, 1, "幻影轮 0 必须被挡掉，只留真实的第 1 轮");
  assert.strictEqual(items[0].turn, 1);
  assert.deepStrictEqual(items[0].anchor, { kind: "loaded", messageId: "u:1" },
    "真实轮的锚点仍是那条用户消息");
  assert.strictEqual(userPromptCount(items), 1, "一条用户消息 → 只有 1 条提示词，横条不显示");

  // 两轮的真实会话：幻影轮照样被挡，两条用户消息都在
  const twoTurns: MessageView[] = [
    assistant("a:0", []),
    user("u:1", "第一问"),
    assistant("a:1", ["第一答"]),
    user("u:2", "第二问"),
    assistant("a:2", ["第二答"]),
  ];
  const shown = mergeTurnRailItems(twoTurns, [
    { turn: 1, seq: 3, prompt: "第一问", response: "第一答" },
    { turn: 2, seq: 20, prompt: "第二问", response: "第二答" },
  ]);
  assert.deepStrictEqual(shown.map((item) => item.turn), [1, 2]);
  assert.strictEqual(userPromptCount(shown), 2, "两条用户消息 → 横条显示");

  // 大纲说「一轮都没有」（只有命令行 / 注入、还没发过消息）→ 一枚刻点都不留
  assert.deepStrictEqual(mergeTurnRailItems([assistant("a:0", [])], []), []);

  // 大纲缺席（老服务端没挂投影）时无从确认，退回已加载轮次（幻影轮仍可能出现——
  // 那条路上没有权威可依，但显示判据要求 ≥2 条用户消息，一条消息的会话照样不显示）
  const fallback = mergeTurnRailItems(messages, undefined);
  assert.deepStrictEqual(fallback.map((item) => item.turn), [0, 1]);
  assert.strictEqual(userPromptCount(fallback), 1);
}
console.log("turnRail: 幻影轮 0 被大纲挡掉、单消息会话不显示 ✓");

// ---------- 10. 显示判据的用户消息计数 ----------
//
// 「用户消息 ≥ 2 且宽度足够才显示横条」里那个数：带提示词预览的轮数。自动轮
// （goal 驱动、纯注入）没有提示词，不计入——它们不是"用户说的话"。
{
  assert.strictEqual(userPromptCount([]), 0);
  assert.strictEqual(
    userPromptCount([{ turn: 1, prompt: "", response: "自动轮", anchor: { kind: "loaded", messageId: "a:1" } }]),
    0,
    "自动轮不计入用户消息数",
  );
  assert.strictEqual(
    userPromptCount([
      { turn: 1, prompt: "问过了", response: "", anchor: { kind: "loaded", messageId: "u:1" } },
      { turn: 2, prompt: "", response: "自动轮", anchor: { kind: "loaded", messageId: "a:2" } },
      { turn: 3, prompt: "又问", response: "", anchor: { kind: "unloaded", seq: 40 } },
    ]),
    2,
    "已加载与未加载的提示词都算（窗口外的大纲预览同样有提示词）",
  );
}
console.log("turnRail: 显示判据的用户消息计数 ✓");

// ---------- 11. 跳转的滚动语义：显式放跟随 —— 接线 ----------
//
// 跳进历史位置 = 离开实况尾部。**程序化滚动不算手势**（`autoScroll.ts` 的意愿只由
// 手势翻），所以跳转必须有一条显式通道把"跟随最新"放掉：不放的话下一次 settle 会把
// 视口钉回底部，跳转等于没跳（官方 TurnNavigator 同一条注释）。
//
// 「放掉之后确实不钉底」的行为断言在 `scripts/autoScroll.test.ts`（真调用）；
// 这里只钉**接线**：横条拿到的是 `autoScroll` 模块产出的那个动作，且两个分支都先放后跳。
{
  const nav = readFileSync(join(process.cwd(), "src", "webview", "turnRailNav.ts"), "utf8");
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");

  assert.ok(
    /releaseFollow: \(\) => void;/.test(nav),
    "横条的胶水要接一个「放掉跟随」的入口（程序化滚动不算手势，不给这条通道就跳不动）",
  );
  assert.ok(
    /releaseFollow: chatScroll\.releaseFollow,/.test(app),
    "App 要从 autoScroll 模块的绑定里取放跟随动作给横条（不再自己拼一个 useCallback）",
  );

  // 两个跳转分支：① 窗口外先放跟随再取历史；② 已加载先放跟随再落位。
  // 放跟随必须在**落位之前**（顺序反了的话，落位那一下又被钉回底部）。
  const unloadedAt = nav.indexOf("if (item.anchor.kind === \"unloaded\")");
  const releaseInUnloaded = nav.indexOf("releaseRef.current?.();", unloadedAt);
  const loadAt = nav.indexOf("loadEarlierRef.current?.();", unloadedAt);
  assert.ok(unloadedAt > 0 && releaseInUnloaded > unloadedAt, "窗口外那个分支要先显式放跟随");
  assert.ok(
    releaseInUnloaded < loadAt,
    "窗口外的跳转顺序必须是：放跟随 → 取历史（反了的话连取期间的 prepend 补偿会被 settle 当成布局事故拉回底部）",
  );

  const loadedAt = nav.indexOf("const row = anchorElement(list, item.anchor.messageId);", releaseInUnloaded);
  const releaseInLoaded = nav.indexOf("releaseRef.current?.();", loadedAt);
  const landAt = nav.indexOf("landOnRow(el, row, item.turn, setActiveTurnStable);", loadedAt);
  assert.ok(loadedAt > 0 && releaseInLoaded > loadedAt && landAt > releaseInLoaded, "已加载那个分支要先显式放跟随再落位");

  assert.ok(
    nav.indexOf("if (running || !hasMoreHistory) return;", unloadedAt) < releaseInUnloaded,
    "no-op 的点击（生成中 / 没有更早历史）不许顺手把实况跟开关掉：防御判断必须在放跟随**之前**",
  );
}
console.log("turnRail: 跳转先放跟随再落位（接线）✓");
