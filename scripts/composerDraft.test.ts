/**
 * 草稿（输入框内容）在「提交」这条链路上的顺序契约。
 *
 * 用户 2026-09-23 报的现场：消息发出后输入框先清空，又闪回一下，再消失。
 *
 * 机制（§0 是可执行的**对照**）：界面在按下发送那一刻就乐观清空了自己的草稿
 * （`Composer.send` → `ui/setDraft`），而宿主的草稿表要等到 `send` 后段才清。
 * 空态第一次发消息时 `send` 会先 `ensureSession` → `createSession`，它在绑定后推一份
 * **整份状态快照**，快照里的 `draft` 读的正是那张表——于是刚发出去的正文被塞回输入框
 * （闪回），随后提交那条 patch 再把它清掉（消失）。
 *
 * 因此有两条不变量，且都在宿主侧：
 *  1. 「按下发送那一刻的乐观动作」（乐观回显 + 清草稿 + 清附件芯片）必须早于**任何**
 *     await——现在收在 `beginSend` 里，由 `submitMessage` 在 `ensureConnected` 之前调用
 *     （连接可能要拉起内部 DSH，秒级；这期间任何一份整份快照都会把正文塞回输入框、
 *     把回显抹掉）；
 *  2. 只要没真的发出去，那条回显就**留在原地标成失败**（红框 + 重发 / 撤回 + 原因，
 *     用户 2026-09-25 口径：失败不撤回显示），**不**把正文回填输入框——正文就在那一行里，
 *     回填会变成两份。唯一例外是用户主动取消目录选择（那不是失败）。
 *
 * 宿主这两条只能按源码钉：`controller.ts` 依赖 `vscode`，离线断言跑不了它
 * （抠方法体比偏移是既有手法，见 `invariants.test.ts` 的「没有第一条消息就不建会话」）。
 * 「回显到底有没有到界面、承认/失败后长什么样」是行为级断言，在 `scripts/pendingEcho.test.ts`
 * 里驱动真控制器跑（同一套 offline stub）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialState, reducer } from "../src/webview/state";

const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");

/** 抠出一个方法体：从签名到下一个同缩进的成员 / 文档注释（与 invariants.test.ts 同一手法）。 */
function bodyOf(signature: string): string {
  const start = controller.indexOf(signature);
  assert.ok(start >= 0, `controller.ts 里找不到 ${signature}`);
  const rest = controller.slice(start + signature.length);
  const end = rest.search(/\n  \/\*\*|\n  (?:private|public|protected|async|readonly|get|set) /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** `case "send":` 那一段（到 `case "stop":` 为止；找不到终点时取一段固定长度）。 */
function sendBranch(): string {
  const start = controller.indexOf('case "send":');
  assert.ok(start >= 0, "controller.ts 里找不到 send 分支");
  const stop = controller.indexOf('case "stop":', start);
  return controller.slice(start, stop < 0 ? start + 1200 : stop);
}

// ---------- 0. 对照：整份快照会把「已经提交过的」草稿塞回输入框 ----------
//
// 这条是**对照**，不是产品行为：它证明后面两条顺序钉子不是形式主义。
// 序列 = 界面按下发送（乐观清空）+ 宿主建会话时推的那一份整份快照。
{
  const typed = reducer(initialState, { type: "ui/setDraft", text: "hello" });
  assert.strictEqual(typed.draft, "hello", "打字：草稿在界面里");

  const submitted = reducer(typed, { type: "ui/setDraft", text: "" });
  assert.strictEqual(submitted.draft, "", "按下发送：界面立刻清空输入框（乐观）");

  // 宿主 `snapshotFor` 出的整份快照（这里只摆与草稿有关的那一项）
  const snapshot = reducer(submitted, { type: "state", state: { draft: "hello" } } as never);
  assert.strictEqual(
    snapshot.draft,
    "hello",
    "（对照）整份快照带着已提交的正文 → 输入框闪回；这就是 bug 现场",
  );
}
console.log("composerDraft: 整份快照会把已提交的草稿塞回输入框（bug 现场可复现）✓");

// ---------- 1. 按下发送那一刻的乐观动作，必须早于任何 await ----------
//
// 空态第一次发消息这条路：`case "send":` → `beginSend`（同步：乐观回显 + 清草稿 +
// 清附件）→ `ensureConnected`（可能要拉起内部 DSH，秒级）→ `ensureSession` →
// `createSession` → 推整份快照（快照里的 `draft` / `attachments` / `pendingMessages`
// 读的都是宿主那几张表）。晚一步，那一帧就是「清空 → 闪回 → 消失」，或者回显被抹掉。
{
  const begin = bodyOf("private beginSend(");

  assert.ok(
    /this\.commitDraft\(viewId\)/.test(begin),
    "「提交即清空草稿」要落在 beginSend 里（它排在连接与建会话之前）",
  );
  assert.ok(
    /this\.commitAttachments\(viewId\)/.test(begin),
    "附件芯片同理：界面自己不清附件，晚清一步回显里那份与芯片那份会同时显示",
  );
  assert.ok(
    !/\bawait\b/.test(begin),
    "beginSend 必须是同步的：它一旦 await，回显与清空就落到 await 之后，等于没优化",
  );

  const branch = sendBranch();
  assert.ok(
    /await this\.submitMessage\(/.test(branch),
    '`case "send":` 分支要走 submitMessage（它内部先 beginSend 再连接；重发那条路走同一个入口）',
  );
  const submit = bodyOf("private async submitMessage(");
  const submitBeginAt = submit.indexOf("this.beginSend(");
  const submitConnectAt = submit.indexOf("ensureConnected(");
  assert.ok(
    submitBeginAt >= 0 && submitConnectAt >= 0 && submitBeginAt < submitConnectAt,
    "乐观动作（beginSend）必须排在 ensureConnected 之前：连接期间界面就该看到这条消息" +
      `（实测偏移：beginSend ${submitBeginAt}、ensureConnected ${submitConnectAt}）`,
  );
}
console.log("composerDraft: 乐观动作早于连接与建会话 ✓");

// ---------- 1b. 绑定会话时这份（已经是空的）草稿要跟着迁到会话键 ----------
//
// 空态清的是**窗口键**（那时还没有会话），随后 `bindViewToSession` 把它迁到会话键，
// 而整份快照读的正是会话键。迁移判据必须是「值不是 undefined」而不是「值非空」：
// 提交后的草稿刚好是空串，按「非空」判就会把它留在窗口键上，会话键下读到的是
// 更早的值（老值早被清则无事，但有旧值时就是同一族闪回的另一个入口）。
// 乐观回显同理：它是**第一条消息**唯一必须迁的东西（不迁就被 createSession 那份快照抹掉）。
{
  assert.ok(
    /if \(draft !== undefined\) \{/.test(controller),
    "窗口↔会话的草稿迁移必须按「值不是 undefined」搬：提交后的空串也要搬走",
  );
  assert.ok(
    /const pending = this\.pendingMessages\.get\(viewId\);/.test(controller),
    "乐观回显要跟着草稿/附件一起从窗口键迁到会话键（第一条消息的唯一依据）",
  );
}
console.log("composerDraft: 空草稿与乐观回显同样按会话键迁移 ✓");

// ---------- 2. 没真的发出去：那一行留在原地标成失败（正文不回输入框） ----------
//
// 用户 2026-09-25 口径（改了 2026-09-23 那条「必须把草稿还回去」）：失败**不撤回显示**
// ——消息留在对话流里、气泡红框、给「重发 / 撤回」，行尾写原因；正文就留在那一行里，
// 回填输入框只会变成「输入框一份 + 消息流一份」。
// **有回显**的那些失败路径（连不上 / 拼不出内容块 / prompt 抛错）都落到 `failEcho`；
// 本来就没有回显的两档（运行中发送那条、子代理会话）走老口径 `appendDraft` + 原生提示，
// 唯一「有回显却回填草稿」的例外是用户**主动取消**目录选择——那不是失败。
{
  const send = bodyOf("private async send(");
  assert.ok(
    !/if \(!scope\) return;/.test(send),
    "ensureSession 拿不到会话时不能裸 return：要么标成失败，要么（用户取消时）把正文还回去",
  );
  assert.ok(
    /this\.retireEcho\(requestId, "workspace-cancelled"\)[\s\S]{0,80}?this\.appendDraft\(/.test(send),
    "用户主动取消目录选择是唯一回填草稿的路径（把用户自己的取消画成红框是误导）",
  );
  const failed = (send.match(/failEcho\(/g) ?? []).length;
  assert.ok(
    failed >= 2,
    "「没发出去」的路径都要落到 failEcho（那一行留在原地标成失败），" +
      `send 里只找到 ${failed} 处`,
  );
  assert.ok(
    /finally \{[\s\S]{0,120}?if \(!admitted\) this\.failEcho\(/.test(send),
    "try 里那些提前 return 的失败分支由 finally 收网（将来往 try 里加分支也不会漏）",
  );
  assert.ok(
    !/appendDraft\(viewId, text, attachments\);[\s\S]{0,60}?retireEcho\(/.test(send),
    "失败路径不许再走「回填草稿 + 收回回显」那套旧口径",
  );
}
console.log("composerDraft: 没发出去的路径都留在原地标成失败 ✓");

// ---------- 3. 连不上后台：那一行标成失败并说明原因 ----------
//
// `ensureConnected` 失败后 `send` 会因为 `!this.client` 直接返回，而界面已经清空了
// 输入框（关掉 autoConnect、内部后台又起不来时就能撞上）。
{
  const submit = bodyOf("private async submitMessage(");
  assert.ok(
    /this\.failEcho\(requestId, "@sendNoConnection"\)/.test(submit),
    "连不上时那一行标成失败并写明原因（正文不回输入框）",
  );
}
console.log("composerDraft: 连不上后台时那一行标成失败 ✓");

// ---------- 4. 「谁的内容」决定动不动输入框；发给服务端只有一条通道 ----------
//
// 四个调用点（用户按发送 / 失败行上的重发 / ESC 后把排队消息接着发出去 / 摘不动队列时的回滚）
// 共用 `submitMessage` 一条通道；`source` 只回答「这段内容是谁的」：
// - `composer` = 输入框里那份 ⇒ 提交即清空（`beginSend` 与 `send` 里的复述都只对它做）；
// - `retry` / `queue` = 失败那一行 / 排队区里那份 ⇒ **一个字都不许动输入框**：用户此刻
//   可能正打着另一句话，清它就是数据丢失。
{
  // ① 清空两处都 gate 在 composer 上
  const begin = bodyOf("private beginSend(");
  const beginGate = begin.indexOf('if (source === "composer") {');
  const beginCommit = begin.indexOf("this.commitDraft(viewId)");
  assert.ok(
    beginGate >= 0 && beginCommit > beginGate,
    "beginSend 的「提交即清空」必须在 `source === \"composer\"` 门内（重发 / 排队重发不许清）",
  );
  const send = bodyOf("private async send(");
  const sendGate = send.indexOf('if (source === "composer") {');
  const sendClear = send.indexOf("this.drafts.set(key, \"\")");
  assert.ok(
    sendGate >= 0 && sendClear > sendGate,
    "send 里那处按会话键的「复述清空」同样只在输入框来源下发生",
  );

  // ② 重发走 `retry` 来源（它不是输入框里那份）
  const resendStart = controller.indexOf('case "resendPending":');
  assert.ok(resendStart >= 0, "找不到 resendPending 分支");
  const resend = controller.slice(resendStart, controller.indexOf('case "stop":', resendStart));
  assert.ok(
    /submitMessage\(viewId, echo\.text, echo\.attachments, "enter", "retry"\)/.test(resend),
    "重发按 `retry` 提交：走同一条通道，但不碰输入框",
  );
  assert.ok(
    /this\.echoOfView\(viewId, message\.requestId\)/.test(resend),
    "重发只认这个窗口自己那份账本（不许按 id 全局找）",
  );
  assert.ok(
    /this\.echoOfView\(viewId, message\.requestId\)/.test(controller.slice(controller.indexOf('case "retractPending":'))),
    "撤回同样要过所有权这道门",
  );

  // ③ 排队重发/回滚也走同一条通道：`resubmit` 不再自己铸 requestId、自己 prompt
  const resubmit = bodyOf("private async resubmit(");
  assert.ok(
    /this\.submitMessage\(\s*viewId,\s*origin\.text,\s*origin\.attachments,\s*"enter",\s*"queue"/.test(resubmit),
    "ESC 后的排队重发走统一入口（那一刻空闲就立刻显示、失败也按统一口径收场）",
  );
  assert.ok(
    !/client\.prompt\(/.test(resubmit) && !/rememberSubmission\(/.test(resubmit),
    "`resubmit` 不许自己调 prompt / 自己记 submissions（那就是第二条发送通道）",
  );
  assert.ok(
    /origin\.content as PromptContentPart\[\] \| undefined/.test(resubmit),
    "排队消息的内容块用当初提交的那一份（投影里那份可能含内联图片字节，按文本重建会丢）",
  );

  // ④ 成功之后的提示不许落在 try 里（它抛错会被 catch 当成「没发出去」）
  const warnAt = send.indexOf("this.warnUploadIncomplete(");
  const finallyAt = send.indexOf("} finally {");
  assert.ok(
    warnAt > finallyAt && /if \(admitted && notUploaded\.length\)/.test(send),
    "上传不完整的提示放在 try/finally 之外，且只在真的发出去之后发",
  );
}
console.log("composerDraft: 来源决定动不动输入框、发送只有一条通道 ✓");

console.log("\ncomposerDraft: all assertions passed");
