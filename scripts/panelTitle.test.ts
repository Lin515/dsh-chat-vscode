/**
 * 编辑区标签的标题与「窗口身份」的读法（`shared/chat.ts` 的两个纯函数）。
 *
 * 用户 2026-09-21 的两条口径：
 *   1. 标签上**不再恒写 `DSH`**——会话有标题就显示标题，只有新会话（还没标题）才写
 *      `DSH`；**不带运行状态**（同一天的二次口径：状态后缀与图标标识都撤掉，保持静态）；
 *   2. 重载后标签与会话**不能交叉**——靠的是 webview 存下的会话 id（身份），
 *      所以「存成什么形状、怎么读回来」必须逐字对得上：写的那一半在
 *      `webview/bridge.ts`（`persistIdentity`），读的那一半在 `chatView.ts`
 *      （`parsePanelIdentity`），这里把形状本身钉住（认不出 → undefined →
 *      宿主退回按顺序认领，不会拿着垃圾字符串去猜）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { panelTabTitle, parsePanelIdentity, type PersistedState } from "../src/shared/chat";

// ---------- 1. 标签标题（纯静态：标题 / DSH，不带状态） ----------

{
  assert.strictEqual(
    panelTabTitle("修复标签恢复错位"),
    "修复标签恢复错位",
    "已经有标题的会话：标签就是标题（不再顶一个 DSH 前缀）",
  );
  // 新会话（没有标题）只显示 DSH：标签区只有它一条，认得出是扩展的窗口
  assert.strictEqual(panelTabTitle(undefined), "DSH");
  assert.strictEqual(panelTabTitle(""), "DSH");
  assert.strictEqual(panelTabTitle("   "), "DSH", "只有空白的标题按「还没有标题」处理（否则标签一片空白）");
  assert.strictEqual(panelTabTitle("  修 bug  "), "修 bug", "标题两端空白去掉（会话标题来自服务端，可能带空白）");
}
console.log("panelTitle: 标签标题（标题 / DSH，纯静态）✓");

// ---------- 2. 窗口身份的读法：认不出的就当没存过 ----------

{
  // 界面真正写下去的形状（bridge.persistIdentity 的产物）
  const written: PersistedState = { identity: { sessionId: "session-abc" } };
  // 真实路径会过一遍 JSON（webview state 是字符串存下来的）
  assert.deepStrictEqual(
    parsePanelIdentity(JSON.parse(JSON.stringify(written)) as unknown),
    { sessionId: "session-abc" },
    "过 JSON 之后仍要读得出会话 id（webview state 就是 JSON 存的）",
  );
  assert.strictEqual(
    parsePanelIdentity({ identity: { sessionId: null } }),
    undefined,
    "空态（当时是新建的空窗口）没有会话可接",
  );
  // 正在看子代理的窗口：地址完整成立才带回来
  assert.deepStrictEqual(
    parsePanelIdentity({ identity: { sessionId: "child-1", subagent: { parentSessionId: "p", mode: "continuable" } } }),
    { sessionId: "child-1", subagent: { parentSessionId: "p", mode: "continuable" } },
    "子代理会话的地址必须原样读回（恢复路径只有它能重新进入）",
  );
  for (const broken of [
    { identity: { sessionId: "child-1", subagent: { parentSessionId: "", mode: "continuable" } } },
    { identity: { sessionId: "child-1", subagent: { parentSessionId: "p" } } },
    { identity: { sessionId: "child-1", subagent: { parentSessionId: "p", mode: "whatever" } } },
    { identity: { sessionId: "child-1", subagent: "p" } },
  ]) {
    assert.deepStrictEqual(
      parsePanelIdentity(broken),
      { sessionId: "child-1" },
      `半截的子代理地址按普通会话处理：${JSON.stringify(broken)}`,
    );
  }
  // 认不出的形状一律 undefined：宿主据此退回按顺序认领，而不是拿垃圾去猜
  for (const broken of [
    undefined,
    null,
    "session-abc", // 旧版本可能存成裸字符串（那一版没有这个能力，就当没存过）
    {},
    { identity: null },
    { identity: "session-abc" },
    { identity: { sessionId: 42 } },
    { identity: { sessionId: "" } },
  ]) {
    assert.strictEqual(
      parsePanelIdentity(broken),
      undefined,
      `形状不认识必须返回 undefined：${JSON.stringify(broken)}`,
    );
  }
}
console.log("panelTitle: 窗口身份只认自己写的形状 ✓");

// ---------- 3. 结构不变量：写与读必须真的接上（跨两个产物，静默失效最难查） ----------

{
  const bridge = readFileSync(join(process.cwd(), "src", "webview", "bridge.ts"), "utf8");
  assert.ok(
    /setState\(state\)/.test(bridge) && /PersistedState/.test(bridge),
    "webview 必须真的把身份写进 VS Code 的 state（setState 是唯一的写入通道）",
  );
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.ok(
    /deserializeWebviewPanel: \(panel: vscode\.WebviewPanel, state: unknown\)/.test(chatView) &&
      /parsePanelIdentity\(state\)/.test(chatView) &&
      /claimPanelRestore\(/.test(chatView),
    "序列化器必须把 state 里的身份交给认领（只看顺序就还会交叉）",
  );
  assert.ok(
    /registerTitleSetter\(viewId/.test(chatView),
    "面板必须把「写标签标题」的动作注册给控制器（否则标题永远停在创建时的 DSH）",
  );
  // 标签**纯静态**（用户 2026-09-21 二次口径）：图标只有那一份静态鲸鱼，运行时不再
  // 改 `iconPath`，也没有「生成中」这个状态标识
  assert.ok(
    !/registerRunningIconSetter|loading~spin|ThemeIcon/.test(chatView) &&
      !/runningIcons/.test(chatView),
    "标签上不许再有任何运行状态标识（图标不随状态变）",
  );
  assert.ok(
    !/panelRunning/.test(chatView) &&
      !/panelRunning/.test(readFileSync(join(process.cwd(), "src", "dsh", "hostText.ts"), "utf8")),
    "「正在生成」那条文案与它的 l10n 通道一起撤掉（不留死文案 / 死译文）",
  );
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /persistIdentity\(sessionId/.test(app),
    "界面必须在**会话变化时**重存身份（只在启动写一次的话，切过会话再重载就错了）",
  );
  // attachPanel 的顺序：`bindViewKind` 会顺手同步一次标签，标题写入动作必须已经就位
  const kindAt = chatView.indexOf('this.controller.bindViewKind(viewId, "panel")');
  const titleAt = chatView.indexOf("this.controller.registerTitleSetter(viewId");
  const iconAt = chatView.indexOf('panel.iconPath = vscode.Uri.joinPath');
  assert.ok(kindAt > 0 && titleAt > 0 && iconAt > 0, "attachPanel 的三处接线都要在");
  assert.ok(
    titleAt < kindAt && iconAt < kindAt,
    "静态图标与标题写入动作必须先于 bindViewKind（否则它同步那一次算出来的标题没人接）",
  );
}
console.log("panelTitle: 身份写 / 读两侧接线（标签纯静态）✓");

console.log("\npanelTitle: all assertions passed");
