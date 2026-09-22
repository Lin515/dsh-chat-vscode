/**
 * 【探针定位】防线型 · 耗 token —— 扩展 ↔ dsh 契约对拍：命令通道语义（/plan 走
 *   commands/execute、command/run↔done 折叠、goal 投影嵌套形状）离线断言盖不住，
 *   dsh 升级或动 plan/goal/命令链路时才有价值。按 AGENTS.md 硬约束，不得随构建
 *   自动执行，每次运行前须获用户批准（一次批准一次有效）。
 *
 * 端到端验证「斜杠命令通道 + 投影形状」，对着真实的 `dsh web` 跑。
 *
 * 覆盖本次修复里**离线断言覆盖不到**的那一半：形状与语义的权威来源是服务端，
 * 契约文件（.d.ts）只是它的声明。三组断言：
 *
 *  A. `/plan` 只认命令通道：正文前缀无效、`commands/execute` 有效、退出是 `/plan off`；
 *  B. 命令事件的折叠：`command/run`/`command/done` 真的会发出来，且适配器能把它们
 *     折成一条命令节点（这正是「手打命令有可见结果」的完整链路）；
 *  C. `goal` 投影是**嵌套**的：目标本体在 `goal` 里、轮次计数在外层 `roundsStarted`
 *     —— 用真实投影值验证，而不是照契约猜。
 *
 * 刻意不编数据：C 组的目标是用 `/goal` 命令真建出来的，值全部来自服务端。
 *
 * 运行：npm run build:scripts && node build/command-e2e.mjs
 */
import { randomUUID } from "node:crypto";
// 必须排在最前面：把会合目录指到本次探针专用的临时目录（模块求值期读一次）。
// 少了它，探针会往**用户的真实** `~/.dsh/dsh-chat-vscode/supervisors` 里起一套后台
// （2026-09-14 实测：命令写错时留下一个 2MB 的 supervisor.log 与一个目录）。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { SessionAdapter } from "../src/dsh/adapter";
import { goalFromProjection, planModeFromProjection } from "../src/dsh/projections";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

const log = (line: string) => console.log(`[cmd-e2e] ${line}`);
// 命令与其它探针、与扩展默认值一致：裸 `dsh` 在需要 `--profile` 的版本上会直接退出
// （实测 `error: --profile <name> is required`），于是 supervisor 每秒重起一次、
// 探针在两分钟后报"启动超时"，而真正的原因在命令字符串里。
const server = new SupervisorManager({ url: "", command: "dsh web --port 0 --no-open", log });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let client: DshClient | undefined;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface WireEvent {
  type: string;
  data: Record<string, unknown>;
}

/** 跟随一个会话：同时喂给真实适配器，并单独记下投影值。 */
function observe(sessionId: string) {
  const adapter = new SessionAdapter(() => {});
  const events: WireEvent[] = [];
  const projections = new Map<string, unknown>();
  const follow = client!.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as { type?: string; event?: WireEvent };
      if (frame?.type === "event" && frame.event) {
        events.push(frame.event);
        adapter.applyEvent(frame.event as never);
      }
    },
  });
  const control = client!.followControl({
    onItem: (value) => {
      const frame = value as {
        type?: string;
        sessionId?: string;
        key?: string;
        value?: unknown;
      };
      if (frame?.type === "projection" && frame.sessionId === sessionId && typeof frame.key === "string") {
        projections.set(frame.key, frame.value);
      }
      const baseline = (frame as { value?: { projections?: Record<string, { values?: Record<string, unknown> }> } })
        .value?.projections?.[sessionId]?.values;
      if (frame?.type === "baseline" && baseline) {
        for (const [key, value] of Object.entries(baseline)) projections.set(key, value);
      }
    },
  });
  return {
    adapter,
    events,
    projections,
    /** 把适配器当前折叠出的段落取出来（含命令节点）。 */
    segments: (messageId: string) =>
      adapter.snapshotMessages().find((message) => message.id === messageId)?.segments ?? [],
    stop: () => {
      follow.cancel();
      control.cancel();
    },
  };
}

async function until(check: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(stepMs);
  }
  return check();
}

/** 与控制器 `runCommand` 相同的调用形状（第三个位置参数名见 docs/dsh-server-api.md「端点位置参数名总表」）。 */
const execute = (sessionId: string, line: string) =>
  client!.request<{ result?: { kind?: string; text?: string } } | undefined>("commands/execute", {
    agentId: sessionId,
    line,
    submittedAttachments: [],
  });

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  // ================= A. /plan 的通道与生效状态 =================
  console.log("\n=== A. /plan 只认命令通道，且生效状态要算上 pending ===");
  {
    const { sessionId } = await client.createSession(process.cwd());
    const view = observe(sessionId);
    await wait(600);
    try {
      // ① 正文前缀：扩展旧做法，服务端不认
      await client.prompt(sessionId, [{ type: "text", text: "/plan 你好" }], "queue", randomUUID());
      await until(() => view.events.some((e) => e.type === "turn/end"), 60_000, 300);
      check("正文写「/plan 」不会进入计划模式", effectivePlan(view) === false, `生效=${effectivePlan(view)}`);

      // ② 轮次进行中发 `/plan`：这是**只读 active 会出错**的那条路径。
      //    发出的选择要等下一个被接受的 pre-step 才落日志，于是投影里是
      //    `{active:false, pending:true}`；裸 active 会读成「没进入」。
      void client.prompt(
        sessionId,
        [{ type: "text", text: "从 1 数到 300，每个数字单独占一行，不要省略。" }],
        "queue",
        randomUUID(),
      );
      await until(() => view.events.some((e) => e.type === "turn/start"), 30_000, 200);
      const entered = await execute(sessionId, "/plan");
      const enterText = entered?.result?.text ?? "";
      const sawPending = await until(() => planProjection(view)?.pending === true, 15_000, 100);
      check(
        "轮次进行中的选择会先挂起（投影出现 pending=true）",
        sawPending || planProjection(view)?.active === true,
        `投影=${JSON.stringify(planProjection(view) ?? null)} 文案=${JSON.stringify(enterText)}`,
      );
      if (sawPending) {
        const raw = planProjection(view)!;
        check(
          "挂起时 active 仍为 false（裸读 active 的旧算法在这里会说「没进入」）",
          raw.active === false,
          JSON.stringify(raw),
        );
      }
      // 无论服务端把它落成 committed 还是 queued，**生效**状态都必须是「已进入」
      check(
        "commands/execute「/plan」后生效状态为「已进入计划模式」",
        effectivePlan(view) === true,
        `投影=${JSON.stringify(planProjection(view) ?? null)} 文案=${JSON.stringify(enterText)}`,
      );
      check(
        "返回 result.kind=success",
        entered?.result?.kind === "success",
        JSON.stringify(entered?.result ?? null),
      );
      await client.cancel(sessionId).catch(() => undefined);
      await until(() => !view.events.length || view.events.filter((e) => e.type === "turn/end").length > 0, 15_000, 200);

      // ③ 命令通道：退出（`/plan off`，不是 `/plan`）
      await execute(sessionId, "/plan off");
      await until(() => effectivePlan(view) === false, 5_000);
      check("commands/execute「/plan off」退出计划模式", effectivePlan(view) === false);

      // ④ 不存在的命令：返回空值（客户端据此提示「没有这条命令」）
      const unknown = await execute(sessionId, "/definitely-not-a-command");
      check("不存在的命令返回 undefined", unknown === undefined, JSON.stringify(unknown ?? null));
    } finally {
      view.stop();
      await client.archiveSession(sessionId).catch(() => undefined);
    }
  }

  // ================= B. 命令事件的折叠 =================
  console.log("\n=== B. command/run ↔ command/done 折叠成节点 ===");
  {
    const { sessionId } = await client.createSession(process.cwd());
    const view = observe(sessionId);
    await wait(600);
    try {
      await execute(sessionId, "/plan");
      const sawRun = await until(() => view.events.some((e) => e.type === "command/run"), 8_000);
      const sawDone = await until(() => view.events.some((e) => e.type === "command/done"), 8_000);
      check("服务端确实发出 command/run", sawRun);
      check("服务端确实发出 command/done", sawDone);

      const runs = view.events.filter((e) => e.type === "command/run");
      const dones = view.events.filter((e) => e.type === "command/done");
      const paired = runs.some((run) => dones.some((done) => done.data.commandId === run.data.commandId));
      check("两个事件按 commandId 配对", paired, `run=${runs.length} done=${dones.length}`);

      // 适配器折出来的命令节点
      const commands = view
        .adapter.snapshotMessages()
        .flatMap((message) => message.segments)
        .filter((segment) => segment.kind === "command");
      check("适配器折出了命令节点", commands.length >= 1, `${commands.length} 个`);
      const node = commands[0];
      check(
        "节点已结算为 ok 且带结果文案",
        node?.kind === "command" && node.command.state === "ok" && Boolean(node.command.text),
        node?.kind === "command" ? JSON.stringify(node.command) : "（无节点）",
      );
      check(
        "命令名/参数取自事件本体",
        node?.kind === "command" && node.command.name === "plan",
        node?.kind === "command" ? node.command.name : "（无节点）",
      );
    } finally {
      view.stop();
      await client.archiveSession(sessionId).catch(() => undefined);
    }
  }

  // ================= C. goal 投影的真实形状 =================
  console.log("\n=== C. goal 投影是嵌套的（真实值） ===");
  {
    const { sessionId } = await client.createSession(process.cwd());
    const view = observe(sessionId);
    await wait(600);
    let created = false;
    try {
      // 真实建一个目标（`/goal <objective>`），立刻读投影，读完马上清掉，
      // 不让目标轮驱动跑下去
      const outcome = await execute(sessionId, "/goal 用一句话说明这个仓库是做什么的");
      created = await until(() => goalProjection(view) !== undefined && goalProjection(view) !== null, 10_000);
      const raw = goalProjection(view);
      check("建目标后 goal 投影非空", created, JSON.stringify(raw ?? null));
      if (created) {
        const shape = raw as Record<string, unknown>;
        check(
          "投影顶层是 { goal, roundsStarted, createdAt, updatedAt }",
          typeof shape === "object" &&
            shape !== null &&
            "goal" in shape &&
            "roundsStarted" in shape &&
            "createdAt" in shape,
          Object.keys(shape ?? {}).join(","),
        );
        const inner = shape.goal as Record<string, unknown> | undefined;
        check(
          "目标本体嵌在 goal 里，带 objective/phase/maxGoalRounds",
          Boolean(inner && typeof inner.objective === "string" && typeof inner.phase === "string" && "maxGoalRounds" in inner),
          JSON.stringify(inner ?? null),
        );
        check(
          "roundsStarted 在**外层**（不在 goal 本体里）",
          typeof shape.roundsStarted === "number" && inner?.roundsStarted === undefined,
          `外层=${String(shape.roundsStarted)} 内层=${String(inner?.roundsStarted)}`,
        );

        // 解析函数读真实投影必须拿到目标（扁平读会得到 undefined）
        const parsed = goalFromProjection(raw);
        check(
          "goalFromProjection 能读出真实投影",
          Boolean(parsed && parsed.objective.length > 0 && parsed.phase !== "complete"),
          JSON.stringify(parsed ?? null),
        );
      }
      console.log(`   commands/execute 返回：${JSON.stringify(outcome?.result ?? null)}`);
    } finally {
      // 无论断言结果如何都要清掉，避免目标轮驱动继续跑
      await execute(sessionId, "/goal clear").catch(() => undefined);
      await wait(500);
      view.stop();
      await client.archiveSession(sessionId).catch(() => undefined);
    }
  }

  console.log(failures === 0 ? "\n✓ 命令通道与投影形状 E2E：全部通过" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("cmd-e2e 失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}

/** `plan` 投影的原始值（undefined = 还没收到过）。 */
function planProjection(view: { projections: Map<string, unknown> }): { active?: boolean; pending?: boolean } | undefined {
  const value = view.projections.get("plan") as { active?: boolean; pending?: boolean } | null | undefined;
  return value ?? undefined;
}

/**
 * 计划模式的**生效**状态：与控制器同口径（`planModeFromProjection`）。
 * 直接调产品代码而不是在这里重写一遍表达式，否则两边会各自飘。
 */
function effectivePlan(view: { projections: Map<string, unknown> }): boolean | undefined {
  const raw = view.projections.get("plan");
  return raw === undefined ? undefined : planModeFromProjection(raw);
}

/** `goal` 投影的原始值（undefined = 还没收到过）。 */
function goalProjection(view: { projections: Map<string, unknown> }): unknown {
  return view.projections.get("goal");
}
