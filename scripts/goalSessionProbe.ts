/**
 * 探针：`goal` 投影是不是**会话级**的，以及「没有目标的会话」在开帧里到底给不给
 * `goal` 键（给 `null` 还是干脆不给）。
 *
 * 为什么非要实测：扩展把 goal 存成一个**扁平字段** `controller.goal`，只在收到
 * `goal` 键时才更新。于是「新会话的开帧里没有 goal 键」就会让上一个会话的目标
 * 一直挂在界面上（用户 2026-09-12 反馈：切会话目标条也都在）。
 *
 * 契约（`dsh-goal/lib/types/types.d.ts`）只说 `goal: GoalProjection | null`
 * （"null before the first create and after a clear tombstone"），
 * **没说** null 会不会随开帧发出来——这正是必须实测的那一点。
 *
 * 运行：npm run build:scripts && node build/goal-session-probe.mjs
 */
import { SessionAdapter } from "../src/dsh/adapter";
import { goalFromProjection } from "../src/dsh/projections";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const log = (line: string) => console.log(`[goal-probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let client: DshClient | undefined;

/** 跟随一个会话，分别记下 **开帧 snapshot** 与 **控制流 baseline** 里的投影。 */
function follow(sessionId: string) {
  const adapter = new SessionAdapter(() => {});
  let snapshotValues: Record<string, unknown> | undefined;
  const controlBaseline = new Map<string, unknown>();
  const pushed = new Map<string, unknown>();

  const handle = client!.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as {
        type?: string;
        projections?: { values?: Record<string, unknown> };
      };
      adapter.applyFrame(value as never);
      if (frame?.type === "snapshot") snapshotValues = frame.projections?.values ?? {};
    },
  });

  const control = client!.followControl({
    onItem: (value) => {
      const frame = value as {
        type?: string;
        sessionId?: string;
        key?: string;
        value?: unknown;
        value2?: unknown;
      };
      const baseline = (frame as { value?: { projections?: Record<string, { values?: Record<string, unknown> }> } })
        .value?.projections?.[sessionId]?.values;
      if (frame?.type === "baseline" && baseline) {
        for (const [key, v] of Object.entries(baseline)) controlBaseline.set(key, v);
      }
      if (frame?.type === "projection" && frame.sessionId === sessionId && typeof frame.key === "string") {
        pushed.set(frame.key, frame.value);
      }
    },
  });

  return {
    adapter,
    /** 开帧 snapshot 里的投影值（`undefined` = 这一帧还没到）。 */
    snapshot: () => snapshotValues,
    controlBaseline: () => controlBaseline,
    pushed: () => pushed,
    /** 合并三种来源后的 goal 原始值（和 controller.applyProjection 的输入同源）。 */
    goal: () => pushed.get("goal") ?? snapshotValues?.goal ?? controlBaseline.get("goal"),
    stop: () => {
      handle.cancel();
      control.cancel();
    },
  };
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(stepMs);
  }
  return check();
}

const execute = (sessionId: string, line: string) =>
  client!.request<{ result?: { kind?: string; text?: string } } | undefined>("commands/execute", {
    agentId: sessionId,
    line,
    submittedAttachments: [],
  });

function keys(value: unknown): string {
  if (value === undefined) return "（没有这一帧）";
  const list = Object.keys((value ?? {}) as Record<string, unknown>);
  return list.length ? list.join(",") : "（空）";
}

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  // ---------- 会话 A：有目标 ----------
  const a = (await client.createSession(process.cwd())).sessionId;
  const viewA = follow(a);
  await wait(800);
  await execute(a, "/goal 探针：验证目标投影是否按会话隔离");
  const built = await until(() => goalFromProjection(viewA.goal()) !== undefined, 15_000);
  // 目标轮驱动会自己往下跑：拿到投影就立刻暂停，别让它真干活
  await execute(a, "/goal pause").catch(() => undefined);
  await client.cancel(a).catch(() => undefined);
  console.log(`\nA（有目标）sessionId=${a}`);
  console.log(`  建目标成功=${built}`);
  console.log(`  A 开帧 snapshot 投影键：${keys(viewA.snapshot())}`);
  console.log(`  A 控制流 baseline 投影键：${keys(Object.fromEntries(viewA.controlBaseline()))}`);
  console.log(`  A 的 goal 值：${JSON.stringify(viewA.goal())?.slice(0, 160)}`);
  console.log(`  A 解析后：${JSON.stringify(goalFromProjection(viewA.goal()) ?? null)}`);

  // ---------- 会话 B：新建、没有目标 ----------
  await wait(500);
  const b = (await client.createSession(process.cwd())).sessionId;
  const viewB = follow(b);
  const gotSnapshot = await until(() => viewB.snapshot() !== undefined, 15_000);
  await wait(1200);
  console.log(`\nB（新会话、没有目标）sessionId=${b}`);
  console.log(`  收到开帧=${gotSnapshot}`);
  console.log(`  B 开帧 snapshot 投影键：${keys(viewB.snapshot())}`);
  console.log(`  B 控制流 baseline 投影键：${keys(Object.fromEntries(viewB.controlBaseline()))}`);
  console.log(`  B 推到过的投影键：${keys(Object.fromEntries(viewB.pushed()))}`);
  const rawB = (viewB.snapshot() ?? {}) as Record<string, unknown>;
  console.log(`  **B 开帧里有没有 goal 键：${"goal" in rawB ? `有，值=${JSON.stringify(rawB.goal)}` : "没有"}**`);
  console.log(`  按扩展现在的读法，B 的 goal 会解析成：${JSON.stringify(goalFromProjection(rawB.goal) ?? null)}`);

  // ---------- 目标清掉之后，同会话里 goal 键会变成什么 ----------
  await execute(a, "/goal clear").catch(() => undefined);
  const cleared = await until(() => viewA.pushed().get("goal") === null, 10_000);
  console.log(`\nA 执行 /goal clear 后：`);
  console.log(`  推送里出现 goal=null：${cleared}，当前推送值=${JSON.stringify(viewA.pushed().get("goal"))}`);

  viewA.stop();
  viewB.stop();
  await client.archiveSession(a).catch(() => undefined);
  await client.archiveSession(b).catch(() => undefined);
  console.log("\n探针结束");
} catch (error) {
  console.error("goal-probe 失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
