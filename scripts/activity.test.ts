/**
 * 顶栏两颗面板入口的「有东西在跑」判据（用户 2026-09-19 口径）：
 * 有子代理在跑 → 子代理按钮亮起并呼吸；有后台任务在跑 → 后台任务按钮亮起并呼吸。
 *
 * 为什么单独钉：判据横跨两份数据（子代理目录的 `activity` 与后台任务的 `status`），
 * 而且**只认「活的」那一份**——判成常亮就成了噪音，判成不亮则用户看不出还在跑。
 * 界面侧只做渲染，改坏了不会报错（`App.tsx` 的 Header 里没有别的证据）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobItemView, SubagentView } from "../src/shared/chat";
import { jobsBusy, subagentsBusy } from "../src/webview/activity";

const job = (patch: Partial<JobItemView>): JobItemView => ({
  id: "j",
  kind: "bash",
  label: "npm run build",
  status: "running",
  startedAt: 0,
  ...patch,
});

const entry = (patch: Partial<SubagentView>): SubagentView => ({
  id: "s",
  label: "调研 MCP 工具清单",
  mode: "one-shot",
  ...patch,
});

// ---------- 1. 后台任务：live（running / stopping）才算在跑 ----------
{
  assert.strictEqual(jobsBusy([]), false, "没有任务 = 不亮");
  assert.strictEqual(jobsBusy([job({})]), true, "running = 在跑");
  assert.strictEqual(jobsBusy([job({ status: "stopping" })]), true, "stopping 还没结束 = 也算在跑");
  for (const status of ["completed", "killed", "failed"]) {
    assert.strictEqual(jobsBusy([job({ status })]), false, `${status} = 已收场，不亮`);
  }
  // 服务端将来新增的状态：不认识就不认领（不猜「已完成」也不猜「在跑」）
  assert.strictEqual(jobsBusy([job({ status: "paused" })]), false, "未知状态不点亮");
}
console.log("activity: 后台任务的活性判据 ✓");

// ---------- 2. 子代理：目录的 activity 是权威值 ----------
{
  assert.strictEqual(
    subagentsBusy([entry({ activity: "running" })], []),
    true,
    "目录说 running = 在跑",
  );
  assert.strictEqual(
    subagentsBusy([entry({ activity: "inactive" })], []),
    false,
    "目录说 inactive（已完成）= 不亮",
  );
}
console.log("activity: 子代理目录的活性判据 ✓");

// ---------- 3. 目录只有投影（没有 activity）时，用后台任务兜底 ----------
//
// 投影没有 `activity` 这个字段（见 `SubagentView` 的注释），角色还没问过 RPC 时
// 目录里全是「不知道」；子代理派发同时会进后台任务（`kind: 'subagent'`），
// 所以那一路能把「正在跑」捞回来。反之，只有别的 kind 在跑时**不能**点亮子代理按钮。
{
  const projected = [entry({ activity: undefined }), entry({ id: "s2", activity: undefined })];
  assert.strictEqual(subagentsBusy(projected, []), false, "什么都不知道时不亮");
  assert.strictEqual(
    subagentsBusy(projected, [job({ kind: "subagent" })]),
    true,
    "后台任务里那条 subagent 正在跑 = 点亮（目录还没有 activity 时唯一的证据）",
  );
  assert.strictEqual(
    subagentsBusy(projected, [job({ kind: "bash" })]),
    false,
    "只有 bash 在跑不该点亮子代理按钮",
  );
  assert.strictEqual(
    subagentsBusy(projected, [job({ kind: "subagent", status: "completed" })]),
    false,
    "子代理那条后台任务已收场 = 不亮",
  );
}
console.log("activity: 投影目录 + 后台任务兜底 ✓");

// ---------- 4. 界面接线：两颗按钮挂的是 is-busy（CSS 里才有呼吸） ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /const agentsBusy = subagentsBusy\(state\.subagentEntries, state\.jobs\);/.test(app),
    "Header 的子代理按钮必须用 subagentsBusy（喂目录 + 后台任务两条来源）",
  );
  assert.ok(
    /const jobsRunning = jobsBusy\(state\.jobs\);/.test(app),
    "Header 的后台任务按钮必须用 jobsBusy",
  );
  assert.ok(
    /className=\{`icon-btn\$\{state\.panel === "subagents" \? " is-active" : ""\}\$\{agentsBusy \? " is-busy" : ""\}`\}/.test(
      app,
    ),
    "子代理按钮要有 is-busy 态",
  );
  assert.ok(
    /className=\{`icon-btn\$\{state\.panel === "jobs" \? " is-active" : ""\}\$\{jobsRunning \? " is-busy" : ""\}`\}/.test(
      app,
    ),
    "后台任务按钮要有 is-busy 态",
  );

  // 样式：亮色 + 与运行圆点/思考鲸鱼**同一组关键帧**（呼吸节奏必须一致）
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  // 从选择器出现处取到那组规则结束（成组选择器 `.a, .a:hover {` 也一并落在里面）
  const group = (selector: string): string => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `app.css 里找不到 ${selector}`);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open, close);
  };
  assert.ok(
    /animation:\s*icon-glow/.test(group(".icon-btn.is-busy > svg")),
    ".icon-btn.is-busy 的图标必须复用 icon-glow 关键帧",
  );
  assert.ok(
    /color:\s*var\(--info\)/.test(group(".icon-btn.is-busy,")),
    "亮起来用活动色 var(--info)（与运行圆点同色）",
  );
  // 同特异性下后者胜：这条规则必须排在 .icon-btn.is-active 之后，否则面板开着时颜色被吃掉
  assert.ok(
    css.indexOf(".icon-btn.is-busy") > css.indexOf(".icon-btn.is-active"),
    ".icon-btn.is-busy 必须写在 .icon-btn.is-active 之后（同特异性后者胜）",
  );
}
console.log("activity: 两颗按钮的 is-busy 接线与样式 ✓");

console.log("\nactivity: all assertions passed");
