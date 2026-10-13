/**
 * 附件草稿的**归属与上传生命周期**回归（驱动真 `ChatController` + 账本 module，离线、
 * 无网络、零 token、亚秒级）。vscode 由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`。
 *
 * 这一族缺陷的现场（本文件在修复前必须红）：**上传还在飞的时候从会话 A 切到 B**，
 * A 的芯片永远停在「上传中」——成功与失败都经 `setStateForUpload(viewId)` →
 * `keyForView(viewId)` **重新解出当前会话**，于是状态写到 B 的账上（找不到那枚附件，
 * 什么也没改），A 那枚既没有回执、也没能落到失败态；更糟的是成功那一支把
 * `droppedBytes` 无条件删掉，切回 A 连「重试」都点不出第二次（没有路径、字节也没了），
 * 用户只能把芯片删掉重新添加。
 *
 * 修法：附件草稿的**归属**（哪一枚属于谁、字节归谁暂存）收进 `dsh/attachmentLifecycle.ts`
 * 一个 module——它按**记录身份**记账（键在空壳首次绑定 / 退回空态时会搬，身份不变），
 * 上传的「开轮 → 结算 → 旧轮作废」也全在里面，宿主只注入一次 IO（读字节 + `uploadFile`）。
 * 结算落在**开轮那一刻那条记录**上，与窗口此刻看的是哪条会话无关；没人看那条会话时就
 * 不推帧（切走后不再污染当前会话的输入框）。
 *
 * 文件分两段：
 * - §一 账本 module 的行为（跨它的真实 interface，不经过控制器）；
 * - §二 真控制器的接入 / 上传 / 切会话 / 移除 / 重试集成场景。
 *
 * §二 的读数口子（`listOf` / `putAttachment`）在账本接进控制器之前退回旧表，所以
 * 「旧控制器的真实上传链是红的」这件事可以在接线前后各跑一遍同一组断言来证明——
 * 红不是事后补一条永远绿的断言。
 *
 * 场景用 `scenario()` 包一层：一个场景的断言失败不打断其余场景，跑完一次性报出
 * 全部失败场景并以退出码 1 收场（诊断一条链路上的多个独立不变量时比逐条重跑快）。
 */
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Attachment } from "../src/shared/chat";
import { attachmentTempRoot, contentDigest } from "../src/dsh/attachmentOpen";
import { readOriginalTarget } from "../src/dsh/attachmentOpenStore";

process.on("unhandledRejection", (error) => {
  console.error("[attachmentLifecycle] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");
const { AttachmentLifecycle } = await import("../src/dsh/attachmentLifecycle");
const { editorCalls } = await import("./vscodeTestStub");

const A = "session-a";
const B = "session-b";
/** 一小段字节的 base64（内容本身不重要，断言只看字节是否原样复用）。 */
const BYTES_BASE64 = "aGVsbG8=";

/** 场景收集器：断言失败只记下来，跑完全部场景再一次性报出。 */
const failures: { name: string; error: unknown }[] = [];
async function scenario(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    console.log(`  ${name} ✓`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ${name} ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 受控 Promise：把一次上传挂在闸门上，场景自己决定何时放行。 */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让在飞的 Promise 续体跑完（一次宏任务足以覆盖 settled 之后的那几行同步代码）。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

/**
 * 一条**在当前平台上算绝对**的夹具路径。
 *
 * `node:path` 的 `isAbsolute` 是平台相关的：写死 `C:\ws\notes.md` 这类 Windows 形态，在
 * Linux 上会被当成相对路径（缺 cwd 时直接解析不了）——CI 在 ubuntu-latest 上冒出来的
 * 就是这一条。夹具只要求「绝对」，不要求文件真的存在（调用方各自定 `fileExistence`）；
 * 真正要落盘的场景另用 `mkdtempSync` 那一套。
 */
const absoluteFixturePath = (...parts: string[]): string => join(tmpdir(), "dsh-attachment-fixture", ...parts);

// =====================================================================================
// §一 账本 module 的行为（跨它的真实 interface；不经过控制器）
// =====================================================================================

/** 账本的行为测试台：记下每一次 IO 与每一次下发的列表；上传默认立即成功，可切成受控闸门。 */
function ledgerHarness() {
  const uploads: { sessionId: string; name: string; kind: string; bytes?: Uint8Array; path?: string }[] = [];
  const published: { key: string; ids: string[] }[] = [];
  const logs: string[] = [];
  const gates: ReturnType<typeof gate<{ receiptId: string; attachmentId?: string }>>[] = [];
  /** 「本地能打开什么」的交付：内容身份 + 当时那份来源（字节或原文件路径）。 */
  const openTargets: { attachmentId: string; name: string; kind: string; bytes?: Uint8Array; path?: string }[] = [];
  let gated = false;
  const ledger = new AttachmentLifecycle({
    performUpload: (input) => {
      uploads.push({
        sessionId: input.sessionId,
        name: input.name,
        kind: input.source.kind,
        ...(input.source.kind === "bytes" ? { bytes: input.source.bytes } : { path: input.source.path }),
      });
      if (!gated) return Promise.resolve({ receiptId: `rcpt-${input.name}` });
      const pending = gate<{ receiptId: string; attachmentId?: string }>();
      gates.push(pending);
      return pending.promise;
    },
    rememberOpenTarget: (input) => {
      openTargets.push({
        attachmentId: input.attachmentId,
        name: input.name,
        kind: input.source.kind,
        ...(input.source.kind === "bytes" ? { bytes: input.source.bytes } : { path: input.source.path }),
      });
    },
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    publish: (key, list) => published.push({ key, ids: list.map((a) => a.id) }),
    log: (message) => logs.push(message),
  });
  const chip = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
    id,
    kind: "file",
    name: `${id}.txt`,
    ...extra,
  });
  return {
    ledger,
    uploads,
    published,
    logs,
    gates,
    openTargets,
    /** 之后的上传都挂到闸门上（场景自己 resolve / reject）。 */
    useGates: () => {
      gated = true;
    },
    idsOf: (key: string) => ledger.list(key).map((a) => a.id),
    uploadState: (key: string, id: string) => ledger.list(key).find((a) => a.id === id)?.upload,
    chip,
  };
}

console.log("attachmentLifecycle: 附件草稿的归属与上传生命周期（真控制器 + 账本 module）");
console.log("§一 账本 module 的行为");

// ---------- 一.1 空壳首次绑定：整份记录换键，在飞的那一轮跟着走 ----------
await scenario("一.1 空壳首次绑定：在飞的那一轮跟着记录走", async () => {
  const h = ledgerHarness();
  h.useGates();
  h.ledger.add("v1", [h.chip("c1"), h.chip("c2", { path: "C:\\ws\\c2.txt" })]);
  const bytes = new Uint8Array([1, 2, 3]);
  h.ledger.start("v1", "c1", "session-a", { kind: "bytes", bytes });
  assert.strictEqual(h.uploads.length, 1, "起轮就该打一次 IO");
  assert.strictEqual(h.uploads[0]!.sessionId, "session-a");

  // 空壳绑定会话：键从 viewId 搬到会话 id
  h.ledger.move("v1", "session-a");
  assert.deepStrictEqual(h.idsOf("session-a"), ["c1", "c2"], "整份草稿跟着键搬过去");
  assert.deepStrictEqual(h.idsOf("v1"), [], "窗口键上不许留副本");

  h.published.length = 0;
  h.gates[0]!.resolve({ receiptId: "rcpt-1" });
  await flush();
  assert.deepStrictEqual(
    h.uploadState("session-a", "c1"),
    { status: "ready", receiptId: "rcpt-1" },
    "结算要落在搬过去的那条记录上",
  );
  assert.deepStrictEqual(
    h.published.map((entry) => entry.key),
    ["session-a"],
    "下发要用**搬后**的键（会话键），不是开轮时的窗口键",
  );
});

// ---------- 一.2 两份相遇（两个窗口共用一条壳）→ 合并，不整份覆盖 ----------
await scenario("一.2 换键相遇 → 合并（不覆盖），空来源是空操作", () => {
  const h = ledgerHarness();
  h.ledger.add("session-a", [h.chip("s1")]);
  h.ledger.add("v2", [h.chip("w1")]);
  h.ledger.move("v2", "session-a");
  assert.deepStrictEqual(h.idsOf("session-a"), ["s1", "w1"], "目标在前、来源在后，两份都要在");
  assert.deepStrictEqual(h.idsOf("v2"), [], "来源键清空");
  h.ledger.move("v9", "session-a");
  assert.deepStrictEqual(h.idsOf("session-a"), ["s1", "w1"], "没有来源记录时移动是空操作");
});

// ---------- 一.3 移除后迟到完成：不复活；真正未结算的旧轮不覆盖新一轮 ----------
await scenario("一.3 移除后迟到不复活、旧轮不覆盖新轮", async () => {
  const h = ledgerHarness();
  h.useGates();
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes: new Uint8Array([1]) });
  // 旧一轮**一直不结算**（`gate` 的 promise 只能结算一次，所以「旧轮迟到」必须由它来证）
  const stale = h.gates[0]!;
  h.ledger.remove("s", "c1");
  assert.deepStrictEqual(h.idsOf("s"), [], "移除后列表里没有了");

  // 同一枚附件重新接进来（同一 id）+ 新一轮
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes: new Uint8Array([7]) });
  assert.strictEqual(h.uploads.length, 2, "重新接入后可以再起一轮（旧轮已随移除作废）");
  h.gates[1]!.resolve({ receiptId: "fresh" });
  await flush();
  assert.deepStrictEqual(
    h.uploadState("s", "c1"),
    { status: "ready", receiptId: "fresh" },
    "新一轮的回执才是有效的",
  );

  // 旧一轮此刻才**第一次**结算（成功）：不许覆盖新轮的结果，也不许推帧
  h.published.length = 0;
  stale.resolve({ receiptId: "stale" });
  await flush();
  assert.deepStrictEqual(
    h.uploadState("s", "c1"),
    { status: "ready", receiptId: "fresh" },
    "旧轮（此前从未结算过）的成功不许覆盖新轮",
  );
  assert.deepStrictEqual(h.published, [], "作废轮次的结算不许推帧");

  // 反向：另一枚附件走一遍，旧轮以**失败**迟到，同样不许覆盖
  h.ledger.add("s", [h.chip("c2")]);
  h.ledger.start("s", "c2", "s", { kind: "bytes", bytes: new Uint8Array([8]) });
  const staleFail = h.gates.at(-1)!;
  h.ledger.remove("s", "c2");
  h.ledger.add("s", [h.chip("c2")]);
  h.ledger.start("s", "c2", "s", { kind: "bytes", bytes: new Uint8Array([9]) });
  h.gates.at(-1)!.resolve({ receiptId: "fresh-2" });
  await flush();
  h.published.length = 0;
  staleFail.reject(new Error("旧轮失败"));
  await flush();
  assert.deepStrictEqual(
    h.uploadState("s", "c2"),
    { status: "ready", receiptId: "fresh-2" },
    "旧轮的失败同样不许覆盖新轮",
  );
  assert.deepStrictEqual(h.published, [], "作废轮次的失败也不许推帧");

  // 第三枚：移除之后**不再接回来**，那一轮的迟到完成不许把它复活、也不许推帧
  h.ledger.add("s", [h.chip("c3")]);
  h.ledger.start("s", "c3", "s", { kind: "bytes", bytes: new Uint8Array([10]) });
  const orphan = h.gates.at(-1)!;
  h.ledger.remove("s", "c3");
  assert.strictEqual(h.idsOf("s").includes("c3"), false, "移除后列表里没有它");
  h.published.length = 0;
  orphan.resolve({ receiptId: "resurrect" });
  await flush();
  assert.strictEqual(h.idsOf("s").includes("c3"), false, "迟到完成不许复活已移除的附件");
  assert.deepStrictEqual(h.published, [], "不复活也不推帧");

  // 已经有回执的那一枚不再重传（连点重试的空操作）
  const before = h.uploads.length;
  h.ledger.retry("s", "c2", "s");
  assert.strictEqual(h.uploads.length, before, "已经有回执时不打 IO");
});

// ---------- 一.4 字节留存（失败可重试）/ 释放（成功即弃）/ 无会话标记 ----------
await scenario("一.4 字节留存与释放（用假 IO 观测重试来源）", async () => {
  const h = ledgerHarness();
  h.useGates();
  const bytes = new Uint8Array([9, 9, 9]);
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes });
  h.gates[0]!.reject(new Error("网络断了"));
  await flush();
  assert.deepStrictEqual(
    h.uploadState("s", "c1"),
    { status: "error", message: "网络断了" },
    "失败要落进芯片（原因由宿主的 describeError 给）",
  );

  h.ledger.retry("s", "c1", "s");
  assert.strictEqual(h.uploads.length, 2, "失败后重试要能再传");
  assert.strictEqual(h.uploads[1]!.kind, "bytes");
  assert.strictEqual(h.uploads[1]!.bytes, bytes, "重试用的是账本留的那一份字节（同一个数组，不重读）");

  h.gates[1]!.resolve({ receiptId: "rcpt-ok" });
  await flush();
  h.ledger.retry("s", "c1", "s");
  assert.strictEqual(h.uploads.length, 2, "成功后字节已释放：没有路径的字节来源再也重试不出第二轮");

  // 路径来源也一样：已经有回执就没有「再重试一次」这回事（不是「字节没了」碰巧成了空操作）
  h.ledger.add("s", [h.chip("c3", { path: "C:\\ws\\c3.txt" })]);
  h.ledger.start("s", "c3", "s", { kind: "path", path: "C:\\ws\\c3.txt" });
  assert.strictEqual(h.uploads.length, 3, "路径来源正常起一轮");
  h.gates[2]!.resolve({ receiptId: "rcpt-c3" });
  await flush();
  h.ledger.retry("s", "c3", "s");
  assert.strictEqual(h.uploads.length, 3, "已经有回执的附件不再重传");

  // 没有会话就不打 IO（宿主那一侧不必自己判）：直接落到语言中立标记
  h.ledger.add("s", [h.chip("c2")]);
  h.ledger.start("s", "c2", undefined, { kind: "bytes", bytes: new Uint8Array([1]) });
  assert.strictEqual(h.uploads.length, 3, "没有会话时不许打 IO");
  assert.deepStrictEqual(
    h.uploadState("s", "c2"),
    { status: "error", message: "@uploadNoSession" },
    "没有会话给的是语言中立标记（界面查词典）",
  );
});

// ---------- 一.5 提交是「移走」：租约里的条目照旧结算，归还能拿回字节 ----------
await scenario("一.5 提交移走（租约）：结算不推帧、归还恢复、释放彻底收场", async () => {
  const h = ledgerHarness();
  h.useGates();
  const bytes = new Uint8Array([1]);
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes });
  h.published.length = 0;

  const leased = h.ledger.detach("s", "req-1");
  assert.deepStrictEqual(h.idsOf("s"), [], "提交后可见列表清空（界面凭那一帧收芯片）");
  assert.deepStrictEqual(h.published.at(-1), { key: "s", ids: [] }, "要下发一份空表");
  assert.deepStrictEqual(leased?.map((a) => a.id), ["c1"], "条目移进这次提交的租约");

  // 在飞那一轮照旧结算——写进租约，且**不推帧**（它不是可见草稿）
  h.published.length = 0;
  h.gates[0]!.resolve({ receiptId: "rcpt-1" });
  await flush();
  assert.deepStrictEqual(
    h.ledger.lease("req-1")?.[0]?.upload,
    { status: "ready", receiptId: "rcpt-1" },
    "结算落在租约里那一枚上",
  );
  assert.deepStrictEqual(h.published, [], "租约的结算不许推帧");

  // 归还：原来那一枚（含回执与字节）整份回到可见列表
  assert.deepStrictEqual(
    h.ledger.returnLease("req-1", "s")?.map((a) => a.id),
    ["c1"],
    "归还返回并入后的可见列表",
  );
  assert.deepStrictEqual(h.idsOf("s"), ["c1"], "归还后条目在可见列表里");
  assert.strictEqual(h.ledger.lease("req-1"), undefined, "归还之后租约不复存在");

  // 释放：取消在飞轮次、释放字节、丢掉条目（归还也复活不了）
  h.ledger.start("s", "c1", "s", { kind: "path", path: "C:\\ws\\c1.txt" });
  const pendingRound = h.gates.at(-1)!;
  h.ledger.detach("s", "req-2");
  h.ledger.releaseLease("req-2");
  assert.strictEqual(h.ledger.lease("req-2"), undefined, "释放后租约不再存在");
  const publishedBefore = h.published.length;
  pendingRound.resolve({ receiptId: "zombie" });
  await flush();
  assert.strictEqual(h.published.length, publishedBefore, "释放之后迟到的结算什么都不做");
  assert.deepStrictEqual(h.ledger.returnLease("req-2", "s") ?? [], [], "已释放的租约归还不了（不复活）");

  // 没有记录也要下发空表（与提交路径今天的帧序一致）
  h.published.length = 0;
  h.ledger.detach("never-seen", "req-3");
  assert.deepStrictEqual(h.published, [{ key: "never-seen", ids: [] }]);
});

// ---------- 一.6 按键回收 / dispose：不连带租约，dispose 全清 ----------
await scenario("一.6 按键回收不误杀租约，dispose 全清", async () => {
  const h = ledgerHarness();
  h.ledger.add("v9", [h.chip("w1")]);
  h.ledger.detach("v9", "req-9");
  h.ledger.release("v9");
  assert.deepStrictEqual(h.idsOf("v9"), [], "窗口键的可见草稿回收");
  assert.deepStrictEqual(
    h.ledger.lease("req-9")?.map((a) => a.id),
    ["w1"],
    "按键回收不许连带杀掉租约（别的窗口解绑不能误杀会话的失败行重试能力）",
  );

  h.ledger.add("s", [h.chip("c9")]);
  h.ledger.detach("s", "req-10");
  h.ledger.dispose();
  assert.strictEqual(h.ledger.lease("req-9"), undefined, "dispose 清掉所有租约");
  assert.strictEqual(h.ledger.lease("req-10"), undefined, "dispose 清掉所有租约");
  assert.deepStrictEqual(h.ledger.list("s"), [], "dispose 清空可见草稿");
  h.ledger.add("s2", [h.chip("y1")]);
  assert.deepStrictEqual(h.ledger.list("s2"), [], "dispose 之后不许再记账（关窗后不许复活）");
});

// ---------- 一.7 租约交接：换 requestId 继续持有，在飞轮次不重启 ----------
await scenario("一.7 租约交接：换 requestId 继续持有，遇已有租约则合并", async () => {
  const h = ledgerHarness();
  h.useGates();
  const bytes = new Uint8Array([4]);
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes });
  h.ledger.detach("s", "old");
  h.ledger.transferLease("old", "new");
  assert.strictEqual(h.ledger.lease("old"), undefined, "旧 requestId 不再持有");
  assert.deepStrictEqual(h.ledger.lease("new")?.map((a) => a.id), ["c1"], "新 requestId 接管同一份");
  assert.strictEqual(h.uploads.length, 1, "交接不许重启上传");
  h.ledger.transferLease("missing", "new");
  assert.deepStrictEqual(h.ledger.lease("new")?.map((a) => a.id), ["c1"], "没有旧租约时交接是空操作");

  h.gates[0]!.resolve({ receiptId: "rcpt-h" });
  await flush();
  assert.deepStrictEqual(
    h.ledger.lease("new")?.[0]?.upload,
    { status: "ready", receiptId: "rcpt-h" },
    "交接之后结算仍写回那一枚",
  );

  // 交接进一份已经存在的租约 → 合并（两次撤回重发撞在同一份上也不会丢）
  h.ledger.add("s2", [h.chip("d1")]);
  h.ledger.detach("s2", "a");
  h.ledger.add("s2", [h.chip("d2")]);
  h.ledger.detach("s2", "b");
  h.ledger.transferLease("a", "b");
  assert.deepStrictEqual(h.ledger.lease("b")?.map((x) => x.id).sort(), ["d1", "d2"], "并入已有租约");
});

// ---------- 一.8 租约告警阈值：越过只记日志，**从不按数量销毁**（失败行的重试能力） ----------
await scenario("一.8 越过告警阈值只记日志、不销毁任何租约", () => {
  const h = ledgerHarness();
  // 阈值是 module 里的 `LEASE_WARN_THRESHOLD = 1024`（= 回显表上限 8×64 的两倍）。
  // 这条断言钉住它的两条性质：①不小于回显表上限；②**越界也不销毁**——被丢掉的租约背后
  // 可能是某条失败行的重试能力，按数量淘汰等于静默丢用户数据。
  const threshold = 1024;
  for (let i = 0; i <= threshold; i += 1) {
    const id = `c${i}`;
    h.ledger.add("s", [h.chip(id)]);
    h.ledger.detach("s", `req-${i}`);
  }
  assert.deepStrictEqual(h.ledger.lease("req-0")?.map((a) => a.id), ["c0"], "最旧的一份**不**被丢掉");
  assert.deepStrictEqual(h.ledger.lease(`req-${threshold}`)?.map((a) => a.id), [`c${threshold}`], "最新的一份也在");
  assert.ok(
    h.logs.some((line) => line.includes("在飞提交租约达到")),
    `越过阈值要有开发者日志：${h.logs.slice(-1)[0] ?? "（没有日志）"}`,
  );
  // 收场释放才是唯一的减少途径
  h.ledger.releaseLease("req-0");
  assert.strictEqual(h.ledger.lease("req-0"), undefined, "releaseLease 才能让它消失");
});

// ---------- 一.9 整份替换（队列还原回填）：掉出列表的枚释放字节与在飞轮次 ----------
await scenario("一.9 整份替换：掉出列表的枚不再占字节与轮次", async () => {
  const h = ledgerHarness();
  h.useGates();
  h.ledger.add("s", [h.chip("c1"), h.chip("c2", { path: "C:\\ws\\c2.txt" })]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes: new Uint8Array([5]) });
  const dropped = h.gates[0]!;

  // 调用方按自己的身份口径合并好一份新列表（队列「取回重新编辑」的回填就是这样）
  h.ledger.replace("s", [h.chip("c2", { path: "C:\\ws\\c2.txt" }), h.chip("c3", { path: "C:\\ws\\c3.txt" })]);
  assert.deepStrictEqual(h.idsOf("s"), ["c2", "c3"], "整份替换就是账本此刻的列表");
  h.published.length = 0;
  dropped.resolve({ receiptId: "too-late" });
  await flush();
  assert.deepStrictEqual(h.published, [], "掉出列表那一枚的迟到结算不许再推帧");
  h.ledger.retry("s", "c1", "s");
  assert.strictEqual(h.uploads.length, 1, "掉出列表 = 字节已释放：重试空操作");

  // 没有记录时替换也要能建立（键上第一次就有列表：先清后填那种调用顺序）
  h.ledger.replace("fresh", [h.chip("f1")]);
  assert.deepStrictEqual(h.idsOf("fresh"), ["f1"]);
});

// ---------- 一.10 重复 start（同一 id、不同字节）不许改掉在飞那一轮的来源 ----------
await scenario("一.10 重复 start 不改在飞那一轮的字节来源", async () => {
  const h = ledgerHarness();
  h.useGates();
  const first = new Uint8Array([1, 1, 1]);
  const second = new Uint8Array([2, 2, 2]);
  h.ledger.add("s", [h.chip("c1")]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes: first });
  // 重复的接入请求（同一 id、不同字节）：并成一轮，且不许把在飞那份来源换掉
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes: second });
  assert.strictEqual(h.uploads.length, 1, "重复 start 不再起一轮");
  assert.strictEqual(h.uploads[0]!.bytes, first, "在飞那一轮用的仍是第一份字节");

  h.gates[0]!.reject(new Error("第一轮失败"));
  await flush();
  assert.deepStrictEqual(h.uploadState("s", "c1"), { status: "error", message: "第一轮失败" });
  h.ledger.retry("s", "c1", "s");
  assert.strictEqual(h.uploads.length, 2, "失败后重试要能再传");
  assert.strictEqual(h.uploads[1]!.bytes, first, "重试用的仍是第一轮那份字节（没被重复 start 覆写）");
});

// ---------- 一.11 上传成功：内容身份写回芯片，并把「本地能打开什么」交给宿主 ----------
await scenario("一.11 内容身份写回芯片、打开目标交给宿主（失败与作废轮都不给）", async () => {
  const h = ledgerHarness();
  h.useGates();
  const remembered = h.openTargets;
  // 字节来源：成功那一刻连**字节**一起交给宿主（之后账本自己就释放了）
  h.ledger.add("s", [h.chip("c1")]);
  const bytes = new Uint8Array([1, 2, 3]);
  h.ledger.start("s", "c1", "s", { kind: "bytes", bytes });
  h.gates[0]!.resolve({ receiptId: "rcpt-1", attachmentId: "sha256:aaa" });
  await flush();
  assert.strictEqual(h.ledger.list("s")[0]?.attachmentId, "sha256:aaa", "内容身份要写回芯片");
  assert.deepStrictEqual(
    remembered.map((entry) => [entry.attachmentId, entry.kind, entry.bytes === bytes]),
    [["sha256:aaa", "bytes", true]],
    "成功那一刻把同一份字节交给宿主（不是副本）",
  );

  // 路径来源：给的是原文件路径
  h.ledger.add("s", [h.chip("c2", { path: "C:\\ws\\c2.txt" })]);
  h.ledger.start("s", "c2", "s", { kind: "path", path: "C:\\ws\\c2.txt" });
  h.gates.at(-1)!.resolve({ receiptId: "rcpt-2", attachmentId: "sha256:bbb" });
  await flush();
  assert.deepStrictEqual(remembered.at(-1), {
    attachmentId: "sha256:bbb",
    name: "c2.txt",
    kind: "path",
    path: "C:\\ws\\c2.txt",
  });

  // 失败不给（那时本地打开仍然走账本暂存字节，不靠这份索引）
  h.ledger.add("s", [h.chip("c3")]);
  h.ledger.start("s", "c3", "s", { kind: "bytes", bytes: new Uint8Array([9]) });
  h.gates.at(-1)!.reject(new Error("网络断了"));
  await flush();
  assert.strictEqual(remembered.length, 2, "失败的轮次不该记打开目标");

  // 作废轮（移除后迟到完成）也不给：那枚附件已经不在任何列表里
  h.ledger.add("s", [h.chip("c4")]);
  h.ledger.start("s", "c4", "s", { kind: "bytes", bytes: new Uint8Array([4]) });
  const stale = h.gates.at(-1)!;
  h.ledger.remove("s", "c4");
  stale.resolve({ receiptId: "rcpt-4", attachmentId: "sha256:ccc" });
  await flush();
  assert.strictEqual(remembered.length, 2, "已移除的附件不该留下打开目标");
});

// =====================================================================================
// §二 真控制器的集成场景（接入 → 上传 → 切会话 / 移除 / 重试）
// =====================================================================================

/** 拖放 / 粘贴帧（`shared/ipc.ts` 的 `attachBytes`）：宿主侧走 `planIntake` 那条唯一管线。 */
function attachFrame(name: string, base64 = BYTES_BASE64) {
  return {
    type: "attachBytes",
    source: "drop",
    files: [{ name, mimeType: "application/octet-stream", base64 }],
    unreadable: [],
    tooLarge: [],
  };
}

/**
 * 真实 webview IPC 会把界面那一份**过一遍 JSON**再交给宿主：`send` 帧里的附件与账本里
 * 那一枚**不是同一个对象**。这几条场景必须按这个形状走，否则「回填 / 回显引用的是账本里
 * 原来那一枚」就成了白送的（传同一个引用当然相等）。
 */
function wireCopy(attachment: Attachment): Attachment {
  return JSON.parse(JSON.stringify(attachment)) as Attachment;
}

/**
 * `send` 帧里那一批附件（JSON 往返副本 + 前提断言）。
 *
 * 断言「副本与账本里那一枚不是同一个对象」是这条测试形状的**前提**：不先钉住它，
 * 后面「回填 / 回显引用的是账本里原来那一枚」就可能是白送的（传同一个引用当然相等）。
 */
function wireAttachments(canonical: Attachment, label: string): Attachment[] {
  const copy = wireCopy(canonical);
  assert.notStrictEqual(copy, canonical, `${label}：前提是界面送来 JSON 副本，不是账本里那一枚`);
  return [copy];
}

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

interface UploadCall {
  sessionId: string;
  name: string;
  bytes: Uint8Array;
}

/**
 * 控制器内部读数口子（测试专用）。
 *
 * `attachments` 是接线后的账本（真 interface）；`attachmentsBySession` 是接线前的旧表。
 * 两个字段都是可选的：同一组断言因此能在**旧控制器**（红）与**新控制器**（绿）上各跑
 * 一遍，红是真红、绿是真绿。
 */
interface Internals {
  client: unknown;
  connection: string;
  scopes: Map<string, { running: boolean }>;
  pendingMessages: Map<string, { requestId: string; text: string; attachments?: Attachment[] }[]>;
  /** 已提交记录（requestId → 原文/附件/内容块）：批量场景取本次 requestId 用。 */
  submissions: Map<string, unknown>;
  attachments?: {
    list(key: string | undefined): readonly Attachment[];
    add(key: string, attachments: readonly Attachment[]): void;
    replace(key: string, attachments: readonly Attachment[]): void;
    /** 提交租约（接线后才有的接口）：探测式调用，红跑时不炸。 */
    lease?(requestId: string): readonly Attachment[] | undefined;
    returnLease?(
      requestId: string,
      key: string,
      options?: { publish?: boolean },
    ): readonly Attachment[] | undefined;
    releaseLease?(requestId: string): void;
  };
  attachmentsBySession?: Map<string, Attachment[]>;
  /** 「内容身份 → 本地可打开的那个文件」索引（接线后才有的字段：探测式调用）。 */
  attachmentTargets?: { pathFor(id: string): Promise<string | undefined>; remember(id: string, path: string): void };
  /** 路径通道的接入（「添加文件」按钮 / 粘贴真路径）：驱动真 `planIntake` 那条管线。 */
  addPaths?(viewId: string, paths: readonly string[], source: string): Promise<void>;
  fileExistence(uri: { fsPath: string }): Promise<"present" | "absent" | "unknown">;
  openChanges(uri: { fsPath: string }): Promise<boolean>;
  sessions: { id: string; cwd: string }[];
  bindView(viewId: string): void;
  unbindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
}

/** 某个归属键上的附件草稿（只读读法：接线后走账本，接线前读旧表）。 */
function listOf(c: Internals, key: string): Attachment[] {
  if (c.attachments) return [...c.attachments.list(key)];
  return [...(c.attachmentsBySession?.get(key) ?? [])];
}

/** 往某个归属键上放一枚芯片（模拟「用户在输入框上加了一枚附件」）。 */
function putAttachment(c: Internals, key: string, attachment: Attachment): void {
  if (c.attachments) {
    c.attachments.add(key, [attachment]);
    return;
  }
  const list = c.attachmentsBySession?.get(key) ?? [];
  list.push(attachment);
  c.attachmentsBySession?.set(key, list);
}

interface Harness {
  c: Internals;
  frames: Captured[];
  /** 每一次 `uploadFile`（结算断言看它：打在哪个会话、用的哪份字节）。 */
  uploads: UploadCall[];
  /**
   * 下一次上传的应答：场景自己决定什么时候 resolve / reject（受控 Promise）。
   *
   * 只给 `receiptId` 就够——`attachmentId`（内容身份）缺省时由测试台按文件名合成一个，
   * 因为真宿主的上传应答里 `file` 一定在（`performUpload` 要读它写回芯片）。
   */
  answer: (call: UploadCall) => Promise<{ receiptId: string; attachmentId?: string }>;
  /** 每一次 `session/prompt`（内容块断言看它：重发到底带没带上文件回执）。 */
  prompts: { sessionId: string; content: unknown[]; mode: string; requestId: string }[];
  /** 下一次 prompt 的应答：默认成功，场景可以让它挂在闸门上或抛。 */
  promptAnswer: (call: { content: unknown[]; mode: string }) => Promise<void>;
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

/**
 * 一套离线控制器台。
 *
 * `globalState` 可以**跨两次 harness 调用共用**：那正是「重开宿主」的形状——内存里的
 * 一切（索引、账本）都是新的，只有 `globalState` 里那份持久记录还在。
 */
function harness(globalState: ReturnType<typeof fakeMemento> = fakeMemento()): Harness {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    globalState as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  (
    controller as unknown as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));

  const c = controller as unknown as Internals;
  const state = {
    c,
    frames,
    uploads: [] as UploadCall[],
    answer: async (call: UploadCall) => ({ receiptId: `rcpt-${call.name}` }),
    prompts: [] as { sessionId: string; content: unknown[]; mode: string; requestId: string }[],
    promptAnswer: async () => undefined,
  } as Harness;

  const client = {
    request: async (method: string) => (method === "commands/list" ? [] : undefined),
    sessionProjections: async () => ({ values: {} }),
    getJson: async () => undefined,
    settingsDescribe: async () => ({ namespaces: [] }),
    followSession: () => ({ cancel() {} }),
    followJobs: () => ({ cancel() {} }),
    followControl: () => ({ cancel() {} }),
    uploadFile: (sessionId: string, bytes: Uint8Array, name: string) => {
      const call: UploadCall = { sessionId, name, bytes };
      state.uploads.push(call);
      // 真实客户端回的是 `{receiptId, file}`（`DshClient.uploadFile`）：`file.attachmentId`
      // 是内容摘要，控制器要读它写回芯片并记住「本地能打开什么」。场景只给 receiptId 时
      // 在这里补一个内容身份，省得每条场景都手写那一层。
      return state.answer(call).then((answer) => ({
        receiptId: answer.receiptId,
        file: {
          attachmentId: answer.attachmentId ?? `sha256:${call.name}`,
          name: call.name,
          bytes: call.bytes.byteLength,
        },
      }));
    },
    prompt: async (sessionId: string, content: unknown[], mode: string, requestId: string) => {
      state.prompts.push({ sessionId, content, mode, requestId });
      await state.promptAnswer({ content, mode });
    },
    updateQueueRemove: async () => ({ accepted: true }),
  };
  c.client = client as never;
  c.connection = "connected";
  return state;
}

/** 某个归属键上那枚附件此刻的上传状态。 */
const uploadOf = (c: Internals, key: string, name: string) => listOf(c, key).find((a) => a.name === name)?.upload;

/** 本次提交的 requestId（批量场景里提交记录只有一条）。 */
const requestIdOf = (c: Internals) => [...c.submissions.keys()].at(-1);

/** 探租约（`lease` 是接线后才有的方法：红跑时返回 undefined 而不是炸）。 */
const leaseOf = (c: Internals, requestId: string) => c.attachments?.lease?.(requestId);

/** 推给某个窗口的、带 `attachments` 的补丁帧（归属结算会不会污染当前会话看它）。 */
const attachmentPatches = (h: Harness, target: string) =>
  h.frames.filter(
    (f) =>
      f.target === target &&
      f.frame.type === "patch" &&
      Object.prototype.hasOwnProperty.call(f.frame.patch ?? {}, "attachments"),
  );

console.log("§二 真控制器的集成场景");

// ---------- 二.1 切到 B 之后 A 的上传才成功：A 结算，B 不受污染 ----------
await scenario("二.1 切会话后 A 结算、B 不受污染", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);

  const uploadA = gate<{ receiptId: string }>();
  h.answer = () => uploadA.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  assert.strictEqual(listOf(h.c, A).length, 1, "接入后 A 上应有一枚芯片");
  assert.strictEqual(uploadOf(h.c, A, "报告.pdf")?.status, "uploading", "接入即上传中");
  assert.strictEqual(h.uploads.length, 1, "接入起一轮上传");
  assert.strictEqual(h.uploads[0]!.sessionId, A, "上传打在开轮那一刻的会话上");

  // 用户切到 B；B 自己也挂一枚芯片（settle 若解错键，那一帧就会画进 B）
  await h.c.openSession("v1", B);
  h.answer = async (call) => ({ receiptId: `rcpt-${call.name}` });
  await h.c.handle(attachFrame("b.txt"), "v1");
  // B 自己那一枚的结算也走一帧（接线后上传应答多一次微任务）：这里先让它落定，
  // 否则下面清零之后它才到达，会被算成「A 的结算推给了 B」
  await flush();
  assert.deepStrictEqual(
    listOf(h.c, B).map((a) => a.name),
    ["b.txt"],
    "前提：B 上有一枚自己的芯片",
  );
  h.frames.length = 0;

  uploadA.resolve({ receiptId: "rcpt-a" });
  await flush();

  const stateA = uploadOf(h.c, A, "报告.pdf");
  assert.strictEqual(stateA?.status, "ready", `A 的芯片必须结算成 ready（切会话不改归属）：${JSON.stringify(stateA)}`);
  assert.strictEqual((stateA as { receiptId?: string }).receiptId, "rcpt-a", "回执要写回 A 那枚");
  assert.strictEqual(
    attachmentPatches(h, "v1").length,
    0,
    `A 的结算不许把附件帧推给正在看 B 的窗口：${JSON.stringify(attachmentPatches(h, "v1"))}`,
  );
  assert.deepStrictEqual(listOf(h.c, B).map((a) => a.name), ["b.txt"], "B 的草稿附件不受影响");
});

// ---------- 二.2 切到 B 之后 A 的上传才失败：A 落失败态、字节留给重试 ----------
await scenario("二.2 切会话后 A 落失败态、重试可再传", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);

  const uploadA = gate<{ receiptId: string }>();
  h.answer = () => uploadA.promise;
  await h.c.handle(attachFrame("坏.pdf"), "v1");
  await h.c.openSession("v1", B);
  h.frames.length = 0;

  uploadA.reject(new Error("gateway/upload-failed: 网络断了"));
  await flush();

  const stateA = uploadOf(h.c, A, "坏.pdf");
  assert.strictEqual(stateA?.status, "error", `A 的芯片必须落失败态：${JSON.stringify(stateA)}`);
  assert.ok(
    String((stateA as { message?: string }).message ?? "").includes("网络断了"),
    "失败原因要写进芯片（宿主 describeError 给的文案）",
  );
  assert.strictEqual(attachmentPatches(h, "v1").length, 0, "失败结算同样不许推帧给正在看 B 的窗口");

  // 切回 A：失败的那枚点「重试」要能再传一次，且用的是账本留的那份字节
  await h.c.openSession("v1", A);
  const id = listOf(h.c, A).find((a) => a.name === "坏.pdf")!.id;
  h.answer = async (call) => ({ receiptId: `rcpt-${call.name}` });
  await h.c.handle({ type: "retryUpload", id }, "v1");
  await flush();
  assert.strictEqual(h.uploads.length, 2, "失败后重试要真的再传一次");
  assert.deepStrictEqual([...h.uploads[1]!.bytes], [...h.uploads[0]!.bytes], "重试用的是账本暂存的那份字节");
  assert.strictEqual(
    (uploadOf(h.c, A, "坏.pdf") as { receiptId?: string } | undefined)?.receiptId,
    "rcpt-坏.pdf",
    "重试成功后回执落到 A 那枚",
  );
});

// ---------- 二.3 连点两次「重试」：只有一轮有效在飞 ----------
await scenario("二.3 连点重试不叠轮", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);

  h.answer = async () => {
    throw new Error("第一次失败");
  };
  await h.c.handle(attachFrame("重试.pdf"), "v1");
  await flush();
  assert.strictEqual(uploadOf(h.c, A, "重试.pdf")?.status, "error", "前提：首轮失败");

  const callsBefore = h.uploads.length;
  const retry = gate<{ receiptId: string }>();
  h.answer = () => retry.promise;
  const id = listOf(h.c, A)[0]!.id;
  await h.c.handle({ type: "retryUpload", id }, "v1");
  await h.c.handle({ type: "retryUpload", id }, "v1");
  assert.strictEqual(
    h.uploads.length - callsBefore,
    1,
    `连点重试只该有一轮有效在飞：实际新起 ${h.uploads.length - callsBefore} 轮`,
  );
  retry.resolve({ receiptId: "rcpt-once" });
  await flush();
  assert.strictEqual(
    (uploadOf(h.c, A, "重试.pdf") as { receiptId?: string } | undefined)?.receiptId,
    "rcpt-once",
    "唯一那一轮的回执落地",
  );
});

// ---------- 二.4 上传中把那枚删掉：迟到完成不复活、也不推帧 ----------
await scenario("二.4 移除后迟到完成不复活", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);

  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("先删掉.pdf"), "v1");
  const id = listOf(h.c, A)[0]!.id;
  await h.c.handle({ type: "removeAttachment", id }, "v1");
  assert.deepStrictEqual(listOf(h.c, A), [], "移除后 A 上没有芯片");
  h.frames.length = 0;

  upload.resolve({ receiptId: "too-late" });
  await flush();
  assert.deepStrictEqual(listOf(h.c, A), [], "迟到完成不许复活已移除的附件");
  assert.strictEqual(attachmentPatches(h, "v1").length, 0, "没有变化就不许推帧");
});

// ---------- 二.5 空壳窗口上的草稿：绑定那一刻迁到会话键；域回收保留 ----------
await scenario("二.5 空壳首次绑定迁移 + 域回收保留草稿", async () => {
  const h = harness();
  h.c.bindView("v1");
  // 空壳窗口（还没有会话）上先挂一枚：真实链路上这就是「没工作目录 / 用户取消了目录选择」那一段
  putAttachment(h.c, "v1", {
    id: "draft-1",
    kind: "file",
    name: "先挂的.txt",
    path: "C:\\ws\\先挂的.txt",
    upload: { status: "error", message: "@uploadNoSession" },
  });
  await h.c.openSession("v1", A);
  assert.deepStrictEqual(listOf(h.c, A).map((a) => a.id), ["draft-1"], "空壳上的草稿必须迁到会话键");
  assert.deepStrictEqual(listOf(h.c, "v1"), [], "窗口键上不许留副本");

  // 域回收（切走 → 最后一个观察者离开）**不许**替用户丢掉附件草稿
  await h.c.openSession("v1", B);
  assert.deepStrictEqual(listOf(h.c, A).map((a) => a.id), ["draft-1"], "域回收之后草稿仍在原会话键上");
});

// ---------- 二.6 窗口下线：绑过会话的那份留着，没绑的那份回收 ----------
await scenario("二.6 窗口下线的回收口径", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  putAttachment(h.c, A, {
    id: "keep-1",
    kind: "file",
    name: "留住.txt",
    path: "C:\\ws\\留住.txt",
    upload: { status: "ready", receiptId: "r1" },
  });
  h.c.unbindView("v1");
  assert.deepStrictEqual(listOf(h.c, A).map((a) => a.id), ["keep-1"], "绑过会话的草稿按会话键留着");

  h.c.bindView("v2");
  putAttachment(h.c, "v2", { id: "solo-1", kind: "file", name: "空壳.txt", path: "C:\\ws\\空壳.txt" });
  h.c.unbindView("v2");
  assert.deepStrictEqual(listOf(h.c, "v2"), [], "窗口下线后窗口键上的草稿要回收（viewId 不会再用）");
});

// ---------- 二.7 失败回填：芯片以**原对象**回到输入框，且仍在飞的上传照旧结算 ----------
//
// 提交那一刻芯片被移走（租约），但**不销毁**：没有回显的失败把这一份原样还回输入框，
// 上传状态 / 回执 / 暂存字节 / 在飞那一次结算都跟着回来。
await scenario("二.7 失败回填恢复原芯片，在飞上传完成后结算", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  // 让这次提交**不产生回显**（agent 在跑 → 排队口径）：无回显的失败才走「还回输入框」
  h.c.scopes.get(A)!.running = true;
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  assert.strictEqual(original.upload?.status, "uploading", "前提：芯片正在传");

  h.promptAnswer = async () => {
    throw new Error("gateway/input-invalid: 发送失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");

  const restored = listOf(h.c, A);
  assert.strictEqual(restored.length, 1, `回填后应恰好一枚：${restored.length}`);
  assert.strictEqual(restored[0], original, "回到输入框的必须是原来那一枚（状态 / 字节 / 在飞结算都在它身上）");
  assert.strictEqual(restored[0]!.upload?.status, "uploading", "回填那一刻它仍在传");

  // 在飞那次上传照旧结算：完成后芯片自己变成 ready（销毁式清空会在这里永久挂 uploading）
  upload.resolve({ receiptId: "rcpt-restored" });
  await flush();
  assert.deepStrictEqual(
    uploadOf(h.c, A, "报告.pdf"),
    { status: "ready", receiptId: "rcpt-restored" },
    "在飞结算必须活过提交与回填",
  );
  assert.strictEqual(h.uploads.length, 1, "不必重新上传");
});

// ---------- 二.8 失败回填后「重试」仍用账本留的那份字节 ----------
await scenario("二.8 失败回填后重试仍用原字节", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  h.c.scopes.get(A)!.running = true;
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("坏.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("发送失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");
  assert.strictEqual(listOf(h.c, A)[0], original, "前提：原芯片已回填");

  upload.reject(new Error("网络断了"));
  await flush();
  assert.strictEqual(uploadOf(h.c, A, "坏.pdf")?.status, "error", "在飞失败要落进回填后的那一枚");

  const retry = gate<{ receiptId: string }>();
  h.answer = () => retry.promise;
  await h.c.handle({ type: "retryUpload", id: original.id }, "v1");
  assert.strictEqual(h.uploads.length, 2, "回填后的失败芯片还能再传一次");
  assert.strictEqual(h.uploads[1]!.bytes, h.uploads[0]!.bytes, "重试用的是账本留的那一份字节（同一个数组）");
  retry.resolve({ receiptId: "rcpt-retry" });
  await flush();
  assert.deepStrictEqual(uploadOf(h.c, A, "坏.pdf"), { status: "ready", receiptId: "rcpt-retry" });
});

// ---------- 二.9 失败红行引用租约里的活条目 → 重发带上真回执 ----------
await scenario("二.9 失败红行引用租约，重发带上真回执", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("发送失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");

  const row = h.c.pendingMessages.get(A)?.[0];
  assert.ok(row, "应有失败红行");
  assert.strictEqual(row!.attachments?.[0], original, "失败行引用的必须是账本里那一枚（活的上传状态）");
  assert.strictEqual(row!.attachments?.[0]?.upload?.status, "uploading", "那一刻仍在传");

  upload.resolve({ receiptId: "rcpt-row" });
  await flush();
  assert.deepStrictEqual(
    row!.attachments?.[0]?.upload,
    { status: "ready", receiptId: "rcpt-row" },
    "在飞完成后行里那一枚自己变 ready（重发才拿得到真回执）",
  );

  // 重发：这次让它成功，内容块必须带上真回执
  h.promptAnswer = async () => undefined;
  await h.c.handle({ type: "resendPending", requestId: row!.requestId }, "v1");
  const content = h.prompts.at(-1)?.content ?? [];
  assert.ok(
    content.some((part) => (part as { type?: string; receiptId?: string }).type === "file" &&
      (part as { receiptId?: string }).receiptId === "rcpt-row"),
    `重发的内容块应带上真回执：${JSON.stringify(content)}`,
  );
});

// ---------- 二.10 重发 = 租约交接：不取消仍在飞的上传、不重启、不放回输入框 ----------
await scenario("二.10 重发交接租约：在飞上传不被取消", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("第一次失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");
  const row = h.c.pendingMessages.get(A)?.[0];
  assert.ok(row, "应有失败红行");
  const requestId = requestIdOf(h.c);
  assert.ok(leaseOf(h.c, requestId!), "失败行持有租约");

  // 用户又打了一句话（失败行还在）：重发**不许碰**输入框里这份草稿
  h.c.drafts.set(A, "用户正在写的草稿");
  // 第一次重发：那次上传仍在飞，交接不许把它取消，也不许再起一轮
  h.promptAnswer = async () => undefined;
  await h.c.handle({ type: "resendPending", requestId: row!.requestId }, "v1");
  assert.strictEqual(h.uploads.length, 1, "重发不许取消 / 重启仍在飞的那一轮上传");
  assert.deepStrictEqual(listOf(h.c, A), [], "重发不许把芯片放回输入框");
  assert.strictEqual(h.c.drafts.get(A), "用户正在写的草稿", "重发不许碰输入框里的草稿");
  assert.ok(leaseOf(h.c, requestIdOf(h.c)!), "租约跟着交接给新的提交");

  // 在飞那次完成：新提交（新回显）里的那一枚要自己变成 ready
  upload.resolve({ receiptId: "rcpt-handoff" });
  await flush();
  const newRow = h.c.pendingMessages.get(A)?.at(-1);
  assert.deepStrictEqual(
    newRow?.attachments?.[0]?.upload,
    { status: "ready", receiptId: "rcpt-handoff" },
    "交接之后结算仍写回那一枚（重发失败还有可用租约的同一份东西）",
  );

  // 再重发一次：这次内容块要带上真回执
  await h.c.handle({ type: "resendPending", requestId: newRow!.requestId }, "v1");
  const content = h.prompts.at(-1)?.content ?? [];
  assert.ok(
    content.some((part) => (part as { type?: string; receiptId?: string }).receiptId === "rcpt-handoff"),
    `第二次重发应带上第一次结算出的回执：${JSON.stringify(content)}`,
  );
});

// ---------- 二.11 重试在飞 → 失败 → 再重试（原能力：不叠轮、字节不丢） ----------
await scenario("二.11 重试在飞→失败→再重试", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  const gates: ReturnType<typeof gate<{ receiptId: string }>>[] = [];
  h.answer = () => {
    const pending = gate<{ receiptId: string }>();
    gates.push(pending);
    return pending.promise;
  };
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const id = listOf(h.c, A)[0]!.id;

  await h.c.handle({ type: "retryUpload", id }, "v1");
  assert.strictEqual(h.uploads.length, 1, "还在飞时再点重试并成一轮");

  gates[0]!.reject(new Error("第一轮失败"));
  await flush();
  assert.strictEqual(uploadOf(h.c, A, "报告.pdf")?.status, "error", "失败落到芯片上");

  await h.c.handle({ type: "retryUpload", id }, "v1");
  assert.strictEqual(h.uploads.length, 2, "失败之后还能再重试");
  assert.strictEqual(h.uploads[1]!.bytes, h.uploads[0]!.bytes, "再重试用的仍是账本留的那份字节");
  gates[1]!.resolve({ receiptId: "rcpt-again" });
  await flush();
  assert.deepStrictEqual(uploadOf(h.c, A, "报告.pdf"), { status: "ready", receiptId: "rcpt-again" });
});

// ---------- 二.12 租约不被别的窗口解绑误杀；撤回才释放 ----------
await scenario("二.12 租约与回显同寿命：别处解绑不误杀，撤回才释放", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("发送失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");
  const requestId = requestIdOf(h.c)!;
  assert.ok(leaseOf(h.c, requestId), "失败行持有租约");

  // 另一个还没绑定会话的窗口上线又下线：不许动这条失败行的租约
  h.c.bindView("v2");
  h.c.unbindView("v2");
  assert.ok(leaseOf(h.c, requestId), "别的窗口解绑不许误杀会话的租约");

  // 提交它的那个窗口下线：失败行按会话键刻意保留（跨切换还能重发）→ 租约同样保留
  h.c.unbindView("v1");
  assert.ok(leaseOf(h.c, requestId), "绑过会话的失败行跨窗口下线保留（与回显同寿命）");

  // 用户撤回那条失败行 → 租约最终释放
  await h.c.openSession("v3", A);
  await h.c.handle({ type: "retractPending", requestId }, "v3");
  assert.strictEqual(leaseOf(h.c, requestId), undefined, "撤回之后租约必须释放（不靠上限兜底）");
  assert.deepStrictEqual(listOf(h.c, A), [], "撤回不把芯片塞回输入框");
});

// ---------- 二.13 没有回显的提交成功（排队 / 子代理口径）→ 租约立即释放 ----------
await scenario("二.13 无回显提交成功即释放租约", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  putAttachment(h.c, A, {
    id: "ready-1",
    kind: "file",
    name: "已就绪.txt",
    path: "C:\\ws\\已就绪.txt",
    upload: { status: "ready", receiptId: "r1" },
  });
  h.c.scopes.get(A)!.running = true;
  await h.c.handle({ type: "send", text: "排队发出去", attachments: listOf(h.c, A).map((entry) => wireCopy(entry)), gesture: "enter" }, "v1");
  const requestId = requestIdOf(h.c)!;
  assert.strictEqual(
    leaseOf(h.c, requestId),
    undefined,
    "没有回显的提交成功之后租约必须释放（有界生命周期不靠上限兜底）",
  );
  assert.deepStrictEqual(listOf(h.c, A), [], "芯片随提交移走");
});

// ---------- 二.14 提交期间切了会话：回填不丢、不重复（沿用 appendDraft 原有键策略） ----------
await scenario("二.14 提交期间切会话：回填不丢不重复", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  h.c.scopes.get(A)!.running = true;
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("晚点.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;

  const promptGate = gate<void>();
  h.promptAnswer = () => promptGate.promise;
  const sending = h.c.handle({ type: "send", text: "切走再说", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");
  await h.c.openSession("v1", B);
  promptGate.reject(new Error("发送失败"));
  await sending;

  // 这条测试只钉「不丢、不重复、不留副本」：落在哪个键上沿用 appendDraft 现有策略
  const landed = [...listOf(h.c, A), ...listOf(h.c, B)];
  assert.strictEqual(landed.length, 1, `回填后全场应恰好一枚：A=${listOf(h.c, A).length} B=${listOf(h.c, B).length}`);
  assert.strictEqual(landed[0], original, "回填的仍是原来那一枚（原对象）");
  upload.resolve({ receiptId: "rcpt-late" });
  await flush();
  const anyList = [...listOf(h.c, A), ...listOf(h.c, B)];
  assert.deepStrictEqual(
    anyList[0]?.upload,
    { status: "ready", receiptId: "rcpt-late" },
    "切了会话也要继续结算（结算落在归属记录上，与当前在看哪条会话无关）",
  );
});

// ---------- 二.15 重发交接后再失败：新行仍持租约，结算与第三次重发都不丢 ----------
await scenario("二.15 重发交接后再失败：新行仍持租约", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("第一次失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");
  const first = h.c.pendingMessages.get(A)?.[0];
  assert.ok(first, "第一条失败红行");
  const firstId = requestIdOf(h.c)!;

  // 第一次重发**也失败**：交接必须完整（新行持有租约，旧 id 不再持有）
  await h.c.handle({ type: "resendPending", requestId: first!.requestId }, "v1");
  const second = h.c.pendingMessages.get(A)?.[0];
  const secondId = requestIdOf(h.c)!;
  assert.notStrictEqual(secondId, firstId, "重发是一次新提交");
  assert.strictEqual(leaseOf(h.c, firstId), undefined, "旧 requestId 不再持有租约");
  assert.ok(leaseOf(h.c, secondId), "重发失败后**新那一行**仍持有租约（还能再重发）");
  assert.strictEqual(h.uploads.length, 1, "全过程没有取消 / 重启仍在飞的那一轮上传");
  assert.strictEqual(second?.attachments?.[0], original, "新行引用的还是账本里那一枚");

  // 在飞完成 → 新行那一枚变 ready；第三次重发带上真回执
  upload.resolve({ receiptId: "rcpt-third" });
  await flush();
  assert.deepStrictEqual(
    (h.c.pendingMessages.get(A) ?? []).at(-1)?.attachments?.[0]?.upload,
    { status: "ready", receiptId: "rcpt-third" },
    "交接之后结算写回那一枚",
  );
  h.promptAnswer = async () => undefined;
  await h.c.handle({ type: "resendPending", requestId: second!.requestId }, "v1");
  const content = h.prompts.at(-1)?.content ?? [];
  assert.ok(
    content.some((part) => (part as { receiptId?: string }).receiptId === "rcpt-third"),
    `第三次重发应带上回执：${JSON.stringify(content)}`,
  );
});

// ---------- 二.16 无回显失败回填与清理断言 ----------
await scenario("二.16 无回显失败回填与清理断言", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  h.c.scopes.get(A)!.running = true;
  const upload = gate<{ receiptId: string }>();
  h.answer = () => upload.promise;
  await h.c.handle(attachFrame("报告.pdf"), "v1");
  const original = listOf(h.c, A)[0]!;
  h.promptAnswer = async () => {
    throw new Error("发送失败");
  };
  await h.c.handle({ type: "send", text: "带上附件", attachments: wireAttachments(original, "界面副本"), gesture: "enter" }, "v1");

  // 回填与清理：条目整份归还到可见草稿，租约账上**不留**那一份（不是复制持有）
  const requestId = requestIdOf(h.c)!;
  assert.strictEqual(listOf(h.c, A).length, 1, "回填后恰好一枚（界面副本按 id 去重）");
  assert.strictEqual(listOf(h.c, A)[0], original, "归还的是原来那一枚");
  assert.strictEqual(leaseOf(h.c, requestId), undefined, "回填之后这次提交的租约已经不在账上");
  assert.deepStrictEqual(h.c.pendingMessages.get(A) ?? [], [], "无回显的失败不留红行");

  // 在飞失败 → 重试（第二次上传同一份字节）→ 成功
  upload.reject(new Error("网络断了"));
  await flush();
  assert.deepStrictEqual(uploadOf(h.c, A, "报告.pdf"), { status: "error", message: "网络断了" });
  const retry = gate<{ receiptId: string }>();
  h.answer = () => retry.promise;
  await h.c.handle({ type: "retryUpload", id: original.id }, "v1");
  assert.strictEqual(h.uploads.length, 2, "回填后能重试");
  assert.strictEqual(h.uploads[1]!.bytes, h.uploads[0]!.bytes, "重试仍用账本留的那份字节");
  retry.resolve({ receiptId: "rcpt-clean" });
  await flush();
  assert.deepStrictEqual(uploadOf(h.c, A, "报告.pdf"), { status: "ready", receiptId: "rcpt-clean" });

  // 清理：失败态那一枚被移除之后不再占字节（重试成为空操作）
  const second = gate<{ receiptId: string }>();
  h.answer = () => second.promise;
  await h.c.handle(attachFrame("另一份.pdf"), "v1");
  const otherId = listOf(h.c, A).find((a) => a.name === "另一份.pdf")!.id;
  second.reject(new Error("又失败"));
  await flush();
  assert.strictEqual(uploadOf(h.c, A, "另一份.pdf")?.status, "error", "前提：第二枚落到失败态");
  await h.c.handle({ type: "removeAttachment", id: otherId }, "v1");
  assert.deepStrictEqual(listOf(h.c, A).map((a) => a.name), ["报告.pdf"], "移除之后只剩前面那一枚");
  const before = h.uploads.length;
  await h.c.handle({ type: "retryUpload", id: otherId }, "v1");
  assert.strictEqual(h.uploads.length, before, "移除释放了字节：重试不再打 IO");
});

// ---------- 二.17 上传成功的字节附件：本地留了一份可打开的副本 ----------
await scenario("二.17 字节来源上传成功后内容身份可换回本地副本", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  await h.c.handle(attachFrame("拖进来的.txt"), "v1");
  await flush();

  const chip = listOf(h.c, A)[0]!;
  assert.deepStrictEqual(uploadOf(h.c, A, "拖进来的.txt"), {
    status: "ready",
    receiptId: "rcpt-拖进来的.txt",
  });
  assert.strictEqual(chip.attachmentId, "sha256:拖进来的.txt", "上传成功要把内容身份写回芯片");

  // 落盘是后台的：这里等它一次（真机上用户点到之前早就写完了）
  const path = await h.c.attachmentTargets?.pathFor(chip.attachmentId!);
  assert.ok(path, "内容身份要能换回本地那一份");
  assert.ok(existsSync(path!), `临时副本要真的在磁盘上：${path}`);
  assert.strictEqual(readFileSync(path!, "utf8"), "hello", "副本内容与拖进来的字节一致");
  rmSync(dirname(path!), { recursive: true, force: true });
});

// ---------- 二.18 打开附件：账本里的字节落临时副本；没有可打开的内容就明确说一声 ----------
await scenario("二.18 打开附件：内存字节落副本、无处可取时提示", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);

  // 粘贴进来的截图：磁盘上没有原件，账本里那一条带着 dataUrl
  const png = Buffer.from("fake-png-bytes");
  putAttachment(h.c, A, {
    id: "img-1",
    kind: "image",
    name: "图1.png",
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
  });
  editorCalls.reset();
  await h.c.handle({ type: "openAttachment", name: "图1.png", kind: "image", id: "img-1" }, "v1");
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(png).slice(0, 12), "图1.png");
  assert.ok(existsSync(copy), `账本里的字节要落成临时副本：${copy}`);
  assert.strictEqual(readFileSync(copy, "utf8"), "fake-png-bytes");
  // 普通打开**只发 `vscode.open`**：不按文件类型分流，也不走文本编辑器那条路
  // （`openTextDocument` 对二进制直接抛「文件似乎是二进制文件，不能作为文本打开」
  // ——2026-10-13 用户报「单击没有反应」就是这一条，真机日志里只有一行 `[open] 打开失败`）。
  assert.deepStrictEqual(
    editorCalls.opened,
    [],
    "普通打开不许走文本编辑器那条路（二进制在真机上必失败）",
  );
  assert.deepStrictEqual(
    editorCalls.openedViaCommand,
    [copy],
    "把文件交给 VS Code：vscode.open 打开临时副本，编辑器由它自己挑",
  );
  assert.deepStrictEqual(
    h.frames.filter((f) => f.frame.type === "toast"),
    [],
    "打开成功不弹提示",
  );
  rmSync(dirname(copy), { recursive: true, force: true });

  // 只有服务端副本的文件附件（重开这套扩展之后的历史消息）：明说打不开，不静默
  h.frames.length = 0;
  await h.c.handle({ type: "openAttachment", name: "历史.pdf", kind: "file", attachmentId: "sha256:none" }, "v1");
  const toasts = h.frames.filter((f) => f.frame.type === "toast");
  assert.strictEqual(toasts.length, 1, "打不开要有提示");
  assert.strictEqual(toasts[0]!.frame.text, "@attachmentUnavailable", "提示走语言中立标记");
});

// ---------- 二.19 打开附件：普通打开交给 vscode.open，带行号才走文本文档 ----------
await scenario("二.19 普通打开发 vscode.open；带行号才走文本文档", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  h.c.fileExistence = async () => "present";
  // 路径要用**宿主平台上算绝对**的那种（`isAbsolute` 是平台相关的：写死 `C:\…` 在 Linux 上
  // 会被当成相对路径，缺 cwd 时直接解析不了——CI 在 ubuntu-latest 上跑出来的正是这条）
  const notes = absoluteFixturePath("notes.md");
  putAttachment(h.c, A, { id: "f1", kind: "file", name: "notes.md", path: notes });

  editorCalls.reset();
  await h.c.handle({ type: "openAttachment", name: "notes.md", kind: "file", id: "f1", path: notes }, "v1");
  assert.deepStrictEqual(
    editorCalls.openedViaCommand,
    [notes],
    "普通打开就是把资源交给 VS Code（`vscode.open`），编辑器由它自己挑",
  );
  assert.deepStrictEqual(editorCalls.opened, [], "普通打开不经过文本编辑器 API");
  assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), [], "成功时不弹提示");

  // 正文链接那种**带行号**的打开（`[…](src/a.ts#L12)`）仍走文本文档：光标要按真实行数夹取，
  // 越界的 `Position` 在 VS Code 里是抛异常而不是夹取
  editorCalls.reset();
  await h.c.handle({ type: "openFile", path: notes, line: 7 }, "v1");
  assert.deepStrictEqual(editorCalls.opened, [notes], "带行号时先取文本文档");
  assert.deepStrictEqual(editorCalls.shown, [notes], "再把那份文档显示出来");
});

// ---------- 二.20 不按类型分流：不是图片的二进制一样开得出来；带行号指到二进制也不静默 ----------
await scenario("二.20 二进制附件照常打开；带行号那条路失败也不静默", async () => {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  // 拖进来的压缩包：上传失败 → 字节留在账本里（这正是「点开临时副本」的来路之一）
  h.answer = async () => {
    throw new Error("网络断了");
  };
  await h.c.handle(attachFrame("archive.zip"), "v1");
  await flush();
  const chip = listOf(h.c, A)[0]!;
  assert.strictEqual(chip.upload?.status, "error", "前提：这一枚落在失败态（字节仍在）");

  editorCalls.reset();
  await h.c.handle({ type: "openAttachment", name: chip.name, kind: "file", id: chip.id }, "v1");
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(Buffer.from("hello")).slice(0, 12), "archive.zip");
  assert.ok(existsSync(copy), `账本里的暂存字节要落成临时副本：${copy}`);
  assert.deepStrictEqual(editorCalls.opened, [], "压缩包同样不走文本编辑器（这里没有按类型分流）");
  assert.deepStrictEqual(editorCalls.openedViaCommand, [copy], "vscode.open 照样把文件开出来");
  rmSync(dirname(copy), { recursive: true, force: true });

  // 带行号打开指到一个二进制上（`![](pic.png#L3)` 那种链接）：文本那条路在真机上必失败
  // （桩按扩展名复刻），必须退到普通打开——不能只留一行日志
  editorCalls.reset();
  const pic = absoluteFixturePath("pic.png");
  await h.c.handle({ type: "openFile", path: pic, line: 3 }, "v1");
  assert.deepStrictEqual(editorCalls.opened, [], "二进制拿不到文本文档");
  assert.deepStrictEqual(editorCalls.openedViaCommand, [pic], "退回普通打开，仍然开出来");
  assert.ok(
    (h.frames.filter((f) => f.frame.type === "toast").length === 0),
    "这条退让不需要提示（用户拿到了文件）",
  );
});

/** 打开链的离线台：查真实临时文件，服务端字节只由场景注入。 */
async function openHarness() {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", A);
  h.c.fileExistence = async (uri) => existsSync(uri.fsPath) ? "present" : "absent";
  const reads: { sessionId: string; attachmentId: string }[] = [];
  const source = { answer: async (): Promise<unknown> => undefined };
  (h.c.client as { request: (method: string, params: { request: { sessionId: string; attachmentId: string } }) => Promise<unknown> }).request = async (method, params) => {
    assert.strictEqual(method, "session/attachment", "只允许离线附件读数");
    reads.push(params.request);
    return source.answer();
  };
  h.c.openChanges = async () => { assert.fail("附件缺原件不能用 git diff 冒充打开成功"); };
  h.frames.length = 0;
  editorCalls.reset();
  return { ...h, reads, source };
}

await scenario("二.21 失效的消息路径继续到账本字节，不提前报文件删除", async () => {
  const h = await openHarness();
  const bytes = Buffer.from("stale-message-path-copy");
  const name = "stale-message.png";
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(bytes).slice(0, 12), name);
  putAttachment(h.c, A, { id: "stale-message", kind: "image", name, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
  try {
    await h.c.handle({ type: "openAttachment", kind: "image", name, id: "stale-message", path: join(tmpdir(), "missing-attachment-original", name) }, "v1");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [copy], "原路径失效后打开账本副本");
    assert.strictEqual(readFileSync(copy, "utf8"), bytes.toString());
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
    assert.deepStrictEqual(h.reads, [], "账本能打开就不读服务端");
  } finally {
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

await scenario("二.22 失效的账本路径不挡 dataUrl，无法解析的消息路径同样继续", async () => {
  const h = await openHarness();
  const bytes = Buffer.from("stale-ledger-path-copy");
  const name = "stale-ledger.png";
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(bytes).slice(0, 12), name);
  putAttachment(h.c, A, { id: "stale-ledger", kind: "image", name, path: join(tmpdir(), "missing-attachment-original", name), dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
  try {
    await h.c.handle({ type: "openAttachment", kind: "image", name, id: "stale-ledger", path: "relative-without-cwd.png" }, "v1");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [copy]);
    assert.strictEqual(readFileSync(copy, "utf8"), bytes.toString());
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
  } finally {
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

await scenario("二.23 失效原路径后先取上传索引，再取 durable 图片字节", async () => {
  const h = await openHarness();
  const root = mkdtempSync(join(tmpdir(), "dsh-attachment-index-"));
  const indexed = join(root, "indexed.png");
  const bytes = Buffer.from("durable-fallback-bytes");
  const name = "durable-fallback.png";
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(bytes).slice(0, 12), name);
  writeFileSync(indexed, "indexed-original-bytes");
  h.c.attachmentTargets!.remember("sha256:fallback", indexed);
  putAttachment(h.c, A, { id: "durable", kind: "image", name, path: join(root, "gone.png"), attachmentId: "sha256:fallback" });
  h.source.answer = async () => ({ data: bytes.toString("base64"), attachment: { mediaType: "image/png" } });
  const message = { type: "openAttachment", kind: "image", name, id: "durable", path: join(root, "gone.png") };
  try {
    await h.c.handle(message, "v1");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [indexed], "有效索引优先于服务端副本");
    assert.deepStrictEqual(h.reads, []);
    rmSync(indexed);
    editorCalls.reset();
    await h.c.handle(message, "v1");
    assert.deepStrictEqual(h.reads, [{ sessionId: A, attachmentId: "sha256:fallback" }]);
    assert.deepStrictEqual(editorCalls.openedViaCommand, [copy]);
    assert.strictEqual(readFileSync(copy, "utf8"), bytes.toString());
    assert.strictEqual(await h.c.attachmentTargets!.pathFor("sha256:fallback"), copy, "恢复副本写回索引");
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

await scenario("二.24 全来源不可用只报一次附件提示，普通删文件仍走 git diff", async () => {
  const h = await openHarness();
  const missing = join(tmpdir(), "missing-attachment-original", "unavailable.png");
  h.c.attachmentTargets!.remember("sha256:unavailable", missing);
  putAttachment(h.c, A, { id: "unavailable", kind: "image", name: "unavailable.png", path: missing, attachmentId: "sha256:unavailable" });
  h.source.answer = async () => { throw new Error("离线：没有服务端副本"); };
  await h.c.handle({ type: "openAttachment", kind: "image", name: "unavailable.png", path: missing, id: "unavailable" }, "v1");
  assert.deepStrictEqual(editorCalls.openedViaCommand, []);
  assert.strictEqual(h.reads.length, 1, "前面失效不阻断最后的字节来源");
  assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast").map((f) => f.frame.text), ["@attachmentUnavailable"]);

  let diffs = 0;
  h.c.openChanges = async (uri) => { assert.strictEqual(uri.fsPath, missing); diffs++; return true; };
  h.frames.length = 0;
  await h.c.handle({ type: "openFile", path: missing }, "v1");
  assert.strictEqual(diffs, 1, "普通 openFile 的 git 删除文件退路保持不变");
  assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
});

await scenario("二.25 原件存在时优先打开，按会话 cwd 解析相对路径", async () => {
  const h = await openHarness();
  const root = mkdtempSync(join(tmpdir(), "dsh-attachment-original-"));
  const original = join(root, "original.png");
  writeFileSync(original, "original-edited-content");
  h.c.sessions = [{ id: A, cwd: root }];
  putAttachment(h.c, A, { id: "original", kind: "image", name: "original.png", path: original, dataUrl: "data:image/png;base64,Y29weQ==", attachmentId: "sha256:original" });
  try {
    await h.c.handle({ type: "openAttachment", kind: "image", name: "original.png", id: "original", path: "original.png" }, "v1");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [original]);
    assert.deepStrictEqual(h.reads, []);
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
    editorCalls.reset();
    await h.c.handle({ type: "openAttachment", kind: "image", name: "original.png", id: "original" }, "v1");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [original], "账本原路径同样优先于 dataUrl");
    assert.deepStrictEqual(h.reads, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario("二.26 编辑器拒绝原件后继续副本，全部拒绝只报一次", async () => {
  const h = await openHarness();
  const root = mkdtempSync(join(tmpdir(), "dsh-attachment-rejected-"));
  const original = join(root, "rejected.png");
  writeFileSync(original, "rejected-original");
  const bytes = Buffer.from("editor-fallback-bytes");
  const name = "editor-fallback.png";
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(bytes).slice(0, 12), name);
  putAttachment(h.c, A, { id: "rejected", kind: "image", name, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
  const execute = vscode.commands.executeCommand;
  const attempted: string[] = [];
  let rejectAll = false;
  vscode.commands.executeCommand = (async (_command: string, uri: { fsPath: string }) => {
    attempted.push(uri.fsPath);
    if (rejectAll || uri.fsPath === original) throw new Error("离线：编辑器拒绝打开");
    return execute("vscode.open", uri);
  }) as typeof execute;
  try {
    await h.c.handle({ type: "openAttachment", kind: "image", name, id: "rejected", path: original }, "v1");
    assert.deepStrictEqual(attempted, [original, copy], "不能把 openFile 的 void 当打开成功");
    assert.deepStrictEqual(editorCalls.openedViaCommand, [copy]);
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast"), []);
    rejectAll = true;
    await h.c.handle({ type: "openAttachment", kind: "image", name, id: "rejected", path: original }, "v1");
    assert.deepStrictEqual(h.frames.filter((f) => f.frame.type === "toast").map((f) => f.frame.text), ["@attachmentUnavailable"]);
  } finally {
    vscode.commands.executeCommand = execute;
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

// ---------- 二.27 打开记录落盘：重开宿主之后，历史文件附件照样打开用户那个原件 ----------
await scenario("二.27 重开宿主后按持久记录打开历史文件附件", async () => {
  const globalState = fakeMemento();
  const root = mkdtempSync(join(tmpdir(), "dsh-attachment-restart-"));
  const original = join(root, "报告.pdf");
  writeFileSync(original, "original-file-content");

  const h1 = harness(globalState);
  h1.c.bindView("v1");
  await h1.c.openSession("v1", A);
  h1.c.fileExistence = async (uri) => (existsSync(uri.fsPath) ? "present" : "absent");
  // 「添加文件」按钮 / 粘贴真路径走的是**路径通道**：附件本来就带着用户磁盘上那个路径
  await h1.c.addPaths!("v1", [original], "button");
  await flush();
  const chip = listOf(h1.c, A)[0]!;
  assert.strictEqual(chip.upload?.status, "ready", "前提：这一枚上传成功（上传回执里带了内容身份）");
  const durable = chip.attachmentId;
  assert.ok(durable, "前提：上传成功那一刻内容身份写回了芯片");
  assert.strictEqual(
    readOriginalTarget(globalState, durable),
    original,
    "路径通道记的是用户自己那个文件：芯片悬停显示它、点开也开它",
  );

  // 另一条通道：拖放 / 粘贴进来的字节在磁盘上没有原件，只有我们落的临时副本。
  // 它照样打得开，但**不是**「用户的文件路径」，不能拿去当悬停提示。
  await h1.c.handle(attachFrame("drop.bin"), "v1");
  await flush();
  const dropped = listOf(h1.c, A).find((attachment) => attachment.name === "drop.bin")!;
  const droppedId = dropped.attachmentId!;
  const copy = join(attachmentTempRoot(tmpdir()), contentDigest(Buffer.from("hello")).slice(0, 12), "drop.bin");
  // 副本是**后台**落的：索引里挂着那份承诺，等它就等于等盘上那份文件
  assert.strictEqual(
    await h1.c.attachmentTargets!.pathFor(droppedId),
    copy,
    "前提：临时副本落到了内容寻址的那条路径上",
  );
  assert.ok(existsSync(copy), `前提：临时副本真的在盘上（${copy}）`);
  assert.strictEqual(
    readOriginalTarget(globalState, droppedId),
    undefined,
    "临时副本不当「原文件路径」展示（临时目录里的路径不是用户的文件）",
  );

  // 重开宿主：新的控制器、新的内存索引，只有 globalState 是同一份
  const h2 = harness(globalState);
  h2.c.bindView("v1");
  await h2.c.openSession("v1", A);
  h2.c.fileExistence = async (uri) => (existsSync(uri.fsPath) ? "present" : "absent");
  assert.strictEqual(
    await h2.c.attachmentTargets!.pathFor(durable),
    undefined,
    "前提：新宿主的内存索引是空的（这里只剩持久记录可依）",
  );

  editorCalls.reset();
  try {
    // 回放的历史消息：芯片上只剩内容身份（durable 行的 id 是 `m<序号>`，账本里查不到）
    await h2.c.handle(
      { type: "openAttachment", kind: "file", name: "报告.pdf", attachmentId: durable, id: "m0" },
      "v1",
    );
    assert.deepStrictEqual(editorCalls.openedViaCommand, [original], "按持久记录打开用户磁盘上那个原件");
    assert.deepStrictEqual(h2.frames.filter((f) => f.frame.type === "toast"), [], "打得开就不该有提示");

    // 字节通道那一枚跨重启也打得开——打开的是我们落的副本（悬停不显示它，但单击能用）
    await h2.c.handle(
      { type: "openAttachment", kind: "file", name: "drop.bin", attachmentId: droppedId, id: "m1" },
      "v1",
    );
    assert.deepStrictEqual(
      editorCalls.openedViaCommand,
      [original, copy],
      "没有原件的附件打开副本（同一条记录，只是 `copy` 为真）",
    );

    // 原文件被移走 / 删掉之后，同一条记录不能假装还打得开
    rmSync(original);
    await h2.c.handle(
      { type: "openAttachment", kind: "file", name: "报告.pdf", attachmentId: durable, id: "m0" },
      "v1",
    );
    assert.deepStrictEqual(editorCalls.openedViaCommand, [original, copy], "文件不在了就不再发起打开");
    assert.deepStrictEqual(
      h2.frames.filter((f) => f.frame.type === "toast").map((f) => f.frame.text),
      ["@attachmentUnavailable"],
      "文件不在了就明确说打不开",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`\nattachmentLifecycle: ${failures.length} 个场景失败`);
  for (const { name, error } of failures) {
    console.error(`\n===== ${name} =====`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
}
console.log("attachmentLifecycle: 归属 / 迁移 / 移除 / 迟到 / 重试 / 回收 全部成立 ✓");
