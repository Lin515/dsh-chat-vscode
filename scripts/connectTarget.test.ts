/**
 * 离线断言：**选路**（`connectTarget.chooseTarget`，用户 2026-09-18 口径）。
 *
 * 这是本次机制改动里唯一有分支组合的地方（内部在/不在 × 外部配了/没配 × 可达/不可达），
 * 而它的每一条分支都对应界面上一种真实处境，所以逐条钉住：
 *
 * - **内部优先**：内部守护进程在跑 → 连内部，**不管**外部配没配、可不可达
 *   （配了 url 不再等于"用外部"，那是被本次改动作废的旧口径）；
 * - **外部备用**：内部不在、而外部地址**配了且此刻可达** → 连外部（不启动内部）；
 * - **都没有**：内部不在、外部没配或不可达 → **拉起一套内部**（`start: true`）；
 * - 可达性只在"配了地址"时才有意义：没配地址时不产生探测，状态是 `unconfigured`。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { chooseTarget, describeFacts, externalStateOf, type TargetFacts } from "../src/dsh/connectTarget";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 六种组合（内部 × 外部三态）逐条过一遍。 */
const cases: Array<{ facts: TargetFacts; target: string; start: boolean; why: string }> = [
  {
    facts: { internalRunning: true, externalConfigured: true, externalReachable: true },
    target: "internal",
    start: false,
    why: "内部优先：内部在跑就不看外部",
  },
  {
    facts: { internalRunning: true, externalConfigured: true, externalReachable: false },
    target: "internal",
    start: false,
    why: "内部在跑 + 外部不可达：仍是内部（且不重启它）",
  },
  {
    facts: { internalRunning: true, externalConfigured: false, externalReachable: false },
    target: "internal",
    start: false,
    why: "内部在跑 + 没配外部：内部",
  },
  {
    facts: { internalRunning: false, externalConfigured: true, externalReachable: true },
    target: "external",
    start: false,
    why: "内部不在 + 外部可达：备用顶上（**不**顺手起内部）",
  },
  {
    facts: { internalRunning: false, externalConfigured: true, externalReachable: false },
    target: "internal",
    start: true,
    why: "内部不在 + 外部不可达：备用不算数 → 启动内部",
  },
  {
    facts: { internalRunning: false, externalConfigured: false, externalReachable: false },
    target: "internal",
    start: true,
    why: "都没有：启动内部",
  },
];

for (const item of cases) {
  const plan = chooseTarget(item.facts);
  check(
    `${item.why} → ${item.target}${item.start ? "（启动）" : ""}`,
    plan.target === item.target && plan.start === item.start,
    `实际 ${plan.target}${plan.start ? "（启动）" : ""}`,
  );
}

// ---------- 外部轴的界面状态 ----------
check("外部没配 → unconfigured（不探测）", externalStateOf(cases[2].facts) === "unconfigured");
check("外部配了且可达 → reachable", externalStateOf(cases[0].facts) === "reachable");
check("外部配了但不可达 → unreachable", externalStateOf(cases[1].facts) === "unreachable");

// ---------- 诊断串（日志里那半句） ----------
check(
  "describeFacts 把两个轴都写出来",
  describeFacts(cases[4].facts) === "内部=未运行，外部=不可达",
  describeFacts(cases[4].facts),
);
check(
  "describeFacts 区分“未配置”与“不可达”（否则日志里分不清是没填还是连不上）",
  describeFacts(cases[5].facts) === "内部=未运行，外部=未配置",
  describeFacts(cases[5].facts),
);

// ---------- 选路是纯函数：同一份输入永远给同一份输出（粘性目标的依据） ----------
{
  const facts = cases[3].facts;
  const first = chooseTarget(facts);
  const second = chooseTarget({ ...facts });
  check(
    "同样的事实 → 同样的结论（自动重试不会在两条路之间摇摆）",
    first.target === second.target && first.start === second.start,
  );
}

if (failures > 0) {
  console.error(`\n✗ 选路：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 选路（内部优先 / 外部备用 / 都没有则启动内部 / 外部三态）全通过");
  assert.ok(true);
}
