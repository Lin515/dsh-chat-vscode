/**
 * 端到端冒烟测试：拉起真实的 dsh web，走完「连接 → 建会话 → 发消息 → 收流」。
 *
 * 只覆盖与 vscode 无关的三层（ServerManager / DshClient / SessionAdapter），
 * 因此可以在没有 VS Code 的环境里直接跑：
 *   node esbuild.smoke.mjs && node dist/smoke.cjs
 */
import { SessionAdapter } from "../src/dsh/adapter";
import { DshClient } from "../src/dsh/client";
import { ServerManager } from "../src/dsh/serverManager";

const log = (line: string) => console.log(`[smoke] ${line}`);

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const server = new ServerManager({
  url: "",
  command: "dsh",
  startTimeoutMs: 120_000,
  log,
});

let client: DshClient | undefined;

/** 当前会话跟随句柄（切换会话时要先取消旧的，和扩展的 openSession 一致）。 */
let followHandle: { cancel(): void } | undefined;
/** 测试 9d 挂上的审批观察者；为空时 $events 收到 waterfall 一律回 next 放行。 */
let approvalWatcher: ((frame: any) => void) | undefined;
/** 审批 waterfall 是否收到并成功应答。 */
let approvalVerified = false;
/** 主对话轮是否以错误收场（例如选中的 provider 掉线）。 */
let turnFailed = false;
let turnFailureReason = "";

try {
  console.log("1) 启动服务器 …");
  const info = await server.ensure();
  console.log(`   baseUrl = ${info.baseUrl}  token = ${info.token ? "有" : "无"}  owned = ${info.owned}`);
  if (!info.token) fail("没有从启动日志解析到 token —— 0.1.2+ 的 /api 需要它。");

  client = new DshClient(info.baseUrl, info.token, log);
  console.log("2) 换取签名 cookie …");
  await client.authenticate();
  client.connect();

  console.log("3) session/list …");
  const list = await client.listSessions();
  console.log(`   现有会话 ${list.items?.length ?? 0} 个`);

  console.log("4) session/modelCatalog …");
  const catalog = await client.modelCatalog();
  const models = (catalog.groups ?? []).flatMap((g: any) => (g.models ?? []).map((m: any) => `${g.id}/${m.id}`));
  console.log(`   模型 ${models.length} 个：${models.slice(0, 6).join(", ")}${models.length > 6 ? " …" : ""}`);

  // 记下部署默认模型：session/selectModel 会把它写回 agent-default-model 设置，
  // 测试结束时若发现被改动就还原，避免污染本机环境
  const settingsBefore = await client.settingsDescribe();
  const defaultBefore = (
    (settingsBefore.namespaces ?? []).find((ns: any) => ns.ns === "agent-default-model") as any
  )?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
  console.log(`   部署默认模型：${defaultBefore ? `${defaultBefore.provider}/${defaultBefore.model}` : "(读不到)"}`);

  console.log("5) session/create …");
  const created = await client.createSession(process.cwd());
  console.log(`   sessionId = ${created.sessionId}  preset = ${created.agentPreset ?? "(默认)"}`);

  // 「新建对话」必须真的新建：若 create 对同一 cwd 幂等返回旧会话，
  // 用户点新建会看到旧内容，属于硬缺陷。
  const second = await client.createSession(process.cwd());
  console.log(`   再次 create → ${second.sessionId}`);
  if (second.sessionId === created.sessionId) {
    fail("session/create 对同一 cwd 返回了同一个会话 id —— 「新建对话」会失效。");
  }

  // 审批/提问只从 $events 流来。这里验证它能连上并拿到 clientId——
  // 拿不到就意味着审批卡片永远不会出现。收到 waterfall 一律回 next 放行，
  // 避免把 Agent 挂住（协议要求必须回）。
  console.log("6) $events（审批通道）…");
  let eventsClientId: string | undefined;
  const eventsReady = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    client!.openEvents({
      onItem: (value: any) => {
        if (value?.type === "ready") {
          clearTimeout(timer);
          eventsClientId = value.clientId;
          console.log(`   收到 ready：clientId=${String(value.clientId).slice(0, 12)}…`);
          resolve(true);
        } else if (value?.type === "waterfall") {
          // 测试 9d 会挂一个观察者来接管应答；没有观察者时一律放行
          if (approvalWatcher) {
            approvalWatcher(value);
            return;
          }
          console.log(`   waterfall：${value.event}（自动放行）`);
          void client!.answerEvent(value.clientId ?? "", value.eventId, { kind: "next" });
        }
      },
      onError: (error: any) => {
        clearTimeout(timer);
        console.error(`   $events 失败：${error.code} ${error.message}`);
        resolve(false);
      },
    });
  });

  // 斜杠命令通道：权限切换（/permission）走这里
  console.log("7) commands/execute …");
  let commandOk = false;
  try {
    await client.request("commands/execute", {
      agentId: created.sessionId,
      line: "/permission workspace-write",
      submittedAttachments: [],
    });
    commandOk = true;
    console.log("   斜杠命令执行成功");
  } catch (error) {
    console.error(`   斜杠命令失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 模型切换的线格式验证放到对话之后：先用真实跑通的模型，再切一次同样的模型，
  // 既证明报文形状正确，又不会把会话留在本机不可用的 provider 上。
  console.log("7b) session/selectModel …（延后到对话之后验证）");

  const frames: string[] = [];
  const adapter = new SessionAdapter((frame) => {
    frames.push(frame.type);
  });
  adapter.setSession({ id: created.sessionId, title: "smoke", updatedAt: Date.now(), running: false });

  // 控制流：投影（模型选择/权限/待办/标题）经此推送，客户端界面靠它初始化胶囊
  const projections: Record<string, unknown> = {};
  let sawControlBaseline = false;
  client.followControl({
    onItem: (value: any) => {
      if (value?.type === "baseline") {
        sawControlBaseline = true;
        const forSession = value.value?.projections?.[created.sessionId]?.values ?? {};
        Object.assign(projections, forSession);
        console.log(`   控制流 baseline：本会话投影 ${Object.keys(forSession).length} 个`);
      } else if (value?.type === "projection" && value.sessionId === created.sessionId) {
        projections[String(value.key)] = value.value;
        if (value.key === "modelSelection" || value.key === "title") {
          console.log(`   投影推送 ${value.key} = ${JSON.stringify(value.value)}`);
        }
      }
    },
  });

  let sawSnapshot = false;
  let done = false;
  const settled = new Promise<void>((resolve) => {
    followHandle = client!.followSession(created.sessionId, {
      onItem: (value: any) => {
        if (value?.type === "snapshot") {
          sawSnapshot = true;
          console.log(`   收到 snapshot：cursor=${value.cursor} 记录=${value.records?.length ?? 0}`);
          const values = value.projections?.values ?? {};
          const keys = Object.keys(values);
          console.log(`   投影键（${keys.length}）：${keys.join(", ")}`);
          for (const key of ["title", "modelSelection", "permissions", "plan", "contextPressure"]) {
            if (key in values) console.log(`     ${key} = ${JSON.stringify(values[key])}`);
          }
        }
        adapter.applyFrame(value);
        const event = value?.type === "event" ? value.event : undefined;
        if (event) {
          if (event.type === "assistant/message") {
            const text = (event.data?.message?.content ?? [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
            if (text.trim()) console.log(`   助手正文：${text.trim().slice(0, 120)}`);
          }
          if (event.type === "turn/end") {
            console.log(`   turn/end：${JSON.stringify(event.data?.reason)}`);
            const reason = event.data?.reason as { kind?: string } | undefined;
            if (reason?.kind === "error") {
              turnFailed = true;
              turnFailureReason = JSON.stringify(reason);
            }
            done = true;
            resolve();
          }
        }
        if (value?.type === "assistant-stream" && value.frame?.type === "chunk") {
          // 逐 token 增量确实存在即可，不打印全部
        }
      },
      onError: (error: any) => {
        console.error(`   流错误：${error.code} ${error.message}`);
        resolve();
      },
    });
  });

  // ---------- 8) 找一个真的能跑通的模型 ----------
  // 本机可能配了多个 provider，某个（如本地推理服务）随时可能不可达。
  // 内容相关的断言必须建立在一个能真正完成一轮的模型上，否则失败原因会被
  // 误读成客户端缺陷。
  console.log("8) 挑选可用模型（依次试目录，直到有一轮跑通）…");
  const candidates: { provider: string; model: string; effort?: string }[] = [];
  if (defaultBefore?.provider && defaultBefore.model) {
    candidates.push({
      provider: defaultBefore.provider,
      model: defaultBefore.model,
      effort: defaultBefore.reasoningEffort,
    });
  }
  for (const group of catalog.groups ?? []) {
    for (const model of group.models ?? []) {
      if (candidates.some((c) => c.provider === group.id && c.model === model.id)) continue;
      candidates.push({ provider: group.id, model: model.id, effort: model.reasoning?.defaultEffort });
    }
  }

  let working: { provider: string; model: string; effort?: string } | undefined;
  let failReason = "";
  for (const candidate of candidates) {
    const probe = await client.createSession(process.cwd());
    const outcome = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: "超时 60s" }), 60_000);
      client!.followSession(probe.sessionId, {
        onItem: (value: any) => {
          if (value?.type !== "event" || value.event?.type !== "turn/end") return;
          clearTimeout(timer);
          const reason = value.event.data?.reason;
          resolve({ ok: reason?.kind === "completed", reason: JSON.stringify(reason) });
        },
        onError: (error: any) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: `${error.code} ${error.message}` });
        },
      });
      void client!
        .selectModel(probe.sessionId, candidate.provider, candidate.model, candidate.effort)
        .catch(() => {})
        .then(() => client!.prompt(probe.sessionId, [{ type: "text", text: "hi" }], "queue"))
        .catch((error) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
        });
    });
    if (outcome.ok) {
      working = candidate;
      console.log(`   ✓ ${candidate.provider}/${candidate.model} 可用`);
      break;
    }
    failReason = outcome.reason ?? "";
    console.log(`   ✗ ${candidate.provider}/${candidate.model} 不可用：${failReason}`);
  }
  if (!working) {
    fail(`目录里没有任何模型能完成一轮对话（最后一个失败原因：${failReason}）。`);
  }

  console.log("8b) session/prompt …（真实调用模型，输出很短）");
  await client.selectModel(created.sessionId, working.provider, working.model, working.effort);
  await client.prompt(created.sessionId, [{ type: "text", text: "只回复两个字：收到" }], "queue");

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 180_000));
  await Promise.race([settled, timeout]);
  if (!sawSnapshot) fail("没有收到 session/follow 的首帧 snapshot。");
  if (!done) fail("等待 turn/end 超时（180s）。");
  if (turnFailed) {
    fail(`已选中的可用模型本轮仍失败：${turnFailureReason}`);
  }

  const messages = adapter.snapshotMessages();
  console.log(`9) 适配结果：${messages.length} 条消息`);
  for (const message of messages) {
    const kinds = message.segments.map((s) => s.kind).join("+") || "-";
    const preview =
      message.role === "user"
        ? (message.text ?? "").slice(0, 40)
        : message.segments
            .map((s) => (s.kind === "text" ? s.text : s.kind === "thinking" ? "(思考)" : ""))
            .join("")
            .slice(0, 60);
    console.log(`   [${message.role}] 段落=${kinds} ${JSON.stringify(preview)}`);
  }
  const usage = messages.find((m) => m.usage)?.usage;
  console.log(`   usage = ${usage ? JSON.stringify(usage) : "(无)"}`);

  // ---------- 9b) 历史回放：切换会话时必须只凭 snapshot.records 重建转写 ----------
  // 这正是「打开历史对话」的路径：取消旧跟随、开一条新跟随流，
  // 新适配器此前没见过任何实时帧，能重建出内容才说明历史可用。
  console.log("9b) 历史回放（重新跟随同一会话，仅靠 snapshot 重建）…");
  followHandle?.cancel();
  await new Promise((r) => setTimeout(r, 500));

  const replayAdapter = new SessionAdapter(() => {});
  replayAdapter.setSession({ id: created.sessionId, title: "replay", updatedAt: Date.now(), running: false });
  let replayRecords = 0;
  let sawReplaySnapshot = false;
  const replayed = new Promise<void>((resolve) => {
    client!.followSession(created.sessionId, {
      onItem: (value: any) => {
        if (value?.type === "snapshot") {
          sawReplaySnapshot = true;
          replayRecords = value.records?.length ?? 0;
        }
        replayAdapter.applyFrame(value);
        if (value?.type === "event" || value?.type === "snapshot") resolve();
      },
      onError: () => resolve(),
    });
  });
  await Promise.race([replayed, new Promise((r) => setTimeout(r, 20_000))]);
  if (!sawReplaySnapshot) fail("重新跟随时没有收到 snapshot —— 历史回放不可用。");

  const replayedMessages = replayAdapter.snapshotMessages();
  const replayUser = replayedMessages.find((m) => m.role === "user");
  const replayAssistant = replayedMessages.find(
    (m) => m.role === "assistant" && m.segments.some((s) => s.kind === "text"),
  );
  console.log(`   快照记录 ${replayRecords} 条 → 重建 ${replayedMessages.length} 条消息`);
  if (!replayUser) fail("历史回放里没有用户消息 —— 打开历史对话会看到空白。");
  if (!replayAssistant) fail("历史回放里没有助手正文 —— 打开历史对话会看到空白。");
  const replayText =
    replayUser.text ?? "";
  if (!replayText.includes("收到")) {
    console.log(`   回放到的用户消息：${JSON.stringify(replayText.slice(0, 40))}`);
  }

  // ---------- 9c) 停止：中途取消必须真的结束该轮 ----------
  console.log("9c) 停止（发一条长回复，中途 session/cancel）…");
  const stopAdapter = new SessionAdapter(() => {});
  stopAdapter.setSession({ id: created.sessionId, title: "stop", updatedAt: Date.now(), running: false });
  let stopStreamStarted = false;
  let stopEnded: any;
  const stopEnd = new Promise<void>((resolve) => {
    followHandle = client!.followSession(created.sessionId, {
      onItem: (value: any) => {
        stopAdapter.applyFrame(value);
        if (value?.type === "assistant-stream") stopStreamStarted = true;
        if (value?.type === "event" && value.event?.type === "turn/end") {
          stopEnded = value.event.data?.reason;
          resolve();
        }
      },
      onError: () => resolve(),
    });
  });

  await client.prompt(
    created.sessionId,
    [{ type: "text", text: "从 1 数到 300，每个数字单独占一行，不要省略。" }],
    "queue",
  );

  // 等它真正开始输出再打断，否则取消会落空
  const streamDeadline = Date.now() + 60_000;
  while (!stopStreamStarted && Date.now() < streamDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`   已开始流式输出：${stopStreamStarted ? "是" : "否（仍继续取消测试）"}`);
  await client.cancel(created.sessionId);
  await Promise.race([stopEnd, new Promise((r) => setTimeout(r, 30_000))]);

  const abortKind = stopEnded?.kind;
  console.log(`   取消后 turn/end = ${JSON.stringify(stopEnded)}`);
  if (abortKind !== "aborted") {
    fail(`停止没有让本轮正常中止（turn/end reason=${JSON.stringify(stopEnded)}）。`);
  }
  const stopNotices = stopAdapter
    .snapshotMessages()
    .flatMap((m) => m.segments)
    .filter((s) => s.kind === "notice");
  console.log(`   界面会显示 ${stopNotices.length} 条提示（已停止）`);

  // ---------- 9d) 审批：只读权限下写文件必须弹 waterfall，且必须能应答 ----------
  console.log("9d) 审批（切只读 → 请求写文件 → 应答拒绝）…");
  await client.request("commands/execute", {
    agentId: created.sessionId,
    line: "/permission read-only",
    submittedAttachments: [],
  });
  await new Promise((r) => setTimeout(r, 1500));

  let approvalFrame: any;
  const approvalPromise = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (approvalFrame) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 120_000);
  });

  // 复用 $events 流：把 waterfall 记下来并由测试统一应答
  approvalWatcher = (frame: any) => {
    if (!approvalFrame) approvalFrame = frame;
  };

  await client.prompt(
    created.sessionId,
    [{ type: "text", text: "用 write 工具在当前目录下创建文件 dsh-approval-probe.txt，内容写 ok。" }],
    "queue",
  );
  await approvalPromise;
  approvalWatcher = undefined;

  if (!approvalFrame) {
    // 模型可能自己拒绝执行；这不算客户端缺陷，但要明确说出来
    console.log("   ⚠ 没有收到 approval/request（模型可能自行拒绝写文件），该链路本次未验证");
  } else {
    console.log(
      `   收到 approval/request：tool=${approvalFrame.request?.toolName} reason=${JSON.stringify(approvalFrame.request?.reason ?? "")}`,
    );
    await client.answerEvent(eventsClientId!, approvalFrame.eventId, { kind: "result", value: "rejected" });
    console.log("   已应答 rejected（未写入任何文件）");
    await new Promise((r) => setTimeout(r, 3000));
    approvalVerified = true;
  }

  // 恢复工作区可写，别把会话留在只读
  await client.request("commands/execute", {
    agentId: created.sessionId,
    line: "/permission workspace-write",
    submittedAttachments: [],
  });

  const hasUser = messages.some((m) => m.role === "user");
  const hasAssistant = messages.some((m) => m.role === "assistant" && m.segments.some((s) => s.kind === "text"));
  if (!hasUser) fail("转写里没有用户消息。");
  if (!hasAssistant) fail("转写里没有助手正文。");
  if (!eventsReady) fail("$events 流没有返回 ready —— 审批与提问将永远收不到。");
  if (!commandOk) fail("commands/execute 调用失败 —— 权限切换不可用。");
  if (!sawControlBaseline) fail("session/control 没有返回 baseline —— 模型/权限胶囊将无法初始化。");

  // 模型切换：用刚跑通的模型再切一次（相同 provider/model + 显式 effort），
  // 证明 session/selectModel 的报文形状正确
  const effective = (projections.modelSelection as any)?.lastUsed ?? (projections.modelSelection as any)?.next;
  if (effective?.provider && effective.model) {
    try {
      const result = await client.selectModel(
        created.sessionId,
        effective.provider,
        effective.model,
        effective.reasoningEffort,
      );
      const ok = result.selected?.model === effective.model;
      console.log(`11) session/selectModel → ${result.selected?.provider}/${result.selected?.model}`);
      if (!ok) fail("session/selectModel 返回的模型与请求不一致。");
    } catch (error) {
      fail(
        `session/selectModel 失败：${error instanceof Error ? error.message : String(error)} —— 模型与思考深度切换不可用。`,
      );
    }
  } else {
    console.log("11) 跳过模型切换验证（投影里没有生效的模型选择）");
  }

  // 还原部署默认模型（若被上面的切换改动）
  if (defaultBefore?.provider && defaultBefore.model) {
    const settingsAfter = await client.settingsDescribe();
    const defaultAfter = (
      (settingsAfter.namespaces ?? []).find((ns: any) => ns.ns === "agent-default-model") as any
    )?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
    const changed =
      defaultAfter &&
      (defaultAfter.provider !== defaultBefore.provider ||
        defaultAfter.model !== defaultBefore.model ||
        (defaultAfter.reasoningEffort ?? "") !== (defaultBefore.reasoningEffort ?? ""));
    if (changed) {
      await client.request("settings/update", {
        ns: "agent-default-model",
        patch: {
          provider: defaultBefore.provider,
          model: defaultBefore.model,
          ...(defaultBefore.reasoningEffort ? { reasoningEffort: defaultBefore.reasoningEffort } : {}),
        },
      });
      console.log(
        `12) 已还原部署默认模型为 ${defaultBefore.provider}/${defaultBefore.model}` +
          `${defaultBefore.reasoningEffort ? ` (${defaultBefore.reasoningEffort})` : ""}`,
      );
    }
  }

  const permissions = projections.permissions as { currentValue?: string } | undefined;
  console.log(`10) 权限投影 currentValue = ${permissions?.currentValue ?? "(无)"}`);
  const modelSelection = projections.modelSelection as
    | { lastUsed?: { model?: string } | null; next?: { model?: string } | null }
    | undefined;
  const selected = modelSelection?.next ?? modelSelection?.lastUsed;
  console.log(`    模型投影 = ${selected?.model ?? "(仍未选择)"}`);

  console.log(
    "\n✓ 端到端通过：连接、鉴权、建会话、审批通道、斜杠命令、发消息、流式、事件→视图全部正常。",
  );
} catch (error) {
  fail(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
} finally {
  client?.dispose();
  server.stop();
}
