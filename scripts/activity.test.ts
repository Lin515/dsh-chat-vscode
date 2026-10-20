/**
 * 顶栏两颗面板入口的「有东西在跑」判据（用户 2026-09-19 口径）：
 * 有子代理在跑 → 子代理按钮亮起并呼吸；有后台任务在跑 → 后台任务按钮亮起并呼吸。
 * 用户 2026-10-15 口径：**有待执行的自动化任务时，后台任务按钮同样要亮**（那个抽屉
 * 里还有东西排着）。
 *
 * 为什么单独钉：判据横跨两份数据（子代理目录的 `activity` 与后台任务的 `status`，
 * 外加自动化任务的 `status`），而且**只认「活的」那一份**——判成常亮就成了噪音，
 * 判成不亮则用户看不出还在跑。界面侧只做渲染，改坏了不会报错（`App.tsx` 的 Header
 * 里没有别的证据）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobItemView, ScheduleItemView, SubagentView, TodoView } from "../src/shared/chat";
import { jobsEntrySignal, stepDotClass, subagentsBusy } from "../src/webview/activity";

const job = (patch: Partial<JobItemView>): JobItemView => ({
  id: "j",
  kind: "bash",
  label: "npm run build",
  status: "running",
  startedAt: 0,
  ...patch,
});

const schedule = (patch: Partial<ScheduleItemView>): ScheduleItemView => ({
  id: "schedule-1",
  sessionId: "s1",
  title: "跑一遍回归测试",
  prompt: "把 npm test 跑一遍",
  kind: "every",
  status: "active",
  everySeconds: 1800,
  scheduledAt: "2026-10-15T02:00:00.000Z",
  ...patch,
});

const entry = (patch: Partial<SubagentView>): SubagentView => ({
  id: "s",
  label: "调研 MCP 工具清单",
  mode: "one-shot",
  ...patch,
});

// ---------- 1. 后台任务：live（running / stopping）才算在跑（busy 档） ----------
{
  assert.strictEqual(jobsEntrySignal([], []), "off", "没有任务 = 不亮");
  assert.strictEqual(jobsEntrySignal([job({})], []), "busy", "running = 在跑（亮且呼吸）");
  assert.strictEqual(jobsEntrySignal([job({ status: "stopping" })], []), "busy", "stopping 还没结束 = 也算在跑");
  for (const status of ["completed", "killed", "failed"]) {
    assert.strictEqual(jobsEntrySignal([job({ status })], []), "off", `${status} = 已收场，不亮`);
  }
  // 服务端将来新增的状态：不认识就不认领（不猜「已完成」也不猜「在跑」）
  assert.strictEqual(jobsEntrySignal([job({ status: "paused" })], []), "off", "未知状态不点亮");
  // 子代理那一路不点亮后台任务按钮（用户 2026-09-24 口径：面板不收子代理，
  // 按钮信号同口径——否则「按钮亮着、面板却是空的」）
  assert.strictEqual(jobsEntrySignal([job({ kind: "subagent" })], []), "off", "只有子代理在跑 = 后台任务按钮不亮");
  assert.strictEqual(
    jobsEntrySignal([job({ kind: "subagent" }), job({ id: "j2" })], []),
    "busy",
    "混着时普通后台任务照样点亮",
  );
}
console.log("activity: 后台任务的活性判据 ✓");

// ---------- 1b. 自动化任务：待执行（active）亮起**但不呼吸**（pending 档） ----------
//
// 用户 2026-10-15 口径：那个抽屉里还有排着的自动化任务时，入口不该看起来是空的。
// 判据只认 `status: 'active'`（服务端说的「还会触发」）：已结束与词表外的状态都不点
// ——与后台任务那边同一条「不认识就不认领」的纪律。
//
// 档位分开的理由：`pending` 时什么都没在执行，而这只界面把「呼吸」当作活动的专用
// 信号（运行圆点 / 思考鲸鱼 / 待办刻点）；一条每日任务配上一段永远跑的动画，正是
// 用户自己抱怨过的那类谎报（见 `stepDotClass` 的注释与 `ToDo.md`）。
{
  assert.strictEqual(jobsEntrySignal([], [schedule({})]), "pending", "有待执行的任务 = 亮起（不呼吸）");
  assert.strictEqual(jobsEntrySignal([], [schedule({ status: "inactive" })]), "off", "已结束（一次性投递完）= 不亮");
  assert.strictEqual(jobsEntrySignal([], [schedule({ status: "paused" })]), "off", "词表外的状态不认领");
  assert.strictEqual(
    jobsEntrySignal([], [schedule({ status: "inactive" }), schedule({ id: "schedule-2" })]),
    "pending",
    "名册里有待执行的（哪怕混着已结束的）就点亮",
  );
  assert.strictEqual(
    jobsEntrySignal([job({ status: "completed" })], [schedule({})]),
    "pending",
    "后台任务已收场、自动化任务还排着 = 亮起（不呼吸）",
  );
  // 有东西真的在跑时**以 busy 为准**：那一刻该给的是活动信号
  assert.strictEqual(
    jobsEntrySignal([job({})], [schedule({})]),
    "busy",
    "同时在跑 → busy（呼吸），不因为还有排着的就降成 pending",
  );
  assert.strictEqual(
    jobsEntrySignal([job({ kind: "subagent" })], [schedule({ kind: "cron", expression: "0 9 * * 1-5" })]),
    "pending",
    "与子代理的过滤互不影响（两条来源各判各的）",
  );
}
console.log("activity: 自动化任务的待执行判据（亮而不呼吸） ✓");

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

// ---------- 4. 界面接线：活性信号挂到计数触发器 / 面板按钮上（CSS 里才有呼吸） ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /const agentsBusy = subagentsBusy\(state\.subagentEntries, state\.jobs\);/.test(app),
    "Header 的子代理信号必须用 subagentsBusy（喂目录 + 后台任务两条来源）",
  );
  assert.ok(
    /const jobsSignal = jobsEntrySignal\(state\.jobs, state\.schedules\);/.test(app),
    "Header 的后台任务按钮必须用 jobsEntrySignal（喂后台任务 + 自动化任务两条来源）",
  );
  // 子代理没有独立按钮：信号落在标题上的切换入口 / 计数提示（用户 2026-10-20 口径）
  assert.ok(
    /<SessionTitle state=\{state\} agentsBusy=\{agentsBusy\} \/>/.test(app),
    "标题本身就是会话切换入口（无子代理时保持纯文本，不占位）",
  );
  assert.ok(
    /className="header-subagent-count"/.test(app) && /<span className="dot dot-running" \/>/.test(app),
    "标题后的计数提示要保留，有在跑时仍亮状态点",
  );
  assert.ok(
    /className=\{`icon-btn\$\{state\.panel === "jobs" \? " is-active" : ""\}\$\{\s*\n?\s*jobsSignal === "busy" \? " is-busy" : jobsSignal === "pending" \? " is-pending" : ""\s*\n?\s*\}`\}/.test(
      app,
    ),
    "后台任务按钮要有 is-busy（在跑）与 is-pending（排着，亮而不呼吸）两档",
  );

  // 后台任务面板不收子代理行（用户 2026-09-24 口径）：过滤必须真的落在面板里，
  // 且空态判据吃的是过滤后的名单（名册里只剩子代理时显示「没有后台任务」而不是空白）
  const panels = readFileSync(join(process.cwd(), "src", "webview", "components", "Panels.tsx"), "utf8");
  assert.ok(
    /\[...jobs\]\.filter\(\(job\) => !isSubagentJob\(job\)\)\.sort\(compareJobs\)/.test(panels),
    "JobsPanel 必须先滤掉子代理行再排序（isSubagentJob 来自 jobsOrder，判据一处）",
  );

  // 样式：亮色 + 与运行圆点/思考鲸鱼**同一组关键帧**（呼吸节奏必须一致）
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");  // 从选择器出现处取到那组规则结束（成组选择器 `.a, .a:hover {` 也一并落在里面）
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
  // 「排着」那一档：同样是活动色，但**不许有动画**——那是活动的专用信号
  assert.ok(
    /color:\s*var\(--info\)/.test(group(".icon-btn.is-pending,")),
    "待执行那一档也用活动色 var(--info)",
  );
  assert.ok(
    /animation:\s*none/.test(group(".icon-btn.is-pending > svg")),
    "待执行那一档必须关掉呼吸（排着不是在跑，见 activity.ts 的 JobsEntrySignal）",
  );
  // 同特异性下后者胜：这条规则必须排在 .icon-btn.is-active 之后，否则面板开着时颜色被吃掉
  assert.ok(
    css.indexOf(".icon-btn.is-busy") > css.indexOf(".icon-btn.is-active"),
    ".icon-btn.is-busy 必须写在 .icon-btn.is-active 之后（同特异性后者胜）",
  );
  assert.ok(
    css.indexOf(".icon-btn.is-pending") > css.indexOf(".icon-btn.is-active"),
    ".icon-btn.is-pending 必须写在 .icon-btn.is-active 之后（同特异性后者胜）",
  );
  // 触发器的状态点必须复用运行圆点那组关键帧（同语义指示器同节奏）：
  // 组件给点挂的是 dot-running，样式里不许再为它造第二套动画
  assert.ok(
    !/\.subagent-trigger[^{]*\{[^}]*animation/.test(css),
    ".subagent-trigger 不得为状态点另造动画（dot-running 自带 icon-glow）",
  );
}
console.log("activity: 触发器与按钮的 is-busy 接线与样式 ✓");

// ---------- 5. 待办清单的「当前执行步骤」：会话一停下来就不再呼吸 ----------
//
// 用户 ToDo 口径（仓库根 `ToDo.md`）：会话生成中，任务清单里那一步是蓝色呼吸灯；
// 但会话中止 / 停止之后它**仍然在闪**——与实际状态不符，应当「显示为蓝色不闪动」。
//
// 根因在数据侧：`todos` 是**投影**，`in_progress` 是最后一次写入的状态；轮次收场
// （用户按停 / 这一轮出错 / 打开一个早就停下的会话）时服务端不会回头改它
// （`todosFromProjection` 的状态词表只有 pending / in_progress / completed，
// 表达不了「已停止」）。「这一步此刻真的在执行」只能由会话域的 `running` 补，
// 所以判据必须把两者组合起来——只认投影就会留下一枚永远呼吸的蓝点。
{
  const todo = (status: TodoView["status"], content: string): TodoView => ({
    id: content,
    content,
    status,
  });
  // 模型写完的三步计划：第一步做完、第二步是当前步骤、第三步还没开始
  const plan = [todo("completed", "读源码"), todo("in_progress", "改代码"), todo("pending", "跑测试")];

  // ① 会话生成中：当前执行步骤是**活的**（蓝点 + 呼吸）
  assert.deepStrictEqual(
    plan.map((item) => stepDotClass(item.status, true)),
    ["dot-ok", "dot-running", ""],
    "生成中：完成 → 绿点、当前步骤 → 呼吸蓝点、未开始 → 无点",
  );

  // ② 用户按停（ESC / 停止按钮）、这一轮出错、或打开一个早就停下的会话：
  //    **投影一个字都没变**（服务端不会回头改 in_progress），但会话已经不在生成——
  //    呼吸必须停。这几种入口在数据上是同一件事：`running` 落回 false。
  assert.strictEqual(
    stepDotClass("in_progress", false),
    "dot-running is-idle",
    "停下之后仍是 `dot-running`（蓝色 + 常驻光晕，点还是亮的），只多了 `is-idle` 关掉呼吸",
  );

  // ③ 恢复生成（又发了一条消息）：同一份投影重新开始闪
  assert.strictEqual(stepDotClass("in_progress", true), "dot-running", "恢复生成 → 重新呼吸");

  // ④ 已完成 / 未开始的步骤与会话跑不跑无关：它们本来就不呼吸，也不该被这一档影响
  assert.strictEqual(stepDotClass("completed", false), "dot-ok", "已完成的绿点与运行状态无关");
  assert.strictEqual(stepDotClass("completed", true), "dot-ok");
  assert.strictEqual(stepDotClass("pending", true), "", "未开始的步骤没有点");
  assert.strictEqual(stepDotClass("pending", false), "");
}
console.log("activity: 待办刻点的活性随会话跑 / 停切换 ✓");

// ---------- 5b. 接线与样式：判据真的接到清单上，停下那一档只关动画 ----------
{
  // 清单项在 `TodoPanel` 里（任务清单可折叠之后从 `App` 提了出来），接线断言跟着它走；
  // 传参这一跳由 TS 兜住（`running` 是必填 prop）
  const panel = readFileSync(
    join(process.cwd(), "src", "webview", "components", "TodoPanel.tsx"),
    "utf8",
  );
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  assert.ok(
    /<span className=\{`dot \$\{stepDotClass\(todo\.status, running\)\}`\} \/>/.test(panel),
    "待办刻点的活性必须同时吃「投影状态」与「会话是否还在生成」（stepDotClass，见 activity.ts）——" +
      "只按 todo.status 画就会在中止 / 停止后继续呼吸",
  );
  const idle = /\.dot-running\.is-idle\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(idle !== undefined, "应当有一条 `.dot-running.is-idle`（停下来那一档）");
  assert.ok(
    /animation:\s*none/.test(idle),
    "停下来那一档要把呼吸关掉（animation: none）",
  );
  // 同语义指示器的「待遇一致性」：这一档**只关动画**，不许自带颜色 / 光晕——
  // 用户口径是「显示为蓝色不闪动」，那份观感必须继续来自 `.dot-running`，
  // 否则同一枚刻点在停 / 跑两态下会换一种颜色（等于谎报状态变了）
  assert.ok(
    !/background|box-shadow|color\s*:/.test(idle),
    `.dot-running.is-idle 只能关动画，不许改观感（现在是 "${idle.trim()}"）`,
  );
}
console.log("activity: 待办刻点的判据接线与「只关动画」的样式 ✓");

console.log("\nactivity: all assertions passed");
