/**
 * 「Agent 改动」对比：逐文件对比的形状校验 + 两侧文本的拼法 + 两端接线。
 *
 * 背景：文件芯片默认「看改动」走的是 VS Code git 的工作区对比，**提交之后就什么都
 * 看不到**。DSH 的 Host 在 Session 存活期间另有本轮快照（`/api/changes.diff`），
 * 与官方 web 端复查面板同一份契约；这里钉住把它铺成对比窗口两段文本的规则：
 *
 *  1. 路由回来的是 hunk（不是两整份文件），形状不对就整份丢弃；
 *  2. 整份新建 / 删除 / 粗粒度直接由 hunk 拼整侧；
 *  3. 两边都在时，只有当前文件逐行对得上每个 hunk 的 new 侧才回填整份；
 *  4. 对不上就退化成片段（带省略标记），绝不把另一版内容冒充成本轮上下文；
 *  5. 改动卡片 / 交付行把清单下标带下来，宿主才会去走这条新路。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentDiffTexts, decodeChangesDiff, type AgentDiff } from "../src/dsh/changesDiff";

const SRC = join(process.cwd(), "src");
const omitted = (lines: number) => `GAP ${lines}`;

// ---------- 1. 形状校验：验不过就整份丢弃 ----------

const text = {
  kind: "text",
  path: "src/a.ts",
  display: "src/a.ts",
  before: true,
  after: true,
  coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] },
  ],
};

{
  assert.deepStrictEqual(decodeChangesDiff(text), text, "合规的文本对比应原样解出");
  assert.deepStrictEqual(
    decodeChangesDiff({ kind: "binary", path: "a.png", display: "a.png" }),
    { kind: "binary", path: "a.png", display: "a.png" },
    "二进制对比只带路径",
  );
  assert.deepStrictEqual(
    decodeChangesDiff({ kind: "oversized", path: "big.bin", display: "big.bin" }),
    { kind: "oversized", path: "big.bin", display: "big.bin" },
    "过大对比只带路径",
  );
}
console.log("changesDiff: 合规的文本 / 二进制 / 过大对比原样解出 ✓");

{
  const bad: [string, unknown][] = [
    ["非对象", "nope"],
    ["null", null],
    ["数组", []],
    ["缺 path", { ...text, path: "" }],
    ["缺 display", { ...text, display: undefined }],
    ["未知 kind", { ...text, kind: "patch" }],
    ["before 不是布尔", { ...text, before: "yes" }],
    ["coarse 缺失", { ...text, coarse: undefined }],
    ["hunks 不是数组", { ...text, hunks: {} }],
    ["hunk 坐标是负数", { ...text, hunks: [{ ...text.hunks[0]!, oldStart: -1 }] }],
    ["hunk 行没有标记", { ...text, hunks: [{ ...text.hunks[0]!, lines: ["a"] }] }],
    ["hunk 行不是字符串", { ...text, hunks: [{ ...text.hunks[0]!, lines: [1] }] }],
  ];
  for (const [label, value] of bad) {
    assert.strictEqual(decodeChangesDiff(value), null, `${label} 应整份丢弃`);
  }
}
console.log("changesDiff: 形状不合规的对比整份丢弃（半截对比比没有更误导） ✓");

// ---------- 2. 整份新建 / 删除 / 粗粒度：hunk 覆盖整侧 ----------

function textDiff(overrides: Partial<Extract<AgentDiff, { kind: "text" }>>): Extract<AgentDiff, { kind: "text" }> {
  return {
    kind: "text",
    path: "src/a.ts",
    display: "src/a.ts",
    before: true,
    after: true,
    coarse: false,
    hunks: [],
    ...overrides,
  };
}

{
  const created = textDiff({
    before: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }],
  });
  assert.deepStrictEqual(buildAgentDiffTexts(created, undefined, omitted), {
    before: "",
    after: "a\nb\n",
    excerpt: false,
  });
}
console.log("changesDiff: 整份新建 → 左侧为空、右侧由 hunk 拼全 ✓");

{
  const deleted = textDiff({
    after: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ["-a", "-b"] }],
  });
  assert.deepStrictEqual(buildAgentDiffTexts(deleted, undefined, omitted), {
    before: "a\nb\n",
    after: "",
    excerpt: false,
  });
}
console.log("changesDiff: 整份删除 → 右侧为空、左侧由 hunk 拼全 ✓");

{
  const coarse = textDiff({
    coarse: true,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ["-a", "-b", "+x"] }],
  });
  assert.deepStrictEqual(buildAgentDiffTexts(coarse, undefined, omitted), {
    before: "a\nb\n",
    after: "x\n",
    excerpt: false,
  });
}
console.log("changesDiff: 粗粒度（超时降级）→ 全删 + 全增即是整侧 ✓");

// ---------- 3. 两边都在：当前文件对得上才回填整份 ----------

{
  const diff = textDiff({
    hunks: [
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: [" a", "-b", "+B", " c", "-d", "+D"],
      },
    ],
  });
  const texts = buildAgentDiffTexts(diff, "a\nB\nc\nD\n", omitted);
  assert.deepStrictEqual(texts, {
    before: "a\nb\nc\nd\n",
    after: "a\nB\nc\nD\n",
    excerpt: false,
  });
}
console.log("changesDiff: 当前文件逐行对得上 → 回填 turn-start 全文 ✓");

{
  // Windows 的 CRLF：hunk 行尾带 \r，当前文件也是 CRLF；比较与输出都按行归一
  const diff = textDiff({
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ["-b\r", "+B\r", " c\r"],
      },
    ],
  });
  const texts = buildAgentDiffTexts(diff, "B\r\nc\r\n", omitted);
  assert.deepStrictEqual(texts, { before: "b\nc\n", after: "B\nc\n", excerpt: false });
}
console.log("changesDiff: CRLF 归一后仍能对齐（Windows 文件不误判成「又改过」） ✓");

{
  // hunk 的 newLines 与段体对不上：载荷坏了，不能按它去改文本
  const diff = textDiff({
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 9, lines: [" a", "-b", "+B"] }],
  });
  const texts = buildAgentDiffTexts(diff, "a\nB\n", omitted);
  assert.strictEqual(texts.excerpt, true, "段体行数对不上时不许回填整份");
}
console.log("changesDiff: hunk 自洽性不成立时退回片段 ✓");

// ---------- 4. 对不上就退化成片段：中间夹省略标记 ----------

{
  const diff = textDiff({
    hunks: [
      { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [" a", "-b", "+B", " c"] },
    ],
  });
  const texts = buildAgentDiffTexts(diff, "完全不是这一版\n", omitted);
  assert.deepStrictEqual(texts, {
    before: "GAP 2\na\nb\nc\n",
    after: "GAP 2\na\nB\nc\n",
    excerpt: true,
  });
}
console.log("changesDiff: 当前文件对不上 → 只铺 hunk，未展示区间用同一行标记占位 ✓");

{
  // 两侧行完全相同：给一份无差异对比，而不是退回 git（那会显示另一件事）
  const texts = buildAgentDiffTexts(textDiff({ hunks: [] }), "same\nfile\n", omitted);
  assert.deepStrictEqual(texts, { before: "same\nfile\n", after: "same\nfile\n", excerpt: false });
}
console.log("changesDiff: 无 hunk 时显示「没有行差异」，不假装有改动 ✓");

// ---------- 5. 两端接线 ----------

{
  const controller = readFileSync(join(SRC, "dsh", "controller.ts"), "utf8");
  assert.ok(
    /\/api\/changes\.diff\?\$\{new URLSearchParams\(\{[\s\S]{0,120}sessionId,[\s\S]{0,80}seq:[\s\S]{0,80}index:/.test(
      controller,
    ),
    "宿主必须走 Host 的认证路由 /api/changes.diff（官方 ui-deliverables 的同一份契约）",
  );
  assert.ok(/private async openAgentChanges\(/.test(controller), "要有打开本轮快照对比的入口");
  assert.ok(
    /diff === true && changes[\s\S]{0,160}?openAgentChanges\(sessionId, path, changes\)/u.test(controller),
    "「看改动」要先按坐标试本轮快照，不先 stat 当前文件；没有坐标时打开文件本身（不再回落本机 git）",
  );
  assert.ok(
    /await vscode\.commands\.executeCommand\("vscode\.diff"/u.test(controller),
    "两侧文本要交给 VS Code 原生对比窗口",
  );
  assert.ok(
    /buildAgentDiffTexts\(diff, current,/u.test(controller),
    "两侧文本必须由共用拼装函数生成（片段 / 整份的判据只有一份）",
  );
  assert.ok(
    /if \(!diff\.before && current !== undefined\) return false;/u.test(controller),
    "新文件仍遵旧口径：执行世界还在就打开文件，不显示「空 → 全文」的 diff",
  );
  assert.ok(
    /targetAbsolute\?: string/u.test(controller) &&
      /sameExecutionPath\(currentAbsolute, targetAbsolute\)/u.test(controller),
    "坐标是历史快照的身份；绝对路径只在能同时读到当前文本时做防错比对，当前读不到不否掉快照",
  );
  assert.ok(
    /if \(diff\.kind !== "text"\)/u.test(controller),
    "二进制 / 过大没有行可铺：打开文件本身",
  );
  assert.ok(!/readTextFile\(/u.test(controller), "当前文本必须从执行世界分页读取，不再本机 readFile");
  assert.ok(!/openChanges\(/u.test(controller), "不再回落未验证的本机 git");
  // 点击延迟：取数缓存 + 悬停预热 + in-flight 合并，三者缺一都会回到「点了才去加载」
  assert.ok(/private loadAgentDiff\(/.test(controller), "对比取数要有独立的缓存入口");
  assert.ok(
    /case "prefetchChanges":/.test(controller) && /private prefetchAgentChanges\(/.test(controller),
    "悬停预热的帧要接到取数缓存（只取数，不打开编辑器）",
  );
  assert.ok(
    /agentDiffRequests/.test(controller) && /agentDiffOwner !== client/.test(controller),
    "同坐标要合并 in-flight 请求，换连接要整体作废（seq 只在同一条连接里有意义）",
  );
  assert.ok(/AGENT_DIFF_CACHE_LIMIT/.test(controller), "缓存要有条数上限，长会话不能无限攒正文");
  assert.ok(
    /耗时 \$\{Date\.now\(\) - started\}ms（取数 \$\{fetchedMs\}ms）/.test(controller),
    "打开日志要能看出这一段花了多久、其中取数占多少（定位延迟用）",
  );

  const ipc = readFileSync(join(SRC, "shared", "ipc.ts"), "utf8");
  assert.ok(/export interface ChangeCoordinates/.test(ipc), "坐标类型要有唯一定义");
  assert.ok(/changes\?: ChangeCoordinates/.test(ipc), "openFile 要接受改动坐标");
  assert.ok(
    /\{ type: "prefetchChanges"; seq: number; index: number \}/.test(ipc),
    "要有独立的预热帧（不打开编辑器）",
  );

  const extension = readFileSync(join(SRC, "extension.ts"), "utf8");
  assert.ok(
    /registerTextDocumentContentProvider\(AGENT_DIFF_SCHEME, agentDiff\)/.test(extension),
    "虚拟文档提供者必须在激活期注册（两侧文本不落盘）",
  );
  assert.ok(/new AgentDiffDocuments\(\)/.test(extension), "提供者实例要随扩展释放");

  const card = readFileSync(join(SRC, "webview", "components", "ChangesCard.tsx"), "utf8");
  assert.ok(
    /changes: \{ seq, index, turn: summary\.turn \}/.test(card),
    "改动卡片每行要把清单下标带下去（折叠不重排下标）",
  );
  assert.ok(/shown\.map\(\(file, index\)/.test(card), "下标取自 files 里的原始位置");
  assert.ok(
    /post\(\{ type: "prefetchChanges", seq, index \}\)/.test(card),
    "悬停 / 聚焦要发预热帧（只取数，点击时才打开编辑器）",
  );
  assert.ok(
    /onPointerEnter=\{\(\) => prefetch\(index\)\}/.test(card) &&
      /onFocus=\{\(\) => prefetch\(index\)\}/.test(card),
    "鼠标悬停与键盘聚焦都要能预热（不必等真正按下）",
  );
  assert.ok(
    /const prefetched = useRef\(new Set<number>\(\)\)/.test(card) &&
      /prefetched\.current\.clear\(\)/.test(card),
    "同一行只预热一次；换一份清单（seq）重新记",
  );

  const message = readFileSync(join(SRC, "webview", "components", "Message.tsx"), "utf8");
  assert.ok(
    /files: changesSummary\.files/.test(message),
    "「本轮改动」/交付行也要能按清单下标打开本轮快照对比",
  );

  const rows = readFileSync(join(SRC, "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(/function changeCoordinates\(/.test(rows), "芯片路径要能对上清单下标");
  assert.ok(/\.\.\.\(coordinates \? \{ changes: coordinates \} : \{\}\)/.test(rows), "对上时才带坐标");
}
console.log("changesDiff: 卡片坐标 → 宿主 /api/changes.diff → 原生对比窗口 接线完整 ✓");

console.log("\nchangesDiff: all assertions passed");
