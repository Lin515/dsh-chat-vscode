// 一次性夹具体检：确认 test/preview.html 的 state 字面量能被真正求值，
// 且新加的界面形态都在。
//
// 为什么值得单独跑：预览夹具是**手工维护**的对象字面量，重复的键（JS 里不报错，
// 后者覆盖前者）或语法错都会让预览静默显示旧内容——调样式时照着假数据调，
// 这正是文档里记过的坑（`test/preview.html` 曾编过 5 个思考档位）。
import { readFileSync } from "node:fs";

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
const codeSample = "export function bootstrap() {\n  // …\n}";
const build = new Function(
  "now",
  "codeSample",
  "location",
  `return (function () ${source})();`,
);

function buildState(locale: "zh-cn" | "en") {
  return build(Date.now(), codeSample, { search: `?locale=${locale}` });
}

const state = buildState("zh-cn");

// 2) 结构断言
const must = [
  ["goal 目标条", () => state.goal?.objective],
  ["contextOccupancy 占用环", () => state.contextOccupancy?.percent],
  ["hasMoreHistory 加载更早", () => state.hasMoreHistory === true],
  ["附件：引用", () => state.attachments?.some((a) => a.kind === "reference")],
  ["附件：上传中", () => state.attachments?.some((a) => a.upload?.status === "uploading")],
  ["附件：上传失败", () => state.attachments?.some((a) => a.upload?.status === "error")],
  ["命令节点", () => state.messages.some((m) => m.segments.some((s) => s.kind === "command"))],
  ["轮尾 produced", () => state.messages.some((m) => m.produced?.length)],
  ["轮尾 deliverables", () => state.messages.some((m) => m.deliverables?.length)],
  // 助手消息里的图片块（`images` 段）：此前 image 块被静默丢弃，夹具要留住这个形态
  ["助手消息里的图片", () => state.messages.some((m) => m.segments.some((s) => s.kind === "images"))],
  // 用户消息的操作行（时钟 + 复制）：**常驻**显示（不再靠悬停揭示），DOM 里必须在
  ["用户消息操作行", () => state.messages.some((m) => m.role === "user")],
  // 超过 5 行的用户消息：默认收缩 + 「展开 / 收起」。夹具要留一条长的，
  // 否则预览页看不到那枚按钮（判定按实测渲染高度，不看换行符）
  [
    "长用户消息（默认收缩）",
    () => state.messages.some((m) => m.role === "user" && (m.text ?? "").split("\n").length > 5),
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
  // 轮级过程折叠要有 step 才能算边界：夹具里必须有带 step 的段，否则预览页永远
  // 看不到折叠（保守降级成平铺），这条断言防止「改了折叠但预览看不出」
  [
    "轮级过程折叠（段带 step）",
    () => state.messages.some((m) => m.segments.some((s) => typeof s.step === "number")),
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

// 4) 语言：夹具必须两种语言都能构造出来（预览页支持 `?locale=en`）
//
// 这条不是形式主义：`?locale=en` 是唯一能**肉眼**检查英文下排版会不会溢出的入口，
// 它一旦坏掉，双语改动就失去了自查手段。
{
  const en = buildState("en");
  const ok = Boolean(en.goal?.objective && en.messages?.length);
  console.log(`  ${ok ? "✓" : "✗"} 英文（?locale=en）也能构造出完整状态`);
  if (!ok) failed += 1;
}

console.log(failed === 0 ? "\npreview: 夹具结构完整" : `\npreview: ${failed} 项不合规`);
if (failed > 0) process.exitCode = 1;
