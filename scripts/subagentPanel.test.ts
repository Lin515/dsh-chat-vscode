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
  assert.ok(
    /<SubagentTranscriptPanel[\s\S]{0,300}loading=\{state\.subagent\.loading === true\}/.test(app),
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

console.log("\nsubagentPanel: all assertions passed");
