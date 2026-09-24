/**
 * 后台任务实时输出的累积口径（对应官方 `dsh-api-job-controller` 的 `ClientJobsModel`）
 * 与面板接线的离线断言。
 *
 * 为什么值得单钉一套：这条链上的错都**不报错**——代号对不上时那几帧会被静默丢掉
 * （界面停在半截输出）、截断点切在代理对中间会出乱码方块、忘了发 `unobserveJob`
 * 则流一直挂在扩展宿主里。它们各自都不影响别的功能，只能靠断言钉住。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyObservedFailed,
  applyObservedOpened,
  applyObservedOutput,
  jobObserveStart,
  JOB_RENDER_TAIL_LIMIT,
  type JobObserved,
} from "../src/webview/jobObserve";

const opened = (jobId: string, watchId: number, from: number, earliest: number) =>
  ({ type: "jobs/opened", jobId, watchId, from, earliest }) as const;
const output = (jobId: string, watchId: number, text: string, gapBefore = false) =>
  ({ type: "jobs/output", jobId, watchId, text, gapBefore }) as const;
const failed = (jobId: string, watchId: number, detail?: string) =>
  ({ type: "jobs/observeFailed", jobId, watchId, ...(detail === undefined ? {} : { detail }) }) as const;

/** 三型帧的联合（喂给下面那个 `feed`）。 */
type Frame =
  | ReturnType<typeof opened>
  | ReturnType<typeof output>
  | ReturnType<typeof failed>;

/** 一步到位：起一条观察，再把若干帧依次喂进去（返回最终状态）。 */
function feed(watchId: number, ...frames: Frame[]): JobObserved {
  let state: JobObserved | undefined = jobObserveStart(watchId);
  for (const frame of frames) {
    state =
      frame.type === "jobs/opened"
        ? applyObservedOpened(state, frame)
        : frame.type === "jobs/output"
          ? applyObservedOutput(state, frame)
          : applyObservedFailed(state, frame);
  }
  assert.ok(state, "帧与当前观察同号，状态不该凭空消失");
  return state;
}

// ---------- 1. 锚点：三种「开头已经没了」都要留痕 ----------
{
  // 从环头开始：不欠字节
  assert.deepStrictEqual(feed(1, opened("j1", 1, 0, 0)), {
    watchId: 1,
    opened: true,
    text: "",
    gapBefore: false,
  });

  // 第一次观察就锚在非零偏移：环头在打开之前就被淘汰了（官方 freshPastHead）
  assert.strictEqual(feed(1, opened("j1", 1, 40, 40)).gapBefore, true, "首次锚在 from>0 就欠了开头");

  // 锚点落在最旧保留字节之前：中间那段已经没了
  assert.strictEqual(feed(1, opened("j1", 1, 0, 40)).gapBefore, true, "from < earliest 欠了开头");

  // 续传（重连后重开）：文本还在，锚点接着来——**不许**因为「文本非空」就清掉
  const resumed = feed(1, opened("j1", 1, 10, 10), output("j1", 1, "abc"), opened("j1", 1, 13, 10));
  assert.strictEqual(resumed.text, "abc", "重连后的锚点不清空已累积的文本");
  assert.strictEqual(resumed.opened, true);
}
console.log("jobObserve: 锚点的三种欠头判定与续传 ✓");

// ---------- 2. 输出：追加、gap 折算、保留上限 ----------
{
  const state = feed(1, opened("j1", 1, 0, 0), output("j1", 1, "a"), output("j1", 1, "b", true));
  assert.strictEqual(state.text, "ab", "多帧依次接在尾部");
  assert.strictEqual(state.gapBefore, true, "任一帧标了 gapBefore，整条观察就欠开头");

  // 超上限：从头截掉，并且**标上 gapBefore**（截断与「服务端淘汰了开头」对读者是同一件事）
  const long = "x".repeat(JOB_RENDER_TAIL_LIMIT + 500);
  const capped = feed(1, opened("j1", 1, 0, 0), output("j1", 1, long));
  assert.strictEqual(capped.text.length, JOB_RENDER_TAIL_LIMIT, "保留上限就是官方那个 128K（UTF-16）");
  assert.strictEqual(capped.gapBefore, true, "截断必须留痕：前面的输出没了");

  // 截断点正好落在代理对中间（低位代理处）：整对丢掉，不吐出一个孤立代理
  // （孤立代理在界面上就是乱码方块；这条断言同时证明了「往后挪一位」真的生效）
  const tail = "b".repeat(JOB_RENDER_TAIL_LIMIT - 1);
  const straddling = feed(1, opened("j1", 1, 0, 0), output("j1", 1, "aaaaa😀" + tail));
  assert.strictEqual(straddling.text, tail, "跨在边界上的代理对被整对丢掉，而不是留下半个");
  assert.strictEqual(straddling.gapBefore, true, "同一次截断照旧留痕");
}
console.log("jobObserve: 追加 / gap 折算 / 128K 截断不切开代理对 ✓");

// ---------- 3. 失败：文本留着，两种失败分开表达 ----------
{
  const withDetail = feed(
    1,
    opened("j1", 1, 0, 0),
    output("j1", 1, "half"),
    failed("j1", 1, "gateway/not-found: no such route"),
  );
  assert.strictEqual(withDetail.text, "half", "流断了，已经看到的部分不该消失");
  assert.strictEqual(withDetail.error, "gateway/not-found: no such route", "服务端原样报错照存");

  const withoutDetail = feed(1, failed("j1", 1));
  assert.strictEqual(withoutDetail.error, null, "宿主没开成流 = `null`（界面用概括文案，不是空字符串）");
  assert.strictEqual(withoutDetail.opened, false, "没锚点就不算 opened（展开体据此不画空输出框）");
}
console.log("jobObserve: 失败保留文本、两种失败分开表达 ✓");

// ---------- 4. 代号守卫与「没有条目」：一律不动手 ----------
{
  // 收起后再点开会换号：旧流还在路上的残余帧不能接进新一轮
  const stale = applyObservedOutput(jobObserveStart(2), output("j1", 1, "old"));
  assert.strictEqual(stale, undefined, "旧代号的帧丢掉");
  assert.strictEqual(applyObservedOpened(undefined, opened("j1", 1, 0, 0)), undefined, "没有条目就不新建");
  assert.strictEqual(applyObservedFailed(undefined, failed("j1", 1, "x")), undefined, "失败帧同理");
  assert.strictEqual(
    applyObservedFailed(jobObserveStart(1), failed("j1", 9, "x")),
    undefined,
    "别条观察的失败帧不许落到这一条上",
  );
}
console.log("jobObserve: 代号守卫与「没有条目不动手」 ✓");

// ---------- 5. 接线：展开要开流、收起/关面板要释放 ----------
//
// 这一节只做**源码接线**断言（静态），行为断言在上面几节与 `state.ts` 的纯函数里：
// 「忘了发 unobserveJob」的后果是扩展宿主里挂着一条永不结束的流，没有任何界面症状，
// 而它对纯函数断言完全不可见。用 jsdom 真点一下需要引入一整套测试环境，这里就以
// 接线为准（改动这几行时断言会红，逼人回来看一眼）。
{
  const panels = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Panels.tsx"),
    "utf8",
  );
  assert.match(panels, /post\(\{ type: "observeJob", jobId: job\.id, watchId \}\)/, "展开必须发 observeJob");
  assert.match(
    panels,
    /dispatch\(\{ type: "ui\/jobObserve", jobId: job\.id, watchId \}\)/,
    "代号要先落进状态，宿主回带的帧才有号可对",
  );
  assert.match(panels, /post\(\{ type: "unobserveJob", jobId \}\)/, "收起 / 关面板必须发 unobserveJob");
  assert.match(panels, /className="job-row-toggle"/, "可展开的行要挂上身按钮（chevron 在行内）");

  const state = readFileSync(join(process.cwd(), "src", "webview", "state.ts"), "utf8");
  assert.match(state, /case "jobs\/opened":/, "锚点帧要有落点");
  assert.match(state, /case "jobs\/observeFailed":/, "失败帧要有落点");
  assert.match(state, /switched \? \{ jobOutputs: undefined \}/, "换会话要丢掉上一会话的输出累积");
}
console.log("jobObserve: 面板接线（展开开流 / 收起释放 / 换会话清累积） ✓");

console.log("\njobObserve: all assertions passed");
