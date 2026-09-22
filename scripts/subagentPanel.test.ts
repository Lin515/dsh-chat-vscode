/**
 * 子代理面板与它的只读记录（用户 2026-09-19 的四条口径）：
 *
 * 1. **点进去能看它的会话内容**，默认停在**最新**一条，只读（没有输入区）；
 * 2. 跑完的子代理读作**已完成**（绿灯），不再读作「未运行」；
 * 3. 那一行的状态点**独享一格**、格内水平垂直居中，且与标题之间留出距离；
 * 4. 「先点 A 再点 B」时抽屉不能拿 A 的记录充数（打开即清空 + loading）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

const panels = read("src", "webview", "components", "Panels.tsx");
const css = read("src", "webview", "styles", "app.css");
const state = read("src", "webview", "state.ts");
const controller = read("src", "dsh", "controller.ts");

// ---------- 1. 点进去 = 宿主拉一份只读快照 + 抽屉开到这个 id ----------
{
  const app = read("src", "webview", "App.tsx");
  assert.ok(
    /onOpen=\{\(id\) => \{[\s\S]{0,200}post\(\{ type: "openSubagent", id \}\);[\s\S]{0,200}dispatch\(\{ type: "ui\/openSubagent", id \}\)/.test(
      app,
    ),
    "点子代理既要点宿主拉记录，也要把抽屉开到这个 id（见状态里那条 ui/openSubagent）",
  );
  // 记录面板那段 JSX 的**属性块**（`<SubagentTranscriptPanel … />`）：按字符数开窗
  // 太脆——中间加一段注释就会把断言撞红，而它想说的从来不是「这段有多长」。
  const transcriptStart = app.indexOf("<SubagentTranscriptPanel");
  const transcript = app.slice(transcriptStart, app.indexOf("/>", transcriptStart));
  assert.ok(transcriptStart >= 0, "App 要渲染 SubagentTranscriptPanel");
  assert.ok(
    /loading=\{state\.subagent\.loading === true\}/.test(transcript),
    "记录面板要收到 loading（宿主那份快照没到之前显示「正在读取」）",
  );
  assert.ok(
    /post\(\{ type: "openSubagent", id \}\)/.test(app),
    "打开子代理走 openSubagent 这条 IPC（宿主用 session/follow 的 subagent 地址拉只读快照）",
  );

  // 只读：记录面板里**没有**输入区（没有 Composer / textarea），
  // 卡片也走只读渲染（问卷 / 审批只画内容，不给能发出去的控件）
  const panelBlock = panels.slice(panels.indexOf("export function SubagentTranscriptPanel"));
  assert.ok(
    !/<Composer/.test(panelBlock) && !/<textarea/.test(panelBlock),
    "子代理记录**只读**：面板里不许出现输入区（只有查看）",
  );
  assert.ok(
    /<Message key=\{message\.id\} message=\{message\} readOnly \/>/.test(panelBlock),
    "记录里的消息必须以 readOnly 渲染（见 Message 的同名 prop）",
  );

  // 标题是**目录里的名字**（用户刚点的那一行），不是会话 id：一串 uuid 没法帮人
  // 确认「我看的是哪一个」。目录里查不到时退回 id（那是唯一还认得出的身份）。
  assert.ok(
    /<Drawer title=\{label\} /.test(panelBlock),
    "记录抽屉的标题用 label（目录里的名字），不是会话 id",
  );
  assert.ok(
    /label=\{state\.subagentEntries\.find\(\(entry\) => entry\.id === state\.subagent\?\.id\)\?\.label \?\? state\.subagent\.id\}/.test(
      transcript,
    ),
    "App 从 subagentEntries 里取回当前子代理的 label，查不到时退回 id",
  );

  const rows = read("src", "webview", "components", "Rows.tsx");
  assert.ok(
    /const interactive = waiting && !readOnly;/.test(rows),
    "问卷卡：只读时 interactive 为假（选项不可点、没有输入框、没有提交行）",
  );
  assert.ok(
    /disabled=\{!interactive\}/.test(rows),
    "问卷卡：选项按钮的 disabled 走 interactive（只读时点不动）",
  );
  assert.ok(
    /\{interactive \? \(\s*<div className="question-footer">/.test(rows),
    "问卷卡：只读时不画提交行",
  );
  assert.ok(
    /const stepped = interactive && mode === "stepped";/.test(rows),
    "问卷卡：只读时平铺全部题目（一次一题的分页只在能作答时有意义）",
  );
  assert.ok(
    /\{waiting && !readOnly \? \(\s*<div className="approval-actions">/.test(rows),
    "审批卡：只读时不画放行 / 拒绝",
  );

  const message = read("src", "webview", "components", "Message.tsx");
  assert.ok(
    /<ApprovalCard key=\{segment\.id\} approval=\{segment\.approval\} readOnly=\{readOnly\} \/>/.test(message) &&
      /readOnly=\{readOnly\}/.test(message),
    "Message 要把 readOnly 透传给审批卡与问卷卡",
  );
}

// ---------- 2. 默认停在最新一条 ----------
{
  assert.ok(
    /useLayoutEffect\(\(\) => \{[\s\S]{0,220}el\.scrollTop = el\.scrollHeight;[\s\S]{0,80}\}, \[id, messages\]\)/.test(
      panels,
    ),
    "记录抽屉要在打开（含内容到达）后落到底部——默认看的是「它最后做了什么」",
  );
  assert.ok(
    /bodyRef=\{body\}/.test(panels) && /bodyRef\?: React\.RefObject<HTMLDivElement>/.test(panels),
    "滚动容器是 Drawer 的 .drawer-body，ref 要能传进去",
  );
}

// ---------- 3. 跑完 = 已完成（绿灯） ----------
{
  assert.ok(
    /function subagentTone\(activity: SubagentView\["activity"\]\): string \{\s*return activity === "running" \? "dot-running" : "dot-ok";/.test(
      panels,
    ),
    "状态点色调：running → 蓝点，其余（inactive）→ 绿灯",
  );
  assert.ok(
    /\{entry\.activity === "running" \? texts\.jobRunning : texts\.subagentCompleted\}/.test(panels),
    "跑完的子代理显示「已完成」（subagentCompleted），不再显示「未运行」",
  );

  // 词典：两条文案都还在，且中文分别是「运行中」/「已完成」
  const messages = read("src", "webview", "messages.ts");
  assert.ok(
    /subagentCompleted: \{ zh: "已完成", en: "completed" \}/.test(messages),
    "subagentCompleted 的中英两套必须在消息表里",
  );
  assert.ok(
    !/subagentInactive/.test(messages) && !/subagentInactive/.test(panels),
    "「未运行」这条文案已随口径一起删掉（留着就是死文案）",
  );
}

// ---------- 4. 状态点独享一格：水平垂直居中 + 与标题隔开 ----------
{
  assert.ok(
    /<span className="session-item-state">\s*<span className=\{`dot \$\{subagentTone\(entry\.activity\)\}`\} \/>\s*<\/span>/.test(
      panels,
    ),
    "状态点要渲染在 .session-item-state 这一格里（不再是跟在标题后的裸圆点）",
  );
  const at = css.indexOf(".session-item-state {");
  assert.ok(at >= 0, "app.css 必须有 .session-item-state 规则");
  const body = css.slice(at, css.indexOf("}", at));
  assert.ok(/display:\s*inline-flex/.test(body), "格子是 inline-flex（圆点不会把格子撑变形）");
  assert.ok(/align-items:\s*center/.test(body), "圆点在格内**垂直**居中（用户 2026-09-19 报的靠顶）");
  assert.ok(/justify-content:\s*center/.test(body), "圆点在格内**水平**居中");
  assert.ok(/margin-left:\s*\d+px/.test(body), "格子自带左外边距，把点与标题隔开（此前只有行的 2px gap）");
  assert.ok(/width:\s*\d+px/.test(body) && /height:\s*\d+px/.test(body), "格子要有明确的边长（独享空间）");

  // 工具行那个状态点坑位同样要垂直居中（同一类「独享空间」）
  const rowIcon = css.slice(css.indexOf(".row-icon-status {"), css.indexOf("}", css.indexOf(".row-icon-status {")));
  assert.ok(/align-items:\s*center/.test(rowIcon), ".row-icon-status 里的圆点也要垂直居中");
}

// ---------- 5. 打开就清掉上一次的记录 ----------
{
  assert.ok(
    /case "ui\/openSubagent":[\s\S]{0,320}panel: "subagent", subagent: \{ id: action\.id, messages: \[\], loading: true \}/.test(
      state,
    ),
    "ui/openSubagent 要把内容清空并置 loading——否则「先点 A 再点 B」会先显示 A 的记录",
  );
  assert.ok(
    /case "subagent\/transcript":[\s\S]{0,200}loading: false/.test(state),
    "宿主回帧后要落 loading",
  );
  // 宿主侧：目录里查不到也要回一帧空的，否则界面永远停在「正在读取…」
  assert.ok(
    /this\.emitToView\(viewId, \{ type: "subagent\/transcript", id: childSessionId, messages: \[\] \}\);/.test(
      controller,
    ),
    "openSubagent 在目录里查不到 id 时也要回一帧空记录",
  );
}

// ---------- 6. follow 请求不许带 `assistantStream: false`（2026-09-22） ----------
//
// 症状：点开任何子代理都是「这个子代理没有可显示的内容」——**从这条链路上线起就没
// 好过**。根因是请求里写了 `assistantStream: false`，而契约里它是**字面量 `true`**
// （`readonly assistantStream?: true`）：网关的边界校验把整条 request 拒掉
// （`gateway/input-invalid: wire field "request" failed boundary validation`），
// `onError` 立刻回一帧空记录，界面于是显示空态而不是报错。
//
// 对真实服务器的复现（2026-09-22，只读）：同一个子代理地址，带 `assistantStream: false`
// 报 `gateway/input-invalid`；去掉这个字段或写 `true` 都回 `snapshot(records=35)`，
// 折出 2 条消息。所以这条断言钉的是「这个字段不许出现」，不是「值要写对」——
// 契约只允许 `true`，不传是它的默认。
{
  const protocol = read("src", "dsh", "protocol.ts");
  const client = read("src", "dsh", "client.ts");
  const open = controller.slice(controller.indexOf("private async openSubagent"));
  // 只看**代码行**：这段的注释成篇讲的就是 `assistantStream` 为什么不能写，
  // 连着注释一起匹配只会匹配到注释自己（`invariants.test.ts` 那份带字符串
  // 感知的扫描器在这里用不上——这段里没有含 `//` 的字符串字面量）
  const request = open
    .slice(0, open.indexOf("onItem"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !/assistantStream/.test(request),
    "子代理 follow 请求里不许出现 assistantStream（契约只认字面量 `true`，写 `false` 会被网关整条拒掉）",
  );
  assert.ok(
    /assistantStream\?: true;/.test(protocol) && /SessionFollowRequest/.test(protocol),
    "线上类型里要有 `SessionFollowRequest`，且 assistantStream 必须是字面量 `true`",
  );
  assert.ok(
    /satisfies SessionFollowRequest/.test(request) && /satisfies SessionFollowRequest/.test(client),
    "两条 follow 请求都要经 `satisfies SessionFollowRequest` 过一遍编译期——openStream 收 unknown，不标就没人拦",
  );
  assert.ok(
    /followSession\(sessionId: string, callbacks: StreamCallbacks\): StreamHandle/.test(client),
    "`beforeSeq` 属于 session/page，不在 follow 请求里（它此前是个没人传过的死选项，留着就是同一道校验的下一个坑）",
  );
}

// ---------- 7. 注册与打底（2026-09-23）：列表不再依赖「点开面板」那一下 ----------
//
// 三个来源各司其职（形状解析与并入语义在 `projections.test.ts` 钉住，这里只钉**接线**）：
// durable 事件（`subagent/catalog`）→ 适配器 → 控制器注册；域创建/重连 → RPC 打底；
// `api-session/status` 中继 → 就地改 activity。少接一根线，功能就整个静默消失，
// 而离线断言照样全绿——这正是本仓库「测试绿、功能缺」的经典形态。
{
  const adapter = read("src", "dsh", "adapter.ts");
  const protocol = read("src", "dsh", "protocol.ts");

  // 1) 事件被认成「消费」而不是「静默」：适配器要读它的内容
  assert.ok(
    /export const CONSUMED_EVENT_TYPES[\s\S]{0,300}"subagent\/catalog"/.test(protocol),
    "subagent/catalog 要在 CONSUMED_EVENT_TYPES 里（消费但不渲染）",
  );
  assert.ok(
    /case "subagent\/catalog": \{[\s\S]{0,400}subagentFromCatalogEvent\(data\)[\s\S]{0,200}this\.onSubagentEstablished\?\.\(entry\)/.test(
      adapter,
    ),
    "适配器要解析 subagent/catalog 并交给 onSubagentEstablished",
  );
  assert.ok(
    /case "session\/end-seed": \{[\s\S]{0,200}this\.seedEndSeq = /.test(adapter),
    "适配器要记下继承前缀的边界（分叉会话的目录事实属于源会话）",
  );

  // 2) 控制器把注册接上（漏了的话适配器那个钩子永远是 undefined）
  assert.ok(
    /adapter\.onSubagentEstablished = \(entry\) => this\.registerSubagent\(scope, entry\);/.test(controller),
    "openScopeFollow 要把 onSubagentEstablished 接到 registerSubagent",
  );
  assert.ok(
    /private registerSubagent\(scope: SessionScope, entry: SubagentView\): void \{[\s\S]{0,300}mergeSubagentEntries\(scope, \[entry\]\)/.test(
      controller,
    ),
    "registerSubagent 要并入目录（不是整表替换）",
  );

  // 3) 打底：域创建与重连各拉一次 RPC —— 重载窗口后不点开面板也得有列表
  const bootstraps = controller.match(/void this\.refreshSubagentCatalog\(scope\);/g) ?? [];
  assert.ok(
    bootstraps.length >= 2,
    `域创建与 onConnected 都要打底（数到的调用点：${bootstraps.length} 个）`,
  );
  // 只看 `ensureScope` 那一段：别处（`onConnected`）也有同样的调用文本，
  // 整文件正则会在错的地方匹配成功（本仓库「断言钉错东西」的老毛病）
  const ensureStart = controller.indexOf("private ensureScope(");
  const ensureBody = controller.slice(ensureStart, controller.indexOf("private ensureDefaultModelApplied("));
  assert.ok(ensureStart >= 0, "controller 必须有 ensureScope");
  assert.ok(
    /this\.openScopeFollow\(scope\);[\s\S]{0,900}?void this\.refreshSubagentCatalog\(scope\);/.test(ensureBody),
    "ensureScope 建域后要打底（这是「重载窗口零点击」的那一下）",
  );
  assert.ok(
    /for \(const scope of this\.scopes\.values\(\)\) void this\.refreshSubagentCatalog\(scope\);/.test(controller),
    "onConnected 要对所有域重拉（掉线期间建立的子代理没有任何帧能到）",
  );

  // 4) RPC 那一路带 `activity`，但**也是并入**（它不保证是超集：冷子代理身份读不出来
  //    时服务端给的是被滤掉的诊断行，整表替换会把已有条目一起丢掉）；失败时保留现有列表
  const refresh = controller.slice(controller.indexOf("private refreshSubagentCatalog"));
  const refreshBody = refresh.slice(0, refresh.indexOf("private async refreshSubagents"));
  assert.ok(
    /const entries = subagentsFromList\(result\.entries\);[\s\S]{0,400}?this\.mergeSubagentEntries\(scope, entries\)/.test(
      refreshBody,
    ),
    "RPC 行要并入（并带上它给的 activity），不是整表替换",
  );
  assert.ok(
    !/entries: \[\]/.test(refreshBody),
    "RPC 失败时不许发空列表——那会把一次瞬时故障说成「这个会话没有子代理」",
  );
  assert.ok(
    /subagentRefreshes\.delete\(scope\.sessionId\)/.test(refreshBody),
    "单飞表必须有清理路径（按会话为键的 Map 涨上去就是永久泄漏）",
  );

  // 5) 状态中继：不点开面板也要能点亮状态点与头部呼吸
  assert.ok(
    /this\.syncSubagentActivity\(status\.sessionId, status\.running\);/.test(controller),
    "api-session/status 中继要同步子代理的 activity（官方 updateCatalogActivity 同款）",
  );
  assert.ok(
    /private syncSubagentActivity\(childSessionId: string, running: boolean\): void \{[\s\S]{0,400}withSubagentActivity\(/.test(
      controller,
    ),
    "syncSubagentActivity 要按 id 就地改一条",
  );
}

console.log("\nsubagentPanel: all assertions passed");
