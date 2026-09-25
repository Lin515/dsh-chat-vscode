/**
 * 子代理导航与会话级切换（2026-09-24 口径：与官方 Web 端同构）：
 *
 * 1. **入口在标题右侧**（官方 `SubagentHeaderLineage` / `SubagentCatalogAction`），
 *    没有独立的子代理按钮；目录为空时整个不渲染；
 * 2. **进入子代理 = 会话级切换**（`openSession` 带子代理地址）：消息流、输入框、
 *    生成状态全来自子代理会话本身——可继续子代理**可以接着对话**，不再只读；
 * 3. 面包屑点**左半**返回父会话；右半（标题 + 切换图标）弹出父目录切换兄弟；
 * 4. 一次性子代理的对话是**只读**记录（输入区换成说明）；
 * 5. 发送与停止按地址路由（`subagents/prompt` / `subagents/interruptByParent`）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

const app = read("src", "webview", "App.tsx");
const composer = read("src", "webview", "components", "Composer.tsx");
const state = read("src", "webview", "state.ts");
const client = read("src", "dsh", "client.ts");
const controller = read("src", "dsh", "controller.ts");
const messages = read("src", "webview", "messages.ts");
const css = read("src", "webview", "styles", "app.css");

// ---------- 1. 入口：标题右侧，没有独立按钮，无子代理时不占位 ----------
{
  assert.ok(
    !/panel === "subagents"/.test(app),
    "子代理不再有独立的抽屉面板：头部那颗按钮已随入口一起删掉",
  );
  assert.ok(
    !/SubagentsPanel|SubagentTranscriptPanel/.test(app),
    "两个子代理面板组件不再被 App 使用（入口换成标题右侧的导航）",
  );
  const panels = read("src", "webview", "components", "Panels.tsx");
  assert.ok(
    !/SubagentsPanel|SubagentTranscriptPanel/.test(panels),
    "Panels.tsx 里不应再有两个子代理面板的实现（历史 / 后台任务仍在）",
  );
  // 导航组件在标题之后：面包屑读起来才是「标题 / 子代理」
  const headerAt = app.indexOf("<span className=\"header-title\">");
  const navAt = app.indexOf("<SubagentNav state={state} agentsBusy={agentsBusy} />");
  const spacerAt = app.indexOf('<span className="header-spacer" />');
  assert.ok(headerAt > 0 && navAt > headerAt && spacerAt > navAt, "导航要挂在标题右侧、弹性空隙之前");
  // 普通会话：目录为空就整个不渲染（官方：empty catalog 隐藏触发器）。
  // 判据统一收口在「展开用的那份清单」上——普通会话取自己的目录、子代理页取父目录。
  assert.ok(
    /if \(entries\.length === 0\) return null;/.test(app),
    "目录为空时导航整个不渲染（不占位置，与官方同口径）",
  );
  // 触发器发一次按需刷新（下拉里的清单要拿最新的）
  assert.ok(
    /post\(\{ type: "listSubagents" \}\)/.test(app),
    "打开 / 悬停触发器要发 listSubagents 刷新目录",
  );
}
console.log("subagentPanel: 入口在标题右侧、空目录不渲染 ✓");

// ---------- 2. 返回主会话 = 点标题栏的主会话标题；切换列表 = 点「/ 子代理标题 ▾」 ----------
{
  // 标题栏本身就有主会话标题：子代理页把它变成可点按钮（不重复加一节「父标题 /」）
  assert.ok(
    /className="header-title"\s+title=\{texts\.backToParent\(child\.parentTitle\)\}\s+onClick=\{\(\) => post\(\{ type: "openSession", sessionId: child\.parentSessionId \}\)\}/.test(
      app,
    ),
    "子代理页的主会话标题要变成可点按钮（点击返回主会话，openSession 不带地址 = 普通会话）",
  );
  // 导航里不许再有第二份「父会话标题」（否则标题重复一节）
  assert.ok(
    !/subagent-crumb-root/.test(app),
    "导航里不许再渲染父会话标题（返回入口就是标题栏已有的那颗标题）",
  );
  assert.ok(
    /current=\{entry\.id === currentId\}/.test(app) && /const currentId = child \? state\.session\?\.id : undefined;/.test(app),
    "父目录里要标出当前所在的那一行（current 行不可再点）",
  );
  // 清单两路合一：子代理页取父目录（兄弟行含自己），普通会话取自己的目录；
  // 列表里 current 行标记当前所在（兄弟切换 / 下级进入共用同一份渲染）
  assert.ok(
    /const entries = child \? child\.parentEntries : state\.subagentEntries;/.test(app) &&
      /entries\.map\(\(entry\) =>/.test(app),
    "切换列表的数据两路合一（父目录 / 自身目录），当前行可识别",
  );
  // 触发器标题与列表行**同源**（目录里当前那一行的 label）：子代理会话的自动标题
  // 是另一套字段，不会出现「列表里叫 A、触发器上叫 B」（2026-09-24 报的不一致）
  assert.ok(
    /const currentLabel = child\s*\?\s*\(entries\.find\(\(entry\) => entry\.id === currentId\)\?\.label \?\? state\.session\?\.title\)/.test(
      app,
    ),
    "触发器的标题必须取目录里当前行的 label（与列表行同一个来源同一个值）",
  );
  // 词典：计数 / 返回 / 切换的提示都要中英两套（双语硬规则）
  assert.ok(
    /subagentCount:\s*\{\s*zh: \(count: number\)/.test(messages),
    "计数触发器的文案（含个数）在消息表里",
  );
  assert.ok(
    /backToParent:\s*\{\s*zh: \(title: string\)/.test(messages) &&
      /subagentSwitcher:\s*\{\s*zh: \(title: string\)/.test(messages),
    "返回提示（主会话标题的 title）与切换提示在消息表里",
  );
  // 样式：可点标题 / 触发器 / 弹出列表都在（官方 CatalogDropdown 的同款皮肤）
  assert.ok(
    /button\.header-title \{/.test(css) && /\.subagent-trigger \{/.test(css) && /\.subagent-menu \{/.test(css),
    "app.css 要有导航的样式（可点标题 / 触发器 / 定宽列表）",
  );
  // 列表是「点了展开」的固定宽度菜单（官方 .menu 同款），不是每次渲染都挂着的浮层
  assert.ok(
    /\{open \? \(\s*<div className="subagent-menu"/.test(app),
    "目录列表随 open 条件渲染（点击展开，点外部 / Esc 收起）",
  );
  // 开合**只认点击**（用户 2026-09-24 口径：不要悬停自动展开）；再点一次关闭
  const nav = app.slice(app.indexOf("function SubagentNav"), app.indexOf("const CONNECT_POST"));
  assert.ok(
    !/onMouseEnter|onMouseLeave/.test(nav),
    "触发器不许带悬停展开 / 移开收起（用户口径：只认点击）",
  );
  assert.ok(
    /setOpen\(\(v\) => !v\)/.test(nav),
    "触发器点击是 toggle：展开后再点一次关闭",
  );
}

// ---------- 3. 会话级切换：宿主按目录行的真实模式开子代理 ----------
{
  assert.ok(
    /await this\.openSession\(viewId, childSessionId, \{\s*parentSessionId: hit\.parentId,\s*mode: hit\.entry\.mode,\s*\},\s*hit\.catalog\);/.test(
      controller,
    ),
    "openSubagent 走 openSession 的子代理地址（会话级切换，与官方 openSession(address) 同构），父目录随行作种子",
  );
  // 地址的 mode 必须来自目录行：硬编码 continuable 打开 one-shot 子代理会被
  // `subagent/unauthorized` 拒绝（address 是鉴权的一部分，不是提示）
  const open = controller.slice(controller.indexOf("private async openSubagent"));
  const openBody = open.slice(0, open.indexOf("// ---------- 斜杠命令"));
  const requestLines = openBody
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !/mode: "continuable"/.test(requestLines),
    "openSubagent 里不许出现硬编码的 mode（一次性子代理会被鉴权整条拒绝）",
  );
  // follow 流按域上的地址打开（子代理地址是宿主鉴权的一部分）
  assert.ok(
    /\}, scope\.subagentAddress\);/.test(controller),
    "openScopeFollow 要把域上的子代理地址传给 followSession（普通会话地址打不开子代理）",
  );
  assert.ok(
    /subagent\?: \{ parentSessionId: string; mode: "one-shot" \| "continuable" \},\s*\): StreamHandle/.test(
      client.replace(/\n/g, "\n"),
    ) || /subagent\?: \{ parentSessionId: string; mode: "one-shot" \| "continuable" \},\s*\n\s*\): StreamHandle/.test(client),
    "followSession 要能带子代理地址（地址拼装在 client 一处）",
  );
  // 分页同样按地址（往前翻历史用 session/page，地址错了一页都取不到）
  assert.ok(
    /this\.client!\.page\(scope\.sessionId, throughSeq, beforeSeq, 50, scope\.subagentAddress\)/.test(controller),
    "分页要带上子代理地址",
  );
  // 一次性子代理点不进去的保护：目录里没有的 id 不切窗口
  assert.ok(
    /text: "@subagentNotFound"/.test(controller),
    "目录里查不到的子代理要如实提示，不把窗口切到开不出来的会话上",
  );
  // **层级不能因为切换而变深**（用户 2026-09-24 口径）：子代理页上的查找空间**只有
  // 父目录**——先查当前会话自己目录的写法会把「切换兄弟」变成「进入下级」
  const resolveBlock = requestLines.slice(
    requestLines.indexOf("const resolve = ()"),
    requestLines.indexOf("let hit = resolve()"),
  );
  assert.ok(
    /if \(address\) \{[\s\S]{0,300}return undefined;[\s\S]{0,80}\}/.test(resolveBlock),
    "子代理页上的查找必须先按地址分流：只在父目录里找兄弟，查不到就放弃",
  );
  assert.ok(
    resolveBlock.indexOf("if (address)") < resolveBlock.indexOf("scope.subagentEntries.find"),
    "查找空间要先判「自己在子代理页」：兄弟查找优先、自身目录只在普通会话时才参与",
  );
  // 打开菜单 / 切换前刷新的也是「列表根部」的目录（官方 refreshProjection(parentId)）：
  // 子代理页刷父目录，普通会话刷自己的
  const refresh = controller.slice(
    controller.indexOf("private async refreshSubagents"),
    controller.indexOf("private async openSubagent"),
  );
  assert.ok(
    /if \(scope\.subagentAddress\) \{[\s\S]{0,500}refreshSubagentCatalog\(parent\)|fetchParentCatalog\(scope\)/.test(
      refresh,
    ),
    "子代理页打开导航要刷父目录（兄弟行的 label / activity 才是最新的）",
  );
}
console.log("subagentPanel: 会话级切换（真实模式 + 地址化 follow/page）✓");

// ---------- 3b. 状态打底：进入前就能亮出「生成中」 ----------
//
// 子代理不在会话列表里（列表是过滤过的），running 的打底来自父目录行的 activity；
// 父域不在（恢复路径）时用 session/list 原始行的 running。
{
  const ensure = controller.slice(
    controller.indexOf("private ensureScope("),
    controller.indexOf("private openScopeFollow("),
  );
  assert.ok(
    /scope\.running =/.test(ensure) && /entry\.activity === "running"|subagentRunning\.get\(/.test(ensure),
    "ensureScope 要给子代理域一个 running 打底（正在跑的子代理开进来必须立刻是「生成中」）",
  );
  assert.ok(
    /this\.subagentRunning\.set\(item\.sessionId, item\.running\)/.test(controller),
    "refreshSessions 要把子代理行的 running 记下来（恢复路径的打底来源）",
  );
}
console.log("subagentPanel: 子代理域的 running 打底 ✓");

// ---------- 4. 发送与停止按地址路由 ----------
{
  assert.ok(
    /await this\.client\.promptSubagent\(address\.parentSessionId, scope\.sessionId, content, mode, requestId\);/.test(
      controller,
    ),
    "子代理地址的发送走 subagents/prompt（session/prompt 对子代理会话不成立）",
  );
  assert.ok(
    /delivery,\s*content,/.test(client) || /delivery,/.test(client),
    "prompt 的 mode 在 subagents/prompt 上叫 delivery（契约字段名）",
  );
  // 文件附件：官方硬规则（subagent/attachment-invalid）——有文件芯片就不发。
  // 子代理会话**不回显**（官方 sendSession 的 subagent 分支同样绕过 beginSubmission），
  // 所以这里没有能承载失败的那一行，沿用老口径：提示 + 正文回输入框。
  assert.ok(
    /address && content\.some\(\(part\) => part\.type === "file"\)/.test(controller) &&
      /text: "@subagentFilesUnsupported"/.test(controller),
    "子代理会话有文件附件时直接不发并提示（服务端会整轮拒绝）",
  );
  assert.ok(
    /await this\.client\.interruptSubagentByParent\(scope\.sessionId, address\.parentSessionId\);/.test(
      controller,
    ),
    "子代理的停止走 subagents/interruptByParent（父地址是持久事实，父不在线也停得了）",
  );
  // 客户端方法与线格式对齐（docs/dsh-server-api.md §9.2 的位置参数名）
  assert.ok(
    /"subagents\/prompt",\s*\{\s*request:\s*\{[\s\S]{0,400}delivery,/.test(client),
    "subagents/prompt 的参数是 {request: {...}}，delivery 必填（0.1.5 起）",
  );
  assert.ok(
    /"subagents\/interruptByParent",\s*\{\s*childSessionId,\s*parentSessionId,\s*mode: "continuable",\s*\}/.test(
      client,
    ),
    "interruptByParent 是三个平铺位置参数（不是 request 包裹）",
  );
}
console.log("subagentPanel: 发送与停止按地址路由 ✓");

// ---------- 5. 一次性子代理 = 只读记录 ----------
{
  assert.ok(
    /state\.subagent\?\.mode === "one-shot" \? \(\s*<div className="composer-readonly" role="status">/.test(
      composer(),
    ),
    "一次性子代理的输入区整个换成只读说明（官方 SubagentReadOnlyComposer 的选举）",
  );
  assert.ok(
    /subagentReadonlyTitle: \{ zh: "一次性子代理记录"/.test(messages) &&
      /subagentReadonlyBody:\s*\{[\s\S]{0,200}一次性任务不支持后续消息/.test(messages),
    "只读说明的中英两套在消息表里（官方 readonly.oneShot.* 同口径）",
  );
  assert.ok(
    /\.composer-readonly \{/.test(css),
    "只读说明要有样式（替代整个输入区，不是往输入框里塞 disabled）",
  );
  function composer(): string {
    return read("src", "webview", "components", "Composer.tsx");
  }
}
console.log("subagentPanel: 一次性子代理只读 ✓");

// ---------- 6. 上下文随绑定走：切回普通会话时清掉 ----------
{
  // `subagent` 是会话状态片段的一个键：快照全字段下发，切回普通会话时折成 null 清掉
  const sessionView = read("src", "dsh", "sessionView.ts");
  assert.ok(
    /"subagentEntries",\s*"subagent",\s*"jobs",/.test(sessionViewKeys(sessionViewText())),
    "SessionView 的键清单里要有 subagent（切换会话时随快照整体换掉）",
  );
  assert.ok(
    /subagent: \{\s*read: \(source\) => source\.subagent\?\.\(\) as SessionView\["subagent"\],\s*\}/.test(
      sessionViewText(),
    ),
    "字段表里要有 subagent 的取值与折返条目（三处生产者共用一张表）",
  );
  function sessionViewText(): string {
    return read("src", "dsh", "sessionView.ts");
  }
  function sessionViewKeys(text: string): string {
    return text.slice(text.indexOf("export const SESSION_VIEW_KEYS"), text.indexOf("] as const"));
  }
}

// ---------- 7. 注册与打底（2026-09-23 口径，继续有效）：列表不依赖「点开面板」 ----------
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
      read("src", "dsh", "adapter.ts"),
    ),
    "适配器要解析 subagent/catalog 并交给 onSubagentEstablished",
  );
  assert.ok(
    /case "session\/end-seed": \{[\s\S]{0,200}this\.seedEndSeq = /.test(read("src", "dsh", "adapter.ts")),
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

  // 3) 打底：域创建与重连各拉一次 RPC —— 重载窗口后不点开导航也得有列表
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
    /this\.openScopeFollow\(scope\);[\s\S]{0,1200}?void this\.refreshSubagentCatalog\(scope\);/.test(ensureBody),
    "ensureScope 建域后要打底（这是「重载窗口零点击」的那一下）",
  );
  assert.ok(
    /for \(const scope of this\.scopes\.values\(\)\) void this\.refreshSubagentCatalog\(scope\);/.test(controller),
    "onConnected 要对所有域重拉（掉线期间建立的子代理没有任何帧能到）",
  );

  // 3b) 恢复路径直接落到子代理页时，父目录用投影 RPC 补（单发 RPC，不开父域）
  assert.ok(
    /private async fetchParentCatalog\(scope: SessionScope\): Promise<void> \{[\s\S]{0,400}sessionProjections\(parentId\)/.test(
      controller,
    ),
    "父会话域不在时要用 session/projections 把父目录补进来（切换下拉才有兄弟行）",
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

  // 5) 状态中继：不点开导航也要能点亮状态点；父目录变化要推进正在看的子代理页
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
  assert.ok(
    /private deliverSubagentList\(scope: SessionScope\): void \{[\s\S]{0,500}this\.syncSubagentContext\(scope\.sessionId\);/.test(
      controller,
    ),
    "目录变化的唯一扇出点要把新上下文推进正在看子代理的窗口",
  );
}

console.log("\nsubagentPanel: all assertions passed");
