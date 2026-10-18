/**
 * 离线断言：**选路**（`connectTarget.chooseTarget`，用户 2026-09-18 与 2026-10-18 口径）。
 *
 * 这是本次机制改动里唯一有分支组合的地方（内部在/不在 × 外部配了/没配 × 可达/不可达 ×
 * 桌面端配了/没配 × 在跑/可连接 × 内部命令可用/不可用），而它的每一条分支都对应界面上一种
 * 真实处境，所以逐条钉住：
 *
 * - **内部优先**：内部守护进程在跑 → 连内部，**不管**外部配没配、可不可达
 *   （配了 url 不再等于"用外部"，那是被本次改动作废的旧口径）、也不管桌面端在不在跑；
 * - **外部备用**：内部不在、而外部地址**配了且此刻可达** → 连外部（不启动内部）；
 * - **桌面端也是"已在跑的服务"**（用户 2026-10-18 口径）：内部不在、外部不算数，而配了
 *   `dshChat.desktopExecutable` 且那套服务**真的可连接** → 接它。桌面端的服务随应用启动
 *   即跑，扩展连的是同一个服务进程，能继续它正开着的会话（见 `docs/design-desktop.md`）；
 * - **都没有**：拉起一套内部；内部那一轴不存在（没配 `dshChat.command`）而配了桌面端 → 拉起桌面端。
 *
 * 2026-10-19 补上**内部那一轴的存在性**：留空启动命令 = 没有内部 DSH，于是
 * 「内部在跑」不再有资格选内部（那可能是别的窗口那套，本窗口按命令行辨认，跟它没关系）、
 * 没有可选项时也**不许**兜底成"启动内部"（那会拿空命令去 spawn）。
 *
 * 两条容易搞反的判据各自钉一条：「进程在跑」不等于「可连接」（选路看后者），
 * 「配了路径」不等于「服务可用」（配了但不可连接要回落到启动内部）。
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

/** 一份"什么都没有"的事实，逐例覆盖其中几项。 */
function factsOf(patch: Partial<TargetFacts> = {}): TargetFacts {
  return {
    internalRunning: false,
    internalConfigured: true,
    externalConfigured: false,
    externalReachable: false,
    desktopConfigured: false,
    desktopRunning: false,
    desktopAttachable: false,
    ...patch,
  };
}

const cases: Array<{ facts: TargetFacts; target?: string; start?: boolean; why: string }> = [
  {
    facts: factsOf({ internalRunning: true, externalConfigured: true, externalReachable: true, desktopConfigured: true, desktopRunning: true, desktopAttachable: true }),
    target: "internal",
    start: false,
    why: "内部优先：内部在跑就不看外部与桌面端",
  },
  {
    facts: factsOf({ internalRunning: true, externalConfigured: true, externalReachable: false }),
    target: "internal",
    start: false,
    why: "内部在跑 + 外部不可达：仍是内部（且不重启它）",
  },
  {
    facts: factsOf({ internalRunning: true, externalConfigured: false, externalReachable: false }),
    target: "internal",
    start: false,
    why: "内部在跑 + 没配外部：内部",
  },
  {
    facts: factsOf({ externalConfigured: true, externalReachable: true }),
    target: "external",
    start: false,
    why: "内部不在 + 外部可达：备用顶上（**不**顺手起内部）",
  },
  {
    facts: factsOf({ externalConfigured: true, externalReachable: false }),
    target: "internal",
    start: true,
    why: "内部不在 + 外部不可达：备用不算数 → 启动内部",
  },
  {
    facts: factsOf(),
    target: "internal",
    start: true,
    why: "都没有：启动内部",
  },
  {
    facts: factsOf({ externalConfigured: true, externalReachable: true, desktopConfigured: true, desktopRunning: true, desktopAttachable: true }),
    target: "external",
    start: false,
    why: "外部可达优先于桌面端（外部是用户自己配的那个地址）",
  },
  {
    facts: factsOf({ desktopConfigured: true, desktopRunning: true, desktopAttachable: true }),
    target: "desktop",
    start: false,
    why: "内部不在、外部没配，桌面端可连接：接它（**不**另起一套内部 DSH，避免两套进程抢同一份 home）",
  },
  {
    facts: factsOf({ desktopConfigured: true, desktopRunning: true, desktopAttachable: false }),
    target: "internal",
    start: true,
    why: "桌面端进程在跑但**不可连接**（凭据读不到 / 票被拒）：选路不看「在跑」，回落启动内部",
  },
  {
    facts: factsOf({ desktopConfigured: true, desktopAttachable: true }),
    target: "desktop",
    start: false,
    why: "可连接蕴含在跑，不必再看 desktopRunning",
  },
  {
    facts: factsOf({ desktopConfigured: true }),
    target: "internal",
    start: true,
    why: "配了桌面端但它没在跑：先启动内部（桌面端要用户点头才拉 GUI）",
  },
  {
    facts: factsOf({ internalConfigured: false, desktopConfigured: true, desktopRunning: true }),
    target: "desktop",
    start: true,
    why: "内部启动命令不可用 + 配了桌面端：这一支才拉起桌面端",
  },
  {
    facts: factsOf({ internalConfigured: false, desktopConfigured: false }),
    why: "内部命令不可用又没有桌面端：**没有可选项**（不兜底启动内部——那是拿空命令去 spawn）",
  },
  // ---------- 内部那一轴不存在（`dshChat.command` 留空，用户 2026-10-19 口径） ----------
  {
    facts: factsOf({ internalConfigured: false, internalRunning: true }),
    why: "内部在跑但本窗口没配命令：那一轴不存在，**不接**（那是别人的套，按命令行辨认）",
  },
  {
    facts: factsOf({ internalConfigured: false, internalRunning: true, externalConfigured: true, externalReachable: true }),
    target: "external",
    start: false,
    why: "内部在跑但没配命令 → 轮到外部（不因为「内部在跑」就去接它）",
  },
  {
    facts: factsOf({ internalConfigured: false, internalRunning: true, desktopConfigured: true, desktopAttachable: true }),
    target: "desktop",
    start: false,
    why: "内部在跑但没配命令、桌面端可连接 → 接桌面端",
  },
  {
    facts: factsOf({ internalConfigured: false, desktopConfigured: true, desktopRunning: true, desktopAttachable: false }),
    target: "desktop",
    start: true,
    why: "没配命令 + 桌面端在跑但不可连接：拉起桌面端（**不**回落启动内部）",
  },
  {
    facts: factsOf({ internalConfigured: false, externalConfigured: true, externalReachable: false, desktopConfigured: false }),
    why: "没配命令 + 外部配了但不可达 + 没有桌面端：没有可选项（外部不可达不算数）",
  },
];

for (const item of cases) {
  const plan = chooseTarget(item.facts);
  const actual = plan ? `${plan.target}${plan.start ? "（启动）" : ""}` : "（没有可选项）";
  const expected = item.target ? `${item.target}${item.start ? "（启动）" : ""}` : "（没有可选项）";
  check(`${item.why} → ${expected}`, actual === expected, `实际 ${actual}`);
}

// ---------- 外部轴的界面状态 ----------
check("外部没配 → unconfigured（不探测）", externalStateOf(cases[5].facts) === "unconfigured");
check("外部配了且可达 → reachable", externalStateOf(cases[0].facts) === "reachable");
check("外部配了但不可达 → unreachable", externalStateOf(cases[1].facts) === "unreachable");

// ---------- 诊断串（日志里那半句） ----------
check(
  "describeFacts 把两个轴都写出来",
  describeFacts(cases[4].facts) === "内部=未运行，外部=不可达",
  describeFacts(cases[4].facts),
);
check(
  "describeFacts 区分「未配置」与「不可达」（否则日志里分不清是没填还是连不上）",
  describeFacts(cases[5].facts) === "内部=未运行，外部=未配置",
  describeFacts(cases[5].facts),
);
check(
  "没配桌面端时**不多写**那半句（日志不该为没用到的东西变长）",
  !describeFacts(cases[5].facts).includes("桌面端"),
  describeFacts(cases[5].facts),
);
check(
  "配了桌面端且可连接 → 「桌面端=可连接」",
  describeFacts(cases[7].facts) === "内部=未运行，外部=未配置，桌面端=可连接",
  describeFacts(cases[7].facts),
);
check(
  "配了桌面端但只在跑 → 「在跑但不可连接」（这两态在日志里必须分得开）",
  describeFacts(cases[8].facts) === "内部=未运行，外部=未配置，桌面端=在跑但不可连接",
  describeFacts(cases[8].facts),
);
check(
  "配了桌面端但没在跑 → 「未运行」",
  describeFacts(cases[10].facts) === "内部=未运行，外部=未配置，桌面端=未运行",
  describeFacts(cases[10].facts),
);
check(
  "没配启动命令 → 「内部=未配置」（与「未运行」必须分得开：用户报的就是「我都没配它怎么起来了」）",
  describeFacts(cases[12].facts) === "内部=未配置，外部=未配置",
  describeFacts(cases[12].facts),
);
check(
  "内部在跑但没配命令 → 仍写「未配置」（那一轴不存在，「运行中」会让日志自相矛盾）",
  describeFacts(cases[13].facts) === "内部=未配置，外部=未配置",
  describeFacts(cases[13].facts),
);

// ---------- 选路是纯函数：同一份输入永远给同一份输出（粘性目标的依据） ----------
{
  const facts = cases[3].facts;
  const first = chooseTarget(facts);
  const second = chooseTarget({ ...facts });
  check(
    "同样的事实 → 同样的结论（自动重试不会在两条路之间摇摆）",
    first?.target === second?.target && first?.start === second?.start,
  );
}

if (failures > 0) {
  console.error(`\n✗ 选路：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 选路（内部优先 / 外部备用 / 桌面端可连接 / 都没有则启动内部 / 桌面端回落 / 内部未配置时没有可选项）全通过",
  );
  assert.ok(true);
}
