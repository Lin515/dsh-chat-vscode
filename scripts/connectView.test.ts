/**
 * 离线断言：**连接条的三类状态、文案与按钮矩阵**（`src/webview/connectView.ts` 的纯函数）。
 *
 * 为什么能离线跑（这是这次收敛的主要收益）：判定搬进纯函数之前，"这一档给哪几个按钮、
 * 条上写哪句话"是**渲染条件**——散在 `App.tsx` 的 `ConnectionBar` / `statusText` /
 * `connectingText` 里，要验它得先起一个 DOM、再模拟 React；`scripts/styles.test.ts`
 * 那一组只能按**源码正则**钉（`{isConnecting ? ( ... type: "stopReconnect" ...`）。
 * 现在给一个 `ChatState` 与一份词典就能把三类 × 每种标志逐条断言，而界面只负责渲染。
 *
 * 权威是 `docs/design-supervisor.md`「连接条按钮矩阵」那张表，逐条对应见下面各组：
 *
 * | 状态 | 什么时候 | 文案 | 按钮 |
 * |---|---|---|---|
 * | `ready` | 连上了 | — | 整条不渲染 |
 * | `connecting` | 首轮、掉线重试、外部地址的等待 | 目标 + 阶段；有失败详情时详情优先 | 停止连接 + 查看日志 |
 * | 按钮态（`stopped` / `error`） | 关掉自动连接 / 用户点过停止 / 内部不在且外部不可用（stopped）；启动类、认证类失败（error，文案改用原因） | 两轴短语併一行（` · `） | 内部在跑 → 连接内部 DSH，不在 → 启动内部 DSH；连接外部 DSH（恒显，没配 url 时置灰 + 提示）；内部在跑 → 重启内部 DSH；`needsToken` → 输入令牌；查看日志（恒显） |
 *
 * 另有三条**不许动**的口径（矩阵栏目留的两条硬约束 + 「停止连接」语义）：
 * 1. 「停止连接」只要正在连接就得给（首轮连接同样可能卡在"等就绪"上没有时长上限）；
 * 2. 「查看日志」恒显（每一档都可能是"连不上但说不清"）；
 * 3. 连接中**只**给这两个按钮——不许冒出启动/连接/重启按钮。
 *
 * 运行：npm test（**新增文件必须登记到 esbuild.scripts.mjs 的 entries**，否则静默不跑）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatState } from "../shared/chat";
import { connectViewOf, type ConnectButtonId, type ConnectTexts, type ConnectView } from "../src/webview/connectView";

/**
 * 假词典：每条文案与它的字段名**逐字相同**，于是断言里"文案对了没有"是一眼可见的
 * （真词典的中英两份由 `messages.ts` 派生，那种"翻错了"不归这一组管）。
 */
const TEXTS: ConnectTexts = {
  connecting: "connecting",
  startingInternal: "startingInternal",
  connectingInternal: "connectingInternal",
  connectingExternal: (baseUrl: string) => `connectingExternal(${baseUrl})`,
  statusInternalRunning: "statusInternalRunning",
  statusInternalNotRunning: "statusInternalNotRunning",
  statusExternalReachable: "statusExternalReachable",
  statusExternalUnreachable: "statusExternalUnreachable",
  statusExternalUnconfigured: "statusExternalUnconfigured",
  statusSeparator: " · ",
  startInternal: "startInternal",
  connectInternal: "connectInternal",
  connectExternal: "connectExternal",
  restartInternal: "restartInternal",
  externalDisabledHint: "externalDisabledHint",
  enterToken: "enterToken",
  stopReconnect: "stopReconnect",
  showLogs: "showLogs",
};

/** 假解析器：把宿主会发的那两个标记换成可辨认的字面量（真解析在 `texts.ts`）。 */
function resolve(text: string): string {
  return text.split("\n").map((line) => (line === "@connectionLost" ? "LOST" : line === "@authNeedsToken" ? "NEEDS_TOKEN" : line)).join("\n");
}

/** 一个最小的 `ChatState`（只填连接条用得到的字段）。 */
function stateOf(patch: Partial<ChatState>): ChatState {
  return { connection: "stopped", messages: [], running: false, ...patch };
}

/** 按钮 id 序列（顺序也是矩阵的一部分）。 */
function ids(view: ConnectView): string {
  return view.buttons.map((button) => button.id).join(",");
}

function buttonOf(view: ConnectView, id: ConnectButtonId) {
  return view.buttons.find((button) => button.id === id);
}

const view = (patch: Partial<ChatState>): ConnectView => connectViewOf(stateOf(patch), TEXTS, resolve);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- 1. `ready`：整条不渲染（就绪时不占位置），别的字段一概不看 ----------
{
  const ready = view({ connection: "ready", internalRunning: true, needsToken: true });
  check("ready → kind=hidden、没有文案、没有按钮", ready.kind === "hidden" && ready.text === "" && ids(ready) === "", JSON.stringify(ready));
}

// ---------- 2. `connecting`：目标 + 阶段写在文案里，按钮**只有**停止 + 日志（矩阵） ----------
{
  const internalStarting = view({ connection: "connecting", connectTarget: "internal", connectPhase: "starting" });
  check("连接中 + 内部 + starting → 文案是「正在启动内部 DSH…」", internalStarting.text === TEXTS.startingInternal, internalStarting.text);
  check(
    "连接中只给「停止连接」+「查看日志」（顺序也是它）",
    ids(internalStarting) === "stopReconnect,showLogs",
    ids(internalStarting),
  );
  check(
    "连接中不许出现启动/连接/重启内部、连接外部（用户 2026-09-18 口径）",
    !/startInternal|connectInternal|connectExternal|restartInternal/.test(ids(internalStarting)),
  );
  check("连接中「查看日志」依然是幽灵小按钮 + data-mini（恒显那条口径不变）", (() => {
    const logs = buttonOf(internalStarting, "showLogs");
    return logs?.variant === "ghost" && logs.miniHide === true && logs.icon === null;
  })());

  const internalConnecting = view({ connection: "connecting", connectTarget: "internal", connectPhase: "connecting" });
  check("连接中 + 内部 + connecting → 「正在连接内部 DSH…」", internalConnecting.text === TEXTS.connectingInternal, internalConnecting.text);

  const external = view({ connection: "connecting", connectTarget: "external", externalAddress: "http://a.b:1" });
  check(
    "连接中 + 外部 → 文案带上地址（`connectingExternal(<地址>)`）",
    external.text === "connectingExternal(http://a.b:1)",
    external.text,
  );

  const externalNoAddress = view({ connection: "connecting", connectTarget: "external" });
  check("连接中 + 外部但没配地址 → 退回「正在连接…」", externalNoAddress.text === TEXTS.connecting, externalNoAddress.text);

  const targetUnset = view({ connection: "connecting", serverUrl: "http://127.0.0.1:9/" });
  check(
    "目标未定（autoConnect 关掉且没点过按钮）→ 「正在连接… <上次地址>」",
    targetUnset.text === `${TEXTS.connecting} http://127.0.0.1:9/`,
    targetUnset.text,
  );

  const withDetail = view({ connection: "connecting", connectTarget: "internal", connectPhase: "starting", connectionDetail: "@connectionLost" });
  check("连接中**有详情时详情优先**（原因是用户最想看的）", withDetail.text === "LOST", withDetail.text);

  const tokenWhileConnecting = view({ connection: "connecting", connectTarget: "internal", needsToken: true });
  check(
    "连接中即使 needsToken 也不给「输入令牌」（那一档只有停止 + 日志）",
    ids(tokenWhileConnecting) === "stopReconnect,showLogs",
    ids(tokenWhileConnecting),
  );
}

// ---------- 3. 按钮态 `stopped`：两轴短语 + 内部不在 → 启动内部，外部恒显但置灰 ----------
{
  const stopped = view({ connection: "stopped", internalRunning: false, externalState: "unconfigured" });
  check("stopped → kind=stopped", stopped.kind === "stopped", stopped.kind);
  check(
    "按钮态文案是两轴短语併一行（内部未运行 · 外部未配置）",
    stopped.text === `${TEXTS.statusInternalNotRunning}${TEXTS.statusSeparator}${TEXTS.statusExternalUnconfigured}`,
    stopped.text,
  );
  check(
    "内部不在 → 启动内部 DSH；顺序：启动内部 → 连接外部 → 查看日志",
    ids(stopped) === "startInternal,connectExternal,showLogs",
    ids(stopped),
  );
  check("「启动内部 DSH」是主按钮（用户这一档的主动作）", buttonOf(stopped, "startInternal")?.variant === "primary");
  check("「启动内部 DSH」用加号图标（与「连接内部」的重启图标区分）", buttonOf(stopped, "startInternal")?.icon === "plus");
  check("内部不在时**没有**「重启内部 DSH」", buttonOf(stopped, "restartInternal") === undefined);
  check("内部不在时**没有**「连接内部 DSH」", buttonOf(stopped, "connectInternal") === undefined);

  const externalOff = buttonOf(stopped, "connectExternal");
  check("没配 url → 「连接外部 DSH」置灰", externalOff?.disabled === true);
  check("置灰时带悬停提示（提示挂在 disabled 外层的 span 上）", externalOff?.tip === TEXTS.externalDisabledHint, String(externalOff?.tip));
}

// ---------- 4. 按钮态 `stopped` + 内部在跑：连接内部（主）+ 外部（可点）+ 重启内部 ----------
{
  const running = view({ connection: "stopped", internalRunning: true, externalState: "reachable" });
  check(
    "内部在跑 → 文案「运行中 · 外部可达」",
    running.text === `${TEXTS.statusInternalRunning}${TEXTS.statusSeparator}${TEXTS.statusExternalReachable}`,
    running.text,
  );
  check(
    "内部在跑 → 连接内部 DSH + 连接外部 DSH + 重启内部 DSH + 查看日志",
    ids(running) === "connectInternal,connectExternal,restartInternal,showLogs",
    ids(running),
  );
  check("「连接内部 DSH」占主按钮位（与「启动内部 DSH」同一套逻辑，只是措辞不同）", buttonOf(running, "connectInternal")?.variant === "primary");
  const externalOn = buttonOf(running, "connectExternal");
  check("配了 url 且可达 → 「连接外部 DSH」可点、没有置灰提示", externalOn?.disabled !== true && externalOn?.tip === undefined);

  const unreachable = view({ connection: "stopped", internalRunning: true, externalState: "unreachable" });
  check("外部不可达 → 右半句说「不可达」，但按钮**照样可点**（连接失败写进日志）", (() => {
    const b = buttonOf(unreachable, "connectExternal");
    return unreachable.text === `${TEXTS.statusInternalRunning}${TEXTS.statusSeparator}${TEXTS.statusExternalUnreachable}` && b?.disabled !== true;
  })(), unreachable.text);
}

// ---------- 5. 按钮态 `error`：详情优先 + needsToken 时给「输入令牌」 ----------
{
  const authError = view({
    connection: "error",
    connectionDetail: "@authNeedsToken",
    needsToken: true,
    internalRunning: true,
    externalState: "unreachable",
  });
  check("error → kind=error（要用户动作的失败，与按钮态分开渲染）", authError.kind === "error", authError.kind);
  check("error 有详情 → 文案用详情（不是两轴短语）", authError.text === "NEEDS_TOKEN", authError.text);
  check(
    "needsToken → 多一枚「输入令牌」，且排在最前（顺序：令牌 → 连接内部 → 连接外部 → 重启内部 → 日志）",
    ids(authError) === "enterToken,connectInternal,connectExternal,restartInternal,showLogs",
    ids(authError),
  );
  check("「输入令牌」用钥匙图标", buttonOf(authError, "enterToken")?.icon === "key");

  const startFailure = view({ connection: "error", connectionDetail: "@serverSpawnFailed:ENOENT", internalRunning: false });
  check("启动类失败（无令牌入口）→ 详情 + 启动内部那一支", startFailure.text === "@serverSpawnFailed:ENOENT" && ids(startFailure) === "startInternal,connectExternal,showLogs", `${startFailure.text} / ${ids(startFailure)}`);

  const errorNoDetail = view({ connection: "error", internalRunning: false, externalState: "unconfigured" });
  check(
    "error 没有详情 → 退回两轴短语（`detail ?? statusText`）",
    errorNoDetail.text === `${TEXTS.statusInternalNotRunning}${TEXTS.statusSeparator}${TEXTS.statusExternalUnconfigured}`,
    errorNoDetail.text,
  );
  check("有令牌入口时按钮态仍然是 kind=error（不是 stopped）", view({ connection: "error", needsToken: true }).kind === "error");
}

// ---------- 6. 恒显与纯函数两条不变量 ----------
{
  for (const connection of ["connecting", "stopped", "error"] as const) {
    const current = view({ connection, internalRunning: connection !== "stopped", needsToken: connection !== "connecting" });
    check(`${connection} 这一档「查看日志」恒显（且永远排在最后）`, current.buttons.at(-1)?.id === "showLogs", ids(current));
  }

  const input = stateOf({ connection: "stopped", internalRunning: true, externalState: "reachable", connectTarget: "internal" });
  const first = connectViewOf(input, TEXTS, resolve);
  const second = connectViewOf(input, TEXTS, resolve);
  check("纯函数：同一份输入两次调用结果完全相同", JSON.stringify(first) === JSON.stringify(second));
  check(
    "纯函数：不改调用方给的 state（快照式读取，不写回）",
    JSON.stringify(input) === JSON.stringify(stateOf({ connection: "stopped", internalRunning: true, externalState: "reachable", connectTarget: "internal" })),
  );
}

// ---------- 7. 结构不变量：判定只有一处，界面只渲染它 ----------
//
// 这一组替代 `scripts/styles.test.ts` 第 34 组里那几条**源码结构**断言（那一组按
// `{isConnecting ? ( ... ) : ( ... )}` 这个渲染分支的形状来钉按钮矩阵，判定搬进纯函数之后
// 那个分支不存在了）。同样的口径改在这里钉：判定在 `connectView.ts`，而 `App.tsx`
// 只说"哪颗按钮发哪条指令"。
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  const flat = app.replace(/\s+/gu, " ");
  check("App.tsx 的连接条调用纯函数（判定不再散在组件里）", flat.includes("connectViewOf(state, texts"));
  check(
    "App.tsx 不再自己判两轴（`state.internalRunning === true` / `state.externalState === \"…\"` 都不该有）",
    !flat.includes("state.internalRunning === true") && !/state\.externalState\s*===\s*"/u.test(flat),
  );
  check(
    "App.tsx 不再有 statusText / connectingText 这两个局部判定",
    !/function (statusText|connectingText)\(/u.test(flat),
  );
  for (const kind of ["startInternal", "connectInternal", "connectExternal", "restartInternal"]) {
    check(
      `App.tsx 里「${kind}」这颗按钮仍然真的接了指令（别只在纯函数里存在）`,
      flat.includes(`type: "${kind}"`),
    );
  }
  // 纯 = 不依赖 React：判定要能在没有 DOM 的地方跑（本文件就是证据，这条只是把纪律写下来）
  const module = readFileSync(join(process.cwd(), "src", "webview", "connectView.ts"), "utf8");
  check("connectView.ts 不 import React / 不用 useTexts（纯模块）", !/from "react"|useTexts/u.test(module));
}

if (failures > 0) {
  console.error(`\n✗ 连接条的判定（三类状态 / 文案 / 按钮矩阵）：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 连接条的判定（三类状态 / 文案 / 按钮矩阵）全通过");
  assert.ok(true);
}
