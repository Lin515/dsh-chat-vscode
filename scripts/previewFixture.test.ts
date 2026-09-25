// 一次性夹具体检：确认 test/preview.html 的 state 字面量能被真正求值，
// 且新加的界面形态都在。
//
// 为什么值得单独跑：预览夹具是**手工维护**的对象字面量，重复的键（JS 里不报错，
// 后者覆盖前者）或语法错都会让预览静默显示旧内容——调样式时照着假数据调，
// 这正是文档里记过的坑（`test/preview.html` 曾编过 5 个思考档位）。
import { readFileSync } from "node:fs";
import { foldTurnProcess } from "../src/webview/turnProcess";
import { fileLinkPort, matchFileMention } from "../src/webview/fileLinks";
import { pickLocalizedText } from "../src/shared/localizedText";

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

// `now` / `codeSample` / `locale` 是 script 顶层的变量：一并求值。
// `locale` 来自 `location.search`（预览页支持 `?locale=en` 切换语言），
// 无头环境里没有 location，所以这里也把它参数化——顺带能**两种语言都体检一遍**。
// `previewImageDataUrl` 同理：夹具里图片附件的 data URL 在预览页由一段内联 SVG 算出来，
// 而 `__buildState` 在 Node 里求值时不带那段脚本（所以它**不能**引用 window）。
const codeSample = "export function bootstrap() {\n  // …\n}";
const previewImageDataUrl = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const build = new Function(
  "now",
  "codeSample",
  "location",
  "previewImageDataUrl",
  `return (function () ${source})();`,
);

function buildState(locale: "zh-cn" | "en") {
  return build(Date.now(), codeSample, { search: `?locale=${locale}` }, previewImageDataUrl);
}

const state = buildState("zh-cn");

// 2) 结构断言
const must = [
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
      type Msg = { produced?: string[]; deliverables?: { path: string }[]; streaming?: boolean; segments: Seg[] };
      const textsOf = (m: Msg): string[] =>
        m.segments.flatMap((s) => (s.kind === "text" && s.text ? [s.text] : []));
      const tokensOf = (text: string): string[] =>
        [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
      // 词表按**消息**算（界面就是这么算的：`produced ∪ deliverables` 去重后再判）。
      // 全局拼一起会把别的轮次的同名文件算进来——`config.ts` 因此在两处各出现一次、
      // 被判成「同名歧义」，判定跟着失真。
      const portOf = (m: Msg) =>
        fileLinkPort(
          [...(m.produced ?? []), ...(m.deliverables ?? []).map((file) => file.path)],
          !m.streaming,
        );
      const allTexts = state.messages.flatMap((m: Msg) => textsOf(m));
      const hasLineLink = allTexts.some((text: string) => /\]\([^)\s]+#L\d+\)/.test(text));
      const resolved = state.messages.some((m: Msg) => {
        const port = portOf(m);
        return (
          port.settled &&
          textsOf(m).some((text) =>
            tokensOf(text).some((token) => matchFileMention(port.paths, token) !== undefined),
          )
        );
      });
      // 点不开的那些也要留着：夹具里全是可点的，就看不出「对不上就不猜」这条口径
      const inert = state.messages.some((m: Msg) =>
        textsOf(m).some((text) =>
          tokensOf(text).some((token) => matchFileMention(portOf(m).paths, token) === undefined),
        ),
      );
      return hasLineLink && resolved && inert;
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
    "乐观回显（带图的一条 + 失败红框的一条）",
    () => {
      const transcript = state.pendingMessages.some(
        (echo: { status?: string; attachments?: unknown[] }) =>
          echo.status === "sending" && (echo.attachments?.length ?? 0) > 0,
      );
      const failed = state.pendingMessages.some(
        (echo: { status?: string; error?: string }) =>
          echo.status === "failed" && Boolean(echo.error),
      );
      return transcript && failed;
    },
  ],
  // 轨迹账本：七种记录要留够形态，否则预览页看不到种类标签/检查器页签/折叠行的差别
  [
    "轨迹账本（六种记录 + 系统提示词更新）",
    () => {
      const kinds = new Set(
        (state.trajectory?.turns ?? []).flatMap((turn: { cells: { kind: string }[] }) =>
          turn.cells.map((cell) => cell.kind),
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
      const cells = (state.trajectory?.turns ?? []).flatMap((turn: { cells: { index: number }[] }) => turn.cells);
      const sequential = cells.every((cell: { index: number }, position: number) => cell.index === position + 1);
      return sequential && cells.some((cell: { kind: string; result?: string }) => cell.kind === "tool" && cell.result);
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
    // 对象键：标识符后紧跟冒号（排除 `a ? b : c` —— 那种情形 `?` 会在前面，
    // 这里只认「行内首个非空白 token 是标识符:」，足以覆盖本文件的书写风格）
    const keyMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(html.slice(i, i + 60));
    if (keyMatch && stack.length > 0) {
      const before = html.slice(Math.max(0, i - 1), i);
      const isKeyPosition = /[\s{,]/.test(before) || before === "";
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
// 幻影 `a:0`。这条夹具存在的唯一理由就是钉住用户 2026-09-18 报的那个 bug
// （「即便用户只发了一次消息也有第0轮」）——横条必须整个不出现，所以浏览器侧的
// 验证（`npm run preview` 加 `?rail=one`）需要一个形状正确的入口。
{
  const one = build(Date.now(), codeSample, { search: "?locale=zh-cn&rail=one" }, previewImageDataUrl);
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
  const empty = build(Date.now(), codeSample, { search: "?locale=zh-cn&empty=1" }, previewImageDataUrl);
  const locked = build(Date.now(), codeSample, { search: "?locale=zh-cn&empty=1&lock=1" }, previewImageDataUrl);
  const none = build(Date.now(), codeSample, { search: "?locale=zh-cn&empty=1&none=1" }, previewImageDataUrl);
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
    empty.session == null;
  console.log(`  ${ok ? "✓" : "✗"} ?empty=1：空态夹具（目录三种形态 + 预设目录 + 无会话）`);
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
  const en = buildState("en");
  const ok = Boolean(en.goal?.objective && en.messages?.length);
  console.log(`  ${ok ? "✓" : "✗"} 英文（?locale=en）也能构造出完整状态`);
  if (!ok) failed += 1;
  // 空态也要能构造：英文下的目录行与预设名/描述都长得多，那是唯一能**肉眼**
  // 检查它会不会溢出的入口（`?locale=en&empty=1`）
  const enEmpty = build(
    Date.now(),
    codeSample,
    { search: "?locale=en&empty=1" },
    previewImageDataUrl,
  );
  const emptyOk = enEmpty.messages.length === 0 && Boolean(enEmpty.workspace?.path) && enEmpty.agentPreset === "ptc";
  console.log(`  ${emptyOk ? "✓" : "✗"} 英文空态（?locale=en&empty=1）也能构造`);
  if (!emptyOk) failed += 1;
}

console.log(failed === 0 ? "\npreview: 夹具结构完整" : `\npreview: ${failed} 项不合规`);
if (failed > 0) process.exitCode = 1;
