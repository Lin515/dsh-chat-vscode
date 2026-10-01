/**
 * 「点 + 新建对话 → 这条消息发给谁」的**行为级**回归：驱动真 `ChatController`
 * （offline stub），只看假服务端收到了哪条会话的 `session/prompt`。
 *
 * 报障现场（用户 2026-10-01）：点「+」新建对话之后，**偶尔**第一条消息发进了
 * **上一个对话**里。根因是空壳会话的复用判据只读了**拉的** `session/list` 快照
 * （`reusableBlank`），而服务端的 `blank` 要到 `turn/start` 才翻假、本扩展又只在
 * 建会话那一次拉过列表——判据停在「它还没开始过对话」，下一个「+」把已经用过的会话
 * 当空壳接了回去。官方同一机制靠客户端**本地的** blank 位实时翻假
 * （`@deepseek-ai/dsh-api-session-controller` 的 `blankBit`：prompt 受理那一刻置假并
 * `onEngaged`，管理器记进 `engagedSessions`；`ui-workspace` 的 `reuseOrCreateBlank`
 * 读的正是它）。
 *
 * 2026-10-01 口径调整后（对齐官方：**空态就是一条真会话**，见 `newSession`），本测试
 * 钉住三件事：
 *
 * 1. 点「+」之后窗口**立刻**落在本工作区那条空壳会话上（不再有「无会话的空态」）；
 * 2. 连开几个新对话，每条首消息都必须落在一条**没说过话**的会话上（报障现场）；
 * 3. 还没说过话的空壳要接回来（两个窗口进空态共用同一条），说过话的绝不再接。
 *
 * 假服务端与真服务端同形：`session/create` 造出 `blank:true` 的行，`session/list`
 * 只在被查时才交出新值。`lag` 那一档模拟「服务端还没跟上 `turn/start`」——
 * 本地 blank 位正是为这段空档存在的（官方的 `effectiveBlank`）。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[blankSessionReuse] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const CWD = "C:\\work\\demo";

/**
 * 假服务端：`blank` 位是**服务端真相**（prompt 受理即翻假），只有 `session/list`
 * 会把它交出去——宿主不查就永远是旧值，与真服务端一致。
 *
 * @param options.lag 模拟「服务端还没跟上」：prompt 受理后**不**翻假，看本地 blank 位
 *        自己顶不顶得住（官方 `effectiveBlank` 的那一半）。
 */
function fakeClient(
  seed: { sessionId: string; blank?: boolean }[] = [],
  options: { lag?: boolean } = {},
) {
  const rows: {
    sessionId: string;
    cwd: string;
    blank: boolean;
    updatedAt: number;
    running: boolean;
  }[] = seed.map((row, index) => ({
    sessionId: row.sessionId,
    cwd: CWD,
    blank: row.blank !== false,
    updatedAt: Date.now() + index,
    running: false,
  }));
  const calls: string[] = [];
  const prompts: { sessionId: string; content: unknown[]; mode: string; requestId: string }[] = [];
  /** 每一条落到服务端的模型选择（`session/selectModel`）——它才是「模型是会话属性」的证据。 */
  const models: { sessionId: string; provider: string; model: string }[] = [];
  return {
    calls,
    rows,
    prompts,
    models,
    async selectModel(sessionId: string, provider: string, model: string) {
      calls.push("session/selectModel");
      models.push({ sessionId, provider, model });
      return { selected: { provider, model } };
    },
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      const sessionId = `session-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd ?? "",
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
      });
      return { sessionId };
    },
    async listSessions() {
      calls.push("session/list");
      return { items: rows.map((row) => ({ ...row })) };
    },
    /** 受理 = 服务端把这条会话标成「已经说过话」（真服务端的 `blank` 位同源）。 */
    async prompt(sessionId: string, content: unknown[], mode: string, requestId: string) {
      calls.push("session/prompt");
      prompts.push({ sessionId, content, mode, requestId });
      if (options.lag) return { accepted: true };
      const row = rows.find((item) => item.sessionId === sessionId);
      if (row) row.blank = false;
      return { accepted: true };
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push(method);
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (rows.some((row) => row.sessionId === agentId)) {
        if (method === "commands/list") return [{ name: "plan", description: "切换计划模式" }];
        if (method === "fileReferences/list") return [];
        if (method === "sessionReferenceResolver/candidates") return [];
        if (method === "skills/list") return { skills: [] };
        return undefined;
      }
      if (rows.length === 0 && method === "commands/list") return [];
      return undefined;
    },
    async sessionProjections() {
      return { values: {} };
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    followSession() {
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl() {
      return { cancel() {} };
    },
  };
}

const fakeServer = () => ({
  externalUrl: undefined,
  onHeartbeat() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = () => {
  const map = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

function makeController(
  options: { dir?: string; seed?: { sessionId: string; blank?: boolean }[]; lag?: boolean } = {},
) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  (
    controller as never as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  const client = fakeClient(options.seed ?? [], { lag: options.lag });
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    sessions: { id: string; blank?: boolean }[];
    viewSessions: Map<string, string>;
    scopes: Map<string, unknown>;
    /** 本地 blank 位（官方 `engagedSessions`：我们亲眼见它说过话的会话）。 */
    engagedSessions: Set<string>;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    newSession(viewId?: string): Promise<void>;
    refreshSessions(): Promise<void>;
    openSession(viewId: string, sessionId: string): Promise<void>;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  c.client = client as never;
  c.connection = "connected";
  return { c, frames, client };
}

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 用户按一次「+」：界面发 `newSession`，宿主把窗口退出现有会话、落到空壳上。 */
async function clickPlus(c: ReturnType<typeof makeController>["c"], viewId: string) {
  await c.handle({ type: "newSession" }, viewId);
}

/** 用户在输入框里敲一条正文并按发送。 */
async function sendMessage(c: ReturnType<typeof makeController>["c"], viewId: string, text: string) {
  await c.handle({ type: "send", text, attachments: [], gesture: "enter" }, viewId);
}

/** 界面下发过的会话列表帧里，最后一条 `sessions`（历史列表）的内容。 */
function lastSessionList(frames: Captured[]): { id: string }[] {
  for (let at = frames.length - 1; at >= 0; at -= 1) {
    const frame = frames[at].frame;
    if (frame.type === "sessions") return (frame.sessions ?? []) as { id: string }[];
  }
  return [];
}

console.log("blankSessionReuse: 点「+」之后第一条消息发给谁（驱动真控制器，offline stub）");

// ---------- 一、基础口径：点「+」立刻落到一条空壳上，首条消息发给它 ----------
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  // 2026-10-01 口径：空态**就是**一条真会话（官方「打开工作区就有一条 blank 会话」），
  // 所以「+」之后窗口必须已经绑在它上面，而不是停在「无会话的空态」
  assert.strictEqual(client.rows.length, 1, "点「+」就要有本工作区那条空壳会话");
  assert.strictEqual(
    c.viewSessions.get("v1"),
    client.rows[0].sessionId,
    "点「+」之后窗口必须绑在那条空壳上（空态页显示的就是它的真实状态）",
  );
  await sendMessage(c, "v1", "第一条消息");
  console.log(`  建会话 ${client.rows.length} 条，prompt 去向=${client.prompts.map((p) => p.sessionId).join(", ")}`);
  assert.strictEqual(client.prompts.length, 1, "第一条消息必须真的发出去");
  assert.strictEqual(client.rows.length, 1, "首条消息不再另建会话——它就是发给那条空壳的");
  assert.strictEqual(client.prompts[0].sessionId, client.rows[0].sessionId, "第一条消息发给那条空壳");
  assert.strictEqual(c.viewSessions.get("v1"), client.rows[0].sessionId, "窗口仍绑在它上面");
  // 本地 blank 位：受理那一刻点亮（官方 `blankBit` 的同一件事）
  assert.ok(
    c.engagedSessions.has(client.rows[0].sessionId),
    "发过消息的会话必须点亮本地 blank 位（否则下一个「+」会把它当空壳接回去）",
  );
  assert.strictEqual(
    c.sessions.find((row) => row.id === client.rows[0].sessionId)?.blank,
    false,
    "本地那一行也要按事实翻面（它是历史列表挡不挡这一行的依据）",
  );
  console.log("  空态首条消息 → 那条空壳 ✓");
}

// ---------- 二、报障现场：连开几个新对话，每条首消息都要落在自己的新会话上 ----------
//
// 报障的说法是「**偶尔**」：旧判据只在 `refreshSessions()` 时才知道会话已经不 blank，
// 而建会话那一次刷新发生在**第一条消息之前**——于是判据停在「它还没说过话」，下一次点
// 「+」就被当成可复用的空壳接了回去。接回去那一次自己会刷新列表，所以现象是「中一次、
// 好一次」的交替，看起来就是偶尔。
//
// 注意下面这一档刻意**不让假服务端跟上**（`lag`）：本地 blank 位必须独自顶住整段空档。
{
  const { c, client } = makeController({ dir: CWD, lag: true });
  c.bindView("v1");
  const dest: string[] = [];
  for (let round = 1; round <= 5; round += 1) {
    await clickPlus(c, "v1");
    await sendMessage(c, "v1", `第 ${round} 个对话的第一条`);
    dest.push(client.prompts[round - 1].sessionId);
    assert.strictEqual(
      c.viewSessions.get("v1"),
      dest[round - 1],
      `第 ${round} 个新对话发送后，窗口要绑在它自己的会话上`,
    );
  }
  console.log(`  连开 5 个新对话，prompt 去向：${dest.join(" → ")}`);
  console.log(
    `  服务端 ${client.rows.length} 条会话：${client.rows.map((row) => `${row.sessionId}(blank=${row.blank})`).join(", ")}`,
  );
  assert.strictEqual(
    new Set(dest).size,
    dest.length,
    "每个新对话的第一条消息都必须落在一条**没说过话**的会话上（同一个会话被用了两次＝发进了上一个对话）",
  );
}

// ---------- 三、本地 blank 位与服务端一致之后也不许复用（收敛那一步不误伤） ----------
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  await sendMessage(c, "v1", "对话一的第一条");
  const first = client.prompts[0].sessionId;
  // 用户打开过一次历史抽屉（界面发 listSessions）——宿主此刻才看见 blank 翻假
  await c.handle({ type: "listSessions" }, "v1");
  await clickPlus(c, "v1");
  await sendMessage(c, "v1", "对话二的第一条");
  const second = client.prompts[1].sessionId;
  console.log(`  列表刷新后：对话一 → ${first}；对话二 → ${second}`);
  assert.notStrictEqual(second, first, "刷新过名单之后仍复用旧会话");
  console.log("  刷新后不复用旧会话 ✓");
}

// ---------- 四、该复用还得复用：还没说过话的空壳要接回来 ----------
//
// 复用本身是**要的**，而且是官方的核心行为（`ui-workspace` 的 `reuseOrCreateBlank`）：
// 一个工作区通常只有一条空壳，谁进空态都用它。下面这条修正只该摘掉**已经说过话**的。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  const first = client.rows[0].sessionId;
  // 空态打开 `/` 菜单：窗口已经在壳上了，菜单**不再**另建一条（用户 2026-09-24 口径的
  // 「按需建会话」在新口径下变成「空态一进来就有会话」）
  await c.handle({ type: "listCommands" }, "v1");
  assert.strictEqual(client.rows.length, 1, "菜单不再另建会话（空态窗口已经绑在壳上）");
  assert.ok(!c.engagedSessions.has(first), "没说过话的空壳不许被标成已经用过");
  // 用户再点一次「+」然后发第一条消息：接回同一条，不再堆一条
  await clickPlus(c, "v1");
  assert.strictEqual(c.viewSessions.get("v1"), first, "点「+」回到同一条还没说过话的空壳上");
  await sendMessage(c, "v1", "接回来的第一条");
  console.log(`  空壳 ${first}，首条消息落在 ${client.prompts[0].sessionId}（共 ${client.rows.length} 条）`);
  assert.strictEqual(client.rows.length, 1, "没说过话的空壳要接回来，不再堆一条");
  assert.strictEqual(client.prompts[0].sessionId, first, "首条消息落在那条还没说过话的空壳上");
  assert.ok(c.engagedSessions.has(first), "用过的空壳必须点亮本地 blank 位");
  console.log("  未用过的空壳仍被复用 ✓");
}

// ---------- 五、两个窗口进空态共用同一条空壳（口径 3：不加自加排除条件） ----------
//
// 官方只有一个主视图，所以「两个窗口共用一条空壳」遇不到；遇不到不等于不该发生——用户
// 2026-10-01 明确口径：严格对齐官方，去掉我们自加的 `bound.has` 那条排除。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  c.bindView("v2");
  await clickPlus(c, "v1");
  const first = client.rows[0].sessionId;
  await clickPlus(c, "v2");
  console.log(`  窗口 v1/v2 → ${c.viewSessions.get("v1")} / ${c.viewSessions.get("v2")}`);
  assert.strictEqual(client.rows.length, 1, "第二个窗口进空态不许另建一条（复用本工作区那条空壳）");
  assert.strictEqual(c.viewSessions.get("v2"), first, "两个窗口共用同一条空壳是容许的（官方字面行为）");
  console.log("  两个窗口进空态共用同一条空壳 ✓");
}

// ---------- 六、服务端还没跟上时，本地 blank 位自己顶住（effectiveBlank 的另一半） ----------
//
// 服务端的 `blank` 要到 `turn/start` 才翻假，中间隔着整轮往返：这段时间里 `session/list`
// 说的还是「它没说过话」。少了 `refreshSessions` 里那次折算，刚发出第一条消息的会话会随
// 下一次拉取又从历史列表里消失一下再回来——比接错更常见、更难查。
{
  const { c, client, frames } = makeController({ dir: CWD, lag: true });
  c.bindView("v1");
  await clickPlus(c, "v1");
  const first = client.rows[0].sessionId;
  await sendMessage(c, "v1", "第一条消息");
  // 服务端仍在说 blank=true（lag），宿主拉一次列表
  await c.handle({ type: "listSessions" }, "v1");
  assert.strictEqual(client.rows[0].blank, true, "前置：假服务端这一档刻意还没翻假");
  const listed = lastSessionList(frames);
  console.log(`  拉列表后历史列表：${listed.map((row) => row.id).join(", ") || "（空）"}`);
  assert.ok(
    listed.some((row) => row.id === first),
    "服务端还没翻假时，说过话的会话也必须已经在历史列表里（本地 blank 位折算进列表行）",
  );
  // 而它绝不能再被当空壳接回来
  await clickPlus(c, "v1");
  assert.notStrictEqual(c.viewSessions.get("v1"), first, "已经说过话的会话绝不再被当空壳接回");
  console.log("  服务端未跟上时本地 blank 位仍顶得住 ✓");
}

// ---------- 七、空壳上选的模型要留得住 ----------
//
// 模型是**会话**的属性（官方 `session/selectModel`），所以在壳上选它就当场写进会话。
// 只在域上记一笔（`pendingModel`，等下次发送再提交）会把这个选择丢掉：点「+」会回到同
// 一条壳，而「+」把域整个重建，胶囊下一帧就弹回部署默认。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  const shell = client.rows[0].sessionId;
  await c.handle({ type: "setModel", provider: "prov", model: "model-1" }, "v1");
  console.log(`  空壳上选模型 → ${JSON.stringify(client.models)}`);
  assert.deepStrictEqual(
    client.models,
    [{ sessionId: shell, provider: "prov", model: "model-1" }],
    "空壳会话上选模型要当场写进会话（session/selectModel），不能只记在域上",
  );
  await clickPlus(c, "v1");
  assert.strictEqual(c.viewSessions.get("v1"), shell, "点「+」回到同一条空壳上");
  assert.strictEqual(client.models.length, 1, "回到同一条壳不会重复提交（选择已经在会话上）");
}

// ---------- 八、已经开始的会话仍按老口径：切模型延迟到下一次发送 ----------
//
// 那条延迟是**有意**的（不让本轮中途换模型）。空壳那一档的特殊处理不许把它一起改掉。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  await sendMessage(c, "v1", "第一条消息");
  await c.handle({ type: "setModel", provider: "prov", model: "model-2" }, "v1");
  assert.deepStrictEqual(client.models, [], "已经说过话的会话：这一刻不提交，等下一次发送");
  await sendMessage(c, "v1", "第二条消息");
  assert.deepStrictEqual(
    client.models,
    [{ sessionId: client.rows[0].sessionId, provider: "prov", model: "model-2" }],
    "下一次发送之前才提交（老口径不变）",
  );
}

// ---------- 九、已经在本工作区那条空壳上时，点「+」原地重来 ----------
//
// 官方 `startSession` → `reuseOrCreateBlank` 接回的就是同一条（它 `retain` 同一个会话对象，
// 不拆不建）。我们照做：先 `detachView` 再落壳会把域整个重建（follow 流重开 + 再拉一次列表），
// 白白抖一下，而结果一模一样。
{
  const { c, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  const shell = c.viewSessions.get("v1");
  const lists = client.calls.filter((method) => method === "session/list").length;
  await clickPlus(c, "v1");
  console.log(`  原地再点一次「+」：会话仍 ${c.viewSessions.get("v1")}（列表调用 ${lists} → ${client.calls.filter((m) => m === "session/list").length}）`);
  assert.strictEqual(c.viewSessions.get("v1"), shell, "点「+」还在同一条壳上");
  assert.strictEqual(
    client.calls.filter((method) => method === "session/list").length,
    lists,
    "已经在那条壳上时点「+」不该再拆一次域、再拉一次列表",
  );
  assert.strictEqual(client.rows.length, 1, "更不该堆出第二条壳");
}

// ---------- 十、先切、后建：点「+」的第一帧是**同步**推出去的 ----------
//
// 报障现场（用户 2026-10-01）：点「+」有明显停顿感，「像是先创建后台会话再切换」。落壳那串
// 动作（连后台 → `session/create` → 拉列表）全是往返，必须排在切换**之后**；而切换本身是
// 同步的（解绑 → 建域 → 换绑 → 推整份快照）。这条断言的就是那个次序：**不 await 调用**之后，
// 那一帧已经在路上了。
{
  const { c, frames, client } = makeController({ dir: CWD });
  c.bindView("v1");
  await clickPlus(c, "v1");
  await sendMessage(c, "v1", "先说一句，把这条壳用掉");
  const used = String(c.viewSessions.get("v1"));
  assert.ok(c.engagedSessions.has(used), "前置：这条壳已经用过了（+ 才会走「没有现成壳」那条路）");
  frames.length = 0;

  const pending = c.handle({ type: "newSession" }, "v1"); // 刻意**不** await
  const early = frames.filter(({ target, frame }) => target === "v1" && frame.type === "state");
  const boundAtFrame = c.viewSessions.get("v1");
  assert.ok(
    early.length >= 1,
    "点「+」必须在同步阶段就把那一帧快照推出去（先切、后建）——等落壳的往返正是用户报的停顿",
  );
  assert.strictEqual(
    boundAtFrame,
    undefined,
    "推那一帧时窗口已经退回空态（落壳还没开始）：这一帧就是「立刻变成空态」",
  );
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  console.log(`  同步帧 ${early.length} 帧 → 落壳到 ${c.viewSessions.get("v1")}（原 ${used}）`);
  assert.notStrictEqual(
    c.viewSessions.get("v1"),
    used,
    "落壳之后落在一条**新的**空壳上（用过的那条不再复用）",
  );
  const settled = frames.filter(({ target, frame }) => target === "v1" && frame.type === "state");
  assert.ok(settled.length > early.length, "落壳完成后再补一份带会话的快照");
}

console.log("blankSessionReuse: 空态必有壳、首条消息只发给没说过话的会话 ✓");