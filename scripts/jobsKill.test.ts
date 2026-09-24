/**
 * 后台任务停止按钮：两段式状态机（`webview/jobsKill.ts`）与关键接线 / 样式。
 *
 * 状态机是官方 `dsh-client-ui-jobs` 的 `pressKill` 同口径——点两下才发、没受理
 * 亮「停止失败」、受理了等名册收场。这套流转错了轻则「点一下就停」，重则按钮
 * 永远卡在「请求中」，所以逐档钉住。渲染接线与样式钉的是「只在 running 行出现」
 * 「pending 禁用」「armed 档不折行」这几个肉眼难复查、坏了很难看出来的点。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobItemView } from "../src/shared/chat";
import {
  autoResetMs,
  KILL_ARM_MS,
  KILL_FAILED_MS,
  killSettled,
  phaseLive,
  pressKill,
  type KillPhase,
} from "../src/webview/jobsKill";

const job = (id: string, status: JobItemView["status"]): JobItemView => ({
  id,
  kind: "bash",
  label: id,
  status,
  startedAt: 0,
});

// ---------- 1. 按压流转：第一下 armed，第二下 pending，换行重新 armed ----------
{
  const armed = pressKill(undefined, "a");
  assert.strictEqual(armed.key, "a");
  assert.strictEqual(armed.state, "armed", "第一下只进入待确认，不发请求");

  assert.deepStrictEqual(pressKill(armed, "a"), { key: "a", state: "pending" }, "第二下（同一行还在 armed）才 pending");
  assert.deepStrictEqual(
    pressKill(armed, "b"),
    { key: "b", state: "armed" } satisfies KillPhase,
    "armed 的是另一行：本行重新 armed（面板同时只跟踪一枚按钮）",
  );
  // armed 之外再按同一行（比如 failed 档没复位时又点）：重新 armed，不发请求
  assert.deepStrictEqual(pressKill({ key: "a", state: "failed" }, "a"), { key: "a", state: "armed" });
}
console.log("jobsKill: 按压流转（两段式 + 换行重置） ✓");

// ---------- 2. 自动复位：armed / failed 有时限，pending 不许自动复位 ----------
{
  assert.strictEqual(KILL_ARM_MS, 3_000, "armed 等确认的时长与官方 KILL_ARM_MS 一致");
  assert.strictEqual(KILL_FAILED_MS, 4_000, "failed 提示的停留时长与官方 KILL_FAILED_MS 一致");
  assert.strictEqual(autoResetMs("armed"), KILL_ARM_MS);
  assert.strictEqual(autoResetMs("failed"), KILL_FAILED_MS);
  assert.strictEqual(autoResetMs("pending"), undefined, "pending 不能靠定时器收场——它要等名册把行推离 running");
}
console.log("jobsKill: 自动复位档位 ✓");

// ---------- 3. 结算帧：没受理 → failed；受理了维持 pending；别的行不搭理 ----------
{
  const pending: KillPhase = { key: "a", state: "pending" };
  assert.deepStrictEqual(killSettled(pending, "a", false), { key: "a", state: "failed" });
  assert.deepStrictEqual(
    killSettled(pending, "a", true),
    pending,
    "受理了维持 pending：行状态的收场交给名册帧（requested/already-finished 都算受理）",
  );
  assert.strictEqual(killSettled(pending, "b", false), pending, "别的行的结算与当前状态无关");
  assert.strictEqual(killSettled(undefined, "a", false), undefined);
  const armed: KillPhase = { key: "a", state: "armed" };
  assert.strictEqual(killSettled(armed, "a", false), armed, "只有 pending 消费结算帧");
}
console.log("jobsKill: 结算帧落点 ✓");

// ---------- 4. 名册更新：行离开 running → 收场；还在跑 → 保留 ----------
{
  const roster = [job("a", "running"), job("b", "stopping")];
  assert.deepStrictEqual(phaseLive({ key: "a", state: "pending" }, roster), { key: "a", state: "pending" });
  assert.strictEqual(phaseLive({ key: "b", state: "pending" }, roster), undefined, "行已推成 stopping → 状态收场");
  assert.strictEqual(phaseLive({ key: "c", state: "armed" }, roster), undefined, "整行没了（名册整表替换）→ 状态收场");
  assert.strictEqual(phaseLive(undefined, roster), undefined);
}
console.log("jobsKill: 名册驱动的收场 ✓");

// ---------- 5. 渲染接线与样式：只 running 行有按钮、pending 禁用、armed 不折行 ----------
{
  const panels = readFileSync(join(process.cwd(), "src", "webview", "components", "Panels.tsx"), "utf8");
  assert.ok(
    /if \(job\.status !== "running"\) return null;/.test(panels),
    "停止按钮只在 running 行渲染（stopping = 请求已在路上，按钮消失本身就是受理反馈）",
  );
  assert.ok(/disabled=\{state === "pending"\}/.test(panels), "请求中必须禁用按钮");
  assert.ok(
    /texts\.jobStopConfirmAction/.test(panels) && /texts\.jobStopFailed/.test(panels),
    "armed 档亮「确认停止」、failed 档亮「停止失败」（走词典，不写死中文）",
  );
  assert.ok(
    /next\.state === "pending"\) post\(\{ type: "killJob", jobId: job\.id \}\)/.test(panels),
    "只有第二下确认（pressKill 返回 pending）才真的发请求",
  );

  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const block = (selector: string) => {
    const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
    assert.ok(match, `app.css 里找不到选择器 ${selector}`);
    return match[1];
  };
  assert.ok(
    /white-space:\s*nowrap/.test(block(".job-stop")),
    "停止按钮必须 nowrap：英文「Confirm stop」比中文长一截，折行会把行撑高",
  );
  // armed / failed / 悬停的声明都写在选择器组里（`,\n` 结尾），锚在组里最后一个选择器上
  const armed = block(".job-stop.is-armed:focus-visible");
  assert.ok(
    /var\(--error\)/.test(armed) && /color-mix/.test(armed),
    "armed 档用错误色 + 错误色底（官方 stopArmed 的破坏性配色语义）",
  );
  assert.ok(
    /var\(--error\)/.test(block(".job-stop.is-failed:focus-visible")),
    "failed 档同为错误色（与「悬停透出错误色」一件事）",
  );
  assert.ok(
    /var\(--error\)/.test(block(".job-stop:focus-visible")),
    "悬停透出错误色（按钮平时看起来不像破坏性动作，悬停才提示）",
  );

  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(/killResult=\{state\.jobKill\}/.test(app), "App 要把结算帧交给 JobsPanel");

  const state = readFileSync(join(process.cwd(), "src", "webview", "state.ts"), "utf8");
  assert.ok(
    /case "jobs\/killResult":[\s\S]*?jobKill: \{ jobId: action\.jobId, ok: action\.ok \}/.test(state),
    "结算帧要落到 AppState.jobKill（整对象替换：连着两次失败也要各推进一次）",
  );

  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /case "killJob":[\s\S]*?this\.client\s*\n?\s*\.killJob\(scope\.sessionId, message\.jobId\)/.test(controller),
    "宿主要把 killJob 转成 job/kill 请求（sessionId 取当前视图绑定的会话）",
  );
  assert.ok(
    /jobs\/killResult/.test(controller),
    "宿主每条路都要回 killResult 帧——它是界面「请求中」唯一的收场信号",
  );
}
console.log("jobsKill: 渲染接线与样式 ✓");

console.log("\njobsKill: all assertions passed");
