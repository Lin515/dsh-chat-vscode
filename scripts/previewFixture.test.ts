// 一次性夹具体检：确认 test/preview.html 的 state 字面量能被真正求值，
// 且新加的界面形态都在。
//
// 为什么值得单独跑：预览夹具是**手工维护**的对象字面量，重复的键（JS 里不报错，
// 后者覆盖前者）或语法错都会让预览静默显示旧内容——调样式时照着假数据调，
// 这正是文档里记过的坑（`test/preview.html` 曾编过 5 个思考档位）。
import { readFileSync } from "node:fs";
import { foldTurnProcess } from "../src/webview/turnProcess";
import { fileLinkPort } from "../src/webview/fileLinks";
import { pickLocalizedText } from "../src/shared/localizedText";
import type { AppState } from "../src/webview/state";

const html = readFileSync("test/preview.html", "utf8");

// 1) 抽出 __buildState 的函数体并求值（它不依赖 DOM，只读闭包外的 now/codeSample）
const fnStart = html.indexOf("window.__buildState = function");
if (fnStart < 0) throw new Error("找不到 window.__buildState —— 夹具结构变了");
const bodyStart = html.indexOf("{", fnStart);
// 用花括号配平找到函数结尾（字符串里的花括号也要跳过）
let depth = 0;
let end = -1;
let inString = null;
for (let i = bodyStart; i < html.length; i += 1) {
  const ch = html[i];
  if (inString) {
    if (ch === "\\") i += 1;
    else if (ch === inString) inString = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    inString = ch;
    continue;
  }
  if (ch === "{") depth += 1;
  else if (ch === "}") {
    depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) throw new Error("__buildState 的花括号不配平 —— 夹具语法有问题");
const source = html.slice(bodyStart, end + 1);

/**
 * 真实夹具接线那段（`// ==== trajectory-fixture-wiring:start ====` 到 `:end`）。
 *
 * 它被单独抽出来求值：`__buildState` 现在最后一行调用 `applyTrajectoryFixture(...)`，
 * 那个函数**不碰 `location` / `fetch`**（装载器在页面顶部另一段里），所以这里能把
 * 「真实夹具怎么进 state」整条链路按真实代码求值，不必起浏览器。
 */
const wiringStart = html.indexOf("// ==== trajectory-fixture-wiring:start ====");
const wiringEnd = html.indexOf("// ==== trajectory-fixture-wiring:end ====");
// **不在这里抛**：接线没落地时下面第 5 段要以**断言失败**的形式报出来，而不是让整个
// 测试文件在求值期崩掉——红必须落在断言上（见 AGENTS.md 的注入式回归纪律）。
const wiringPresent = wiringStart >= 0 && wiringEnd > wiringStart;
const wiringSource = wiringPresent ? html.slice(wiringStart, wiringEnd) : "";


// `now` / `codeSample` / `locale` 是 script 顶层的变量：一并求值。
// `locale` 来自 `location.search`（预览页支持 `?locale=en` 切换语言），
// 无头环境里没有 location，所以这里也把它参数化——顺带能**两种语言都体检一遍**。
// `previewImageDataUrl` 同理：夹具里图片附件的 data URL 在预览页由一段内联 SVG 算出来，
// 而 `__buildState` 在 Node 里求值时不带那段脚本（所以它**不能**引用 `document`）。
//
// `window` 也必须注入：接线块里只读 `window.__trajectoryFixtures` 这一份内存表
// （真实夹具的装载器在页面顶部另一段里，`__buildState` 自己不 fetch）。
//
// **返回类型写成生产的 `AppState`，不是 `any`**：求值出来的是手写对象字面量，只有按视图
// 模型定型，`state.messages[].segments` 这类深链才有上下文类型——否则每个回调形参都是隐式
// `any`（本文件曾因此带 50 处 `noImplicitAny`，也因此一直进不了 typecheck）。定型之后
// 「夹具字段与生产视图模型脱节」会在 `npm run typecheck` 里直接报出来。
const codeSample = "export function bootstrap() {\n  // …\n}";
const previewImageDataUrl = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
function evaluateStateBuilder() {
  return new Function(
    "now",
    "codeSample",
    "location",
    "previewImageDataUrl",
    "window",
    `return (function () { ${wiringSource}\n return (function () ${source})(); })();`,
  ) as (
    now: number,
    codeSample: string,
    location: { search: string },
    previewImageDataUrl: string,
    window: unknown,
  ) => AppState;
}

/** 一次求值 = 一份夹具内存表（装载器还没跑完时给空表）。 */
function buildStateWith(locale: "zh-cn" | "en", extraQuery = "", fixtures: Record<string, unknown> = {}): AppState {
  const build = evaluateStateBuilder();
  return build(
    Date.now(),
    codeSample,
    { search: `?locale=${locale}${extraQuery}` },
    previewImageDataUrl,
    { __trajectoryFixtures: fixtures },
  );
}

// ---------- 真实夹具（`test/fixtures/trajectory/`）的装载与事实 ----------

/**
 * 预览页声明的真实夹具清单（从页面源码里读，不是这里另抄一份）。
 *
 * 读页面**声明**而不是自己写死路径：这样「页面接了哪三份夹具」与「磁盘上真有那三份」
 * 由同一条断言比对，页面漏接或路径打错都会红。
 */
const fixtureManifest: { name: string; path: string }[] = (() => {
  if (!wiringPresent) return [];
  const at = html.indexOf("window.__trajectoryFixturePaths = {");
  // 同样**不抛**：清单缺失由下面第 5 段的断言报出
  if (at < 0) return [];
  const open = html.indexOf("{", at);
  const close = html.indexOf("};", open);
  if (open < 0 || close < 0) return [];
  const body = html.slice(open + 1, close);
  return [...body.matchAll(/([A-Za-z][\w-]*)\s*:\s*"([^"]+)"/g)].map((match) => ({
    name: match[1],
    path: match[2],
  }));
})();

const realFixtureNames = fixtureManifest.map((entry) => entry.name);

/** 读一份真实夹具；不存在 / 坏 JSON / 没声明 → `undefined`（由断言判红，不抛）。 */
function realFixture(name: string): any {
  const entry = fixtureManifest.find((item) => item.name === name);
  if (entry === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(`test/${entry.path}`, "utf8")) as any;
  } catch {
    return undefined;
  }
}

/** 一份夹具模型的账本行（按组摊平）。 */
function realFixtureCells(payload: any): { kind: string; toolName?: string }[] {
  return (payload?.model?.turns ?? []).flatMap(
    (turn: { groups: { cells: { kind: string; toolName?: string }[] }[] }) =>
      turn.groups.flatMap((group) => group.cells),
  );
}

/**
 * 把一份真实夹具按页面自己的接线逻辑装进 state（不经 `fetch`）。
 *
 * 返回 `{ state, info }`：`state` 是**生产 State**（真实装载器只改 `panel` 与 `trajectory`），
 * `info` 是**预览专用**的来源标记——页面把它放在 `window.__trajectoryFixtureInfo` 上，
 * **不进 State、不过 JSON wire**。这里按同一形状造一份，用来断言两边都不越界。
 */
function realFixtureState(name: string) {
  const payload = realFixture(name);
  const path = fixtureManifest.find((item) => item.name === name)?.path;
  const ready: Record<string, unknown> = {
    [name]: { status: "ready", path, provenance: payload?.provenance, model: payload?.model },
  };
  const state = buildStateWith("zh-cn", `&trajectory=${name}`, ready);
  return {
    state,
    info: {
      name,
      synthetic: false,
      unavailable: false,
      path,
      payloadReduced: payload?.provenance?.payloadReduced === true,
      payloadMeasurementEligible: payload?.provenance?.payloadMeasurementEligible === true,
      cellCount: payload?.model?.cellCount ?? null,
    },
  };
}

const state = buildStateWith("zh-cn");

// 2) 结构断言
//
// 定型成**二元组数组**：不写这个标注时，TS 会把整份字面量推成「若干 `(string | 函数)[]`
// 的联合」，循环里的 `check` 于是成了 `string | (() => …)` 而报「不可调用」。
const must: [string, () => unknown][] = [
  ["goal 目标条", () => state.goal?.objective],
  ["contextOccupancy 占用环", () => state.contextOccupancy?.percent],
  // 工具栏那枚 tps 胶囊的样例：没有会话统计时它整个不进候选表（缺数据的档位不进表），
  // 预览页就永远看不到 P1 里那一档，宽度阶梯也就少一级。
  [
    "会话统计（tps 胶囊）",
    () => (state.sessionStats?.decodeTokens ?? 0) > 0 && (state.sessionStats?.decodeMs ?? 0) > 0,
  ],
  ["hasMoreHistory 加载更早", () => state.hasMoreHistory === true],
  ["附件：图片内容块", () => state.attachments?.some((a) => a.kind === "image" && a.dataUrl)],
  ["附件：上传中", () => state.attachments?.some((a) => a.upload?.status === "uploading")],
  ["附件：上传失败", () => state.attachments?.some((a) => a.upload?.status === "error")],
  ["命令节点", () => state.messages.some((m) => m.segments.some((s) => s.kind === "command"))],
  ["轮尾 produced", () => state.messages.some((m) => m.produced?.length)],
  ["轮尾 deliverables", () => state.messages.some((m) => m.deliverables?.length)],
  // 用户消息里的图片：**两种形态都要有**——拿到字节的画缩略图，没拿到的退回文件名
  // 芯片。只有一种的话，预览页看不出「字节未到时不画碎图」这条降级
  [
    "用户消息里的图片（真图 + 字节未到）",
    () =>
      state.messages.some((m) => m.attachments?.some((a) => a.kind === "image" && a.dataUrl)) &&
      state.messages.some((m) => m.attachments?.some((a) => a.kind === "image" && !a.dataUrl)),
  ],
  // 正文里的图片：本地路径（交给宿主读盘）与外链（浏览器直连）两种引用，
  // 外加一条读不到的路径（验证降级文案）
  [
    "正文里的图片引用（本地 + 外链）",
    () => {
      const texts = state.messages.flatMap((m) =>
        m.segments.flatMap((s) => (s.kind === "text" ? [s.text] : [])),
      );
      return (
        texts.some((text) => /!\[[^\]]*\]\(\.\/out\/chart\.png\)/.test(text)) &&
        texts.some((text) => /!\[[^\]]*\]\(https:\/\//.test(text))
      );
    },
  ],
  // 正文里的**文件链接**：两种形态都要在夹具里，否则预览页看不出「哪些文字点得开、
  // 哪些保持惰性代码」。判定用界面侧真的那份纯函数（不是「文本里有没有反引号」那种
  // 间接证据）：行内代码 token 必须真能在**这一轮的词表**里命中，否则预览页上一个
  // 可点的都没有，调样式时看到的是假象。
  [
    "正文里的文件链接（markdown 链接 + 命中的行内代码 + 命中的例外）",
    () => {
      type Seg = { kind: string; text?: string };
      type Produced = { path: string; argumentPath?: string };
      type Msg = { produced?: Produced[]; deliverables?: { path: string }[]; streaming?: boolean; segments: Seg[] };
      const textsOf = (m: Msg): string[] =>
        m.segments.flatMap((s) => (s.kind === "text" && s.text ? [s.text] : []));
      const tokensOf = (text: string): string[] =>
        [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
      // 词表按**消息**算（界面就是这么算的：`produced ∪ deliverables` 去重后再判）。
      // 全局拼一起会把别的轮次的同名文件算进来——`config.ts` 因此在两处各出现一次、
      // 被判成「同名歧义」，判定跟着失真。produced 的操作保留参数别名。
      const portOf = (m: Msg) =>
        fileLinkPort(
          m.produced ?? [],
          (m.deliverables ?? []).map((file) => file.path),
        );
      const allTexts = state.messages.flatMap((m: Msg) => textsOf(m));
      const hasLineLink = allTexts.some((text: string) => /\]\([^)\s]+#L\d+\)/.test(text));
      const resolved = state.messages.some((m: Msg) => {
        const port = portOf(m);
        return textsOf(m).some((text) =>
          tokensOf(text).some((token) => port.resolve(token) !== undefined),
        );
      });
      // 点不开的那些也要留着：夹具里全是可点的，就看不出「对不上就不猜」这条口径
      const inert = state.messages.some((m: Msg) =>
        textsOf(m).some((text) =>
          tokensOf(text).some((token) => portOf(m).resolve(token) === undefined),
        ),
      );
      return hasLineLink && resolved && inert;
    },
  ],
  // 用户消息里的 `@` 引用：**两种来路**都要在夹具里，否则预览页看不出它们的分界
  // （长得一模一样，只有悬停说明与点击目标不同）。目录 / 文件那种走草稿里的 `@path`
  // 与正文里的 `@path`；**已发出的会话引用**正文里只剩 `@标题`，靠召回清单
  // （`sessionRefs`）才认成会话——用户 2026-10-10 报的「发出去的会话引用被识别为文件
  // 链接」就是这个形态。判据要连**正文里真有那个 `@标题`** 一起看：清单与正文对不上的
  // 夹具（标题改了、正文没改）在预览里什么都演示不出来。
  [
    "用户消息里的 @ 引用（含已发出的会话引用）",
    () => {
      type RefMsg = { sessionRefs?: { label: string; sessionId?: string }[]; text?: string };
      return state.messages.some((m: RefMsg) => {
        const refs = m.sessionRefs ?? [];
        return refs.length > 0 && refs.every((ref) => (m.text ?? "").includes(`@${ref.label}`));
      });
    },
  ],
  // agent 交付的图片文件（present 申报 / 本轮 write 出来）：这两条路**没有** markdown
  // 引用，界面上要另外画成图——用户 2026-09-18 报的「agent 发来的图看不到」正是这个
  [
    "交付/生成的图片文件",
    () =>
      state.messages.some((m) =>
        (m.deliverables ?? []).some((file) => /\.(png|jpe?g|webp|gif|svg)$/i.test(file.path)),
      ),
  ],
  // 助手消息里的图片块（`images` 段）：此前 image 块被静默丢弃，夹具要留住这个形态
  ["助手消息里的图片", () => state.messages.some((m) => m.segments.some((s) => s.kind === "images"))],
  // **工具结果里的图片**（`read_image` / 截图回带的 image 块，落在 `tool.images`）：
  // 这条渲染路径此前在预览页**没有任何样例**，于是「图藏在工具行展开体里」这件事
  // 一直没被看见（用户 2026-09-18 报「agent 发来的我看不到」）
  [
    "工具结果里的图片",
    () =>
      state.messages.some((m) =>
        m.segments.some((s) => s.kind === "tool" && (s.tool.images?.length ?? 0) > 0),
      ),
  ],
  // 用户消息的操作行（时钟 + 复制）：**常驻**显示（不再靠悬停揭示），DOM 里必须在
  ["用户消息操作行", () => state.messages.some((m) => m.role === "user")],
  // 超过 5 行的用户消息：默认收缩 + 「展开 / 收起」。夹具要留一条长的，
  // 否则预览页看不到那枚按钮（判定按实测渲染高度，不看换行符）
  [
    "长用户消息（默认收缩）",
    () => state.messages.some((m) => m.role === "user" && (m.text ?? "").split("\n").length > 5),
  ],
  // 乐观回显（`PendingMessageView`）：两种形态都要留样例——一条还在飞的（带附件，
  // 看的是「图片立刻画出来」）、一条失败的（红框 + 重发 / 撤回 + 原因）。
  // 账本里只有「已经发出去」的那一类，所以这里不再有「排队中的那条不画」这一档：
  // 排队 / 插话的消息压根不进账本（它们在下面 `__composer` 的服务端队列项里）。
  [
    "乐观回显（带图的一条 + 失败红框的一条 + 失败行带落位锚点）",
    () => {
      const transcript = state.pendingMessages.some(
        (echo: { status?: string; attachments?: unknown[] }) =>
          echo.status === "sending" && (echo.attachments?.length ?? 0) > 0,
      );
      const failed = state.pendingMessages.some(
        (echo: { status?: string; error?: string }) =>
          echo.status === "failed" && Boolean(echo.error),
      );
      // 失败行要带一个**能对上的**锚点：预览页才能看出「插回原地」与「排到最底部」的差别
      const anchored = state.pendingMessages.some(
        (echo: { status?: string; anchor?: string }) =>
          echo.status === "failed" &&
          Boolean(echo.anchor) &&
          state.messages.some((message: { id: string }) => message.id === echo.anchor),
      );
      return transcript && failed && anchored;
    },
  ],
  // 轨迹账本：七种记录要留够形态，否则预览页看不到种类标签/检查器页签/折叠行的差别
  [
    "轨迹账本（六种记录 + 系统提示词更新）",
    () => {
      const kinds = new Set(
        (state.trajectory?.turns ?? []).flatMap(
          (turn: { groups: { cells: { kind: string }[] }[] }) =>
            turn.groups.flatMap((group) => group.cells.map((cell) => cell.kind)),
        ),
      );
      return ["system", "user", "message", "tool", "subtool", "compacted", "context"].every((kind) =>
        kinds.has(kind),
      );
    },
  ],
  [
    "轨迹账本：序号连续、工具行带结果",
    () => {
      const cells = (state.trajectory?.turns ?? []).flatMap((turn) =>
        turn.groups.flatMap((group) => group.cells));
      const sequential = cells.every((cell, position) => cell.index === position + 1);
      return sequential && cells.some((cell) => cell.kind === "tool" && cell.result);
    },
  ],
  // 检查器的「Schema」页签：夹具必须留一条**能解析**的 `schemaDetail`，否则预览页永远显示
  // 「Schema 不可用」，调那一页的样式时看到的是空态。判据与界面侧 `parseToolSchema()` 一致
  // ——`{name, description, parameters}` 三样缺一不可，解析不出就退回显示原文。
  [
    "轨迹账本：工具行带可解析的 schemaDetail",
    () => {
      const cells = (state.trajectory?.turns ?? []).flatMap(
        (turn: { groups: { cells: { kind: string; schemaDetail?: string }[] }[] }) =>
          turn.groups.flatMap((group) => group.cells),
      );
      const schema = cells.find(
        (cell: { kind: string; schemaDetail?: string }) => cell.kind === "tool" && cell.schemaDetail,
      )?.schemaDetail;
      if (typeof schema !== "string") return false;
      const parsed = JSON.parse(schema) as { name?: unknown; description?: unknown; parameters?: unknown };
      return (
        typeof parsed.name === "string"
        && typeof parsed.description === "string"
        && typeof parsed.parameters === "object"
        && parsed.parameters !== null
      );
    },
  ],
  // 被中断的记录：夹具要留一条带 `@interrupted` 的，检查器错误行的换成文案那条路径
  // 才有得看（那是个宿主记号，原样渲染出来是内部符号）。
  [
    "轨迹账本：留一条被中断的记录（错误行的记号）",
    () => {
      const cells = (state.trajectory?.turns ?? []).flatMap(
        (turn: { groups: { cells: { error?: string }[] }[] }) =>
          turn.groups.flatMap((group) => group.cells),
      );
      return cells.some((cell: { error?: string }) => cell.error === "@interrupted");
    },
  ],
  // PTC（`run_code`）**没有真实样本**：本轮三份真实夹具（小 / 长 / v4 压缩）里
  // `run_code` 都是 0 例（`provenance.capabilities` 不含它），所以预览页**不留合成行**
  // ——造一条假的 PTC 输出会让人把「编的」当成「真实出现过的形态」。
  // 这里钉的就是这条**缺席契约**（渲染口径由 `scripts/trajectoryDisplay.test.ts` 与
  // `scripts/trajectoryVendor.test.ts` 的契约用例覆盖，不靠预览页）；有真实样本后，
  // 这条应改成「真实夹具里出现 run_code」并要求它来自 `?trajectory=<名>`。
  [
    "轨迹账本：没有真实 run_code 样本时不留合成 PTC 行（缺席契约）",
    () => {
      const fromPreview = (state.trajectory?.turns ?? []).flatMap(
        (turn: { groups: { cells: { kind: string; toolName?: string }[] }[] }) =>
          turn.groups.flatMap((group) => group.cells),
      );
      const fromFixtures = realFixtureNames.flatMap((name) =>
        realFixtureCells(realFixture(name)).filter((cell) => cell.toolName === "run_code"),
      );
      // 预览页里不能有任何 run_code 行；三份真实夹具里也没有 —— 两边一致才叫「没有样本」
      return fromPreview.every((cell) => cell.toolName !== "run_code") && fromFixtures.length === 0;
    },
  ],
  // 账本虚拟化的**行数阈值**：合成账本已经不再背长账本（真实长夹具顶替了它），
  // 所以这里改成两个来源合起来判——默认合成账本 + 三份真实夹具里的任意一份，
  // 只要有越过阈值 100 的，预览页就有得量。
  [
    "轨迹长账本：默认合成账本 + 真实夹具里存在越过虚拟化阈值（>100 行）的素材",
    () => {
      const syntheticRows = (state.trajectory?.turns ?? []).flatMap(
        (turn: { groups: { cells: unknown[] }[] }) => turn.groups.flatMap((group) => group.cells),
      );
      const longestReal = realFixtureNames.reduce(
        (longest, name) => Math.max(longest, realFixtureCells(realFixture(name)).length),
        0,
      );
      return longestReal > 100 || syntheticRows.length > 100;
    },
  ],
  // 分组形状（`TrajectoryGroup`）：三种组标题都要出现，界面侧的落点/摘要/搜索才有东西可查
  [
    "轨迹账本：三种组（消息 / 步骤 / 压缩）",
    () => {
      const titles = new Set(
        (state.trajectory?.turns ?? []).flatMap(
          (turn: { groups: { title: { kind: string } }[] }) =>
            turn.groups.map((group) => group.title.kind),
        ),
      );
      return ["message", "step", "compaction"].every((kind) => titles.has(kind));
    },
  ],
  // 轮尾「用时 X」胶囊：turn/end 才写入的 turnStats
  ["轮尾用时胶囊", () => state.messages.some((m) => (m.turnStats?.ranForMs ?? 0) > 0)],
  // 连续过程折叠：预览页必须真能看到折叠按钮，否则调样式时看不出效果。
  // 判定直接跑界面侧的纯函数（不是「有没有带 step 的段」那种间接证据）：用户 2026-09-16
  // 收敛后的口径是「**只留本轮最后一段正文**，其余全折」——a:1 里最后那段正文是脚注那段
  // （`fn1`），它前面的一切（中途正文 t1 / t1b / t2 / c1、提示 retry1、六条上下文注入、
  // 两条命令节点、12 次工具调用）合成一枚按钮；`fn1` 之后的图片段只有 0 次工具 → 平铺。
  // 按钮文案要同时报出工具调用数与**中途消息条数**（用户当天又报「只显示工具调用次数」）。
  // 夹具必须留住这个形态，否则预览页看不到折叠效果。
  [
    "连续过程折叠（只留最后一段正文 + 三段计数）",
    () => {
      const message = state.messages.find((m: { id: string }) => m.id === "a:1");
      if (!message) return false;
      const fold = foldTurnProcess(message.segments, !message.streaming);
      const run = fold.runs[0];
      return (
        fold.runs.length === 1 &&
        run?.anchorId === "r1" &&
        run.segments.length === 27 &&
        run.counts.toolCalls === 12 &&
        run.counts.messages === 4 &&
        run.counts.subagents === 0 &&
        // 中途正文、提示、注入、命令都在按钮里
        ["t1", "t1b", "t2", "c1", "retry1", "inj1", "cmd1"].every((id) => fold.bySegment.has(id)) &&
        // 最后那段正文留在流里；它后面的图片段（0 次工具）平铺
        !fold.bySegment.has("fn1") &&
        !fold.bySegment.has("img1")
      );
    },
  ],
  // 认不出的内容块（官方 default 分支）：夹具要留一个，否则预览页看不到它
  ["未知内容块记录", () => state.messages.some((m) => m.segments.some((s) => s.kind === "unknown"))],
  // 上下文条目的结构化字段（官方按 form 分派正文的依据）：三种 form 各留一条，
  // 否则预览页只能看到「正文」，看不出 per-form 正文有没有生效
  [
    "上下文 per-form 字段（changes/entries/references）",
    () => {
      const sources = state.messages.flatMap((m) =>
        m.segments.flatMap((s) => (s.kind === "injected" ? [s.injected.source] : [])),
      );
      return (
        sources.some((s) => (s?.changes?.length ?? 0) > 0) &&
        sources.some((s) => (s?.entries?.length ?? 0) > 0) &&
        sources.some((s) => (s?.references?.length ?? 0) > 0)
      );
    },
  ],
  // 夹具里不许再出现 MessageView 上不存在的字段（曾经摆着 durationMs/firstTokenMs 这种
  // 旧设计的遗留，照着假形状调样式会白干）
  [
    "夹具没有幽灵字段",
    () =>
      state.messages.every(
        (m) => !("durationMs" in m) && !("firstTokenMs" in m),
      ),
  ],
  // 运行中的一轮：produced 已经攒下来了，但轮尾那两行**不显示**（等 turn/end）。
  // 夹具必须留着这个形态，否则「生成中不显示文件行」这条规则在预览页里看不见。
  [
    "运行中一轮（produced 攒着但行不显示）",
    () => state.messages.some((m) => m.streaming === true && (m.produced?.length ?? 0) > 0),
  ],
  ["stopped 工具行", () => state.messages.some((m) => m.segments.some((s) => s.kind === "tool" && s.tool.status === "stopped"))],
  ["非零退出码工具行", () => state.messages.some((m) => m.segments.some((s) => s.kind === "tool" && s.tool.exitCode))],
  ["重试提示", () => state.messages.some((m) => m.segments.some((s) => s.kind === "notice" && s.text.startsWith("@llmRetry")))],
  // 工具栏那枚只读预设标签的样例（用户 2026-09-22 口径：会话开始后显示当前会话的
  // agent 预设名）。主故事是**已开始**的会话，必须有预设目录 + 当前预设 id，
  // 否则预览页里那枚标签永远不出现、宽度分配也看不到它那一档。
  [
    "工具栏 agent 预设标签（已开始的会话）",
    () => state.agentPreset === "ptc" && (state.agentPresets?.options?.length ?? 0) >= 5,
  ],
  // 权限弹层里的实验档（Auto review）：只有 `permissionAutoReview` 为真时那一档才
  // 会渲染（档位名 + EXP 标 + 官方警告卡）。夹具里没有这个字段，预览页就永远看不到
  // 那一档与那张勾选确认卡，双语排版也没法肉眼核对。
  ["权限弹层的 Auto review 档（实验）", () => state.permissionAutoReview === true],
  // 问卷的几种形态都要在夹具里：**已答完**那张必须带 `answers`（展开记录显示
  // 「用户当时选了什么」只能靠它，用户 2026-09-15 报的就是它空着）；**待回答**
  // 那张要有带选项的题，预览页才能看到「自定义回答与普通选项同一列表」。
  //
  // 已答完的记录现在挂在 `ask_user_question` 工具节点上（用户 2026-09-24 口径：
  // 答案与问卷合并成一个节点）——所以下面收集记录时两种落点都要认：工具节点的
  // `tool.question`，以及计划审阅那条留在流里的 `question` 段。
  [
    "问卷：已答完带用户答案（含自定义回答）",
    () => {
      const answered = state.messages.flatMap((m: any) =>
        m.segments.flatMap((s: any) =>
          s.kind === "tool" && s.tool?.question
            ? [s.tool.question]
            : s.kind === "question"
              ? [s.question]
              : [],
        ),
      );
      return answered.some(
        (q: any) =>
          q.state !== "waiting" &&
          Object.values(q.answers ?? {}).some((a: any) => (a.selected?.length ?? 0) > 0) &&
          Object.values(q.answers ?? {}).some((a: any) => Boolean(a.custom)),
      );
    },
  ],
  // 合并后的形态必须有样例：`ask_user_question` 的工具节点带着问卷记录（已答完 +
  // 撤回两种），否则预览页里看不到用户 2026-09-24 要的那个节点长什么样。
  [
    "问卷记录挂在 ask_user_question 工具节点上（已答完 + 已取消）",
    () => {
      const records = state.messages.flatMap((m: any) =>
        m.segments.flatMap((s: any) =>
          s.kind === "tool" && s.tool.name === "ask_user_question" && s.tool.question ? [s.tool.question] : [],
        ),
      );
      return (
        records.some((q: any) => q.state === "answered" && Boolean(q.answers)) &&
        records.some((q: any) => q.state === "cancelled")
      );
    },
  ],
  [
    "问卷：待回答（含多选与带描述的选项）",
    () =>
      state.messages.some((m) =>
        m.segments.some(
          (s) =>
            s.kind === "question" &&
            s.question.state === "waiting" &&
            s.question.items.some((item) => item.multiSelect === true) &&
            s.question.items.some((item) => item.options.some((option) => option.description)),
        ),
      ),
  ],
  // 计划审阅（`exit_plan_mode`）：夹具里必须留一份**带计划正文**的请求
  // （`intent.kind === "plan-review"` + `detail`）。审阅卡的识别全靠这两个字段，
  // 夹具里没有它，预览页就永远看不到那张卡（`__planReview()` 只是把这张已答完的
  // 翻成 `waiting`，好预览输入区接管时的排版）；计划正文里要有围栏代码块，
  // 否则卡里的 CodeBlock 这条路没人验过。
  [
    "计划审阅请求（intent + 计划正文 + 代码块）",
    () =>
      state.messages.some((m) =>
        m.segments.some(
          (s) =>
            s.kind === "question" &&
            s.question.items.some(
              (item) =>
                item.intent?.kind === "plan-review" &&
                typeof item.detail === "string" &&
                item.detail.includes("```"),
            ),
        ),
      ),
  ],
];

let failed = 0;
for (const [label, check] of must) {
  const ok = Boolean(check());
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed += 1;
}

// 3) 键唯一性：同一对象里重复的键在 JS 里**不报错**，后者静默覆盖前者。
//
// 判据必须按**对象作用域**来，不能按缩进：不同对象里的同名键（每个 `__push` 都有
// `type`、每个工具都有 `input`）完全正常。所以这里走一遍花括号配平，
// 给每个 `{` 分配一个作用域编号，只在**同一个作用域**里查重复。
{
  const duplicates: string[] = [];
  const stack: number[] = [];
  let scopeSeq = 0;
  const seen = new Map<string, number>(); // `${scopeId}\u0000${key}` → 行号

  let line = 1;
  let inString: string | null = null;
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === "\\") i += 2;
      else {
        if (ch === inString) inString = null;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      scopeSeq += 1;
      stack.push(scopeSeq);
      i += 1;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i += 1;
      continue;
    }
    /**
     * 对象键：标识符后紧跟冒号，且**紧邻的前一个非空白字符**只能是 `{` / `,` / `(` / `[`。
     *
     * 这条排除不是风格洁癖，是**正确性**：早先只判「前一个字符是 `\s` / `{` / `,`」，
     * 于是多行三元表达式 `payload.provenance ?\n  payload.provenance.payloadReduced === true\n  : null,`
     * 里的 `\n  : null,` 会被当成键 `null:`、`x === true` 那行会被当成键 `true:` ——
     * 全是**假重复**（实脚本用 true 解析器验过：三块都无语法错误，即无真重复键）。
     * 真的对象键前面一定是开括号或逗号；`?` / `:` / 运算符后面跟上来的不是键。
     */
    const keyMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(html.slice(i, i + 60));
    if (keyMatch && stack.length > 0) {
      let before = i - 1;
      while (before >= 0 && /\s/.test(html[before] as string)) before -= 1;
      const previousChar = before < 0 ? "" : (html[before] as string);
      const isKeyPosition = previousChar === "" || previousChar === "{" || previousChar === ","
        || previousChar === "(" || previousChar === "[";
      if (isKeyPosition) {
        const scope = stack[stack.length - 1];
        const id = `${scope}\u0000${keyMatch[1]}`;
        const previous = seen.get(id);
        if (previous !== undefined) {
          duplicates.push(`${keyMatch[1]}（第 ${previous} 行与第 ${line} 行，同一对象内）`);
        } else {
          seen.set(id, line);
        }
        i += keyMatch[0].length;
        continue;
      }
    }
    i += 1;
  }

  if (duplicates.length) {
    console.log(`  ✗ 同一对象内重复键：${duplicates.join("、")}`);
    failed += 1;
  } else {
    console.log("  ✓ 同一对象内无重复键（重复键会静默覆盖，导致预览显示旧数据）");
  }
}

// 3c) 轮次横条的边界形态（`?rail=one`）：单条用户消息 + 首个 turn/start 之前拼出来的
// 幻影 `a:0`。这条夹具存在的理由之一就是钉住用户 2026-09-18 报的那个 bug
// （「即便用户只发了一次消息也有第0轮」）——横条上只许有一枚刻点（单条用户消息也
// 要显示横条，见 `components/TurnRail.tsx` 的显示判据），所以浏览器侧的验证
// （`npm run preview` 加 `?rail=one`）需要一个形状正确的入口。
{
  const one = buildStateWith("zh-cn", "&rail=one");
  const users = one.messages.filter((m: { role: string }) => m.role === "user").length;
  const ok =
    one.messages.length === 3 &&
    one.messages[0].id === "a:0" &&
    users === 1 &&
    one.turnOutline?.length === 1 &&
    one.turnOutline[0].turn === 1;
  console.log(`  ${ok ? "✓" : "✗"} ?rail=one：单条用户消息 + 幻影 a:0（真实服务端轮号从 1 起）`);
  if (!ok) failed += 1;
}

// 3c) 空态（`?empty=1`）：新会话的初始页面。主故事有消息，空态在预览页里就永远
// 看不到，而那两行元信息（工作目录 / agent 预设）正是双语排版最容易出事的地方。
// 三种形态都要在：选过目录（可改）、跟随 VS Code 的静态行（`?lock=1`）、以及
// **没打开文件夹也没选过目录**（`?none=1`，占位「未选择工作区」——绝不能是路径）。
{
  const empty = buildStateWith("zh-cn", "&empty=1");
  const locked = buildStateWith("zh-cn", "&empty=1&lock=1");
  const none = buildStateWith("zh-cn", "&empty=1&none=1");
  const ok =
    empty.messages.length === 0 &&
    empty.workspace?.path &&
    empty.workspace.locked === false &&
    locked.workspace?.locked === true &&
    locked.workspace?.path &&
    // 没选目录时 `path` 是**空串**（界面显示占位文案），不是回退到 cwd
    none.workspace?.path === "" &&
    none.workspace?.locked === false &&
    empty.agentPresets?.selectable === true &&
    (empty.agentPresets?.options?.length ?? 0) >= 5 &&
    // 三条展示路径都要留样例：随产品交付的（走词典）、用户自己写的（用原文）、
    // 没有名字的（退回 id）。少一条，预览页就看不出那条路径长什么样。
    (empty.agentPresets?.options ?? []).some((o: { trust?: string }) => o.trust === "system") &&
    (empty.agentPresets?.options ?? []).some((o: { trust?: string; name?: string }) => o.trust === "user" && o.name) &&
    (empty.agentPresets?.options ?? []).some((o: { trust?: string; name?: string }) => o.trust === "user" && !o.name) &&
    empty.agentPreset === "ptc" &&
    // 空态**没有会话**（会话要等第一条消息才建，宿主侧的不变量见 scripts/invariants.test.ts）
    empty.session == null &&
    // 乐观回显也必须空：空态页的渲染条件是「没有消息且没有回显」，
    // 留着主故事那几条回显的话，预览页这一档渲染的是消息流，两行元信息根本看不到
    empty.pendingMessages.length === 0;
  console.log(`  ${ok ? "✓" : "✗"} ?empty=1：空态夹具（目录三种形态 + 预设目录 + 无会话）`);
  if (!ok) failed += 1;
}

// 3c) 标题栏上的工作目录（`?dir=1`）：VS Code 没打开文件夹、目录是给会话单独设的。
// 判据与渲染在 `scripts/sessionDir.test.ts`，这里只管**预览页有这一档可看**——
// 少了它，标题栏那段路径在预览里永远出不来（夹具默认是「打开着文件夹」的锁定档）。
{
  const withDir = buildStateWith("zh-cn", "&dir=1");
  const ok =
    // 默认档保持锁定（界面与从前逐字一致），`?dir=1` 才是新形态
    state.workspace?.locked === true &&
    withDir.workspace?.locked === false &&
    Boolean(withDir.workspace?.path) &&
    // 会话真的有 cwd：显示的是这条会话落在哪，不是编出来的路径
    withDir.session?.cwd === withDir.workspace?.path;
  console.log(`  ${ok ? "✓" : "✗"} ?dir=1：没打开文件夹的会话（标题栏有工作目录），默认档仍是锁定`);
  if (!ok) failed += 1;
}

// 3d) 审批卡的本地化文案（0.1.7-rc.2 起）：夹具里那条沙箱升级审批要带 `displayReason`，
// 且两种语言各取得到一条——`?locale=zh-cn` / `?locale=en` 是肉眼对照这条路径的唯一入口。
{
  const approval = state.messages
    .flatMap((m) => m.segments)
    .find((s) => s.kind === "approval")?.approval;
  const zh = approval?.displayReason?.zh;
  const en = approval?.displayReason?.en;
  const ok =
    Boolean(zh && en) &&
    pickLocalizedText(approval?.displayReason, "zh-cn") === zh &&
    pickLocalizedText(approval?.displayReason, "en") === en &&
    // 审计用的原文仍留在夹具里：它是取不到本地化文案时的退路
    Boolean(approval?.reason);
  console.log(`  ${ok ? "✓" : "✗"} 审批卡：本地化文案两种语言各一条 + 审计原文兜底`);
  if (!ok) failed += 1;
}

// 4) 语言：夹具必须两种语言都能构造出来（预览页支持 `?locale=en`）
// 这条不是形式主义：`?locale=en` 是唯一能**肉眼**检查英文下排版会不会溢出的入口，
// 它一旦坏掉，双语改动就失去了自查手段。
{
  const en = buildStateWith("en");
  const ok = Boolean(en.goal?.objective && en.messages?.length);
  console.log(`  ${ok ? "✓" : "✗"} 英文（?locale=en）也能构造出完整状态`);
  if (!ok) failed += 1;
  // 空态也要能构造：英文下的目录行与预设名/描述都长得多，那是唯一能**肉眼**
  // 检查它会不会溢出的入口（`?locale=en&empty=1`）
  const enEmpty = buildStateWith("en", "&empty=1");
  const emptyOk = enEmpty.messages.length === 0 && Boolean(enEmpty.workspace?.path) && enEmpty.agentPreset === "ptc";
  console.log(`  ${emptyOk ? "✓" : "✗"} 英文空态（?locale=en&empty=1）也能构造`);
  if (!emptyOk) failed += 1;
}

// 5) 真实轨迹夹具的接线（`?trajectory=small|long|compaction`）
//
// 这一段是**真实素材**的契约，不是排版演示：页面声明了三份夹具、磁盘上真有那三份、
// 每份的登记自洽、装载只吃真实载荷；取不到时**明确标不可用**且不回退到合成账本。
{
  // 5a) 页面**确实**接了真实夹具：标记块在、清单声明了三份（small / long / compaction）
  const namesOk = fixtureManifest.length === 3
    && ["small", "long", "compaction"].every((name) => realFixtureNames.includes(name));
  const ok5a = wiringPresent && namesOk;
  console.log(`  ${ok5a ? "✓" : "✗"} 真实夹具接线：标记块在、声明 3 份（small / long / compaction）`);
  if (!ok5a) failed += 1;

  // 5b) 三份都在磁盘上，且都带整套出处登记与整份载荷模型（不是预览页里那段合成账本）
  const missing = fixtureManifest.filter((entry) => {
    const payload = realFixture(entry.name);
    return !payload?.provenance || !payload?.model;
  });
  const ok5b = fixtureManifest.length === 3 && missing.length === 0;
  console.log(`  ${ok5b ? "✓" : "✗"} 真实夹具：三份磁盘文件都在且都带 provenance + model`);
  if (!ok5b) failed += 1;

  // 5b) 三份都带**整套**出处登记与整份载荷模型（不是预览页里那段合成账本）；
  //     `--limit 0` 下缩减恒 false、可测资格恒 true（否则不得用于 M06 全载荷）
  const payloadOk = realFixtureNames.length === 3 && realFixtureNames.every((name) => {
    const payload = realFixture(name);
    const provenance = payload?.provenance;
    const model = payload?.model;
    return Boolean(
      provenance
      && model
      && typeof provenance.sourceSha256 === "string"
      && typeof provenance.derive?.sha256 === "string"
      && typeof provenance.extractor?.sha256 === "string"
      && typeof provenance.modelSha256 === "string"
      && typeof provenance.seqMapping?.count === "number"
      && provenance.redaction?.fieldLimit === 0
      && provenance.payloadReduced === false
      && provenance.payloadMeasurementEligible === true
      && provenance.synthetic !== true
      && Array.isArray(model.turns)
      && Array.isArray(model.requests)
      && typeof model.cellCount === "number"
      && model.cellCount === realFixtureCells(payload).length,
    );
  });
  console.log(`  ${payloadOk ? "✓" : "✗"} 真实夹具：整套登记 + 整份 TrajectoryModel、--limit 0 未缩减且可测`);
  if (!payloadOk) failed += 1;

  // 5c) 页面自己的装载逻辑把真实模型装进 state 的账本位（按真代码求值，不 mock 逻辑）；
  //     来源标记只落在**预览专用**对象上，**不进生产 State**（新增字段就是越界）
  const small = realFixtureState("small");
  const long = realFixtureState("long");
  const compaction = realFixtureState("compaction");
  /**
   * 判**内容相等**而不是引用相等：`realFixture()` 每次重新 `JSON.parse`，引用必然不同；
   * 接线本身**不许改模型**（原样顶掉合成账本），所以序列化后逐字比对就是它的正确口径。
   */
  const loaded =
    small.state.trajectory !== undefined
    && small.state.trajectory !== null
    && JSON.stringify(small.state.trajectory) === JSON.stringify(realFixture("small")?.model)
    && JSON.stringify(long.state.trajectory) === JSON.stringify(realFixture("long")?.model)
    && JSON.stringify(compaction.state.trajectory) === JSON.stringify(realFixture("compaction")?.model);
  const marksOk = [small, long, compaction].every((built) =>
    built.info.synthetic === false
    && built.info.unavailable === false
    && built.info.payloadReduced === false
    && built.info.payloadMeasurementEligible === true
    && built.state.panel === "trajectory",
  );
  // **生产 State 不许出现只为预览/测试存在的字段**：这两个键在 AppState / ChatState 里都不存在
  const stateClean = [small, long, compaction, { state: buildStateWith("zh-cn") }].every((built) =>
    !("trajectoryFixture" in built.state) && !("trajectoryUnavailable" in built.state),
  );
  console.log(`  ${loaded && marksOk ? "✓" : "✗"} 真实夹具装载：模型进 state 账本位、标记在预览专用对象上且可测`);
  console.log(`  ${stateClean ? "✓" : "✗"} 生产 State 干净：没有 trajectoryFixture / trajectoryUnavailable 这类预览专用字段`);
  if (!(loaded && marksOk)) failed += 1;
  if (!stateClean) failed += 1;

  // 5d) **不许合成回退**：夹具没到 / 取不到时账本清空，且预览标记 unavailable
  const pending = buildStateWith("zh-cn", "&trajectory=long", {});
  const failedEntry = buildStateWith("zh-cn", "&trajectory=long", {
    long: { status: "unavailable", path: "fixtures/trajectory/real-long.json", provenance: null, model: null },
  });
  const noFallback =
    pending.panel === "trajectory"
    && pending.trajectory === null
    && failedEntry.panel === "trajectory"
    && failedEntry.trajectory === null;
  // 不带参数时仍是页面自带的合成账本（服务排版演示）
  const defaultState = buildStateWith("zh-cn");
  const syntheticKept = (defaultState.trajectory?.turns ?? []).length > 0;
  console.log(`  ${noFallback && syntheticKept ? "✓" : "✗"} 取不到真实夹具时不合成回退（账本清空），默认仍是合成账本`);
  if (!(noFallback && syntheticKept)) failed += 1;

  // 5e) 来源可追溯：三份的 derive 与 extractor 摘要都写进了登记，且 `generatedBy` 是正式源
  const traceable = realFixtureNames.length === 3 && realFixtureNames.every((name) => {
    const provenance = realFixture(name)?.provenance;
    return /^[0-9a-f]{64}$/.test(provenance.derive?.sha256 ?? "")
      && /^[0-9a-f]{64}$/.test(provenance.extractor?.sha256 ?? "")
      && /^[0-9a-f]{64}$/.test(provenance.sourceSha256 ?? "")
      && provenance.derive?.file === "src/dsh/trajectory.ts"
      && provenance.extractor?.file === "scripts/trajectoryFixtureBuild.ts"
      && provenance.generatedBy === "scripts/trajectoryFixtureBuild.ts";
  });
  console.log(`  ${traceable ? "✓" : "✗"} 真实夹具：source / derive / extractor 摘要与正式生成源都在登记里`);
  if (!traceable) failed += 1;

  // 5f) 结构事实（给下文的能力矩阵与 M06 用）：长素材**必须**越过虚拟化阈值，
  //     压缩素材必须真的有 `compacted` 行，否则「?trajectory=long」在预览页量不到窗口化
  const longCells = realFixtureCells(realFixture("long")).length;
  const compactionKinds = new Set(realFixtureCells(realFixture("compaction")).map((cell) => cell.kind));
  const structureOk = realFixtureNames.length === 3 && longCells > 100 && compactionKinds.has("compacted");
  console.log(`  ${structureOk ? "✓" : "✗"} 真实夹具结构：长素材 ${longCells} 行（>100）、压缩素材含 compacted 行`);
  if (!structureOk) failed += 1;

  // 5g) 能力矩阵（样本覆盖的**事实**，不是承诺）：三份都不含 run_code / subtool；
  //     没样本的能力不许在预览页造一条假的出来（PTC 那一条已按缺席契约处理）
  const capabilityReport = realFixtureNames.map((name) => ({
    name,
    runCode: realFixtureCells(realFixture(name)).filter((cell) => cell.toolName === "run_code").length,
    capabilities: realFixture(name)?.provenance?.capabilities,
  }));
  const noRunCodeSample = realFixtureNames.length === 3 && capabilityReport.every((entry) => entry.runCode === 0
    && entry.capabilities?.subtool === false);
  console.log(`  ${noRunCodeSample ? "✓" : "✗"} 能力矩阵：三份真实夹具都没有 run_code / subtool 样本（PTC 留缺席契约）`);
  if (!noRunCodeSample) failed += 1;
}

console.log(failed === 0 ? "\npreview: 夹具结构完整" : `\npreview: ${failed} 项不合规`);
if (failed > 0) process.exitCode = 1;
