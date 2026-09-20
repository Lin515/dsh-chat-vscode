/**
 * 【探针定位】勘察型 · 耗 token —— 钉「/plan 走命令通道、正文前缀无效」这条事实；
 *   结论已被 commandE2E 的 A 组断言收编为防线，本探针只在需要看原始反应时跑。
 *   按 AGENTS.md 硬约束，每次运行前须获用户批准，不得随构建自动执行。
 *
 * 探针：`/plan` 到底是「命令」还是「普通消息」？
 *
 * 背景：扩展的「进入计划模式」是给消息正文加 `/plan ` 前缀后按普通 prompt 发出，
 * 退出时发一条正文为 `/plan` 的消息；而官方客户端走的是
 * `ctx.remote.commands.execute(sessionId, "/plan off", [])`（命令通道）。
 * 本探针实测服务端对两种路径的真实反应，判断扩展的做法是否真的生效。
 *
 * 判定依据：`plan` 投影的 `active` 字段。
 *
 * 运行：npm run build:scripts && node build/plan-command-probe.mjs
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[plan-probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { randomUUID } from "node:crypto";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const log = () => {};
const server = new SupervisorManager({ url: "", command: "dsh", log });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  /** `plan` 投影的 active。 */
  planActive: boolean | undefined;
}

let client: DshClient | undefined;
try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  /** 打开会话，跑一次动作，返回 plan 投影的 active。 */
  async function scenario(label: string, act: (sessionId: string) => Promise<void>): Promise<void> {
    const { sessionId } = await client!.createSession(process.cwd());
    let planActive: boolean | undefined;

    const follow = client!.followSession(sessionId, {
      onItem: (value) => {
        const frame = value as { type?: string; event?: { type?: string; data?: unknown } };
        if (frame?.type !== "event" || frame.event?.type !== "plan/mode") return;
        planActive = Boolean((frame.event.data as { active?: boolean })?.active);
      },
    });
    const control = client!.followControl({
      onItem: (value) => {
        const frame = value as {
          type?: string;
          sessionId?: string;
          key?: string;
          value?: { active?: boolean };
          value2?: unknown;
        };
        // 控制流 baseline / projection 都带 plan 投影
        const fromBaseline = (frame as { value?: { projections?: Record<string, { values?: { plan?: { active?: boolean } } }> } })
          .value?.projections?.[sessionId]?.values?.plan;
        if (fromBaseline) planActive = Boolean(fromBaseline.active);
        if (frame?.type === "projection" && frame.sessionId === sessionId && frame.key === "plan") {
          planActive = Boolean((frame.value as { active?: boolean })?.active);
        }
      },
    });
    await wait(700);

    await act(sessionId);
    await wait(3500);

    console.log(`${label}：plan.active = ${String(planActive)}`);

    follow.cancel();
    control.cancel();
  }

  console.log("=== 服务端对 /plan 的真实反应 ===\n");

  // 1) 正文以 `/plan ` 前缀的普通 prompt（扩展「进入计划模式」的做法）
  await scenario("① prompt 正文「/plan 你好」", async (sessionId) => {
    await client!.prompt(sessionId, [{ type: "text", text: "/plan 你好" }], "queue", randomUUID());
  });

  // 2) 走命令通道（官方「退出」的做法），先进入再退出
  await scenario("② commands/execute「/plan」（进入？）", async (sessionId) => {
    await client!.request("commands/execute", {
      agentId: sessionId,
      line: "/plan",
      submittedAttachments: [],
    });
  });

  await scenario("③ commands/execute「/plan off」（退出？）", async (sessionId) => {
    await client!.request("commands/execute", {
      agentId: sessionId,
      line: "/plan off",
      submittedAttachments: [],
    });
  });

  // 3) 先经命令通道进入，再发一条普通消息，确认进入是否真的生效
  {
    const { sessionId } = await client.createSession(process.cwd());
    let planActive: boolean | undefined;
    const control = client.followControl({
      onItem: (value) => {
        const frame = value as { type?: string; sessionId?: string; key?: string; value?: { active?: boolean } };
        if (frame?.type === "projection" && frame.sessionId === sessionId && frame.key === "plan") {
          planActive = Boolean(frame.value?.active);
        }
      },
    });
    await wait(700);
    const entered = await client.request<{ ok?: boolean } | undefined>("commands/execute", {
      agentId: sessionId,
      line: "/plan",
      submittedAttachments: [],
    });
    await wait(2500);
    console.log(`\n④ commands/execute「/plan」返回值 = ${JSON.stringify(entered)}`);
    console.log(`   → plan.active = ${String(planActive)}`);
    control.cancel();
  }

  // 4) 直接列出 /plan 命令是否存在于命令目录
  {
    const { sessionId } = await client.createSession(process.cwd());
    const commands = await client.request<{ name?: string }[]>("commands/list", { agentId: sessionId });
    const names = (commands ?? []).map((c) => String(c?.name));
    console.log(`\n⑤ 命令目录（${names.length} 个）：${names.join(", ")}`);
  }
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
