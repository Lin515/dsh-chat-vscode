/**
 * 【探针定位】勘察型 · 耗 token —— 钉「baseline 带 asOfSeq / 增量帧带 seq / 开帧
 *   asOfSeq==cursor」三条线上事实，结论固化在 projectionStore/projectionIngest；
 *   只在重开投影水位问题时跑。按 AGENTS.md 硬约束，每次运行前须获用户批准，
 *   不得随构建自动执行。
 *
 * 投影水位（seq / asOfSeq）在真实线上的形状 —— 对 `dsh/ProjectionStore` 那条设计的取证。
 *
 * `src/dsh/projectionStore.ts` 与 `projectionIngest.ts` 的整套「higher seq wins / baseline
 * 在它的 cut 上播种并清空」都建立在三个**线上事实**上。这三条以前没人核过（改造前的代码
 * 把水位整个丢掉了），所以用探针实测，而不是照契约推断：
 *
 * 1. `session/control` 的 `baseline` 帧里，每个会话的投影块**真的带 `asOfSeq`**。
 *    拿不到它，`ingestControlBaseline` 会整体退化成「逐键 apply、不清空」——
 *    设计还在，但清空那条路永远走不到。
 * 2. `projection` **增量帧真的带 `seq`**。没有它，水位比较形同虚设（`apply` 一律接受）。
 * 3. `session/follow` 开帧的 `projections.asOfSeq` 与快照的 `cursor` 一致（契约说
 *    「asOfSeq 恒等于 snapshot.cursor」）。
 *
 * 外加一条**观察**（不做硬断言，避免变成随负载飘的假防线）：增量帧的 seq 与 baseline 的
 * asOfSeq 落在同一量级／同一个序空间里——若两者来自不同的序空间，拿它们互相比较就是错的。
 *
 * 运行：npm run build:scripts && node build/projection-seq-probe.mjs
 */
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

const log = (line: string) => console.log(`[proj-seq] ${line}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const server = new SupervisorManager({ url: "", command: "dsh web --port 0 --no-open", log });

let client: DshClient | undefined;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface ProjectionBlock {
  asOfSeq?: unknown;
  values?: Record<string, unknown>;
}

let baseline: ProjectionBlock | undefined;
let baselineKeys: string[] = [];
const increments: { key: string; seq: unknown }[] = [];
let snapshotProjections: { asOfSeq?: unknown; values?: Record<string, unknown> } | undefined;
let snapshotCursor: unknown;

async function until(check_: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check_()) return true;
    await wait(stepMs);
  }
  return check_();
}

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

  const { sessionId } = await client.createSession(process.cwd());
  console.log(`   会话 ${sessionId}`);

  // 控制流要在会话建立**之后**打开：baseline 是开流那一刻的全量快照
  const control = client.followControl({
    onItem: (value) => {
      const frame = value as {
        type?: string;
        value?: { projections?: Record<string, ProjectionBlock> };
        sessionId?: string;
        key?: string;
        seq?: unknown;
      };
      if (frame?.type === "baseline") {
        const block = frame.value?.projections?.[sessionId];
        if (block) {
          baseline = block;
          baselineKeys = Object.keys(block.values ?? {});
        }
        return;
      }
      if (frame?.type === "projection" && frame.sessionId === sessionId && typeof frame.key === "string") {
        increments.push({ key: frame.key, seq: frame.seq });
      }
    },
  });

  console.log("\n=== A. control baseline 的投影块 ===");
  const gotBaseline = await until(() => baseline !== undefined, 20_000);
  check("baseline 里带这个会话的投影块", gotBaseline, gotBaseline ? `键 ${baselineKeys.length} 个` : "20s 内没等到");
  if (baseline) {
    const asOfSeq = baseline.asOfSeq;
    check(
      "块里带 asOfSeq（没有它，「清空块里没带的键」这条永远走不到）",
      typeof asOfSeq === "number" && Number.isFinite(asOfSeq),
      `asOfSeq=${JSON.stringify(asOfSeq)}（${typeof asOfSeq}）`,
    );
    console.log(`   块里的键：${baselineKeys.join(", ") || "（空）"}`);
  }

  console.log("\n=== B. projection 增量帧的 seq ===");
  await execute(sessionId, "/plan").catch(() => undefined);
  const sawIncrement = await until(() => increments.length > 0, 20_000, 200);
  check("收到 projection 增量帧", sawIncrement, sawIncrement ? `${increments.length} 帧` : "20s 内没等到");
  if (sawIncrement) {
    const withSeq = increments.filter((item) => typeof item.seq === "number");
    check(
      "增量帧带 seq（没有它，水位比较形同虚设）",
      withSeq.length === increments.length,
      increments.map((item) => `${item.key}:seq=${JSON.stringify(item.seq)}`).join("  "),
    );
  }

  console.log("\n=== C. follow 开帧的 projections.asOfSeq ===");
  const follow = client.followSession(sessionId, {
    onItem: (value) => {
      const frame = value as {
        type?: string;
        cursor?: unknown;
        projections?: { asOfSeq?: unknown; values?: Record<string, unknown> };
      };
      if (frame?.type === "snapshot") {
        snapshotProjections = frame.projections;
        snapshotCursor = frame.cursor;
      }
    },
  });
  const gotSnapshot = await until(() => snapshotProjections !== undefined, 20_000);
  check("跟随开帧带 projections 块", gotSnapshot);
  if (snapshotProjections) {
    const asOfSeq = snapshotProjections.asOfSeq;
    check(
      "开帧的 projections.asOfSeq 是数字",
      typeof asOfSeq === "number" && Number.isFinite(asOfSeq),
      `asOfSeq=${JSON.stringify(asOfSeq)}`,
    );
    check(
      "asOfSeq === cursor（契约：asOfSeq 恒等于 snapshot.cursor）",
      asOfSeq === snapshotCursor,
      `asOfSeq=${JSON.stringify(asOfSeq)} cursor=${JSON.stringify(snapshotCursor)}`,
    );
    console.log(`   开帧投影键：${Object.keys(snapshotProjections.values ?? {}).join(", ") || "（空）"}`);
  }

  console.log("\n=== D. 序空间（观察，不做硬断言） ===");
  {
    const firstSeq = increments.find((item) => typeof item.seq === "number")?.seq;
    const cut = baseline?.asOfSeq;
    console.log(
      `   baseline.asOfSeq=${JSON.stringify(cut)}  第一个增量帧 seq=${JSON.stringify(firstSeq)}  ` +
        `开帧 asOfSeq=${JSON.stringify(snapshotProjections?.asOfSeq)}`,
    );
    if (typeof firstSeq === "number" && typeof cut === "number") {
      console.log(
        `   观察：增量帧 seq ${firstSeq >= cut ? "≥" : "<"} baseline.asOfSeq（差 ${firstSeq - cut}）——` +
          `两者必须是同一个序空间，否则拿它们互相比较就是错的`,
      );
    }
  }

  await wait(300);
  follow.cancel();
  control.cancel();
  await client.archiveSession(sessionId).catch(() => undefined);

  console.log(failures === 0 ? "\n✓ 投影水位取证：全部通过" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("投影水位探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
