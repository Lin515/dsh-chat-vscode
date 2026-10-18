/**
 * 标题栏上的执行目录：未打开文件夹时显示；打开时仅在与工作区目录不同时显示。
 * 执行目录投影优先，缺失时保留会话创建目录的回退。
 *
 * 第 1 节钉**判据**（纯函数 `sessionDirPath`，按真实取值分档：会话 cwd 优先、
 * 退回扩展记下的目录、拿不到证据就不显示、空串不当目录）；第 2 / 3 节钉**接线**——
 * 元素真的渲染在标题之前、样式给了收缩口径与迷你模式的收起。
 *
 * 为什么这几条必须钉住：判据或接线少一处，症状都是「静默」的——要么路径根本不出现，
 * 要么窄侧栏里长路径把标题挤没（这是本仓库界面改动最常见的两种退化形态）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummaryView } from "../src/shared/chat";
import { sessionDirPath } from "../src/webview/sessionDir";
import { MESSAGES } from "../src/webview/messages";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

const app = read("src", "webview", "App.tsx");
const css = read("src", "webview", "styles", "app.css");
const textsFile = read("src", "webview", "texts.ts");

const DIR_A = "C:\\work\\alpha";
const DIR_B = "D:\\work\\beta";

/** 会话列表里的那一行摘要（只需标题那几个字段，测试不关心）。 */
const summary = (cwd?: string): SessionSummaryView => ({
  id: "s1",
  title: "重构 server 启动流程",
  updatedAt: 0,
  running: false,
  ...(cwd === undefined ? {} : { cwd }),
});

// ---------- 1. 显示哪个目录：会话 cwd 优先，退回扩展记下的那个 ----------
{
  // 打开着文件夹：目录跟随 VS Code，界面保持原状（一个字都不加）
  assert.strictEqual(
    sessionDirPath({ workspace: { path: DIR_A, locked: true }, session: summary(DIR_A) }),
    undefined,
    "打开着文件夹时整段不显示（locked === true 是宿主的锁定口径）",
  );
  // 拿不到外观态（帧还没到 / 旧宿主）：不动手
  assert.strictEqual(sessionDirPath({}), undefined, "没有工作目录帧时不显示（只认肯定证据）");
  assert.strictEqual(
    sessionDirPath({ session: summary(DIR_A) }),
    undefined,
    "只有会话、没有工作目录帧时不显示——没法判断 VS Code 是否开着文件夹",
  );

  // 核心场景：没打开文件夹，目录是给这个会话单独设的 → 显示它
  assert.strictEqual(
    sessionDirPath({ workspace: { path: DIR_A, locked: false }, session: summary(DIR_A) }),
    DIR_A,
    "没打开文件夹时标题栏要显示会话的工作目录",
  );

  // 切到历史里另一条会话：显示的必须是**那条会话**落在哪，不是「下一个新会话」的目录
  assert.strictEqual(
    sessionDirPath({ workspace: { path: DIR_A, locked: false }, session: summary(DIR_B) }),
    DIR_B,
    "会话 cwd 优先于 workspace.path（换过目录后切回旧会话，读的是会话自己的 cwd）",
  );

  // 会话摘要里没有 cwd：空态还没建壳；子代理会话的摘要是宿主合成的那一份（本来就不带）
  assert.strictEqual(
    sessionDirPath({ workspace: { path: DIR_A, locked: false }, session: summary() }),
    DIR_A,
    "会话 cwd 拿不到时退回扩展记下的工作目录",
  );
  assert.strictEqual(
    sessionDirPath({ workspace: { path: DIR_A, locked: false } }),
    DIR_A,
    "空态（还没有会话）也要显示——新会话落在哪同样是这一刻的事实",
  );

  // 没有目录：什么都不显示（不拿宿主的 cwd 冒充工作目录，与空态页同一口径）
  assert.strictEqual(
    sessionDirPath({ workspace: { path: "", locked: false }, session: summary() }),
    undefined,
    "空串按「没有目录」处理——绝不编一个目录出来",
  );
  // 重载窗口后扩展不记得那个目录了（`newSessionCwd` 只在内存里），但会话 cwd 还在
  assert.strictEqual(
    sessionDirPath({ workspace: { path: "", locked: false }, session: summary(DIR_A) }),
    DIR_A,
    "会话自己的 cwd 不依赖扩展记的那个目录（重载后仍读得到）",
  );
}
// 执行目录优先，只有不同才在已打开文件夹的窗口显示；回到工作区后消失。
for (const locked of [true, false]) {
  const state = { workspace: { path: DIR_A, locked }, session: summary(DIR_A) };
  assert.equal(sessionDirPath({ ...state, workingDirectory: DIR_B }), DIR_B);
  assert.equal(sessionDirPath({ ...state, workingDirectory: DIR_A }), locked ? undefined : DIR_A);
  assert.equal(sessionDirPath({ ...state, workingDirectory: "" }), locked ? undefined : DIR_A);
}
assert.equal(sessionDirPath({ workspace: { path: "C:/work/alpha/", locked: true }, workingDirectory: "c:\\work\\alpha" }), undefined);
assert.equal(sessionDirPath({ workspace: { path: "/work/Alpha", locked: true }, workingDirectory: "/work/alpha" }), "/work/alpha");
assert.equal(sessionDirPath({ workspace: { path: "/work/alpha/", locked: true }, workingDirectory: "/work/alpha" }), undefined);
assert.equal(sessionDirPath({ workspace: { path: "/", locked: true }, workingDirectory: "/" }), undefined);
assert.equal(sessionDirPath({ workspace: { path: DIR_A, locked: true }, session: summary(), workingDirectory: DIR_B }), DIR_B, "子代理不必依赖摘要 cwd");
console.log("sessionDir: 执行目录优先、差异显示与平台路径比较 ✓");

// ---------- 2. 接线：渲染在**标题前方**，取值只走判据 ----------
{
  const dirAt = app.indexOf("<HeaderDir state={state} />");
  // 两处标题：子代理页那条可点的面包屑（`className="header-title"` 的 button）与普通会话
  // 那条静态文本——两者都必须在它**之后**
  const crumbAt = app.indexOf('className="header-title"');
  const plainAt = app.indexOf('<span className="header-title">{title}</span>');
  assert.ok(
    dirAt > 0 && crumbAt > dirAt && plainAt > dirAt,
    "工作目录要渲染在标题之前（用户口径：位置在标题前方；两种标题形态都要在它之后）",
  );

  const body = app.slice(app.indexOf("function HeaderDir("), app.indexOf("function BrandMark("));
  assert.ok(
    /const path = sessionDirPath\(state\);/.test(body),
    "取值必须走 sessionDirPath——判据只有那一处（别在组件里再判一遍 locked）",
  );
  assert.ok(/if \(!path\) return null;/.test(body), "没有目录就整个不渲染（不画空壳）");
  assert.ok(/<IconFolder size=\{12\} \/>/.test(body), "路径前要有文件夹图标（无头文字分不出这是目录）");
  assert.ok(
    /header-dir-prefix/.test(body) && /header-dir-name/.test(body),
    "路径要拆成目录前缀 + 末段两段（末段不参与收缩，与正文路径同一口径）",
  );
  // 两段必须包在同一个 `.header-dir-path` 里：装得下时它读起来是一个完整字符串，
  // 「分割」只在被省略号截断时才是可见的（用户 2026-10-10 口径）
  assert.ok(
    /className="header-dir-path"[\s\S]{0,200}className="header-dir-prefix"[\s\S]{0,120}className="header-dir-name"/.test(
      body,
    ),
    "前缀与末段要同属 `.header-dir-path` 一段（各自散着放的话中间会多出一道间隙）",
  );
  assert.ok(
    /title=\{`\$\{path\}\\n\$\{texts\.sessionDir\}`\}/.test(body),
    "完整路径要挂在 title 上——窄侧栏里裁掉的是目录前缀，悬停仍读得到全文",
  );
  // 静态文字：换目录是**新会话**的事，已开始的会话点它换不了目录
  assert.ok(
    !/<button|onClick/.test(body),
    "这一段不是按钮（做成可点的只会让用户以为点它能换目录）",
  );
}
console.log("sessionDir: 接线在标题前方、判据单点、静态文字 ✓");

// ---------- 3. 样式：窄栏里让位，迷你模式整个收起 ----------
{
  /** 取出一个选择器的声明块（第一个匹配）。 */
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
    assert.ok(match, `app.css 里找不到选择器 ${selector}`);
    return (match as RegExpExecArray)[1] as string;
  };

  const dir = rule(".header-dir");
  assert.ok(
    /min-width:\s*0/.test(dir) && /overflow:\s*hidden/.test(dir),
    ".header-dir 必须能收缩（写死宽度的话长路径会把标题挤没）",
  );
  /** 取一条规则的 `max-width` 设计值（vw 口径：窄侧栏里要跟着窗口收）。 */
  const vwCap = (selector: string): number => {
    const value = /max-width:\s*(\d+(?:\.\d+)?)vw/.exec(rule(selector))?.[1];
    assert.ok(value, `${selector} 的 max-width 要是 vw 口径（固定像素会在窄侧栏溢出）`);
    return Number(value);
  };
  assert.ok(
    vwCap(".header-dir") < vwCap(".header-title"),
    ".header-dir 的上限要比标题更紧——标题是这一页的主语，空间不够时先让位的是目录",
  );
  assert.ok(
    /flex:\s*0\s+1\s/.test(dir),
    "收缩按内容宽度等比进行（子代理页上加重权重会把整段路径折成 0 宽，末段目录名也跟着没）",
  );
  assert.ok(/white-space:\s*nowrap/.test(dir), ".header-dir 单行（英文路径更长，折行会撑高顶栏）");

  assert.ok(
    /text-overflow:\s*ellipsis/.test(rule(".header-dir-prefix")),
    "目录前缀要能被裁——挨裁的只能是它，末段目录名要留住",
  );
  // 路径那一段内部**不许有间隙**：完整显示时它就该是一个字符串，
  // 中间那道缝会让人读成「路径 + 另一个词」（间隙只留在图标与文字之间）
  const path = rule(".header-dir-path");
  assert.ok(!/gap:/.test(path), ".header-dir-path 内部不许有间隙（完整显示时要读成一个字符串）");
  assert.ok(
    /flex:\s*0\s+0\s/.test(rule(".header-dir-name")),
    "末段目录名不参与收缩（它才是用户要看的那一段）",
  );
  assert.ok(
    /\.app\.is-mini \.header-dir\s*\{[^}]*display:\s*none/.test(css),
    "迷你模式要连同它一起收起（那一档连标题都不显示，路径留着会把按钮挤出去）",
  );
}
console.log("sessionDir: 收缩口径与迷你模式收起 ✓");

// ---------- 4. 悬停说明：中英两份都在登记表里 ----------
{
  const entry = MESSAGES.sessionDir;
  assert.strictEqual(typeof entry.zh, "string", "sessionDir 的中文在消息表里");
  assert.strictEqual(typeof entry.en, "string", "sessionDir 的英文在消息表里（双语硬规则）");
  assert.ok((entry.zh as string).trim().length > 0 && (entry.en as string).trim().length > 0, "两侧都不许是空串");
  assert.ok(/sessionDir: string;/.test(textsFile), "Texts 接口里要有 sessionDir（派生词典按它收窄）");
}
console.log("sessionDir: 悬停说明中英齐备 ✓");

console.log("\nsessionDir: all assertions passed");
