/**
 * DSH 契约快照与差异分析的纯逻辑断言。
 *
 * 这一套护的是「追踪官方更新」这条路本身：版本/渠道判读错了，就会漏核对版本；
 * 差异分级错了，就会把破坏性变更报成「无影响」——两种情况都只在官方发新版时才暴露，
 * 而那时已经晚了。所以这里对**分级规则**逐条钉死。
 *
 * 夹具来自官方 npm 产物原文（`lib/typert.host.js` / `lib/**\/*.d.ts`），不是编的形状：
 * 抽取正则一旦与生成器产出的缩进/顺序脱节，这里先红，而不是等到对官方版本做差时才发现
 * 「两边都抽不到东西 → 差异为空 → 报无影响」。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  compareDshVersions,
  diffSnapshots,
  extractTypeContract,
  extractTypertContract,
  parseDshVersion,
  renderReport,
  SNAPSHOT_FORMAT_VERSION,
  summarize,
  versionFromTag,
  type ConsumptionSurface,
  type ContractSnapshot,
} from "./dshContract";

// ---------- 1. 版本与渠道：官方只有 latest / next / alpha / canary 四档 ----------

{
  assert.deepStrictEqual(
    parseDshVersion("0.1.5-rc.3"),
    { major: 0, minor: 1, patch: 5, prerelease: "rc.3", channel: "rc" },
    "rc 预发布段要解出渠道",
  );
  assert.strictEqual(parseDshVersion("0.1.7-alpha.2")?.channel, "alpha", "alpha 渠道");
  assert.strictEqual(parseDshVersion("0.2.0-canary.1")?.channel, "canary", "canary 渠道");
  assert.strictEqual(parseDshVersion("0.2.0")?.channel, "stable", "无预发布段即正式版");
  assert.strictEqual(parseDshVersion("0.2.0")?.prerelease, undefined, "正式版没有预发布段");
  // 官方发布脚本里没有 beta 档（beta 会落进 npm 的 next），这里单列是为了不误判成 rc
  assert.strictEqual(parseDshVersion("0.2.0-beta.1")?.channel, "beta", "beta 单列，不并进 rc");
  assert.strictEqual(parseDshVersion("0.2.0-nightly.7")?.channel, "other", "认不出的渠道归 other，不猜");
  assert.strictEqual(parseDshVersion("v0.2.0"), undefined, "带前缀的串不是合法 semver");
  assert.strictEqual(parseDshVersion("0.2"), undefined, "缺段不是合法 semver");
}
console.log("dshContract: 版本解析与渠道判读（含「无 beta 档」） ✓");

{
  assert.ok(compareDshVersions("0.1.5-rc.3", "0.1.7-alpha.2") < 0, "0.1.5 早于 0.1.7，与预发布段无关");
  assert.ok(compareDshVersions("0.1.7-alpha.1", "0.1.7-alpha.2") < 0, "同号预发布按序号");
  assert.ok(compareDshVersions("0.1.7-alpha.2", "0.1.7-rc.1") < 0, "alpha 早于 rc");
  assert.ok(compareDshVersions("0.1.7-rc.1", "0.1.7") < 0, "rc 早于同号正式版");
  assert.ok(compareDshVersions("0.1.7-rc.2", "0.1.7-rc.10") < 0, "rc.2 早于 rc.10（按数字比，不按字典序）");
  assert.strictEqual(compareDshVersions("0.1.6", "0.1.6"), 0, "同版本相等");
}
console.log("dshContract: semver 优先级（git 的 version sort 会把 rc 排在正式版之前，不用它） ✓");

{
  assert.strictEqual(versionFromTag("dsh-v0.1.7-alpha.2"), "0.1.7-alpha.2", "官方 tag 前缀是 dsh-v");
  assert.strictEqual(versionFromTag("vendor-cordis-v4.0.0-rc.7"), undefined, "vendor 家族的 tag 不是 dsh 版本");
  assert.strictEqual(versionFromTag("dsh-v0.1"), undefined, "缺段的 tag 认不出");
}
console.log("dshContract: tag → 版本（只认 dsh-v 家族） ✓");

// ---------- 2. 描述符抽取：端点的线上字段名就是我们必须发的东西 ----------

/** 官方 `@deepseek-ai/dsh-api-session-controller@0.1.5-rc.3` 的 `lib/typert.host.js` 原文片段。 */
const TYPERT_FIXTURE = `
export const TYPERT = {
  package: '@deepseek-ai/dsh-api-session-controller',
  face: 'host',
  schemas: [
  ],
  invocations: [
    {
      id: '@deepseek-ai/dsh-api-session-controller#fileReferences/list',
      service: 'sessionFileReferences',
      namespace: 'fileReferences',
      method: 'list',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            schema: _a$schema,
          },
        },
        {
          name: 'query',
          wire: 'query',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-api-session-controller#fileReferences/list:query',
            schema: _b$schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-api-session-controller#fileReferences/list:result',
      },
    },
    {
      id: '@deepseek-ai/dsh-api-session-controller#session/list',
      service: 'sessions',
      namespace: 'session',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: '_request',
          wire: '_request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-api-session-controller#session/list:_request',
            schema: _c$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-api-session-controller#session/list:result',
      },
    },
  ],
  declaredEvents: [
      {
        "description": "One Agent changed running state.",
        "summary": "One Agent changed running state.",
        "tags": [
          {
            "name": "mode",
            "comment": "emit",
            "text": "@mode emit"
          }
        ],
        "jsDoc": "/** @mode emit */",
        "name": "api-session/status",
        "mode": "emit"
      }
    ],
    "objects": []
  },
}
`;

{
  const contract = extractTypertContract(TYPERT_FIXTURE);
  assert.deepStrictEqual(Object.keys(contract.endpoints).sort(), ["fileReferences/list", "session/list"], "两个端点都要抽到");
  assert.deepStrictEqual(
    contract.endpoints["fileReferences/list"],
    {
      scope: "agentId",
      params: ["agentId", "query"],
      types: [
        "@deepseek-ai/dsh-session/types#SessionId",
        "@deepseek-ai/dsh-api-session-controller#fileReferences/list:query",
        "@deepseek-ai/dsh-api-session-controller#fileReferences/list:result",
      ],
    },
    "scope 的 wire、参数 wire（按描述符顺序）、typeSymbol 三样都要抽出来",
  );
  // `session/list` 的参数名带下划线（`_request`）——这是历史上真实踩过的坑，别在抽取时被「规范化」掉
  assert.deepStrictEqual(contract.endpoints["session/list"]?.params, ["_request"], "参数名逐字保留，包括下划线");
  assert.strictEqual(contract.endpoints["session/list"]?.scope, null, "没有 scope 的端点给 null，不给空串");
  assert.deepStrictEqual(contract.events, ["api-session/status"], "emit 事件名要抽到（tags 里的 name/mode 不是事件，不能误收）");
}
console.log("dshContract: 描述符抽取（端点 / 参数 wire / scope / typeSymbol / emit 事件） ✓");

// ---------- 3. 类型面抽取：内层字段改名也要能看出来 ----------

const DTS_FIXTURE = `
export interface SessionSummary {
    readonly sessionId: SessionId;
    readonly updatedAt: number;
    readonly projections?: SessionProjectionHints;
}
export type SessionAddress = {
    readonly kind: 'session';
    readonly sessionId: SessionId;
} | {
    readonly kind: 'subagent';
    readonly parentSessionId: SessionId;
};
export interface ModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
`;

{
  const types = extractTypeContract([{ path: "lib/types/types.d.ts", text: DTS_FIXTURE }]);
  assert.deepStrictEqual(Object.keys(types).sort(), ["ModelSelection", "SessionAddress", "SessionSummary"], "导出的 interface 与 type 都要收");
  assert.deepStrictEqual(
    types["SessionSummary"],
    ["readonly sessionId: SessionId;", "readonly updatedAt: number;", "readonly projections?: SessionProjectionHints;"],
    "interface 成员逐条归一化",
  );
  assert.strictEqual(types["SessionAddress"]?.length, 1, "联合类型作为一条右值（内含两个分支）");
  assert.ok(types["SessionAddress"]?.[0]?.includes("'subagent'"), "联合类型的分支内容要保留，分支改名才看得出来");

  // 内层字段改名：外层成员头不变，只有嵌套内容变——归一化必须吃到嵌套
  const renamed = extractTypeContract([
    { path: "lib/types/types.d.ts", text: DTS_FIXTURE.replace("readonly provider: string;", "readonly vendor: string;") },
  ]);
  assert.notDeepStrictEqual(renamed["ModelSelection"], types["ModelSelection"], "嵌套字段改名要让类型文本变");

  // 只改 JSDoc 不该改变类型文本：官方顺手补文档是常事，把注释算进成员文本就会天天报「破坏性变更」
  // （实测 0.1.5-rc.3 → 0.1.6-alpha.1 的三个 P0 里有两个是注释或纯新增带来的假阳性）
  const commented = extractTypeContract([
    {
      path: "lib/types/types.d.ts",
      text: "/** 类型说明 */\nexport interface ModelSelection {\n    /** 成员说明 */\n    readonly provider: string; // 行尾说明\n}\n",
    },
  ]);
  const bare = extractTypeContract([{ path: "lib/types/types.d.ts", text: "export interface ModelSelection {\n    readonly provider: string;\n}\n" }]);
  assert.deepStrictEqual(commented, bare, "注释不进类型文本（否则改文档会被报成形状变化）");
}
console.log("dshContract: 类型面抽取（interface 成员 / 联合分支 / 嵌套结构 / 注释剥离） ✓");

// ---------- 4. 差异分级：消费面上的变化才是 P0 ----------

function snapshot(version: string, packages: ContractSnapshot["packages"], missing: string[] = []): ContractSnapshot {
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, version, generatedAt: "2026-09-24T00:00:00.000Z", packages, missing };
}

const CONSUMED: ConsumptionSurface = {
  endpoints: new Set(["session/list", "session/prompt"]),
  events: new Set(["tool/result", "turn/end"]),
  types: new Set(["SessionSummary", "ModelSelection"]),
};

{
  const base = snapshot("0.1.5-rc.3", {
    "@deepseek-ai/dsh-api-session-controller": {
      endpoints: {
        "session/list": { scope: null, params: ["_request"], types: ["#session/list:result"] },
        "session/prompt": { scope: null, params: ["request"], types: [] },
      },
      events: ["tool/result", "turn/end", "llm/retry"],
      types: {
        // 成员改名（等于「消失 + 新增」）——我们消费它，是破坏
        SessionSummary: ["readonly sessionId: SessionId;"],
        // 只新增一个成员——读的一方不受影响
        ModelSelection: ["readonly provider: string;"],
        // 我们没碰的类型
        Retired: ["readonly a: string;"],
      },
    },
  });
  const next = snapshot("0.1.7-alpha.2", {
    "@deepseek-ai/dsh-api-session-controller": {
      endpoints: {
        // 参数改名 = 历史上真实发生的破坏（commands/execute 的 images → submittedAttachments）
        "session/list": { scope: null, params: ["_request"], types: ["#session/list:result"] },
        "session/prompt": { scope: null, params: ["request", "extra"], types: [] },
        "session/brandNew": { scope: "agentId", params: [], types: [] },
      },
      events: ["tool/result", "turn/end", "subagent/catalog"],
      types: {
        SessionSummary: ["readonly sessionID: SessionId;"],
        ModelSelection: ["readonly provider: string;", "readonly reasoningEffort?: string;"],
        Retired: ["readonly a: string;"],
      },
    },
  });

  const changes = diffSnapshots(base, next, CONSUMED);
  const find = (kind: string, name: string) => changes.find((change) => change.kind === kind && change.name === name);

  // 我们调用的端点参数变了 → P0；顺带确认「消费面上的形状变化」确实是 P0 而不是 P1
  assert.strictEqual(find("endpoint-params", "session/prompt")?.level, "P0", "我们调用的端点参数变了就是破坏");
  // 我们消费的类型**成员消失/改名** → P0
  assert.strictEqual(find("type-members", "SessionSummary")?.level, "P0", "我们消费的类型成员没了就是破坏");
  assert.ok(find("type-members", "SessionSummary")?.detail.includes("−"), "破坏性条目要列出被去掉的成员");
  // 我们消费的类型**只新增成员** → P1：读的一方不受影响，但若这是我们构造的请求类型就要确认新字段是否必填
  assert.strictEqual(find("type-members-added", "ModelSelection")?.level, "P1", "只新增成员不是破坏");
  // 没变的类型不该产生条目
  assert.strictEqual(find("type-members", "Retired"), undefined, "没变的类型不该产生条目");
  assert.strictEqual(find("type-members-added", "Retired"), undefined, "没变的类型不该产生条目");
  // 没消费的事件消失 → P2；新增事件 / 新增端点 → P1
  assert.strictEqual(find("event-removed", "llm/retry")?.level, "P2", "没消费的事件消失只是 P2");
  assert.strictEqual(find("event-added", "subagent/catalog")?.level, "P1", "新增事件是 P1（不崩，是否跟进是产品决策）");
  assert.strictEqual(find("endpoint-added", "session/brandNew")?.level, "P1", "新增端点是 P1");
  assert.strictEqual(find("event-removed", "tool/result"), undefined, "tool/result 仍在，不该报消失");
  // 端点没变就不该有条目（否则报告全是噪声，P0 会被淹掉）
  assert.strictEqual(find("endpoint-params", "session/list"), undefined, "没变的端点不该有条目");

  assert.ok(summarize(changes).startsWith("需兼容更新"), "有 P0 时结论必须是「需兼容更新」");
}
console.log("dshContract: 差异分级（消费面「消失/改名」= P0，「新增」= P1，其余 = P2） ✓");

{
  // 未消费的端点/事件消失：只是 P2——「无影响」的判据必须真的只由消费面决定
  const base = snapshot("a", {
    pkg: {
      endpoints: { "unused/gone": { scope: null, params: [], types: [] } },
      events: ["unused/gone"],
      types: { UnusedType: ["readonly a: string;"] },
    },
  });
  const next = snapshot("b", { pkg: { endpoints: {}, events: [], types: {} } });
  const changes = diffSnapshots(base, next, CONSUMED);
  assert.deepStrictEqual(
    changes.map((change) => `${change.kind}:${change.level}`).sort(),
    ["endpoint-removed:P2", "event-removed:P2", "type-removed:P2"],
    "不在消费面上的消失一律 P2",
  );
  assert.ok(summarize(changes).startsWith("无影响"), "只有 P2 时结论是「无影响」");
}
console.log("dshContract: 「无影响」只由消费面决定（未消费的东西消失不驱动更新） ✓");

{
  // 整包消失：里面有我们在用的端点就是 P0，否则 P2
  const base = snapshot("a", {
    used: { endpoints: { "session/list": { scope: null, params: [], types: [] } }, events: [], types: {} },
    other: { endpoints: { "x/y": { scope: null, params: [], types: [] } }, events: [], types: {} },
  });
  const next = snapshot("b", {});
  const changes = diffSnapshots(base, next, CONSUMED);
  assert.strictEqual(changes.find((change) => change.package === "used")?.level, "P0", "用到的包整包消失 = 破坏");
  assert.strictEqual(changes.find((change) => change.package === "other")?.level, "P2", "没用到包消失 = 无关");
}
console.log("dshContract: 整包消失按「里面有没有我们在用的东西」分级 ✓");

{
  // 我们消费的事件消失 = P0：`api-session/status` 中继那条链整个挂在它上面
  const changes = diffSnapshots(
    snapshot("a", { pkg: { endpoints: {}, events: ["tool/result", "turn/end"], types: {} } }),
    snapshot("b", { pkg: { endpoints: {}, events: ["turn/end"], types: {} } }),
    CONSUMED,
  );
  assert.strictEqual(changes.find((change) => change.kind === "event-removed")?.level, "P0", "我们消费的事件消失就是破坏");
}
console.log("dshContract: 消费的事件消失 = P0 ✓");

{
  // 快照自身要能对比：没变化的两个快照必须给出空差异（否则报告永远有噪声）
  const same = snapshot("a", { pkg: { endpoints: { "session/list": { scope: null, params: ["_request"], types: [] } }, events: ["turn/end"], types: { T: ["readonly a: string;"] } } });
  assert.deepStrictEqual(diffSnapshots(same, same, CONSUMED), [], "同版本求差必须为空");
}
console.log("dshContract: 同快照求差为空（差异即真变化） ✓");

// ---------- 5. 报告：P0 在最先，且带上可复核的落点 ----------

{
  const changes = diffSnapshots(
    snapshot("0.1.5-rc.3", { pkg: { endpoints: { "session/list": { scope: null, params: ["_request"], types: [] } }, events: [], types: {} } }),
    snapshot("0.1.7-alpha.2", { pkg: { endpoints: { "session/list": { scope: null, params: ["request"], types: [] } }, events: [], types: {} } }),
    CONSUMED,
  );
  const report = renderReport("0.1.5-rc.3", "0.1.7-alpha.2", changes);
  assert.ok(report.includes("0.1.5-rc.3 → 0.1.7-alpha.2"), "报告标题带两端版本");
  assert.ok(report.indexOf("## P0") < report.indexOf("## P1"), "P0 必须排在 P1 之前");
  assert.ok(report.includes("`session/list`"), "条目要点名端点，便于回源码复核");
  assert.ok(report.includes("[_request] → [request]"), "条目要给出前后形状，而不是只说「变了」");
}
console.log("dshContract: 报告渲染（P0 在前、点名落点、给出前后形状） ✓");
