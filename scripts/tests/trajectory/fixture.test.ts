/**
 * 夹具脱敏库（`scripts/trajectoryFixture.ts`）的离线回归：纯函数与结构不变量断言。
 *
 * 运行：`npm test`（本文件登记在 `esbuild.scripts.mjs` 的 entries 里，产物是
 *       `build/trajectory-fixture.test.mjs`）。**不读用户日志**、不起 dsh、不花 token。
 *
 * 合成输入**只**用于「脱敏安全」「结构不变量」「登记校验」的单测；它不是真实夹具，
 * 也不得被当成真实来源登记。
 *
 * 覆盖里有一条**静态**闸门（helper 必须零 Node 依赖）与一组**成员位置的秘密键不回显**
 * 断言（8 个位置各注入一个受控未知键）+ 深度安全失败；它们的期望与主代理的独立验收
 * 一致，见文件末尾那两个块。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveTrajectoryModel } from "../../../src/dsh/trajectory";
import type { SessionWireEvent } from "../../../src/dsh/protocol";
import type { TrajectoryCell, TrajectoryModel } from "../../../src/shared/trajectory";
import {
  DIGEST_PATTERN,
  DEFAULT_FIELD_LIMIT,
  FIXTURE_INVARIANT_CODES,
  FIXTURE_REDACTION_VERSION,
  MAX_FIXTURE_DEPTH,
  SECRET_RULES,
  TIME_ANCHOR_MS,
  canonicalJson,
  capabilitiesOf,
  checkFixtureInvariants,
  computeTimeShift,
  exceedsDepth,
  findSecretHits,
  newRedactionStats,
  pseudotextLike,
  redactPathsInside,
  redactTrajectoryModel,
  scanFixtureSecrets,
  shannonEntropy,
  structureOf,
  validateFixturePayload,
} from "../../trajectoryFixture";
/**
 * `limitApplies` 走模块命名空间取用，而不是写进上面的具名 import。
 *
 * 理由（与红/绿取证直接相关）：红阶段（实现里还没有这个导出时）要红在**断言**上。
 * esbuild 对「具名 import 了不存在的导出」是硬失败（`No matching export`），打包一失败，
 * 本文件后面的 0 值行为断言（`checkFixtureInvariants` / `validateFixturePayload`）就都跑不到，
 * 红日志只剩一条「无此导出」，反而比断言失败更弱。命名空间取用让同一份文件在红阶段能跑完，
 * 绿阶段也不用改一个字。
 */
import * as fixtureContract from "../../trajectoryFixture";

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
let seq = 0;
const event = (type: string, data: Record<string, unknown>, offset = seq): SessionWireEvent => {
  seq += 1;
  return { type, seq: seq - 1, time: BASE + offset * 1000, data };
};
const block = (text: string) => [{ type: "text", text }];

const FREE_TEXT_SECRET = "https://example.test/callback?token=sk-free-text-secret-abcdefghijklmnop";
const USER_PATH = "C:\\Users\\fixture-user\\proj\\a.ts";
const SYSTEM_TEXT = "系统提示词第一行\n第二行";
const USER_TEXT = `用户问题：把 ${USER_PATH} 读出来\n第二行 ${FREE_TEXT_SECRET}`;
const ASSISTANT_TEXT = "助手回答\n带换行";
const RESULT_TEXT = "结果正文\n第二行";

function syntheticEvents(): SessionWireEvent[] {
  seq = 0;
  const callArgs = JSON.stringify({ path: USER_PATH });
  return [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("system/message", { turn: 1, step: 1, message: { content: block(SYSTEM_TEXT) } }, 0),
    event("request/header", {
      header: {
        config: { provider: "provider-real", model: "model-real" },
        tools: [{ name: "read", description: "读文件" }],
      },
      reason: "initial",
    }, 0),
    event("user/message", { id: "u1", role: "user", source: { kind: "user" }, content: block(USER_TEXT) }, 1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "a1",
        role: "assistant",
        source: { provider: "provider-real", model: "model-real" },
        content: [...block(ASSISTANT_TEXT), { type: "tool-call", id: "call_1", name: "read", arguments: callArgs }],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    }, 2),
    event("tool/call", { turn: 1, step: 1, callId: "call_1", name: "read", arguments: callArgs }, 2),
    event("tool/ptc-dispatch-start", {
      rootCallId: "call_1", parentCallId: "call_1", subCallId: "call_1:ptc:1", name: "read", arguments: {},
    }, 3),
    event("tool/result", {
      turn: 1,
      step: 1,
      message: { content: block(RESULT_TEXT), source: { callId: "call_1" } },
    }, 3),
    event("step/end", { turn: 1, step: 1 }, 3),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
  ];
}

const sourceModel = deriveTrajectoryModel(syntheticEvents(), false);
const { model: redacted, stats, timeShiftMs } = redactTrajectoryModel(sourceModel, {
  fieldLimit: DEFAULT_FIELD_LIMIT,
});
const clone = (): TrajectoryModel => structuredClone(redacted);
const cellsOf = (model: TrajectoryModel): TrajectoryCell[] =>
  model.turns.flatMap((turn) => turn.groups.flatMap((group) => group.cells));
const newlinePositions = (value: string): number[] =>
  [...value].flatMap((ch, at) => (ch === "\n" || ch === "\r" ? [at] : []));

// ---------- 1. 脱敏：等长 + 换行位置保留 + 恒等式 ----------
{
  assert.strictEqual(pseudotextLike("", "seed"), "", "空串照旧是空串");
  const sample = "第一行\n第二行\r\n第三行";
  const pseudo = pseudotextLike(sample, "sample");
  assert.strictEqual(pseudo.length, sample.length, "伪文与原文等长（排版度量不变）");
  assert.deepStrictEqual(newlinePositions(pseudo), newlinePositions(sample), "换行位置逐字保留");
  assert.ok(shannonEntropy(pseudo) < 3.5, "伪文是低熵的（不会反过来触发凭据规则）");
  assert.strictEqual(pseudotextLike(sample, "sample"), pseudo, "同种子必得同输出（确定性）");

  const source = cellsOf(sourceModel).find((cell) => cell.kind === "user");
  const after = cellsOf(redacted).find((cell) => cell.kind === "user");
  assert.ok(source?.previewMarkdown !== undefined && after?.previewMarkdown !== undefined, "两侧都有用户正文");
  assert.strictEqual(after?.previewMarkdown.length, source?.previewMarkdown.length, "模型里的正文同样等长");
  assert.deepStrictEqual(
    newlinePositions(after?.previewMarkdown ?? ""),
    newlinePositions(source?.previewMarkdown ?? ""),
    "模型里的正文换行位置同样保留",
  );
  assert.ok(timeShiftMs !== 0, "有真实时刻就会算出平移量");
}

// ---------- 2. 脱敏：自由文本里的秘密消失，且注入确实发生 ----------
{
  // 注入确认：没有这一条，后面的「扫描为 0」可能只是因为注入没生效
  assert.ok(USER_TEXT.includes("token=") && USER_TEXT.includes(USER_PATH), "注入的样本确实带秘密与用户路径");  assert.ok(
    findSecretHits(USER_TEXT).some((hit) => hit.rule === "url-token"),
    "规则表能认出注入的 token 形态（注入生效）",
  );
  assert.ok(JSON.stringify(sourceModel).includes(FREE_TEXT_SECRET), "源模型里确实带着那条秘密");

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes(FREE_TEXT_SECRET), "自由文本里的秘密被伪文替换");
  assert.ok(!serialized.includes("fixture-user"), "用户目录名不出现");
  assert.ok(!serialized.includes("C:\\\\Users"), "Windows 用户绝对路径不出现");
  assert.ok(!serialized.includes("provider-real") && !serialized.includes("model-real"), "提供方/模型换成中性占位");
  assert.deepStrictEqual(scanFixtureSecrets(redacted), [], "整份脱敏模型扫描干净");
  assert.ok(stats.strings > 0 && stats.paths > 0, "脱敏统计证明转换真的跑了");
  assert.strictEqual(stats.truncated && Object.keys(stats.truncated).length, 0, "短样本没有截断");
}

// ---------- 3. 扫描：嵌套秘密键不回显（返回结果里既无键也无值） ----------
{
  const secretKey = "sk-nestedkeysecret0123456789";
  const secretValue = "ghp_nestedvaluesecret0123456789";
  const nested = { outer: { inner: { [secretKey]: { deep: secretValue } } } };
  assert.ok(JSON.stringify(nested).includes(secretKey), "注入的秘密键确实在输入里");
  const hits = scanFixtureSecrets(nested);
  assert.ok(hits.length >= 2, "键名与值都要命中");
  const report = JSON.stringify(hits);
  assert.ok(!report.includes(secretKey), "返回结果不得回显原始键名");
  assert.ok(!report.includes(secretValue), "返回结果不得回显原始值");
  assert.ok(!report.includes("nestedkeysecret") && !report.includes("nestedvaluesecret"), "连片段都不许出现");
  for (const hit of hits) {
    assert.ok(!hit.path.includes("secret"), `命中路径必须是无键名的位置描述：${hit.path}`);
    assert.strictEqual(typeof hit.at, "number");
    assert.strictEqual(typeof hit.length, "number");
  }
  assert.ok(hits.some((hit) => hit.path.endsWith("#key")), "键名命中用 #key 结尾标出");
}

// ---------- 4. 摘要白名单：只豁免「精确位置 + 合法格式」 ----------
{
  const digest = "a".repeat(64);
  assert.ok(DIGEST_PATTERN.test(digest), "64 位十六进制是合法摘要");
  const whitelist = ["$.provenance.modelSha256"];

  assert.deepStrictEqual(
    scanFixtureSecrets({ provenance: { modelSha256: digest } }, { digestPaths: whitelist }),
    [],
    "白名单位置 + 合法格式才豁免",
  );
  assert.ok(
    scanFixtureSecrets({ provenance: { modelSha256: digest }, model: { text: digest } }, { digestPaths: whitelist })
      .length > 0,
    "同一串出现在模型里照旧命中（不按内容长度全局放行）",
  );
  assert.ok(
    scanFixtureSecrets({ provenance: { modelSha256: `${digest}0` } }, { digestPaths: whitelist }).length > 0,
    "位置对但格式不对（多一个字符）照旧扫",
  );
  assert.ok(
    scanFixtureSecrets({ provenance: { modelSha256: digest, note: digest } }, { digestPaths: whitelist }).length > 0,
    "未知 metadata 里的摘要照旧扫",
  );
  assert.ok(
    scanFixtureSecrets(
      { provenance: { sourceEventCounts: { [digest]: 1 } } },
      { digestPaths: ["$.provenance.sourceEventCounts"] },
    ).length > 0,
    "sourceEventCounts 的**键**不在白名单里（白名单只豁免完整值路径）",
  );
  assert.ok(
    scanFixtureSecrets({ provenance: { modelSha256: digest } }).length > 0,
    "不给白名单时任何 64 位串都照旧命中",
  );
  // 带点号的恶意键：不能把自己拼成白名单里的多级路径
  assert.ok(
    scanFixtureSecrets({ "provenance.modelSha256": digest }, { digestPaths: whitelist }).length > 0,
    "带点号的键不能伪造白名单路径（键名分段必须转义）",
  );
  // 数组白名单：真下标豁免，而「键名里带 [0]」的对象不能冒充它
  assert.deepStrictEqual(
    scanFixtureSecrets({ arr: [digest] }, { digestPaths: ["$.arr[0]"] }),
    [],
    "真正的数组下标位置仍按白名单豁免",
  );
  assert.ok(
    scanFixtureSecrets({ "arr[0]": digest }, { digestPaths: ["$.arr[0]"] }).length > 0,
    "对象键名里的 [0] 不能冒充数组下标白名单位置",
  );
}

// ---------- 4b. 秘密规则正向矩阵：13 条规则各有受控注入，且不回显注入原文 ----------
{
  /** 受控合成样本（**不是真实凭据**）：每条规则一份，形状与该规则一致。 */
  const samples: Record<string, string> = {
    "url-token": "https://fixture.invalid/?token=parent_contract_secret",
    "bearer": "Bearer parent_contract_123456789",
    "authorization-header": "Authorization: parent_contract_value",
    "cookie-header": "Set-Cookie: parent_contract_value",
    "openai-key": "sk-parent-contract-0123456789",
    "github-token": "ghp_parent_contract_1234567890",
    "aws-key": "AKIA1234567890ABCDEF",
    "slack-token": "xoxb-parent-contract-012345",
    "jwt": "eyJabcdefghijk.eyJabcdefghijk",
    "private-key": "-----BEGIN PRIVATE KEY-----",
    "windows-user-path": "C:\\Users\\fixture-user\\data",
    /**
     * POSIX 主目录样本用**占位用户名**（`user`）：仓库级不变量
     * （`scripts/invariants.test.ts` 的本机路径判据）只放行 `me` / `x` / `user` 这类占位名，
     * 提交真实样式的用户名本身就是一条本机痕迹。规则本身照样命中（判据只看 `/home/<段>`）。
     */
    "posix-home-path": "/home/user/work",
    "base64-blob": "T".repeat(64),
  };
  assert.deepStrictEqual(
    SECRET_RULES.map((entry) => entry.rule).sort(),
    Object.keys(samples).sort(),
    "规则表与受控样本一一对应（新增规则而漏样本会在这里红）",
  );

  for (const { rule } of SECRET_RULES) {
    const value = samples[rule];
    assert.ok(findSecretHits(value).some((hit) => hit.rule === rule), `${rule}：规则自身确实命中注入`);
    // 同一份样本既当键又当值：键名与值两条路径都必须命中
    const hits = scanFixtureSecrets({ outer: { [value]: value } });
    assert.ok(hits.some((hit) => hit.rule === rule), `${rule}：嵌套键/值命中`);
    // **按解码后的 path 字符串逐条检查**，不用 `JSON.stringify(hits).includes(...)`：
    // 序列化会把 `\` 转义（`C:\Users\…` → `C:\\Users\\…`），那种写法会对含反斜杠的
    // 样本**假通过**，等于漏掉「路径回显原始键名」这个缺陷。
    for (const hit of hits) {
      assert.ok(!hit.path.includes(value), `${rule}：命中路径不得包含注入原文（解码后检查）`);
    }
  }

  // 检查方式自身的对照：证明「解码后检查」不是摆设
  const backslashSample = samples["windows-user-path"];
  const simulatedLeak = [{ path: `$.${backslashSample}` }];
  assert.ok(simulatedLeak[0].path.includes(backslashSample), "解码后的 path 能看见这种泄漏");
  assert.ok(
    !JSON.stringify(simulatedLeak).includes(backslashSample),
    "同一份泄漏在 JSON 序列化后被转义掩掉（所以不能只看 stringify）",
  );
}

// ---------- 5. 结构不变量：干净模型通过；各类破坏被逐条抓住 ----------
{
  const clean = checkFixtureInvariants(redacted, {
    fieldLimit: DEFAULT_FIELD_LIMIT,
    payloadReduced: false,
    truncatedFields: {},
  });
  assert.deepStrictEqual(clean, [], "合成真实形状的模型不变量全过");

  const codes = (model: TrajectoryModel, options = {}): string[] =>
    checkFixtureInvariants(model, {
      fieldLimit: DEFAULT_FIELD_LIMIT,
      payloadReduced: false,
      truncatedFields: {},
      ...options,
    }).map((issue) => issue.code);

  /** 与 checker 的口径一致地取「整体最早时刻」（用于确认破坏注入确实生效）。 */
  const earliestTime = (model: TrajectoryModel): number => {
    const values: number[] = [];
    const consider = (value: unknown): void => {
      if (typeof value === "number" && Number.isFinite(value)) values.push(value);
    };
    consider(model.firstStartedAt);
    for (const cell of cellsOf(model)) {
      consider(cell.time);
      consider(cell.startedAt);
      consider(cell.assistantMetrics?.stepStartTime);
      consider(cell.assistantMetrics?.firstTokenTime);
      consider(cell.assistantMetrics?.completedTime);
    }
    for (const request of model.requests) {
      consider(request.startedAt);
      consider(request.completedAt);
      consider(request.assistantFirstTokenTime);
    }
    return values.length === 0 ? Number.NaN : Math.min(...values);
  };

  const indexGap = clone();
  const flat = cellsOf(indexGap);
  flat[1].index = 99;
  assert.ok(codes(indexGap).includes("cell-index-not-continuous"), "序号不连续要报");

  const badCount = clone();
  badCount.cellCount = badCount.cellCount + 1;
  assert.ok(codes(badCount).includes("cell-count-mismatch"), "cellCount 对不上要报");

  const emptyGroup = clone();
  emptyGroup.turns[0].groups.push({ title: { kind: "message" }, cells: [] });
  assert.ok(codes(emptyGroup).includes("group-empty"), "空组要报");

  const duplicated = clone();
  const dupCells = cellsOf(duplicated);
  const toolCell = dupCells.find((cell) => cell.kind === "tool");
  const subCell = dupCells.find((cell) => cell.kind === "subtool");
  assert.ok(toolCell !== undefined && subCell !== undefined, "合成模型里有工具行与子工具行");
  if (toolCell !== undefined && subCell !== undefined) {
    subCell.callId = toolCell.callId;
    assert.ok(codes(duplicated).includes("call-id-duplicated"), "callId 重复要报");
  }

  const headMissing = clone();
  const subOnly = cellsOf(headMissing).find((cell) => cell.kind === "subtool");
  assert.ok(subOnly !== undefined);
  if (subOnly !== undefined) {
    subOnly.callId = "id_99:ptc:1";
    assert.ok(codes(headMissing).includes("identity-head-missing"), "子调用前缀头缺失要报");
  }

  const beforeAnchor = clone();
  const timed = cellsOf(beforeAnchor).find((cell) => Number.isFinite(cell.time));
  if (timed !== undefined) timed.time = TIME_ANCHOR_MS - 1000;
  assert.ok(codes(beforeAnchor).includes("time-before-anchor"), "时刻落在锚点之前要报");

  /**
   * 把「全部参与锚点核对的时刻」平移 `delta` —— 与 `checkFixtureInvariants` / `computeTimeShift`
   * 的 `consider` 口径逐项对应：cells 的 `time` / `startedAt`、`assistantMetrics` 的三个时刻、
   * requests 的 `startedAt` / `completedAt` / `assistantFirstTokenTime`、`firstStartedAt`。
   * 返回平移到的处数（供注入确认）。三处定义若漂移，下面的用例会先红。
   */
  const shiftAnchorTimes = (model: TrajectoryModel, delta: number): number => {
    let moved = 0;
    const bump = (value: number | null | undefined): number | null | undefined => {
      if (typeof value !== "number" || !Number.isFinite(value)) return value;
      moved += 1;
      return value + delta;
    };
    for (const cell of cellsOf(model)) {
      cell.time = bump(cell.time) as number;
      cell.startedAt = bump(cell.startedAt) as number | null;
      const metrics = cell.assistantMetrics;
      if (metrics !== undefined) {
        metrics.stepStartTime = bump(metrics.stepStartTime) as number | null;
        metrics.firstTokenTime = bump(metrics.firstTokenTime) as number | null;
        metrics.completedTime = bump(metrics.completedTime) as number | null;
      }
    }
    for (const request of model.requests) {
      request.startedAt = bump(request.startedAt) as number | null;
      request.completedAt = bump(request.completedAt) as number | null;
      request.assistantFirstTokenTime = bump(request.assistantFirstTokenTime) as number | null;
    }
    model.firstStartedAt = bump(model.firstStartedAt) as number | null;
    return moved;
  };

  /**
   * 整体平移破坏：**所有参与锚点核对的时刻**都要 +1000。少平移任何一处，`min` 就还停在
   * 旧锚点上，这条用例会变成「没破坏到不变量」的假绿。
   */
  const shifted = clone();
  const shiftedTimes = shiftAnchorTimes(shifted, 1000);
  // 注入确认（先确认破坏真的写进去了，再看断言）
  assert.ok(shiftedTimes >= 8, `平移注入应覆盖多个时刻，实际 ${shiftedTimes} 处`);
  assert.ok(
    earliestTime(shifted) > TIME_ANCHOR_MS,
    "读回确认：破坏注入生效（整体最早时刻已离开锚点）",
  );
  assert.ok(codes(shifted).includes("time-anchor-mismatch"), "最早时刻不在锚点上要报（相对间隔靠统一平移）");

  /**
   * 平移量必须与 checker 用**同一套时刻集合**：把整体时刻推后，再把「整体最早」只留在某个
   * `assistantMetrics.stepStartTime` 上。`computeTimeShift` 漏掉 metrics 时平移量会偏小，
   * 脱敏后这一处落到锚点之前 —— 那时本用例在 `time-before-anchor` 上红。
   */
  const metricsOnly = deriveTrajectoryModel(syntheticEvents(), false);
  const metricsMoved = shiftAnchorTimes(metricsOnly, 5000);
  assert.ok(metricsMoved >= 8, `metrics 用例的整体平移同样覆盖多个时刻，实际 ${metricsMoved} 处`);
  const metricsHost = cellsOf(metricsOnly).find((cell) => Number.isFinite(cell.time));
  assert.ok(metricsHost !== undefined, "合成模型里至少有一格可以挂 assistantMetrics");
  if (metricsHost !== undefined) {
    const onlyEarliest = earliestTime(metricsOnly) - 3000;
    metricsHost.assistantMetrics = {
      timingRecorded: true,
      stepStartTime: onlyEarliest,
      firstTokenTime: null,
      completedTime: null,
      usageProvided: false,
      outputTokens: null,
    };
    assert.strictEqual(earliestTime(metricsOnly), onlyEarliest, "注入确认：整体最早时刻确实只在 metrics 上");
    assert.strictEqual(
      computeTimeShift(metricsOnly),
      TIME_ANCHOR_MS - earliestTime(metricsOnly),
      "平移量与 checker 用同一套时刻集合（含 assistantMetrics 的三个时刻）",
    );
    const reRedacted = redactTrajectoryModel(metricsOnly, { fieldLimit: DEFAULT_FIELD_LIMIT });
    assert.deepStrictEqual(codes(reRedacted.model), [], "最早时刻只在 metrics 的模型脱敏后不变量全过");
  }

  const tooLong = clone();
  const userCell = cellsOf(tooLong).find((cell) => cell.kind === "user");
  if (userCell !== undefined) userCell.previewMarkdown = "x".repeat(DEFAULT_FIELD_LIMIT + 1);
  assert.ok(codes(tooLong).includes("string-exceeds-field-limit"), "未截断样本里出现超限字段要报");
  assert.ok(
    !codes(tooLong, { payloadReduced: true, truncatedFields: { previewMarkdown: 1 } })
      .includes("string-exceeds-field-limit"),
    "截断样本（payloadReduced）跳过长度检查",
  );
  assert.ok(
    codes(tooLong, { payloadReduced: true, truncatedFields: {} }).includes("payload-reduced-flag-mismatch"),
    "payloadReduced 与 truncatedFields 必须一致",
  );
}

// ---------- 5b. `--limit 0`（不截断）语义：唯一谓词 + 与脱敏/长度判据一致 ----------
{
  /**
   * 目标语义：`0`（以及负值）= **不截断（无上限）**，不是「上限为零」。三处必须一致：
   * 脱敏原样放行、结构不变量不做长度上限比较、登记校验走同一判据。
   *
   * 本块把断言**收集起来一起报**（而不是第一条就中断）：0 值语义是「三处一致」的问题，
   * 只看第一条缺陷会把其余分歧藏起来；红阶段需要一次看清全部不一致点。
   */
  const failures: string[] = [];
  const expect = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  /**
   * 谓词经**模块命名空间**取用（见文件头说明）：谓词还没实现时，红落在断言上而不是打包上。
   */
  const limitApplies = fixtureContract.limitApplies;
  expect(typeof limitApplies === "function", "唯一谓词 limitApplies 必须存在（零值语义只能有一个判定点）");
  expect(limitApplies?.(0) === false, "limitApplies(0) 必须是 false（0 = 不截断，不是上限为零）");
  expect(limitApplies?.(-1) === false, "limitApplies(-1) 必须是 false（负值同样没有上限）");
  expect(limitApplies?.(1) === true, "limitApplies(1) 必须是 true（只有正上限才启用长度上限比较）");

  // 注入确认：这条正文**确实**远超默认上限，否则「0 与 2000 的差别」根本看不出来
  const oversizeText = "长".repeat(DEFAULT_FIELD_LIMIT + 3000);
  assert.ok(oversizeText.length > DEFAULT_FIELD_LIMIT, "注入确认：样本正文超过默认上限");

  const zeroLimitModel = clone();
  const zeroLimitUser = cellsOf(zeroLimitModel).find((cell) => cell.kind === "user");
  assert.ok(zeroLimitUser !== undefined, "合成模型里有用户行");
  if (zeroLimitUser !== undefined) {
    zeroLimitUser.previewMarkdown = oversizeText;
    const out = redactTrajectoryModel(zeroLimitModel, { fieldLimit: 0 });
    const kept = cellsOf(out.model).find((cell) => cell.kind === "user")?.previewMarkdown ?? "";
    expect(kept.length === oversizeText.length, "fieldLimit=0：超长字符串逐字保留（长度等于源长度，不是默认 2000）");
    assert.ok(!kept.includes("长"), "注入确认：正文已被等长伪文替换（保留的是长度，不是原文）");
    expect(Object.keys(out.stats.truncated).length === 0, "fieldLimit=0：没有任何截断登记");

    const zeroIssues = checkFixtureInvariants(out.model, { fieldLimit: 0, payloadReduced: false, truncatedFields: {} });
    expect(
      zeroIssues.length === 0,
      `fieldLimit=0：没有上限就不做长度上限比较（实际报出 ${JSON.stringify(zeroIssues)}）`,
    );
    expect(
      checkFixtureInvariants(out.model, { fieldLimit: 5, payloadReduced: false, truncatedFields: {} })
        .some((issue) => issue.code === "string-exceeds-field-limit"),
      "正上限（5）小于串长时长度检查照样报：豁免只针对「无上限」，不是把检查关掉",
    );
    // 对照：同一份正文在默认正上限下**确实**会被截断（证明上面那条不是「恰好没超限」）
    const defaultOut = redactTrajectoryModel(zeroLimitModel, { fieldLimit: DEFAULT_FIELD_LIMIT });
    expect(
      (cellsOf(defaultOut.model).find((cell) => cell.kind === "user")?.previewMarkdown ?? "").length
        === DEFAULT_FIELD_LIMIT,
      "对照：默认正上限下同一份正文被截到 2000（0 与 2000 的差别是真的）",
    );
    expect(Object.keys(defaultOut.stats.truncated).length > 0, "对照：默认正上限下确实登记了截断");
  }

  assert.deepStrictEqual(
    failures,
    [],
    `--limit 0（不截断）语义不一致（${failures.length} 处）：\n  - ${failures.join("\n  - ")}`,
  );
}

// ---------- 6. 结构统计与字节口径 ----------
{
  const structure = structureOf(redacted);
  assert.strictEqual(
    structure.modelJsonBytes,
    Buffer.byteLength(JSON.stringify(redacted), "utf8"),
    "modelJsonBytes 是 UTF-8 字节数（不是 string.length）",
  );
  assert.ok(structure.modelJsonBytes > JSON.stringify(redacted).length, "含中文时字节数大于字符数");
  assert.strictEqual(structure.cells, cellsOf(redacted).length, "cells 计数与账本一致");
  assert.strictEqual(structure.seqCount, structure.cells, "seq 映射按记录数登记");
}

// ---------- 7. 路径改写（保留相对结构与扩展名） ----------
{
  assert.strictEqual(redactPathsInside(USER_PATH).includes("fixture-user"), false, "串内路径的用户名被抹掉");
  assert.ok(redactPathsInside(USER_PATH).endsWith("a.ts"), "扩展名保留（图标/语言判据靠它）");
}

// ---------- 8. 深层 JSON / jsonFallback / 真实字段契约形态 ----------
{
  /** 类型骨架（键集合 + 容器类型 + 数组长度，**不含值**）：用来钉「脱敏不改形状」。 */
  const typeShape = (value: unknown): unknown => {
    if (Array.isArray(value)) return ["array", value.length, ...value.map(typeShape)];
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = typeShape((value as Record<string, unknown>)[key]);
      }
      return ["object", out];
    }
    return value === null ? "null" : typeof value;
  };

  // 形状不变量：整份模型的键集合 / 类型 / 数组长度逐项一致（真实字段契约形态）
  assert.deepStrictEqual(
    typeShape(redacted),
    typeShape(sourceModel),
    "脱敏不得增删键、改类型或改数组长度（真实 TrajectoryCell/TrajectoryRequest 全套字段）",
  );

  // 各类枚举 / 标识位是「结构」，必须逐字保留
  const pairs = cellsOf(sourceModel).map((cell, at) => [cell, cellsOf(redacted)[at]] as const);
  for (const [before, after] of pairs) {
    assert.strictEqual(after?.kind, before.kind, "kind 保留");
    assert.strictEqual(after?.index, before.index, "index 保留");
    assert.strictEqual(after?.seq, before.seq, "seq 保留");
    assert.strictEqual(after?.turn, before.turn, "turn 保留");
    assert.strictEqual(after?.status, before.status, "status 保留");
    assert.strictEqual(after?.requestOnly, before.requestOnly, "requestOnly 保留");
    assert.strictEqual(after?.steering, before.steering, "steering 保留");
    assert.strictEqual(after?.requestNumber, before.requestNumber, "requestNumber 保留");
    // 自由文本：等长 + 换行位置逐字保留（JSON 结构化字段另算，见下）
    for (const key of ["text", "previewMarkdown", "outputDetail", "thinkingDetail", "systemPromptDetail",
      "previousSystemPromptDetail", "resultPreviewMarkdown", "error", "result"] as const) {
      const left = before[key];
      const right = after?.[key];
      if (typeof left === "string") {
        assert.strictEqual(typeof right, "string", `${key} 仍是字符串`);
        assert.strictEqual((right as string).length, left.length, `${key} 等长`);
        assert.deepStrictEqual(newlinePositions(right as string), newlinePositions(left), `${key} 换行位置保留`);
      }
    }
  }

  // 深层 JSON：结构保留（键集合 / 类型 / 数组长度），值里的秘密与路径被换掉
  const deepJson = JSON.stringify({
    type: "object",
    required: ["outer"],
    enum: ["a", "b"],
    properties: {
      outer: {
        type: "object",
        properties: {
          middle: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: `读取 ${USER_PATH}` },
                note: { type: "string", description: FREE_TEXT_SECRET },
                flag: { type: "boolean" },
                limit: { type: "number" },
                nothing: { type: "null" },
              },
            },
          },
        },
      },
    },
  }, null, 2);
  assert.ok(deepJson.length > 200, "注入确认：深层 JSON 样本足够大");
  assert.ok(findSecretHits(deepJson).length > 0, "注入确认：样本里确实有秘密形态");

  const deepModel = clone();
  const deepCell = cellsOf(deepModel).find((cell) => cell.kind === "tool");
  assert.ok(deepCell !== undefined, "合成模型里有工具行");
  if (deepCell !== undefined) {
    deepCell.schemaDetail = deepJson;
    const deepOut = redactTrajectoryModel(deepModel, { fieldLimit: DEFAULT_FIELD_LIMIT });
    const after = cellsOf(deepOut.model).find((cell) => cell.kind === "tool")?.schemaDetail;
    assert.strictEqual(typeof after, "string", "结构化字段仍是字符串（不改字段类型）");
    assert.ok(deepOut.stats.jsonParsed >= 1, "结构化字段走了 JSON 分支");
    assert.ok((after as string).includes("\n"), "结构化字段保留 JSON 排版（pretty）");
    assert.deepStrictEqual(
      typeShape(JSON.parse(after as string)),
      typeShape(JSON.parse(deepJson)),
      "深层结构保留：键集合 / 类型 / 数组长度逐项一致",
    );
    assert.ok(!(after as string).includes("fixture-user"), "深层值里的用户路径被替换");
    assert.ok(!(after as string).includes("sk-free-text-secret"), "深层值里的秘密被替换");
    assert.deepStrictEqual(scanFixtureSecrets(deepOut.model), [], "深层脱敏后整份模型扫描干净");
    // 确定性：同输入必得同输出
    const again = redactTrajectoryModel(deepModel, { fieldLimit: DEFAULT_FIELD_LIMIT });
    assert.strictEqual(
      cellsOf(again.model).find((cell) => cell.kind === "tool")?.schemaDetail,
      after,
      "结构化脱敏是确定性的",
    );
  }

  // jsonFallback：解析不了的结构化字段退回等长伪文（并计数）
  const brokenModel = clone();
  const brokenCell = cellsOf(brokenModel).find((cell) => cell.kind === "tool");
  if (brokenCell !== undefined) {
    const broken = `{"path": "${USER_PATH}", "oops": }`;
    brokenCell.inputDetail = broken;
    const out = redactTrajectoryModel(brokenModel, { fieldLimit: DEFAULT_FIELD_LIMIT });
    const value = cellsOf(out.model).find((cell) => cell.kind === "tool")?.inputDetail;
    assert.ok(out.stats.jsonFallback >= 1, "解析失败要计数（jsonFallback）");
    assert.strictEqual(typeof value, "string", "退回伪文后仍是字符串");
    assert.strictEqual((value as string).length, broken.length, "退回伪文与原串等长");
    assert.throws(() => JSON.parse(value as string), "退回伪文不再是 JSON");
    assert.ok(!(value as string).includes("fixture-user"), "退回伪文里没有原路径");
    // 低熵是「不是随机高熵串」的判据（阈值给余量：词表固定，实测约 3.5–4.2）
    const entropy = shannonEntropy(value as string);
    console.log(`[观察] jsonFallback 伪文熵=${entropy.toFixed(2)} bit/char`);
    assert.ok(entropy < 4.5, `退回伪文是低熵的（实测 ${entropy.toFixed(2)}）`);
  }

  // 超限的结构化字段：按容器登记截断（不得静默放行、也不得偷偷调大上限）
  const oversizeModel = clone();
  const oversizeCell = cellsOf(oversizeModel).find((cell) => cell.kind === "tool");
  assert.ok(oversizeCell !== undefined);
  if (oversizeCell !== undefined) {
    const bigProperties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      bigProperties[`param_${i}`] = { type: "string", description: "说明".repeat(10) };
    }
    oversizeCell.schemaDetail = JSON.stringify({ type: "object", properties: bigProperties }, null, 2);
    assert.ok(
      oversizeCell.schemaDetail.length > DEFAULT_FIELD_LIMIT,
      "注入确认：结构化字段确实超过字段上限",
    );
    const out = redactTrajectoryModel(oversizeModel, { fieldLimit: DEFAULT_FIELD_LIMIT });
    const value = cellsOf(out.model).find((cell) => cell.kind === "tool")?.schemaDetail ?? "";
    assert.strictEqual(value.length, DEFAULT_FIELD_LIMIT, "超限的结构化字段按容器截断到上限");
    assert.ok((out.stats.truncated.schemaDetail ?? 0) >= 1, "超限结构化字段必须逐字段登记截断");
    assert.deepStrictEqual(
      checkFixtureInvariants(out.model, {
        fieldLimit: DEFAULT_FIELD_LIMIT,
        payloadReduced: true,
        truncatedFields: out.stats.truncated,
      }),
      [],
      "登记截断后不变量全过（不被当成「未缩减的完整载荷」）",
    );
    // 闸门不是摆设：同一份超限内容若**不登记**截断，长度检查必须报出来
    const liar = clone();
    const liarCell = cellsOf(liar).find((cell) => cell.kind === "tool");
    assert.ok(liarCell !== undefined);
    if (liarCell !== undefined) {
      liarCell.schemaDetail = "x".repeat(DEFAULT_FIELD_LIMIT + 1);
      assert.ok(
        checkFixtureInvariants(liar, {
          fieldLimit: DEFAULT_FIELD_LIMIT,
          payloadReduced: false,
          truncatedFields: {},
        }).some((issue) => issue.code === "string-exceeds-field-limit"),
        "超限却不登记截断时，长度检查必须报出来",
      );
    }
  }

  // 深度闸门：迭代测深本身不得递归爆栈
  {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i += 1) deep = { next: deep };
    assert.strictEqual(exceedsDepth(deep), true, "5000 层必须判超限");
    assert.strictEqual(exceedsDepth({ a: { b: { c: 1 } } }), false, "浅结构不超限");
    assert.strictEqual(MAX_FIXTURE_DEPTH, 64, "深度上限是本文件声明的 64（改动要同步文档）");
  }
}

// ---------- 9. 整份 {provenance, model} 扫描：覆盖两侧 + path 匿名化 ----------
{
  const secretKey = "sk-payload-key-0123456789";
  const payload = {
    provenance: { sourceEventCounts: { [secretKey]: 1 }, modelSha256: "a".repeat(64) },
    model: { turns: [{ groups: [{ cells: [{ text: `https://fixture.invalid/?token=${secretKey}` }] }] }] },
  };
  const hits = scanFixtureSecrets(payload, { digestPaths: ["$.provenance.modelSha256"] });
  /**
   * 返回的 `path` 是**逐级匿名化**的（只留 `.<key#序号>` / `[i]` / `#key`），所以不能用
   * 「path 里有没有 `provenance`」判断覆盖面。改成分别扫两侧：两侧都必须命中，
   * 且整份扫出来的条数不少于两侧之和（证明整份扫描确实走到了两棵子树）。
   */
  const provenanceHits = scanFixtureSecrets(payload.provenance);
  const modelHits = scanFixtureSecrets(payload.model);
  assert.ok(provenanceHits.length > 0, "扫描必须覆盖 provenance 部分（含 metadata 的键）");
  assert.ok(modelHits.length > 0, "扫描必须覆盖 model 部分");
  // 整份扫出来的条数必须**多于**任一侧单独扫的结果 —— 说明整份扫描确实走到了两棵子树
  //（整份扫描带摘要白名单，`provenance.modelSha256` 那个裸摘要会被豁免，所以不按「两侧之和」比）
  assert.ok(
    hits.length > provenanceHits.length && hits.length > modelHits.length,
    `整份扫描必须覆盖两棵树（整份 ${hits.length}，provenance ${provenanceHits.length}，model ${modelHits.length}）`,
  );
  for (const hit of [...hits, ...provenanceHits, ...modelHits]) {
    assert.ok(!hit.path.includes(secretKey), "命中路径不得回显秘密键原文");
    assert.ok(!hit.path.includes("token="), "命中路径不得回显秘密值原文");
    assert.ok(hit.path.startsWith("$"), `命中路径必须是匿名化路径：${hit.path}`);
  }
  // 键名回显的**定向**检查：用一个带可识别片段的秘密键，路径里绝不能出现那个片段
  const marker = "ZZMarkerHiddenZZ";
  const markerHits = scanFixtureSecrets({ outer: { [`sk-${marker}-0123456789`]: 1 } });
  assert.ok(markerHits.length > 0, "注入确认：带标记的秘密键确实命中");
  for (const hit of markerHits) {
    assert.ok(!hit.path.includes(marker), "命中路径不得回显原始键名的任何片段");
  }
  // 嵌套同名字段不得被白名单豁免（白名单只认精确位置）
  assert.ok(
    scanFixtureSecrets({ provenance: { modelSha256: "b".repeat(64), nested: { modelSha256: "c".repeat(64) } } }, {
      digestPaths: ["$.provenance.modelSha256"],
    }).length > 0,
    "同名字段出现在别的层级照旧命中",
  );
  // 带点号 / 下标 / 反斜杠的键名都不能把自己拼成白名单路径
  for (const forged of ["provenance.modelSha256", "provenance[0].modelSha256", "provenance\\.modelSha256"]) {
    assert.ok(
      scanFixtureSecrets({ [forged]: "d".repeat(64) }, { digestPaths: ["$.provenance.modelSha256"] }).length > 0,
      `键名 ${forged.length} 字符不得伪造白名单位置`,
    );
  }
}

// ---------- 10. 完整 provenance 校验：肯定证据 + 自洽重算 + 「自洽 ≠ 来源真实」 ----------
{
  const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
  const whitelist = [
    "$.provenance.sourceSha256",
    "$.provenance.extractor.sha256",
    "$.provenance.derive.sha256",
    "$.provenance.modelSha256",
  ];
  /** 按 CLI 的真实登记形状拼一份载荷（成员集合必须与 PROVENANCE_MEMBERS 一致）。 */
  const buildPayload = (model: TrajectoryModel, name = "unit"): { provenance: Record<string, unknown>; model: TrajectoryModel } => {
    const structure = structureOf(model);
    const stats = newRedactionStats();
    const payloadReduced = Object.keys(stats.truncated).length > 0;
    return {
      provenance: {
        fixture: name,
        sourceSha256: "1".repeat(64),
        sourceFormat: "v4",
        sourceEventCounts: { "turn/start": 1 },
        sourceBytes: 1234,
        redaction: {
          version: FIXTURE_REDACTION_VERSION,
          rules: ["text: 等长低熵伪文"],
          stats,
          timeShiftMs: 0,
          fieldLimit: DEFAULT_FIELD_LIMIT,
        },
        extractor: { file: "scripts/trajectoryFixtureBuild.ts", sha256: "2".repeat(64) },
        derive: { file: "src/dsh/trajectory.ts", sha256: "3".repeat(64) },
        structure,
        capabilities: capabilitiesOf(model),
        seqMapping: { retainedIn: "cell.seq", count: structure.seqCount, range: structure.seqRange },
        modelSha256: sha256Hex(canonicalJson(model)),
        truncatedFields: stats.truncated,
        payloadReduced,
        payloadMeasurementEligible: !payloadReduced,
        invariants: { checks: [...FIXTURE_INVARIANT_CODES], issues: [] },
        generatedBy: "unit-test",
      },
      model,
    };
  };
  const validate = (payload: unknown): string[] =>
    validateFixturePayload(payload, {
      sha256Hex,
      digestPaths: whitelist,
      expectedChecks: FIXTURE_INVARIANT_CODES,
      expectedFixtureName: "unit",
    }).map((issue) => issue.code);

  const base = buildPayload(redacted);
  assert.deepStrictEqual(validate(base), [], "自洽载荷必须零问题");

  /**
   * `--limit 0`（不截断）在**登记校验**这一环同样合法：`redaction.fieldLimit === 0` 是允许的值，
   * 且校验时**不做长度上限比较**。否则「0 = 不截断」的夹具会被自己的读回校验判成
   * `invariants-model-mismatch` —— 那正是 CLI 写盘后读回校验走的那条路。
   */
  const zeroLimitPayload = structuredClone(base);
  (zeroLimitPayload.provenance.redaction as { fieldLimit: number }).fieldLimit = 0;
  assert.deepStrictEqual(
    validate(zeroLimitPayload),
    [],
    "fieldLimit=0 + 未截断模型 + payloadReduced=false + truncatedFields={} 必须零问题",
  );
  const tinyLimitPayload = structuredClone(base);
  (tinyLimitPayload.provenance.redaction as { fieldLimit: number }).fieldLimit = 5;
  assert.ok(
    validate(tinyLimitPayload).includes("invariants-model-mismatch"),
    "正上限（5）下同一份未截断模型必须被判超限：豁免不是把长度检查关掉",
  );

  const tamperModel = structuredClone(base);
  cellsOf(tamperModel.model)[0].text = "被改过的正文";
  assert.ok(validate(tamperModel).includes("model-sha256-mismatch"), "模型被改 → 哈希不符");

  const tamperStructure = structuredClone(base);
  (tamperStructure.provenance.structure as { cells: number }).cells += 1;
  assert.ok(validate(tamperStructure).includes("structure-mismatch"), "structure 被改 → 重算不符");

  const tamperCapabilities = structuredClone(base);
  const capabilitiesBefore = (tamperCapabilities.provenance.capabilities as { exceedsVirtualizationThreshold: boolean })
    .exceedsVirtualizationThreshold;
  assert.strictEqual(capabilitiesBefore, false, "注入确认：这个小模型的虚拟化阈值位本来是 false");
  (tamperCapabilities.provenance.capabilities as { exceedsVirtualizationThreshold: boolean })
    .exceedsVirtualizationThreshold = true;
  assert.ok(validate(tamperCapabilities).includes("capabilities-mismatch"), "capabilities 被改 → 重算不符");

  const tamperSeq = structuredClone(base);
  (tamperSeq.provenance.seqMapping as { count: number }).count += 1;
  assert.ok(validate(tamperSeq).includes("seq-mapping-mismatch"), "seq 映射被改 → 重算不符");

  const tamperReduce = structuredClone(base);
  tamperReduce.provenance.truncatedFields = { text: 1 };
  assert.ok(validate(tamperReduce).includes("payload-reduced-flag-mismatch"), "截断登记与闸门必须一致");

  const tamperEligible = structuredClone(base);
  tamperEligible.provenance.payloadMeasurementEligible = false;
  assert.ok(validate(tamperEligible).includes("payload-eligibility-mismatch"), "载荷资格必须与缩减标记互反");

  const tamperMissing = structuredClone(base);
  delete (tamperMissing.provenance.redaction as Record<string, unknown>).fieldLimit;
  assert.ok(
    validate(tamperMissing).some((code) => code.startsWith("provenance.missing:")),
    "缺成员必须报成员级问题",
  );

  const tamperUnknown = structuredClone(base);
  (tamperUnknown.provenance as Record<string, unknown>).extraMember = 1;
  assert.ok(
    validate(tamperUnknown).some((code) => code.startsWith("provenance.unknown:")),
    "未知成员必须报成员级问题",
  );

  const tamperFile = structuredClone(base);
  (tamperFile.provenance.extractor as { file: string }).file = "C:\\abs\\extractor.ts";
  assert.ok(validate(tamperFile).includes("provenance.invalid:extractor.file"), "绝对路径的声明源不合法");

  const tamperDigest = structuredClone(base);
  tamperDigest.provenance.modelSha256 = "not-a-digest";
  assert.ok(validate(tamperDigest).includes("provenance.invalid:modelSha256"), "非法摘要不合法");

  const tamperSecret = structuredClone(base);
  (tamperSecret.provenance.redaction as { rules: string[] }).rules.push("sk-unit-secret-0123456789");
  assert.ok(validate(tamperSecret).includes("secret-scan-hit"), "整份扫描必须覆盖 provenance");

  const tamperChecks = structuredClone(base);
  (tamperChecks.provenance.invariants as { checks: string[] }).checks = [];
  assert.ok(validate(tamperChecks).includes("invariant-checks-incomplete"), "不变量清单必须齐全");

  const tamperIssues = structuredClone(base);
  (tamperIssues.provenance.invariants as { issues: unknown[] }).issues = [{ code: "x", count: 1 }];
  assert.ok(validate(tamperIssues).includes("invariants-issues-not-empty"), "不变量问题必须为空");

  const tamperInvariant = structuredClone(base);
  cellsOf(tamperInvariant.model)[1].index = 99;
  assert.ok(validate(tamperInvariant).includes("invariants-model-mismatch"), "模型本身违反不变量也要报");

  /**
   * **边界（必须显式）：自洽 ≠ 来源真实。** 把三份「来源锚点」摘要换成任意 64 位串，
   * 验证器**照样通过** —— 它证明不了这份夹具真来自那份日志 / 那份源码。要证来源只能去读
   * 那份源（需单独批准）；这条断言就是防止把登记自洽当成来源真实性。
   */
  const forgedSource = structuredClone(base);
  forgedSource.provenance.sourceSha256 = "a".repeat(64);
  (forgedSource.provenance.extractor as { sha256: string }).sha256 = "b".repeat(64);
  (forgedSource.provenance.derive as { sha256: string }).sha256 = "c".repeat(64);
  assert.deepStrictEqual(
    validate(forgedSource),
    [],
    "伪造来源摘要仍通过：自洽校验不是来源真实性证明（本行即边界声明）",
  );
  assert.notStrictEqual(forgedSource.provenance.sourceSha256, base.provenance.sourceSha256, "注入确认：摘要确实被换过");

  /**
   * **规则版本的口径**（三条合起来才是诚实的说法）：
   *
   * 1. 生成器盖的是当前常量（`buildPayload` 用的就是它）；
   * 2. 验证器对 `version` 只做「正整数」这一条**形状**检查 —— 旧版本号照样通过，
   *    所以「验证器收得下 v2」**不是**兼容保证，也不能拿来宣称当前规则向后兼容；
   * 3. 版本号本身不携带任何闸门语义：同号载荷只要截断登记与闸门不一致，照样报错。
   *
   * 真正的版本判别来自「生成器盖章 + 规则实现」，不来自校验器的接受范围。
   */
  assert.strictEqual(
    FIXTURE_REDACTION_VERSION,
    3,
    "当前规则版本是 3：JSON 深脱敏 + 容器截断 + 深度闸门是**上一轮落地**的规则，本批补登记版本号",
  );
  assert.strictEqual(
    (base.provenance.redaction as { version: number }).version,
    FIXTURE_REDACTION_VERSION,
    "生成器盖章 = 当前常量",
  );

  const asV2 = structuredClone(base);
  (asV2.provenance.redaction as { version: number }).version = 2;
  assert.deepStrictEqual(
    validate(asV2),
    [],
    "v2 载荷照样通过结构校验：验证器的能力只是「正整数」，不是「认识 v2」",
  );

  const asZero = structuredClone(base);
  (asZero.provenance.redaction as { version: number }).version = 0;
  assert.ok(
    validate(asZero).includes("provenance.invalid:redaction.version"),
    "0 不是合法正整数版本：形状检查确实存在，但它与版本语义兼容是两件事",
  );

  const sameVersionBadGate = structuredClone(base);
  sameVersionBadGate.provenance.truncatedFields = { text: 1 };
  assert.strictEqual(
    (sameVersionBadGate.provenance.redaction as { version: number }).version,
    FIXTURE_REDACTION_VERSION,
    "注入确认：这份载荷盖的仍是当前版本号",
  );
  assert.ok(
    validate(sameVersionBadGate).includes("payload-reduced-flag-mismatch"),
    "版本号不掩盖闸门不一致：同号载荷该报的照样报",
  );
}

// ---------- 11. 原型键安全：`__proto__` / `constructor` 不得改原型或丢键 ----------
{
  const model = clone();
  const cell = cellsOf(model)[0];
  // JSON.parse 会建**自有**属性；赋值写法才会改原型 —— 这里模拟最坏输入
  const nasty = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"safe":"x"}') as Record<string, unknown>;
  cell.messageSource = { kind: "user", raw: nasty };

  const out = redactTrajectoryModel(model, { fieldLimit: DEFAULT_FIELD_LIMIT });
  const raw = cellsOf(out.model)[0].messageSource?.raw as Record<string, unknown>;
  assert.ok(Object.hasOwn(raw, "__proto__"), "`__proto__` 必须作为**自有**键活下来");
  assert.ok(Object.hasOwn(raw, "constructor"), "`constructor` 必须作为自有键活下来");
  assert.strictEqual(Object.getPrototypeOf(raw), Object.prototype, "重建对象不得改原型");
  assert.strictEqual(({} as { polluted?: unknown }).polluted, undefined, "不得发生原型污染");
  assert.strictEqual(typeof raw.constructor, "number", "`constructor` 是自有数据（不是继承来的函数）");
  assert.notStrictEqual(raw.constructor, Object, "`constructor` 不得退化成继承成员");

  // canonicalJson 同样保留自有键（哈希口径里不能丢键）
  const canonical = canonicalJson(nasty);
  assert.ok(canonical.includes("__proto__") && canonical.includes("constructor"), "规范化 JSON 保留原型名键");
  // 扫描器读到的是自有键（键名命中与值命中都不回显）
  const hits = scanFixtureSecrets({ ["__proto__"]: "x", constructor: "y" });
  assert.deepStrictEqual(hits, [], "非秘密的原型名键不误报");
  assert.ok(scanFixtureSecrets({ ["__proto__"]: "sk-unit-proto-0123456789" }).length > 0, "原型名键的**值**照旧被扫");
}

// ---------- 12. helper 零 Node 依赖：静态闸门（导入说明符清单必须只有那一条类型导入） ----------
{
  /**
   * helper 要被**非 Node** 调用方（预览/界面侧）复用，所以本体不得有任何运行时依赖：
   * 哈希等 Node 能力由调用方经 `ValidateFixtureOptions.sha256Hex` 注入。
   * 这里用**静态**判据（抽导入说明符），而不是「跑一遍没报错」——后者在 Node 里恒为真。
   */
  const source = readFileSync("scripts/trajectoryFixture.ts", "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s+[^;]*?from\s*["']([^"']+)["']/gm)].map((match) => match[1]);
  assert.deepStrictEqual(specifiers, ["../src/shared/trajectory"], "helper 只允许一条导入（类型导入）");
  assert.ok(/^\s*import\s+type\b/m.test(source), "那一条导入必须是 `import type`（擦除后无运行时依赖）");
  assert.ok(!/\brequire\s*\(/.test(source), "helper 不得出现 require()");
  assert.ok(
    !specifiers.some((specifier) => specifier.startsWith("node:")),
    "helper 不得导入任何 node: 内置模块",
  );
}

// ---------- 13. 未知成员不回显原始键名 + 深度安全失败（成员级固定码） ----------
{
  /**
   * 与主代理独立验收同口径的两组预期：
   *
   * 1. **8 个成员位置**各注入一个受控的**秘密形态**未知键：未知成员照旧要报
   *    （码前缀 `provenance.unknown:`），但返回值里**不得出现**那个键或它的任何片段
   *    —— 调用方（CLI 失败出口 / 读回校验）会把这些码打到 stderr 与 CI 日志；
   * 2. **超深载荷**：迭代测深先判，返回成员级固定码（`provenance.` 前缀且含 `depth`），
   *    **不抛异常**（递归实现会抛 `RangeError`，异常原文可能带路径与内容）。
   *
   * 受控样本是**合成**的，不是真实凭据。
   */
  const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
  const validate = (payload: unknown): { code: string; count: number }[] =>
    validateFixturePayload(payload, { sha256Hex });
  /** 收集全部不一致点（8 个成员位置 + 深度），一次看全。 */
  const failures: string[] = [];
  const secretKey = "sk-controlled-validation-key-0123456789";
  const emptyModel = { turns: [], requests: [] };
  const locations: [string, Record<string, unknown>][] = [
    ["provenance", { [secretKey]: "ordinary" }],
    ["redaction", { redaction: { [secretKey]: "ordinary" } }],
    ["redaction-stats", { redaction: { stats: { [secretKey]: "ordinary" } } }],
    ["extractor", { extractor: { [secretKey]: "ordinary" } }],
    ["derive", { derive: { [secretKey]: "ordinary" } }],
    ["structure", { structure: { [secretKey]: "ordinary" } }],
    ["seq-mapping", { seqMapping: { [secretKey]: "ordinary" } }],
    ["invariants", { invariants: { [secretKey]: "ordinary" } }],
  ];
  for (const [name, provenance] of locations) {
    const input = { provenance, model: emptyModel };
    // 注入确认：受控秘密键确实在载荷里（否则下面的「没回显」可能只是没注入）
    assert.ok(JSON.stringify(input).includes(secretKey), `${name}：注入确认（受控键在载荷里）`);
    const issues = validate(input);
    /**
     * 把两个判据**收集起来一起报**：只看第一条会把其余位置的缺陷藏起来，
     * 而这一组要证明的正是「每个成员位置都不回显」。
     */
    if (!issues.some((issue) => issue.code.startsWith("provenance.unknown:"))) {
      failures.push(`${name}：未知成员没有被报出来`);
    }
    const report = JSON.stringify(issues);
    if (report.includes(secretKey) || report.includes("controlled-validation-key")) {
      failures.push(`${name}：问题码或定位回显了原始键名`);
    }
  }

  let branch: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 5000; index += 1) branch = { child: branch };
  const deepInput = { provenance: {}, model: emptyModel, controlledDeep: branch };
  assert.strictEqual(exceedsDepth(deepInput), true, "注入确认：受控输入确实超过深度闸门");
  let deepIssues: { code: string; count: number }[] = [];
  try {
    deepIssues = validate(deepInput);
  } catch (error) {
    failures.push(`超深载荷抛了异常（${error instanceof Error ? error.name : "unknown"}），必须固定安全失败`);
  }
  if (!deepIssues.some((issue) => issue.code.startsWith("provenance.") && issue.code.includes("depth"))) {
    failures.push("超深载荷没有给出成员级固定失败码（`provenance.` 前缀 + 固定 depth 标识）");
  }

  assert.deepStrictEqual(
    failures,
    [],
    `未知成员/深度的安全预期不一致（${failures.length} 处）：\n  - ${failures.join("\n  - ")}`,
  );
}

console.log("trajectoryFixture: 纯函数与结构不变量断言全部通过");
