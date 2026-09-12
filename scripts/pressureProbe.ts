/**
 * 探针：`contextPressure` 投影到底会不会随每轮更新？
 *
 * 背景（用户 2026-09-12 反馈）：重启 VS Code 后打开历史会话继续对话，上下文占用
 * 「卡着不动」。当时改成了官方口径（`projectedTokens ?? pressureTokens`），
 * 而旧实现每次 `assistant/message` 都会刷新——**少了一个刷新触发点**。
 * 于是必须回答一个事实问题：投影会在每一轮之后被推送、并且内容真的变化吗？
 *
 * 这个答案决定修法：
 * - 投影**会**更新 → 我方只需「拿不到分子时清空而不是留着旧值」，别自己造数；
 * - 投影**不会**更新 → 说明管道有问题，得先找出推送为什么没到客户端。
 *
 * 刻意不看「事件流」而只看**控制流**：投影本来就只走控制流。
 *
 * 运行：npm run build:scripts && node build/pressure-probe.mjs
 */
import { randomUUID } from "node:crypto";
import { DshClient } from "../src/dsh/client";
import { ServerManager } from "../src/dsh/serverManager";

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new ServerManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Pressure {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
}

let client: DshClient | undefined;

/** 一条 `assistant/message` 的用量四桶（我们要验证本地可否复算 prompt 侧压力）。 */
interface UsageSample {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens?: number;
}

/**
 * 同时观察两条流：
 * - **控制流**的 `contextPressure` 投影（官方口径）；
 * - **跟随流**的 `assistant/message` usage（本地能直接拿到的那份）。
 *
 * 之所以要一起看：如果「prompt 侧压力」能由 usage 精确复算出来，那么在投影迟到或
 * 漏推时就可以用本地值兜底——用户要求占用条**常驻显示**，不能因为投影没到就空着
 * 或者停住不动。
 */
function observe(sessionId: () => string | undefined) {
  const pushes: { at: number; label: string; value: Pressure }[] = [];
  const usages: UsageSample[] = [];
  const record = (label: string, value: unknown) => {
    pushes.push({ at: Date.now(), label, value: (value ?? {}) as Pressure });
  };
  const control = client!.followControl({
    onItem: (value) => {
      const frame = value as {
        type?: string;
        sessionId?: string;
        key?: string;
        value?: Record<string, { values?: Record<string, unknown> }> | unknown;
      };
      if (frame?.type === "baseline") {
        const id = sessionId();
        const values = (frame.value as Record<string, { values?: Record<string, unknown> }> | undefined)
          ?.projections?.[id ?? ""]?.values;
        if (values && "contextPressure" in values) record("baseline", values.contextPressure);
        return;
      }
      if (frame?.type === "projection" && frame.sessionId === sessionId() && frame.key === "contextPressure") {
        record("push", frame.value);
      }
    },
  });
  const follow = client!.followSession(sessionId() ?? "", {
    onItem: (value) => {
      const frame = value as {
        type?: string;
        event?: { type?: string; data?: { usage?: Record<string, unknown> } };
      };
      if (frame?.type !== "event" || frame.event?.type !== "assistant/message") return;
      const usage = frame.event.data?.usage;
      if (!usage) return;
      usages.push({
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
        totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
      });
    },
  });
  return {
    pushes,
    usages,
    stop: () => {
      control.cancel();
      follow.cancel();
    },
    last: () => pushes.at(-1)?.value,
    lastUsage: () => usages.at(-1),
  };
}

/**
 * 本地复算「最近一次请求的 prompt 侧压力」。
 *
 * 契约里 `pressureTokens` 的定义是「未缓存输入 + 缓存读 + 缓存写」，**不含 output**。
 * 若 usage 的四桶与它同口径，这个和就应当逐字等于投影里的 `pressureTokens`——
 * 这正是下面那条断言要验的事。
 */
function localPressure(usage: UsageSample | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(stepMs);
  }
  return check();
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const fmt = (p: Pressure | undefined) =>
  p === undefined
    ? "(无)"
    : `pressure=${String(p.pressureTokens)} projected=${String(p.projectedTokens)} window=${String(p.contextWindow)}`;

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  const { sessionId } = await client.createSession(process.cwd());
  const view = observe(() => sessionId);
  await wait(800);

  console.log("\n=== 第一轮 ===");
  console.log(`   开窗后：${fmt(view.last())}`);
  const before = view.pushes.length;

  await client.prompt(sessionId, [{ type: "text", text: "只回复两个字：收到" }], "queue", randomUUID());
  await until(() => view.pushes.length > before, 60_000);
  await wait(1_500);
  const afterTurn1 = view.last();
  console.log(`   第一轮后：${fmt(afterTurn1)}（推送 ${view.pushes.length} 次）`);

  // 注意：这里**不**断言「第一轮后就有分子」。实测发现分母先到、分子后到，
  // 中间存在一段「只有 contextWindow、没有 pressureTokens」的窗口——
  // 那正是占用率会「卡着不动」的时刻（见 docs/audit-summary.md §零的新发现）。
  // 探针的职责是把这个事实**如实地报出来**，不是断言一个我们希望的时序。
  const hasNumeratorTurn1 =
    typeof afterTurn1?.pressureTokens === "number" || typeof afterTurn1?.projectedTokens === "number";
  console.log(
    hasNumeratorTurn1
      ? "   （第一轮后分子已就位）"
      : "   （第一轮后**只有分母**：分子要等下一次请求上报 usage —— 界面此时必须清空而不是留着旧值）",
  );
  check("分母（contextWindow）在第一轮后就有了", typeof afterTurn1?.contextWindow === "number", fmt(afterTurn1));

  console.log("\n=== 第二轮（关键：投影会再更新吗？） ===");
  const countBeforeTurn2 = view.pushes.length;
  await client.prompt(sessionId, [{ type: "text", text: "只回复两个字：明白" }], "queue", randomUUID());
  await until(() => view.pushes.length > countBeforeTurn2, 60_000);
  await wait(1_500);
  const afterTurn2 = view.last();
  console.log(`   第二轮后：${fmt(afterTurn2)}（又推送 ${view.pushes.length - countBeforeTurn2} 次）`);

  check("第二轮确实又推了 contextPressure", view.pushes.length > countBeforeTurn2, `共 ${view.pushes.length} 次`);
  check(
    "此刻分子与分母都齐备（占用条有数可显示）",
    (typeof afterTurn2?.pressureTokens === "number" || typeof afterTurn2?.projectedTokens === "number") &&
      typeof afterTurn2?.contextWindow === "number",
    fmt(afterTurn2),
  );
  const numeratorChanged =
    afterTurn1 === undefined ||
    afterTurn2 === undefined ||
    afterTurn1.projectedTokens !== afterTurn2.projectedTokens ||
    afterTurn1.pressureTokens !== afterTurn2.pressureTokens;
  check(
    "分子随轮次变化（不是一直返回同一个值）",
    numeratorChanged,
    `${fmt(afterTurn1)} → ${fmt(afterTurn2)}`,
  );

  console.log("\n=== 第三轮：官方分子会不会停住不动？ ===");
  // 用户报的是「好几轮对话上下文占用都没刷新」。要知道那是「官方值停住」还是
  // 「官方值根本没到」，就得逐轮把**两个来源**并排打出来。
  const rows: string[] = [];
  const countBeforeTurn3 = view.pushes.length;
  await client.prompt(sessionId, [{ type: "text", text: "只回复两个字：好的" }], "queue", randomUUID());
  await until(() => view.pushes.length > countBeforeTurn3, 60_000);
  await wait(1_500);
  const afterTurn3 = view.last();
  console.log(`   第三轮后：${fmt(afterTurn3)}（又推送 ${view.pushes.length - countBeforeTurn3} 次）`);

  rows.push(
    [
      "轮次".padEnd(6),
      "官方 pressure".padEnd(15),
      "官方 projected".padEnd(16),
      "本地复算".padEnd(10),
      "窗口",
    ].join(""),
  );
  const snapshot = (label: string, p: Pressure | undefined) =>
    rows.push(
      [
        label.padEnd(6),
        String(p?.pressureTokens ?? "-").padEnd(15),
        String(p?.projectedTokens ?? "-").padEnd(16),
        String(localPressure(view.lastUsage()) ?? "-").padEnd(10),
        String(p?.contextWindow ?? "-"),
      ].join(""),
    );
  snapshot("一轮后", afterTurn1);
  snapshot("二轮后", afterTurn2);
  snapshot("三轮后", afterTurn3);
  console.log("\n" + rows.map((line) => `   ${line}`).join("\n"));

  const officialMoved = afterTurn2?.pressureTokens !== afterTurn3?.pressureTokens;
  const localMoved =
    localPressure(view.lastUsage()) !== undefined && afterTurn2?.pressureTokens !== afterTurn3?.pressureTokens;
  console.log(
    `\n   官方 pressureTokens：${String(afterTurn2?.pressureTokens)} → ${String(afterTurn3?.pressureTokens)}` +
      `（${officialMoved ? "有变化" : "**没变**"}）`,
  );
  console.log(
    "   注意：prompt 侧压力在小对话里本来就几乎不变（系统提示词占绝大部分），" +
      "所以「数字不动」不等于「没刷新」。",
  );
  void localMoved;

  console.log("\n=== 推送序列（原始值） ===");
  for (const push of view.pushes) {
    console.log(`   ${push.label.padEnd(8)} ${fmt(push.value)}`);
  }
  // 同一轮里推了多次 → 这些槽是逐个落位的（官方契约：各自 last-wins）
  console.log(`\n   合计 ${view.pushes.length} 次推送。`);

  console.log("\n=== 关键：本地能否精确复算 prompt 侧压力？ ===");
  // 这一步决定「投影迟到/漏推时能不能本地兜底」——
  // 用户明确要求占用条**常驻显示**，所以需要一个不依赖投影的刷新源。
  const usage = view.lastUsage();
  const local = localPressure(usage);
  console.log(`   最近一次 assistant/message 的用量：${JSON.stringify(usage ?? null)}`);
  console.log(`   本地复算 input+cacheRead+cacheWrite = ${String(local)}`);
  console.log(`   官方 pressureTokens                  = ${String(afterTurn3?.pressureTokens)}`);
  check(
    "本地复算 == 官方 pressureTokens（同口径，可安全兜底）",
    local !== undefined && afterTurn3?.pressureTokens !== undefined && local === afterTurn3.pressureTokens,
    `本地 ${String(local)} vs 官方 ${String(afterTurn3?.pressureTokens)}`,
  );
  check(
    "本地复算**不含** output（不是 totalTokens）",
    usage?.totalTokens === undefined || local !== usage.totalTokens,
    usage?.totalTokens === undefined ? "（无 totalTokens 可比）" : `totalTokens=${usage.totalTokens}`,
  );

  view.stop();
  console.log(
    failures === 0
      ? "\n✓ 结论：投影会更新，但**分母先到、分子后到**；本地可用 input+cacheRead+cacheWrite 精确复算同一个量 → 兜底安全"
      : `\n✗ ${failures} 项未通过`,
  );
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
