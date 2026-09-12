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
