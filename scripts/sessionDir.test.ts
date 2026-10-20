/**
 * 标题右侧的执行目录：未打开文件夹时显示；打开时仅在与工作区目录不同时显示。
 * 执行目录投影优先，缺失时保留会话创建目录的回退。
 *
 * 第 1 节钉**判据**（纯函数 `sessionDirPath`，按真实取值分档：会话 cwd 优先、
 * 退回扩展记下的目录、拿不到证据就不显示、空串不当目录）；第 2 节钉**显示拆分**
 * （图标与目录名、目录名与所在路径之间各空一格，路径不重复目录名）；第 3 / 4 节钉**接线**——
 * 元素真的渲染在标题（及子代理计数）之后、样式给了占满剩余宽度的口径、与「新建」
 * 按钮的 80dp 基准留白，以及迷你模式的收起。
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
import { sessionDirParts, sessionDirPath } from "../src/webview/sessionDir";
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

// ---------- 2. 显示拆分：目录名 + 所在路径（路径里不重复目录名） ----------
{
  assert.deepStrictEqual(
    sessionDirParts("C:\\work\\alpha"),
    { name: "alpha", parent: "C:\\work" },
    "目录名是最后一段，所在路径是它前面的那一段",
  );
  assert.deepStrictEqual(
    sessionDirParts("D:/dev/demo-app/"),
    { name: "demo-app", parent: "D:/dev" },
    "尾分隔符不影响拆分，也不把目录名空掉",
  );
  assert.deepStrictEqual(sessionDirParts("/work/alpha"), { name: "alpha", parent: "/work" });
  // 没有上一级可写：整条路径当目录名，不编一个假上级
  assert.deepStrictEqual(sessionDirParts("/"), { name: "/", parent: "" });
  assert.deepStrictEqual(sessionDirParts("C:\\"), { name: "C:\\", parent: "" });
  assert.deepStrictEqual(sessionDirParts("C:\\work"), { name: "work", parent: "C:\\" }, "盘根要带分隔符");
  assert.deepStrictEqual(sessionDirParts("\\\\server\\share"), { name: "\\\\server\\share", parent: "" });
  assert.deepStrictEqual(
    sessionDirParts("\\\\server\\share\\proj"),
    { name: "proj", parent: "\\\\server\\share" },
  );
  assert.deepStrictEqual(sessionDirParts("alpha"), { name: "alpha", parent: "" }, "没有分隔符时只剩目录名");
  assert.strictEqual(sessionDirParts("   "), undefined, "空路径不凭空拆出一段");
}
console.log("sessionDir: 图标与目录名/所在路径各空一格、路径不重复目录名 ✓");

// ---------- 3. 接线：渲染在**标题与子代理计数之后**，取值只走判据 ----------
{
  const dirAt = app.indexOf("<HeaderDir state={state} />");
  // 标题（连同后面的子代理计数）是切换入口的整组；目录必须排在整组之后
  const titleAt = app.indexOf("<SessionTitle state={state} agentsBusy={agentsBusy} />");
  const spacerAt = app.indexOf('<span className="header-spacer" />');
  assert.ok(
    dirAt > titleAt && titleAt > 0 && spacerAt > dirAt,
    "工作目录要渲染在标题与子代理计数之后、右侧按钮之前（用户口径：标题右侧；有子代理时在其右侧）",
  );

  const body = app.slice(app.indexOf("function HeaderDir("), app.indexOf("function BrandMark("));
  assert.ok(
    /const path = sessionDirPath\(state\);/.test(body),
    "取值必须走 sessionDirPath——判据只有那一处（别在组件里再判一遍 locked）",
  );
  assert.ok(/if \(!path\) return null;/.test(body), "没有目录就整个不渲染（不画空壳）");
  assert.ok(/<IconFolder size=\{16\} \/>/.test(body), "路径前要有文件夹图标（无头文字分不出这是目录）");
  assert.ok(
    /const parts = sessionDirParts\(path\);/.test(body) &&
      /className="header-dir-name">\{parts\.name\}/.test(body) &&
      /className="header-dir-parent">\{parts\.parent\}/.test(body),
    "目录要拆成「目录名 + 所在路径」两段（图标与目录名、目录名与路径之间各空一格）",
  );
  assert.ok(
    /title=\{`\$\{path\}\\n\$\{texts\.sessionDir\}`\}/.test(body),
    "完整路径要挂在 title 上——窄侧栏里裁掉的是所在路径，悬停仍读得到全文",
  );
  // 静态文字：换目录是**新会话**的事，已开始的会话点它换不了目录
  assert.ok(
    !/<button|onClick/.test(body),
    "这一段不是按钮（做成可点的只会让用户以为点它能换目录）",
  );
}
console.log("sessionDir: 接线在标题与子代理计数之后、判据单点、静态文字 ✓");

// ---------- 4. 样式：占满剩余宽度、80dp 留白，迷你模式整个收起 ----------
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
    /flex:\s*1\s+1\s+auto/.test(dir) && /min-width:\s*0/.test(dir) && /overflow:\s*hidden/.test(dir),
    ".header-dir 要占满标题与右侧按钮之间的剩余宽度（装不下时还能收，长路径不会把标题挤没）",
  );
  assert.ok(
    !/max-width\s*:/.test(dir),
    "不要再给 .header-dir 设 max-width 截断：宽面板里要一直显示到「新建」按钮前（用户 2026-10-21 口径）",
  );
  // 与「新建」按钮之间的基准留白：设计像素口径，字号倍率一变整段留白跟着变；
  // 上限 80dp，窄到放不下时按顶栏宽度收窄（clamp），别把右侧按钮挤出可视区
  assert.ok(
    /min-width:\s*clamp\(\s*0px\s*,\s*calc\(100%\s*-\s*204\s*\*\s*var\(--dp\)\)\s*,\s*calc\(80\s*\*\s*var\(--dp\)\)\s*\)/u.test(
      rule(".header-dir + .header-spacer"),
    ),
    "目录与「新建」按钮之间留 80dp 基准间隔（上限随字号缩放，窄栏按顶栏宽度收窄）",
  );
  assert.ok(
    /\.app\.is-mini \.header-spacer\s*\{[^}]*min-width:\s*0/u.test(css),
    "迷你模式目录收起后要撤掉那段留白（兄弟选择器仍会匹配到 spacer）",
  );
  assert.ok(/white-space:\s*nowrap/.test(dir), ".header-dir 单行（英文路径更长，折行会撑高顶栏）");
  assert.ok(
    /gap:\s*calc\(4 \* var\(--dp\)\)/.test(dir),
    "图标与目录名之间空一格（用户 2026-10-21 口径）",
  );

  assert.ok(
    /text-overflow:\s*ellipsis/.test(rule(".header-dir-name")),
    "目录名过长时自己省略（不能只靠外层裁切）",
  );
  assert.ok(
    /flex:\s*0\s+0\s/.test(rule(".header-dir-name")),
    "目录名不参与收缩（它才是用户要看的那一段）",
  );
  const parent = rule(".header-dir-parent");
  assert.ok(
    /flex:\s*0\s+1\s/.test(parent) && /min-width:\s*0/.test(parent),
    "所在路径可收缩：装不下时先省它",
  );
  assert.ok(
    !/margin-left:/.test(parent),
    "目录名与所在路径之间的空格只由 .header-dir 的 gap 提供（不要再叠一层）",
  );
  assert.ok(/text-overflow:\s*ellipsis/.test(parent), "所在路径过长要能省略");
  assert.ok(
    /\.app\.is-mini \.header-dir\s*\{[^}]*display:\s*none/.test(css),
    "迷你模式要连同它一起收起（那一档连标题都不显示，路径留着会把按钮挤出去）",
  );
}
console.log("sessionDir: 占满剩余宽度、80dp 留白与迷你模式收起 ✓");

// ---------- 5. 悬停说明：中英两份都在登记表里 ----------
{
  const entry = MESSAGES.sessionDir;
  assert.strictEqual(typeof entry.zh, "string", "sessionDir 的中文在消息表里");
  assert.strictEqual(typeof entry.en, "string", "sessionDir 的英文在消息表里（双语硬规则）");
  assert.ok((entry.zh as string).trim().length > 0 && (entry.en as string).trim().length > 0, "两侧都不许是空串");
  assert.ok(/sessionDir: string;/.test(textsFile), "Texts 接口里要有 sessionDir（派生词典按它收窄）");
}
console.log("sessionDir: 悬停说明中英齐备 ✓");

console.log("\nsessionDir: all assertions passed");
