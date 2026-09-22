/**
 * 配置文件热重载：`$events` 的 emit 帧 → 重读动作。
 *
 * DSH Web 的 web profile 是 `patchReload: live`，改 `~/.dsh/settings.yaml`、
 * `~/.dsh/cordis.patch.yml`、`~/.dsh/.credentials.yaml` 都**不重启**就生效，
 * 宿主把这些变化以转发白名单里的 emit 帧推给客户端。本扩展此前在
 * `onEventFrame` 的 `frame.type !== "waterfall"` 处直接 return，帧全被丢掉，
 * 于是「外部改了配置，界面纹丝不动」。
 *
 * 这里钉住两件事：
 * 1. 哪些帧要被本扩展消费、各自触发什么重读（不认识的**不能**误消费）；
 * 2. 一批帧合并成「在飞 + 一次 rerun」，不按帧数放大 RPC。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigChangeRouter, type ConfigChangeActions } from "../src/dsh/configChanges";

/**
 * 可控的重读桩。
 * @param gateFirstSettings - 为 true 时第一次 `reloadSettings` 会挂住，直到 `release()`，
 *   用来把「一轮在飞、后续帧排队」这个时序钉死。
 */
function harness(gateFirstSettings = false) {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let settingsCalls = 0;
  const actions: ConfigChangeActions = {
    async reloadSettings() {
      calls.push("settings");
      settingsCalls += 1;
      if (gateFirstSettings && settingsCalls === 1) await first;
    },
    async reloadModelTopology() {
      calls.push("topology");
    },
    async reloadCommandCatalogs(sessionId) {
      calls.push(`catalogs:${sessionId ?? "all"}`);
    },
  };
  const logs: string[] = [];
  const router = new ConfigChangeRouter(actions, (line) => logs.push(line));
  return { router, calls, logs, release: () => releaseFirst?.() };
}

// ---------- 1. 不认识的帧绝不能误消费 ----------
//
// 转发白名单（dsh-api-remotes 的 API_REMOTE_FORWARDED_EVENTS）里还有一堆
// 本扩展用别的流覆盖的事件：会话目录、审批/提问 waterfall、cordis 检查……
// 把它们也当成「配置变了」会打出成串的无谓 RPC。
{
  const h = harness();
  for (const event of [
    "api-session/added",
    "api-session/status",
    "approval/request",
    "user-questions/request",
    "goal/activation-changed",
    "cordis/request-run",
    "cordis/inspect-query",
    "",
  ]) {
    assert.strictEqual(h.router.handle(event, []), false, `${event} 不该被本扩展消费`);
  }
  await h.router.settled();
  assert.deepStrictEqual(h.calls, [], "不认识的帧不能触发任何重读");
  assert.deepStrictEqual(h.logs, [], "不认识的帧也不该留下「配置热重载」日志");
}
console.log("config: 不认识的 emit 帧零动作 ✓");

// ---------- 2. 设置层变化（含凭据）合并成「在飞 + 一次 rerun」 ----------
//
// `settings.yaml` 一次保存会命中多个命名空间，宿主是**逐条**发
// settings/document-updated 的（dsh-settings 的 bumpRevision 按命名空间发）。
// 官方 settings 镜像同样是「在飞 + 一次 rerun」，不能按帧数放大成 N 轮。
//
// 每一轮里 `topology` 与 `settings` 成对出现：改 `llm-*` 的模型清单/档位只发
// settings/document-updated，但 `session/modelCatalog` 的内容确实变了。
{
  const h = harness(true);
  assert.strictEqual(h.router.handle("settings/document-updated", ["ui-theme", 3]), true);
  // 第一轮已经挂在闸门上，下面三条必须落进**同一个**排队轮
  assert.strictEqual(h.router.handle("settings/document-updated", ["ui-conversation", 4]), true);
  assert.strictEqual(h.router.handle("settings/document-updated", ["llm-deepseek", 5]), true);
  assert.strictEqual(h.router.handle("credentials/reference-updated", ["DEEPSEEK_API_KEY"]), true);
  h.release();
  await h.router.settled();
  assert.deepStrictEqual(
    h.calls,
    ["topology", "settings", "topology", "settings"],
    "四条帧 = 两轮重读（在飞一轮 + 合并后一轮），每轮都重取目录并重读设置",
  );
}
console.log("config: 一批设置帧合并为一轮 ✓");

// ---------- 2b. 回归：只有 settings/document-updated 也要重取模型目录 ----------
//
// 用户 2026-09-12 报的现场：改 `settings.yaml` 删掉一个模型的思考档位，
// 模型选择框里的档位不变。实测（build/config-reload-probe.mjs）证明这一步
// **只发 settings/document-updated**——路由集合没变，不发 llm/adapters-updated
// ——而服务端 `session/modelCatalog` 已经从 ["off","low","high"] 变成
// ["off","high"]。只重读设置、不重取目录，界面就永远停在旧目录上。
{
  const h = harness();
  h.router.handle("settings/document-updated", ["llm-pi-ai", 2]);
  await h.router.settled();
  assert.deepStrictEqual(
    h.calls,
    ["topology", "settings"],
    "删档只发 settings/document-updated 时也必须重取模型目录（否则档位列表永不更新）",
  );
}
{
  const h = harness();
  h.router.handle("credentials/reference-updated", ["DEEPSEEK_API_KEY"]);
  await h.router.settled();
  assert.ok(h.calls.includes("topology"), "换密钥可能激活提供方，同样要重取目录（官方同口径）");
}
console.log("config: settings / credentials 变化也重取模型目录 ✓");

// ---------- 3. 提供方拓扑变了：模型目录与设置命名空间一起重读 ----------
//
// `llm/adapters-updated` 是「适配器注册/注销了路由，或可配置提供方目录增删」——
// cordis.patch.yml 热重载插入了 LLM 插件行就是这个后果。官方
// ui-model-selection / ui-settings-models 也是两个一起重读。
{
  const h = harness();
  h.router.handle("llm/adapters-updated", []);
  await h.router.settled();
  assert.deepStrictEqual(h.calls, ["topology", "settings"], "拓扑变了要连设置命名空间一起重读");
}
console.log("config: llm/adapters-updated → 目录 + 设置 ✓");

// ---------- 4. 命令注册表与 agent preset ----------
{
  const h = harness();
  h.router.handle("commands/change", []);
  await h.router.settled();
  assert.deepStrictEqual(h.calls, ["catalogs:all"], "命令注册表变了要重取所有打开域的目录");
}
{
  const h = harness();
  h.router.handle("agent-preset/selected", ["session-1", "standard"]);
  await h.router.settled();
  assert.deepStrictEqual(h.calls, ["catalogs:session-1"], "预设切换只重取该会话（官方 resetSession 同口径）");
}
{
  // 帧里没带会话 id 时退回「全部」——宁可多取，也不能整条丢掉
  const h = harness();
  h.router.handle("agent-preset/selected", []);
  await h.router.settled();
  assert.deepStrictEqual(h.calls, ["catalogs:all"]);
}
console.log("config: commands/change 与 agent-preset/selected 的目录失效 ✓");

// ---------- 5. 一个动作失败不能拖垮同轮其余动作，也不能卡住下一轮 ----------
{
  const calls: string[] = [];
  let fail = true;
  const router = new ConfigChangeRouter(
    {
      async reloadSettings() {
        calls.push("settings");
        if (fail) {
          fail = false;
          throw new Error("boom");
        }
      },
      async reloadModelTopology() {
        calls.push("topology");
      },
      async reloadCommandCatalogs() {
        calls.push("catalogs:all");
      },
    },
    () => {},
  );
  router.handle("llm/adapters-updated", []);
  router.handle("commands/change", []);
  await router.settled();
  assert.deepStrictEqual(
    calls,
    ["topology", "settings", "catalogs:all"],
    "重读失败只记日志，不该吞掉同一轮里的目录重取",
  );
  router.handle("settings/document-updated", []);
  await router.settled();
  assert.deepStrictEqual(
    calls,
    ["topology", "settings", "catalogs:all", "topology", "settings"],
    "下一轮照常",
  );
}
console.log("config: 首轮失败不影响其余动作与后续轮次 ✓");

// ---------- 6. 结构不变量：控制器真的把 emit 帧接过来了 ----------
//
// 少了这一句，前面所有断言都只是「一个没人调用的模块」。
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  // 取 `onEventFrame` 里 emit 那一个分支的正文（缩进 6 空格的语句到 4 空格的收尾括号）
  const emitBranch = /if \(frame\.type === "emit"\) \{([\s\S]*?)\n    \}/.exec(controller)?.[1] ?? "";
  assert.ok(
    /this\.configChanges\.handle\(frame\.event, frame\.args \?\? \[\]\);/.test(emitBranch),
    "onEventFrame 的 emit 分支必须把帧交给 ConfigChangeRouter",
  );
  // 状态位中继（`api-session/status`）要在配置路由**之前**被接住：它不是配置变更，
  // 交给路由器只会落进 default 被丢掉（2026-09-22 之前就是这样，running 因此少了
  // 一条权威来源）。
  assert.ok(
    /if \(this\.applySessionStatus\(frame\.event, frame\.args \?\? \[\]\)\) return;/.test(emitBranch),
    "emit 分支要先接住 api-session/status（会话状态位）",
  );
  assert.ok(
    /reloadSettings: \(\) => this\.reloadSettings\(\)/.test(controller) &&
      /reloadModelTopology: \(\) => this\.loadModels\(\)/.test(controller) &&
      /reloadCommandCatalogs: \(sessionId\) => this\.reloadCommandCatalogs\(sessionId\)/.test(controller),
    "三个重读动作必须都接上控制器",
  );
  // 部署默认模型必须能**刷新**到没有自己选择的域：旧判据 `scope.model || ...`
  // 会把新会话（投影是 {lastUsed:null,next:null}、胶囊显示部署默认）挡在门外，
  // 改档位后它的档位列表就停在旧目录上
  assert.ok(
    /if \(scope\.pendingModel\) continue;/.test(controller) &&
      !/if \(scope\.model \|\| scope\.lastModelSelection\) continue;/.test(controller),
    "applyDefaultModelToScopes 必须按「有没有自己的选择」判据，而不是「域上有没有 model」",
  );
}
console.log("config: 控制器已接上 emit 帧 ✓");

console.log("\nconfig: all assertions passed");
