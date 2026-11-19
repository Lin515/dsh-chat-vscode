/** 标题栏目录标签：取值、目录身份、悬停详情与窄栏接线。运行：npm test。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummaryView, WorkspaceView } from "../src/shared/chat";
import { MESSAGES } from "../src/webview/messages";
import { sessionDirBadge } from "../src/webview/sessionDir";

const A = "C:\\work\\alpha";
const B = "D:\\work\\beta";
const alpha = { path: A, name: "alpha" };
const beta = { path: B, name: "beta" };
const noRoots: WorkspaceView = { path: A, locked: false, roots: [] };
const single: WorkspaceView = { path: A, locked: true, roots: [alpha] };
const multi: WorkspaceView = { path: A, locked: true, roots: [alpha, beta] };
const summary = (cwd?: string): SessionSummaryView => ({
  id: "s1", title: "重构 server 启动流程", updatedAt: 0, running: false, cwd,
});

assert.equal(sessionDirBadge({ session: summary(B) }), undefined, "没有工作区帧时不预判是否应显示");
assert.equal(sessionDirBadge({ workspace: { ...noRoots, path: "" }, workingDirectory: "  " }), undefined, "未知目录不猜测");
assert.equal(sessionDirBadge({ workspace: { ...noRoots, path: "" }, session: summary(A) })?.directory, A, "重载后仍可回退到会话自己的创建目录");
assert.equal(sessionDirBadge({ workspace: { path: A, locked: true }, session: summary(A) }), undefined, "旧帧沿用锁定判据");
assert.equal(sessionDirBadge({ workspace: { path: "/", locked: true }, workingDirectory: "/" }), undefined, "POSIX 根也能作为唯一根省略");
assert.equal(sessionDirBadge({ workspace: { ...single, roots: [] } })?.directory, A, "显式无根不看旧版锁定状态");
assert.equal(sessionDirBadge({ workspace: multi })?.directory, A, "多根空态可回退新会话目标");
assert.equal(sessionDirBadge({ workspace: noRoots, session: summary() })?.directory, A, "摘要缺 cwd 时回退新会话目标");
assert.equal(sessionDirBadge({ workspace: noRoots, session: summary(B), workingDirectory: "" })?.directory, B, "投影缺失时优先信会话创建目录");
assert.equal(sessionDirBadge({ workspace: multi, session: summary(), workingDirectory: B })?.directory, B, "执行目录不依赖子代理摘要带 cwd");

assert.equal(sessionDirBadge({ workspace: single, session: summary(A) }), undefined, "创建目录和执行目录都在唯一根时省略");
assert.equal(sessionDirBadge({ workspace: single, session: summary(A), workingDirectory: "c:/WORK/ALPHA/" }), undefined, "同一 Windows 路径用目录身份比较");
assert.equal(sessionDirBadge({ workspace: { ...single, path: B }, session: summary(A) }), undefined, "外部的新会话目标不是 VS Code 根");
assert.equal(sessionDirBadge({ workspace: { ...single, path: B } })?.directory, B, "单根空态显示选中的外部目标");
assert.deepEqual(sessionDirBadge({ workspace: single, session: summary(B), workingDirectory: A }), {
  name: "alpha", directory: A, differentCreationDirectory: B,
}, "单根的外部会话执行目录切回唯一根后仍显示，悬停区分两种目录");
assert.deepEqual(sessionDirBadge({ workspace: single, session: summary(A), workingDirectory: B }), {
  name: "beta", directory: B, differentCreationDirectory: A,
}, "单根执行目录切到外部，标签跟随执行目录");
assert.deepEqual(sessionDirBadge({ workspace: multi, session: summary(B), workingDirectory: "d:/WORK/beta/" }), {
  name: "beta", directory: "d:/WORK/beta/", differentCreationDirectory: undefined,
}, "多根同目录照常显示，且悬停不重复创建目录");
const sameBasename = sessionDirBadge({ workspace: multi, session: summary(A), workingDirectory: "D:\\other\\alpha" });
assert.equal(sameBasename?.name, "alpha");
assert.equal(sameBasename?.differentCreationDirectory, A, "短名相同不代表路径相同");
assert.equal(sessionDirBadge({ workspace: noRoots, session: summary("/work/Alpha"), workingDirectory: "/work/alpha" })?.differentCreationDirectory, "/work/Alpha", "POSIX 保留大小写");

for (const [path, name] of [
  ["D:/dev/demo-app/", "demo-app"], ["/work/alpha/", "alpha"], ["/", "/"], ["C:\\", "C:\\"],
  ["\\\\server\\share\\", "share"], ["\\\\server\\share\\proj", "proj"], ["/work/one\\two", "one\\two"],
]) {
  const badge = sessionDirBadge({ workspace: noRoots, workingDirectory: path });
  assert.equal(badge?.name, name);
  assert.equal(badge?.directory, path, "详情保留完整路径原样");
}

assert.equal(MESSAGES.sessionDir.zh(A), `执行目录：${A}`);
assert.equal(MESSAGES.sessionDir.en(A), `Execution directory: ${A}`);
assert.equal(MESSAGES.sessionCreationDir.zh(B), `创建目录：${B}`);
assert.equal(MESSAGES.sessionCreationDir.en(B), `Creation directory: ${B}`);

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");
const app = read("src", "webview", "App.tsx");
const dirAt = app.indexOf("<HeaderDir state={state} />");
const titleAt = app.indexOf("<SessionTitle state={state} agentsBusy={agentsBusy} />");
const spacerAt = app.indexOf('<span className="header-spacer" />');
assert.ok(titleAt > 0 && dirAt > titleAt && spacerAt > dirAt, "目录标签在会话标题及计数后、工具栏前");
const headerDir = app.slice(app.indexOf("function HeaderDir("), app.indexOf("function BrandMark("));
assert.match(headerDir, /<span className="header-dir" title=\{title\}>/);
assert.match(headerDir, /<IconFolder size=\{12\} \/>/);
assert.match(headerDir, /className="header-dir-name">\{badge\.name\}/);
assert.doesNotMatch(headerDir, /<button|onClick|header-dir-parent/, "只读标签不是动作，不能带行内父路径");
const css = read("src", "webview", "styles", "app.css");
assert.match(css, /\.header-dir\s*\{[^}]*flex:\s*0 0\.35 auto[^}]*max-width:/, "标签不吃满余宽，也可收缩");
assert.match(css, /\.header-dir-name\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/, "长名称单行省略");
assert.match(css, /\.app\.is-mini \.header-dir\s*\{[^}]*display:\s*none/, "迷你模式随标题隐藏");
console.log("sessionDir: 目录标签与完整详情、唯一根目录判据、窄栏布局 ✓");
