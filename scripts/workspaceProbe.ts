/**
 * 【探针定位】勘察型 · 零模型 token —— 钉「工作区分组要用 workspaceId 建会话」
 *   这条契约事实，结论固化在 createSession 的调用方式；只在重开分组问题时跑
 *   （自管临时 DSH_HOME，不发模型消息）。
 *
 * 工作区分组的端到端证据（用户 2026-09-14 报的「会话在 DSH Web 上都是未分组」）。
 *
 *   node build/workspace-probe.mjs
 *
 * 用**独立的临时 `DSH_HOME`** 起一个真实的 `dsh web`（完全不碰用户的 `~/.dsh`），
 * 然后按官方契约走一遍：
 *
 *   1. `workspace/create {path}` → 拿到 workspaceId（幂等：再来一次还是同一条）；
 *   2. `session/create {workspaceId}` → 新会话应当出现在该工作区的 `sessionIds` 里；
 *   3. 反证：`session/create {cwd}`（扩展此前的做法）→ 会话**不在** `sessionIds` 里
 *      —— 这正是「Web 端未分组」的根因；
 *   4. `session/list` 里两条会话的 `cwd` 都等于工作区路径（成员资格要求
 *      「header.cwd == 工作区 realpath」，所以按工作区建会话不会改变 cwd 语义）。
 *
 * 契约依据（`dsh-api-session-controller/lib/index.js` 的 `create`）：
 * `session.create accepts workspaceId or cwd, not both`；只有传 `workspaceId` 时
 * 才会 `workspace.attachSession(sessionId)`。而 `dsh-workspace` 的成员资格 =
 * 「在 sessionIds 里」**且**「header 的 canonical cwd == 工作区路径」。
 *
 * 为什么要独立 home：这个探针会注册工作区并真的建会话，不能落到用户的历史里。
 */
// 必须排在最前：supervisor 会合目录指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// DSH_HOME 由本文件自管（下文要预放内容），这里只隔离会合目录。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[workspace] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const home = mkdtempSync(join(tmpdir(), "dsh-chat-workspace-probe-"));
process.env.DSH_HOME = home;
console.log(`[probe] 临时 DSH_HOME = ${home}`);

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh", log });
let client: DshClient | undefined;
const failures: string[] = [];

function check(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const projectPath = process.cwd();

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();

  // ---------- 1. 注册工作区（幂等） ----------
  const created = await client.createWorkspace(projectPath);
  const workspaceId = created?.workspace?.workspaceId;
  check(
    typeof workspaceId === "string" && workspaceId.length > 0,
    "workspace/create 返回 workspaceId",
    `created=${String(created?.created)} id=${String(workspaceId)} title=${String(created?.workspace?.title)}`,
  );
  const again = await client.createWorkspace(projectPath);
  check(
    again?.workspace?.workspaceId === workspaceId && again?.created === false,
    "重复注册是幂等的（返回同一条记录，created=false）",
    `第二次：created=${String(again?.created)} id=${String(again?.workspace?.workspaceId)}`,
  );

  // ---------- 2. 按工作区建会话 → 会话进 sessionIds ----------
  const grouped = await client.createSession({ workspaceId: workspaceId! });
  const afterGrouped = await client.createWorkspace(projectPath);
  const groupedIds = afterGrouped?.workspace?.sessionIds ?? [];
  check(
    groupedIds.includes(grouped.sessionId),
    "按 workspaceId 建的会话被记进工作区（Web 端会分组显示）",
    `sessionId=${grouped.sessionId} sessionIds=[${groupedIds.join(", ")}]`,
  );

  // ---------- 3. 反证：只给 cwd 建的会话不属于任何工作区 ----------
  //
  // 这是扩展此前的做法，也正是用户看到的「会话都是未分组」。
  const ungrouped = await client.createSession(projectPath);
  const afterUngrouped = await client.createWorkspace(projectPath);
  const ids2 = afterUngrouped?.workspace?.sessionIds ?? [];
  check(
    !ids2.includes(ungrouped.sessionId),
    "只给 cwd 建的会话**不在** sessionIds 里（复现「未分组」的根因）",
    `sessionId=${ungrouped.sessionId} sessionIds=[${ids2.join(", ")}]`,
  );

  // ---------- 4. 两条会话的 cwd 都等于工作区路径 ----------
  const list = await client.listSessions();
  const rows = (list.items ?? []) as { sessionId: string; cwd?: string }[];
  const cwdOf = (id: string) => rows.find((row) => row.sessionId === id)?.cwd;
  const normalized = (value: string | undefined) => (value ?? "").replace(/\\/g, "/").toLowerCase();
  check(
    normalized(cwdOf(grouped.sessionId)) === normalized(projectPath) &&
      normalized(cwdOf(ungrouped.sessionId)) === normalized(projectPath),
    "两条会话的 cwd 都等于工作区路径（成员资格的另一半条件也成立）",
    `grouped=${String(cwdOf(grouped.sessionId))} ungrouped=${String(cwdOf(ungrouped.sessionId))}`,
  );

  // ---------- 5. 控制器真的走了这条路径（结构不变量） ----------
  const { readFileSync } = await import("node:fs");
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  check(
    /const workspaceId = await this\.ensureWorkspace\(\);/.test(controller),
    "newSession 先解析工作区 id 再建会话",
  );
  check(
    /createSession\(\{ workspaceId \}\)/.test(controller),
    "建会话把 workspaceId 交给服务端（否则会话永远不会进工作区分组）",
  );
} catch (error) {
  check(false, "探针执行失败", error instanceof Error ? error.message : String(error));
} finally {
  client?.dispose();
  server.stop();
}

console.log(
  failures.length ? `\nworkspace probe: 失败 ${failures.length} 项：${failures.join("；")}` : "\nworkspace probe: 全部通过",
);
process.exitCode = failures.length ? 1 : 0;
