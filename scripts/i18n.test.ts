/**
 * 验证「宿主发给 webview 的每一条文案都能翻出来」，以及 VS Code 原生 UI 那一层
 * （`hostText.ts` + `l10n/bundle.l10n.zh-cn.json`）不漂移。
 *
 * 背景：宿主不知道用户选了哪种语言，所以只传语言中立的 `@key` / `@key:arg`
 * 标记（见 AGENTS.md「@key 标记」）。标记少登记一处，用户就会在界面上**看到
 * 原始 key**（`@branchFailed` 这种），而且只有踩到那条分支才暴露——代码审查看
 * 不出来，所以用测试钉死。
 *
 * 登记处只有一处：`src/webview/messages.ts` 的 `MESSAGES`（以标记为键，每条自带
 * 中英两份）。下面的 `MARKERS` 直接从它的键派生——加一条文案只改那一张表，
 * 这里不再有手抄清单。
 *
 * 六条不变量：
 * 1. **解析**：表里每个标记在 zh / en 下都不能原样返回，也不能解析成空串或
 *    夹着 `undefined`（函数里写错属性名会落到这里）；
 * 2. **参数**：带参标记的每个参数都真的进了文案（含 `C:\tools\dsh\dsh\bin`
 *    这种带冒号的路径不被截断）；
 * 3. **登记**：扫一遍宿主的 emitter 源码，出现过的标记必须在表里；
 * 4. **反方向**：表里登记过的每个标记都真有发射点（`serverExited` /
 *    `switchingServer` 那类死文案不许再攒起来）；
 * 5. **VS Code 层**：`hostText` 覆盖的 key 集合 = 表里标了 `vscode: true` 的键，
 *    且每条的英文源串在 `l10n/bundle.l10n.zh-cn.json` 里都有**不同**的中文译文
 *    （这一层从前零断言，缺译文会静默显示英文）；
 * 6. **表本身**：每条都有中英两份、带参数的登记成函数、不带参数的登记成字符串
 *    （从前那个长 switch 的失败模式是静默的：重复 `case` = 后者不可达）。
 *
 * 顺带钉住两个容易回归的行为：多行连接说明按行解析、不认识的 `@` 文本原样透传
 * （模型/服务端的原始报错就是靠这条不被翻译）。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asMessageTable, assertVscodeFacingList, englishSource, MESSAGES, VSCODE_FACING_MARKERS } from "../src/webview/messages";
import type { LocalizedMessage } from "../src/webview/messages";
import { dictionaryFor, resolveText, type Locale } from "../src/webview/texts";
import l10nZh from "../l10n/bundle.l10n.zh-cn.json";

const LOCALES: Locale[] = ["zh", "en"];

/**
 * 全部可解析的标记 = **消息表的键**（派生，不手抄）。
 *
 * 这张表同时是 webview 界面词典，里面还有大量只由组件渲染、不走 `@key` 的条目
 * （`newChat`、`placeholderFirst`…）。但表里的**每一条**都能被 `resolveText` 解析
 * （表就是登记处），所以「解析」那几条断言可以放心全量跑。
 */
const MARKERS: string[] = Object.keys(MESSAGES);

/**
 * **宿主 `@key` 文案**：会由宿主发出来的那些（其余是纯界面文案）。
 *
 * 反方向断言（登记过的必须有发射点）认的就是这份集合——它是「宿主的登记清单」，
 * 从前叫 `MARKERS`。现在从消息表派生：带函数或带 `vscode` 标记的不会自动区分，
 * 所以这里按「AGENTS.md 里那套 `@key` 机制的实际发射点」手工圈定一次，并由
 * 第 3、4 条断言双向核对（多了会炸「没有发射点」，少了会炸「未登记」）。
 */
const HOST_MARKERS: string[] = [
  // 轮次 / 流式
  "turnFailed",
  "interrupted",
  "stopped",
  "compacted",
  "maxTokens",
  "llmRetry",
  "llmRetryAlways",
  "unknownEvent",
  // 斜杠命令
  "unknownCommand",
  "commandFailed",
  // 历史 / 分支
  "branchNoAnchor",
  "branchFailed",
  "branchCreated",
  // 附件 / 上传
  "uploadIncomplete",
  "uploadNoSession",
  "imagePathsInserted",
  // 排队
  "queueAttachmentsLost",
  "queueContentLost",
  "queueDispatchFailed",
  // 文件芯片
  "chipFileDeleted",
  "chipPathUnresolved",
  // 拖放
  "dropUnreadable",
  "dropTooLarge",
  // 粘贴（剪贴板里的文件 / 图片：准入判据与拖放相同，措辞另有一套）
  "pasteUnreadable",
  "pasteTooLarge",
  // 图片内联上限（超限改按文件上传）
  "imageTooLarge",
  // 剪贴板 / 浏览器
  // （`copied` 已随「复制成功不弹信息条」的口径一起删掉：复制按钮不再发 toast）
  "openInBrowserOffline",
  "openInBrowserFailed",
  // 审批
  "toolGeneric",
  "callId",
  // 连接 / 鉴权 / 服务器
  "connectionLost",
  "authNeedsToken",
  "authTokenRejected",
  "serverSpawnFailed",
  "serverNotReady",
  "serverUnreachable",
  "serverLogTail",
  // 多窗口共享后台
  "sharedRestarted",
];

// ---------- 1. 每个标记在两种语言下都能解析出内容 ----------
//
// 只针对**宿主 `@key`** 那批：表里其余的界面文案（`questionStep` 之类）由组件
// 带参调用，拿空参数去断言「不含 undefined」本来就不成立。

for (const key of HOST_MARKERS) {
  const marker = `@${key}`;
  for (const locale of LOCALES) {
    const texts = dictionaryFor(locale);
    const resolved = resolveText(marker, texts);
    assert.notStrictEqual(
      resolved,
      marker,
      `${marker} 在 ${locale} 下原样返回了——词典没登记这条，或 resolveText 没查到`,
    );
    assert.ok(resolved.trim().length > 0, `${marker} 在 ${locale} 下解析成了空串`);
    assert.ok(
      !resolved.includes("undefined") && !resolved.includes("NaN"),
      `${marker} 在 ${locale} 下解析出了 undefined/NaN：${resolved}`,
    );
  }
}
console.log(`i18n: ${HOST_MARKERS.length} 个宿主标记 × ${LOCALES.length} 种语言均可解析 ✓`);

// ---------- 1a. 消息表里的每一条都能被解析（表就是登记处） ----------

for (const key of MARKERS) {
  for (const locale of LOCALES) {
    const resolved = resolveText(`@${key}`, dictionaryFor(locale));
    assert.notStrictEqual(resolved, `@${key}`, `@${key} 在 ${locale} 下原样返回了`);
  }
}
console.log(`i18n: 消息表的全部 ${MARKERS.length} 个键都能解析（表即登记处）✓`);

// ---------- 1b. 消息表本身的形状：中英齐全、函数/字符串登记形态正确 ----------

{
  for (const [key, message] of Object.entries(asMessageTable(MESSAGES))) {
    for (const locale of LOCALES) {
      const value = message[locale];
      if (typeof value === "string") {
        assert.ok(value.length > 0, `${key}.${locale} 是空串`);
      } else {
        assert.strictEqual(typeof value, "function", `${key}.${locale} 既不是字符串也不是函数`);
        // 带参数的登记成函数：调用一次不能抛（参数随便给，函数自己兜底）
        assert.strictEqual(typeof value(""), "string", `${key}.${locale} 没返回字符串`);
      }
    }
  }
  // 宿主的 `@key` 清单必须是消息表键的子集（拼错一个字母在这里就炸）
  const unknown = HOST_MARKERS.filter((key) => !(key in MESSAGES));
  assert.deepStrictEqual(unknown, [], `HOST_MARKERS 里有消息表里没有的键：${unknown.join("、")}`);
}
console.log("i18n: 消息表每条都有中英两份，带参的登记成函数、无参的登记成字符串 ✓");

// ---------- 2. 带参数的标记：参数真的进到文案里 ----------

{
  const zh = dictionaryFor("zh");

  /**
   * 带参标记**逐条**对拍：每条给一组参数，核对参数真的落进了文案。
   *
   * 参数故意取得互相不同（`AAA` / `BBB` / 数字），任何一段没传到就会炸。
   * 这里把每条标记的**切参数口径**也一并钉住了：
   * - 单参数标记（`argParts` 缺省）：冒号之后的整段都算参数（含冒号也不截断）；
   * - `argParts: 2` 的三条：按第一段冒号对半切（`uploadIncomplete` 还要对调顺序）。
   */
  const PARAM_CASES: Array<[string, string, string[]]> = [
    // 单参数：整段保留
    ["dropUnreadable", "@dropUnreadable:notes.pdf", ["notes.pdf"]],
    ["dropTooLarge", "@dropTooLarge:big.zip", ["big.zip"]],
    ["pasteUnreadable", "@pasteUnreadable:notes.pdf", ["notes.pdf"]],
    ["pasteTooLarge", "@pasteTooLarge:big.zip", ["big.zip"]],
    ["imageTooLarge", "@imageTooLarge:a.png", ["a.png"]],
    ["serverSpawnFailed", "@serverSpawnFailed:ENOENT", ["ENOENT"]],
    ["serverUnreachable", "@serverUnreachable:C:\\tools\\dsh\\dsh\\bin", ["C:\\tools\\dsh\\dsh\\bin"]],
    ["serverLogTail", "@serverLogTail:dsh web: ready\nport 8080", ["dsh web: ready"]],
    ["unknownCommand", "@unknownCommand:/foo", ["/foo"]],
    ["commandFailed", "@commandFailed:/foo", ["/foo"]],
    ["unknownEvent", "@unknownEvent:weird/event", ["weird/event"]],
    ["callId", "@callId:call_abc123", ["call_abc123"]],
    ["branchCreated", "@branchCreated:my-branch", ["my-branch"]],
    ["uploadFailedReason", "@uploadFailedReason:disk full", ["disk full"]],
    ["injectedChars", "@injectedChars:7.0K", ["7.0K"]],
    ["tokensPerSecond", "@tokensPerSecond:12.3", ["12.3"]],
    ["openChangesAria", "@openChangesAria:a.ts", ["a.ts"]],
    ["deletedFileAria", "@deletedFileAria:a.ts", ["a.ts"]],
    ["forkedTitle", "@forkedTitle:Title", ["Title"]],
    ["contextRelayFrom", "@contextRelayFrom:s-1", ["s-1"]],
    // 两个参数：按第一段冒号切，第二段里的冒号整段保留
    ["llmRetry", "@llmRetry:2:5", ["2", "5"]],
    ["imagePathsInserted", "@imagePathsInserted:2:vendor:model", ["2", "vendor:model"]],
    ["uploadIncomplete", "@uploadIncomplete:4:report.pdf, notes.md", ["4", "report.pdf, notes.md"]],
  ];

  for (const [key, marker, expected] of PARAM_CASES) {
    const entry = MESSAGES[key as keyof typeof MESSAGES];
    const declared = typeof entry.zh === "function" ? entry.zh.length : 0;
    assert.ok(
      expected.length <= declared,
      `${marker} 给了 ${expected.length} 段参数，而登记的形参只有 ${declared} 个`,
    );
    const resolved = resolveText(marker, zh);
    assert.notStrictEqual(resolved, marker, `${marker} 没被解析`);
    for (const piece of expected) {
      assert.ok(resolved.includes(piece), `${marker} 的参数「${piece}」没进文案：${resolved}`);
    }
  }

  // 缺参也不能炸出 undefined/NaN（宿主的模板串万一少拼了一段）
  for (const raw of ["@llmRetry:2", "@uploadIncomplete:", "@imagePathsInserted:2", "@serverLogTail:"]) {
    for (const locale of LOCALES) {
      const resolved = resolveText(raw, dictionaryFor(locale));
      assert.ok(!resolved.includes("undefined") && !resolved.includes("NaN"), `${raw} 在 ${locale} 下：${resolved}`);
    }
  }
}
console.log("i18n: 带参数的标记参数不丢（含冒号参数整段保留）✓");

// ---------- 3. 多行：连接失败说明按行解析 ----------

{
  const zh = dictionaryFor("zh");
  const detail = ["@serverNotReady", "@serverLogTail:dsh web: ready\nport 8080"].join("\n");
  const resolved = resolveText(detail, zh);
  assert.ok(!resolved.includes("@serverNotReady"), resolved);
  assert.ok(!resolved.includes("@serverLogTail"), resolved);
  assert.ok(resolved.includes("port 8080"), "日志原文不能被吃掉");
  assert.ok(resolved.split("\n").length >= 4, `多行结构应保留：${resolved}`);
}
console.log("i18n: 多行连接说明逐行解析 ✓");

// ---------- 4. 不认识的 @ 文本原样透传（模型/服务端原始报错不翻译） ----------

{
  const zh = dictionaryFor("zh");
  for (const raw of ["@notAMarker", "@something:1:2", "@", "plain text", "user@example.com"]) {
    assert.strictEqual(resolveText(raw, zh), raw, `${raw} 不该被改动`);
  }
  // 换行里夹着原文：只有标记行被翻，其余原样
  const mixed = "some/model/error\n@stopped";
  assert.strictEqual(resolveText(mixed, zh), `some/model/error\n${zh.stopped}`);
}
console.log("i18n: 未知 @ 文本原样透传 ✓");

// ---------- 5. 宿主源码扫描：出现过的标记都必须在表里 / 表里的宿主标记都有发射点 ----------

{
  /** 宿主侧源码（标记由宿主发出，webview 只消费）。 */
  function hostSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "webview") continue; // 那侧是消费方
        out.push(...hostSources(full));
      } else if (entry.name.endsWith(".ts") && entry.name !== "texts.ts" && entry.name !== "messages.ts") {
        out.push(full);
      }
    }
    return out;
  }

  // 标记的字面量形态：引号/反引号紧接 `@`，后面跟标识符，再跟 `"`、反引号或 `:`
  // （后一个条件把 `"@deepseek-ai/..."` 这类包名挡在外面）
  const EMITTED = /["`]@([A-Za-z][A-Za-z0-9]*)(?=["`':])/g;
  const declared = new Set(MARKERS);
  const found = new Map<string, string>();

  const files = hostSources(join(process.cwd(), "src"));
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // 注释里的 `@path` / `@` 引用是文档，不是发射点
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const match of line.matchAll(EMITTED)) {
        const key = match[1];
        if (!declared.has(key)) found.set(key, `${file}:${index + 1}`);
      }
    });
  }

  assert.strictEqual(
    found.size,
    0,
    `宿主发出了未登记的标记（补进 src/webview/messages.ts 的消息表）：\n` +
      [...found].map(([key, where]) => `  @${key}  ${where}`).join("\n"),
  );
  console.log(`i18n: 宿主源码里的标记均已登记（扫了 ${files.length} 个文件）✓`);

  // **反方向**：登记了但从来没人发的标记同样是缺陷——它有词典条目、有解析分支，
  // 甚至还有 hostText / l10n 译文，看起来"做完了"，实际上那句话永远不会出现在
  // 任何界面上（`serverExited` / `switchingServer` 就是这么留了两轮）。
  // 只做**字面量**比对（与上面的扫描同一套正则）：模板拼出来的标记这里不认，
  // 那类标记请在发出处写成字面量。
  const emitted = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      for (const match of line.matchAll(EMITTED)) emitted.add(match[1]);
    }
  }
  const neverEmitted = HOST_MARKERS.filter((key) => !emitted.has(key));
  assert.deepStrictEqual(
    neverEmitted,
    [],
    "HOST_MARKERS 里登记了却没有任何发射点的标记（从 messages.ts 删掉这条，或补上发射点）：\n" +
      neverEmitted.map((key) => `  @${key}`).join("\n"),
  );
  console.log(`i18n: ${HOST_MARKERS.length} 个宿主标记每个都有真实发射点 ✓`);
}

// ---------- 6. VS Code 原生 UI 那一层：hostText 覆盖的 key ⊆ 消息表，且译文逐条对齐 ----------
//
// 从前这一层零断言：hostText 的英文源串与 l10n bundle 各写一份，改了一边另一边
// 静默不生效（用户看到英文原文）；表里新标一条 `vscode: true` 也可能没人处理。
// 现在四处都钉住（①清单与表一致 ②hostText 恰好覆盖 ③l10n 有译文 ④英文源串不撞车）。

{
  // ① 清单与「表里标了 `vscode: true` 的条目」必须一模一样（多写/漏写都抛）
  assertVscodeFacingList();
  // 清单里的 key 必须都是消息表的键（拼错字母 / 条目被删都会炸）
  const unknown = VSCODE_FACING_MARKERS.filter((key) => !(key in MESSAGES));
  assert.deepStrictEqual(unknown, [], `VSCODE_FACING_MARKERS 里有消息表里没有的 key：${unknown.join("、")}`);
  assert.ok(VSCODE_FACING_MARKERS.length > 0, "一条 VS Code 面向的标记都没有，这条断言就没意义了");

  // ② hostText 实际处理的 key 集合必须**恰好**等于清单那套。
  //    做法是从源码里把 `LOCALIZED` 表的条目的 key 抠出来（`<key>: { key: englishSource("<key>") }`）——
  //    「表里新标了一条 vscode: true 却忘了在 hostText 里加处理」会在这里炸，
  //    「手写英文源串而没走 englishSource」也会（两个数字必须相等）。
  const hostTextSource = readFileSync(join(process.cwd(), "src", "dsh", "hostText.ts"), "utf8");
  const sourceCalls = [...hostTextSource.matchAll(/englishSource\(/g)].length;
  const handledKeys = new Set(
    [...hostTextSource.matchAll(/^\s+([A-Za-z][\w]*):\s*\{\s*key:\s*englishSource\("([A-Za-z][\w]*)"\)/gm)].map(
      (match) => {
        assert.strictEqual(match[1], match[2], `LOCALIZED 里 ${match[1]} 的源串取自 ${match[2]}，两边必须同名`);
        return match[1];
      },
    ),
  );
  assert.strictEqual(
    sourceCalls,
    handledKeys.size,
    `hostText 里有 ${sourceCalls} 处 englishSource(...) 调用，只有 ${handledKeys.size} 处落在 LOCALIZED 的条目上——` +
      "不该有手写的英文源串（它会与消息表里的 en 悄悄漂开）",
  );
  assert.deepStrictEqual(
    [...handledKeys].sort(),
    [...VSCODE_FACING_MARKERS].sort(),
    "hostText 实际处理的 key 与清单（表里 `vscode: true` 的那套）不一致（漏一个 → VS Code 通知里出现裸 @key）",
  );

  // ③ 每条的英文源串（= l10n 的 key）必须与 l10n bundle 逐条对齐
  const bundle = l10nZh as Record<string, string>;
  const missing: string[] = [];
  const untranslated: string[] = [];
  for (const key of VSCODE_FACING_MARKERS) {
    const source = englishSource(key);
    if (!(source in bundle)) missing.push(`${key} → ${JSON.stringify(source)}`);
    else if (bundle[source] === source) untranslated.push(key);
  }
  assert.deepStrictEqual(
    missing,
    [],
    "l10n/bundle.l10n.zh-cn.json 缺下面这些英文源串的译文（VS Code 通知会静默显示英文）：\n" +
      missing.map((line) => `  ${line}`).join("\n"),
  );
  assert.deepStrictEqual(untranslated, [], `这些 key 的中文译文与英文源串一模一样（漏翻）：${untranslated.join("、")}`);

  // ④ l10n 的 key 是英文源串：两条标记共用同一段英文就无法各译一份，必须拦住
  const sources = VSCODE_FACING_MARKERS.map((key) => englishSource(key));
  assert.strictEqual(
    new Set(sources).size,
    sources.length,
    "两条标记的英文源串撞车了（l10n 的 key 是英文源串，同串无法各译一份）",
  );
}
console.log(`i18n: hostText 与 l10n 逐条对齐（${VSCODE_FACING_MARKERS.length} 条 VS Code 面向的标记）✓`);

// ---------- 7. VS Code 原生 UI 的文案（package.nls*）与 package.json 对齐 ----------
//
// 三类漂移都会让用户**直接看到 `%config.xxx%`** 或者留下一条永远不显示的条目：
// - 清单引用了 `%key%`，两份 nls 里却没有；
// - 中英两份 nls 的键集合不一致（改文案时只改了半边）；
// - **删掉配置项却留着 nls 条目**（用户 2026-09-15 要求删 `dshChat.openPanelOnStartup`，
//   这类删除最容易只删 `package.json` 那一处）。
{
  const en = JSON.parse(readFileSync(join(process.cwd(), "package.nls.json"), "utf8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(join(process.cwd(), "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;
  const manifest = readFileSync(join(process.cwd(), "package.json"), "utf8");

  const referenced = new Set([...manifest.matchAll(/%([A-Za-z0-9_.]+)%/g)].map((match) => match[1]));
  const missingEn = [...referenced].filter((key) => !(key in en));
  const missingZh = [...referenced].filter((key) => !(key in zh));
  assert.deepStrictEqual(missingEn, [], `package.json 引用了但英文 nls 里没有：${missingEn.join("、")}`);
  assert.deepStrictEqual(missingZh, [], `package.json 引用了但中文 nls 里没有：${missingZh.join("、")}`);

  const orphanEn = Object.keys(en).filter((key) => !referenced.has(key));
  const orphanZh = Object.keys(zh).filter((key) => !referenced.has(key));
  assert.deepStrictEqual(
    orphanEn,
    [],
    `英文 nls 里有 package.json 不再引用的键（删配置项时漏删了？）：${orphanEn.join("、")}`,
  );
  assert.deepStrictEqual(
    orphanZh,
    [],
    `中文 nls 里有 package.json 不再引用的键（删配置项时漏删了？）：${orphanZh.join("、")}`,
  );

  assert.deepStrictEqual(
    Object.keys(en).sort(),
    Object.keys(zh).sort(),
    "中英两份 nls 的键集合必须一致（改了中文别忘了英文）",
  );
  // 中文那份的值不该是英文原文（漏翻的典型信号：直接复制了英文行）
  const untranslated = Object.keys(zh).filter(
    (key) => zh[key] === en[key] && /[A-Za-z]{4}/.test(en[key]) && !/^DSH/.test(en[key]),
  );
  assert.deepStrictEqual(untranslated, [], `中文 nls 里疑似漏翻的键：${untranslated.join("、")}`);
}
console.log("i18n: package.nls 与 package.json 对齐（无缺失 / 无孤儿 / 中英同键）✓");

// ---------- 8. 已删除的配置项不能再出现（`dshChat.openPanelOnStartup`） ----------
{
  const files = ["package.json", "package.nls.json", "package.nls.zh-cn.json", "README.md"];
  for (const file of files) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(
      !text.includes("openPanelOnStartup"),
      `${file} 里还留着 dshChat.openPanelOnStartup（用户 2026-09-15 要求删除这条配置项）`,
    );
  }
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  assert.ok(
    !/openPanelOnStartup/.test(extension),
    "extension.ts 不能再读这条配置（删了配置项却留着读取点 = 一处静默死代码）",
  );
}
console.log("i18n: 已删除的配置项在各处都不再出现 ✓");

// ---------- 9. webview 的起步语言不得缺省成英文 ----------
//
// 界面词典按 `state.locale` 选（normalizeLocale：undefined → en），起步值若缺省，
// 首帧快照到来之前整个界面都渲染英文。initialState 必须用 `navigator.language`
// （webview 里跟随 VS Code 显示语言，与宿主 readLanguage 的 auto 分支同源）
// 撑住第一帧；宿主首帧快照带上权威值（`dshChat.language` 固定选择优先）后覆盖。
{
  const state = readFileSync(join(process.cwd(), "src", "webview", "state.ts"), "utf8");
  assert.ok(
    /locale:\s*typeof navigator !== "undefined" \? navigator\.language : undefined/.test(state),
    "initialState.locale 必须取 navigator.language（起步即正确语言），不能缺省成 undefined（词典会落英文）",
  );
}
console.log("i18n: webview 起步语言取 navigator.language（不缺省成英文）✓");

console.log("\ni18n: all assertions passed");
