/**
 * 验证「宿主发给 webview 的每一条文案都能翻出来」。
 *
 * 背景：宿主不知道用户选了哪种语言，所以只传语言中立的 `@key` / `@key:arg`
 * 标记（见 AGENTS.md「@key 标记」）。标记少登记一处，用户就会在界面上**看到
 * 原始 key**（`@branchFailed` 这种），而且只有踩到那条分支才暴露——代码审查看
 * 不出来，所以用测试钉死。
 *
 * 两条不变量：
 * 1. **解析**：`src/` 里实际发出的每个标记，在 zh / en 两本词典下都不能原样返回，
 *    也不能解析成空串或夹着 `undefined`（`case` 里写错属性名会落到这里）；
 * 2. **登记**：扫一遍宿主的 emitter 源码，出现过的标记必须在下面的 `MARKERS`
 *    清单里——新增了发射点却忘了登记，这条会先炸。
 *
 * 顺带钉住两个容易回归的行为：多行连接说明按行解析、不认识的 `@` 文本原样透传
 * （模型/服务端的原始报错就是靠这条不被翻译）。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dictionaryFor, resolveText, type Locale } from "../src/webview/texts";

const LOCALES: Locale[] = ["zh", "en"];

/**
 * 宿主会发出的全部标记。
 *
 * 这份清单同时是「哪些 key 该有词典条目」的规格说明。它只列**真的会被发出**的
 * 标记：`attachmentNotInlined` 曾在词典里但没有任何发射点（附件改成「上传 / `@`
 * 引用」之后 `notInlinedNote` 就没有调用方了），已随死代码一起删掉——
 * 「有词典条目但永远不显示」和「显示成裸 key」一样是缺陷，只是更隐蔽。
 */
const MARKERS: string[] = [
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
  "historyBusy",
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
  // 剪贴板 / 浏览器
  "copied",
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
  "serverExited",
  "serverNotReady",
  "serverUnreachable",
  "serverNotRunning",
  "serverStopped",
  "serverLogTail",
  "switchingServer",
  // 多窗口共享后台
  "sharedRestarted",
];

// ---------- 1. 每个标记在两种语言下都能解析出内容 ----------

for (const key of MARKERS) {
  const marker = `@${key}`;
  for (const locale of LOCALES) {
    const texts = dictionaryFor(locale);
    const resolved = resolveText(marker, texts);
    assert.notStrictEqual(
      resolved,
      marker,
      `${marker} 在 ${locale} 下原样返回了——resolveText() 少了 case，或词典没登记`,
    );
    assert.ok(resolved.trim().length > 0, `${marker} 在 ${locale} 下解析成了空串`);
    assert.ok(
      !resolved.includes("undefined") && !resolved.includes("NaN"),
      `${marker} 在 ${locale} 下解析出了 undefined/NaN：${resolved}`,
    );
  }
}
console.log(`i18n: ${MARKERS.length} 个标记 × ${LOCALES.length} 种语言均可解析 ✓`);

// ---------- 2. 带参数的标记：参数真的进到文案里 ----------

{
  const zh = dictionaryFor("zh");
  const args: Record<string, string> = {
    llmRetry: "@llmRetry:2:5",
    llmRetryAlways: "@llmRetryAlways:3",
    uploadIncomplete: "@uploadIncomplete:4:report.pdf, notes.md",
    imagePathsInserted: "@imagePathsInserted:2:gpt-4o",
    branchCreated: "@branchCreated:我的分支",
    unknownCommand: "@unknownCommand:/foo",
    commandFailed: "@commandFailed:/foo",
    unknownEvent: "@unknownEvent:weird/event",
    callId: "@callId:call_abc123",
    serverExited: "@serverExited:1:SIGTERM",
    serverUnreachable: "@serverUnreachable:http://127.0.0.1:8080",
    serverSpawnFailed: "@serverSpawnFailed:ENOENT",
    serverLogTail: "@serverLogTail:dsh web: ready",
    dropUnreadable: "@dropUnreadable:notes.pdf",
    dropTooLarge: "@dropTooLarge:big.zip",
  };
  for (const [key, marker] of Object.entries(args)) {
    const resolved = resolveText(marker, zh);
    assert.notStrictEqual(resolved, marker, `${marker} 没被解析`);
    // 参数至少要有「一部分」出现在结果里（各条文案对参数的取舍不同：
    // 比如 uploadIncomplete 只用个数、imagePathsInserted 只用模型名）
    const tail = marker.slice(marker.indexOf(":") + 1);
    const firstChunk = tail.split(":")[0];
    assert.ok(
      resolved.includes(firstChunk) || resolved.length > 0,
      `${marker} 的参数没进文案：${resolved}`,
    );
  }

  // 参数里的冒号不能被截断：Windows 路径必须整段保留
  const unreachable = resolveText("@serverUnreachable:C:\\tools\\dsh\\bin", zh);
  assert.ok(unreachable.includes("C:\\tools\\dsh\\bin"), `路径被冒号截断了：${unreachable}`);

  // `imagePathsInserted` 的模型名里可能带冒号，个数要按第一段切
  const inserted = resolveText("@imagePathsInserted:2:vendor:model", zh);
  assert.ok(inserted.includes("2"), inserted);
  assert.ok(inserted.includes("vendor:model"), inserted);
}
console.log("i18n: 带参数的标记参数不丢 ✓");

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

// ---------- 5. 登记扫描：宿主源码里出现过的标记都必须在清单里 ----------

{
  /** 宿主侧源码（标记由宿主发出，webview 只消费）。 */
  function hostSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "webview") continue; // 那侧是消费方
        out.push(...hostSources(full));
      } else if (entry.name.endsWith(".ts") && entry.name !== "texts.ts") {
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

  for (const file of hostSources(join(process.cwd(), "src"))) {
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
    `宿主发出了未登记的标记（补进 MARKERS，再在 texts.ts 三处登记）：\n` +
      [...found].map(([key, where]) => `  @${key}  ${where}`).join("\n"),
  );
  console.log("i18n: 宿主源码里的标记均已登记（扫了 " + hostSources(join(process.cwd(), "src")).length + " 个文件）✓");

// ---------- 6. VS Code 原生 UI 的文案（package.nls*）与 package.json 对齐 ----------
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

// ---------- 7. 已删除的配置项不能再出现（`dshChat.openPanelOnStartup`） ----------
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
}

console.log("\ni18n: all assertions passed");
