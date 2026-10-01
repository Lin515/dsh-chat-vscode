/**
 * 源码级不变量：`switch` 里不能有重复的 `case`。
 *
 * 为什么需要这条：**重复 case 不会报错**——后面的那个永远不会执行，
 * 是彻底的死代码，但 TypeScript、eslint、测试全都不说话。本次就撞上了一次：
 * `applyProjection` 里我先加了一个新的 `case "contextPressure"`（占用条口径），
 * 而旧的那个（只同步模型胶囊的 contextWindow）还在下面 —— 新逻辑生效了，
 * **旧的那件事被静默丢掉**（模型胶囊不再更新窗口上限）。最后是 esbuild 的
 * `[duplicate-case]` 警告发现的，`npm run typecheck` 一路绿灯。
 *
 * 所以这条断言的价值不在「现在的代码是对的」，而在「下次改 `applyProjection`
 * 这种几十个 case 的长 switch 时，不会又悄悄盖掉一个分支」。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 递归收集 src 下的 .ts（不含 .d.ts）与 .tsx。 */
function sourceFiles(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * 递归收集 dir 下匹配 ext 的文件，供「本机专属路径」断言扫仓库内容用。
 *
 * 跳过三类不进仓库的东西：点开头的目录、`node_modules`、`docs/dsh-contract`
 * （`npm run dsh:check` 的生成物，.gitignore 里，不属于要审的内容）。
 */
function walkFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dsh-contract") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 去掉行注释与块注释，**保留字符串字面量**（case 标签本身就是字符串）。
 *
 * 必须自己写而不是用正则：`//` 出现在字符串里（例如 `"https://x"`）不是注释，
 * 而注释里出现的 `case "x":` 又不该被当成 case。两者只能靠一个真正的扫描器区分。
 */
function stripComments(source: string): string {
  let out = "";
  let inString: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        // 保留换行，行号才不会跑偏
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 找一个 switch 块内所有 `case "字面量"`，返回重复的字面量。
 *
 * 用花括号配平界定 switch 体，避免把两个不同 switch 里的同名 case 误判成重复
 * （这在 `projections.ts` 那种文件里很容易发生）。
 */
function duplicateCases(source: string): { name: string; line: number }[] {
  const duplicates: { name: string; line: number }[] = [];
  const switchRe = /\bswitch\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = switchRe.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    let inString: string | null = null;
    for (let i = bodyStart; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
      // 注释里的花括号不算（注释内容不进 out，所以这里只需跳过）
      if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    // 注释会**保持原长度**地去掉（换行保留），所以行号仍然对得上原文件
    const body = stripComments(source.slice(bodyStart, end + 1));
    const seen = new Map<string, number>();
    const caseRe = /\bcase\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
    let caseMatch: RegExpExecArray | null;
    while ((caseMatch = caseRe.exec(body)) !== null) {
      const name = caseMatch[1];
      const line = source.slice(0, bodyStart + caseMatch.index).split("\n").length;
      const previous = seen.get(name);
      if (previous !== undefined) duplicates.push({ name, line });
      else seen.set(name, line);
    }
  }
  return duplicates;
}

// ---------- 1. 探测能力自检：假源码必须被抓到 ----------
//
// 一条永远不报错的断言等于没有断言，所以先证明它认得出重复 case。
{
  const bad = `
    switch (key) {
      case "a": return 1;
      case "b": return 2;
      case "a": return 3;
    }
  `;
  const found = duplicateCases(bad);
  assert.strictEqual(found.length, 1, "重复 case 必须被抓到（否则这条断言没有价值）");
  assert.strictEqual(found[0].name, '"a"');
}
console.log("invariants: 重复 case 探测能力自检 ✓");

// ---------- 2. 两个不同 switch 里的同名 case 不算重复 ----------

{
  const fine = `
    switch (a) { case "x": break; }
    switch (b) { case "x": break; }
  `;
  assert.deepStrictEqual(duplicateCases(fine), [], "不同 switch 的同名 case 是正常的");
  // 注释里的同名 case 也不算
  const commented = `
    switch (a) {
      case "x": break;
      // case "x": 这行是注释
    }
  `;
  assert.deepStrictEqual(duplicateCases(commented), [], "注释里的 case 不算");
}
console.log("invariants: 不误报（不同 switch / 注释） ✓");

// ---------- 3. 真实源码：每个 switch 内 case 唯一 ----------

{
  const files = sourceFiles(join(process.cwd(), "src"));
  const problems: string[] = [];
  for (const file of files) {
    for (const dup of duplicateCases(readFileSync(file, "utf8"))) {
      problems.push(`${file.replace(process.cwd() + "\\", "")}:${dup.line} 重复的 case ${dup.name}`);
    }
  }
  assert.deepStrictEqual(
    problems,
    [],
    `同一个 switch 里有重复 case（后者永远不会执行，是静默死代码）：\n${problems.join("\n")}`,
  );
  console.log(`invariants: 扫了 ${files.length} 个源文件，无重复 case ✓`);
}

// ---------- 4. `guard(kind, fn)` 是**工厂**：语句位置漏掉调用 = 那段代码永远不执行 ----------
//
// 2026-09-15 的真实事故：守护进程的 `shutdown` 收尾体被写成 `guard("shutdown", () => {…});`
// ——`guard` 返回的是包装函数，不调用它，收尾体一行都不会跑，而 `stopping` 已经置真，
// 守护进程就变成僵尸：不退场、`tick` 从此直接 return（连「dsh 崩了要重起」都不再做）。
// TypeScript 与所有测试**都不报错**（回调没人接是合法代码），只能靠这条断言。
//
// 口径：要么把包装函数交给别人（`setInterval(guard(…))` / `socket.on(…, guard(…))`），
// 要么显式用 `runGuarded(…)`（= 立即执行）。**裸语句的 `guard(…)` 一律不许出现**。
{
  const file = join(process.cwd(), "src", "supervisor", "main.ts");
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  // 「语句位置」的判据：整行以 `guard(` 开头，且**上一条实质行**不是以 `(` / `,` 结尾
  // ——那种结尾说明它是某个外层调用的实参（`createServer(…, guard(…))` 这类换行写法）。
  // 这个启发式正好覆盖当初出事的位置：`shutdown` 里那行的上一行是 `stopping = true;`。
  const statementish: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!/^guard\(/.test(line)) continue;
    let prev = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("//") || candidate.startsWith("*") || candidate.startsWith("/*")) continue;
      prev = candidate;
      break;
    }
    if (!/[,(]$/.test(prev)) {
      statementish.push(`src/supervisor/main.ts:${i + 1} ${line}（上一行：${prev}）`);
    }
  }
  assert.deepStrictEqual(
    statementish,
    [],
    `guard 的返回值在语句位置被丢掉了（那段回调永远不会执行）：\n${statementish.join("\n")}`,
  );
  assert.ok(
    /guard<\[\]>\(kind, fn\)\(\)/.test(source),
    "runGuarded 必须真的调用 guard 返回的包装函数（否则它自己就是同一个坑）",
  );
  assert.ok(
    /runGuarded\("shutdown", \(\) => \{/.test(source),
    "收尾体（shutdown）必须走 runGuarded——写成裸 guard(…) 的话收尾永远不会执行",
  );
}
console.log("invariants: guard 工厂的返回值不被丢弃（收尾体真的会跑）✓");

// ---------- 5. 安全不变量（2026-09-17 全项目审计立的口径） ----------
//
// 这几条都有同一个性质：**改错了什么都不会报错**。类型系统看不见清单里的 `scope`，
// 也看不见"删目录之前先验 id"这种顺序要求；而它们的代价都是安全级别的
// （工作区里的一行设置就能执行命令 / 一个服务端给的 id 就能删掉别的目录）。
{
  // 5.1 `dshChat.command` 是要**经 shell 执行**的字符串，`dshChat.url` 决定
  //     令牌与聊天内容发到哪个 origin。两者都必须是 `machine` 作用域：
  //     工作区（尤其是克隆来的别人的仓库）不许覆盖它们。
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    contributes?: { configuration?: { properties?: Record<string, { scope?: string }> } };
  };
  const properties = manifest.contributes?.configuration?.properties ?? {};
  for (const key of ["dshChat.command", "dshChat.url"]) {
    assert.strictEqual(
      properties[key]?.scope,
      "machine",
      `${key} 必须是 "scope": "machine"——否则工作区的 .vscode/settings.json 就能覆盖它` +
        `（command 是经 shell 执行的命令，url 决定凭据发到哪个服务器）`,
    );
  }
  console.log("invariants: 会执行命令 / 决定凭据去向的配置项锁在 machine 作用域 ✓");

  // 5.2 删除会话 = `rmSync(recursive)`，而会话 id 是**服务端给的**。
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /function isSafeSessionId\(/.test(controller) && /if \(!isSafeSessionId\(sessionId\)\)/.test(controller),
    "deleteSession 必须先按 isSafeSessionId 收窄会话 id（纯目录名），否则 `..\\..\\x` 这类 id 能删到会话根之外",
  );
  assert.ok(
    /const rootResolved = resolve\(root\);/.test(controller) &&
      /candidate\.startsWith\(rootResolved \+ sep\)/.test(controller),
    "findSessionDir 必须做包含性检查（resolve 之后必须在会话根目录里面）——这是第二道",
  );
  console.log("invariants: 删会话前有 id 形状校验 + 路径包含性检查 ✓");

  // 5.3 按端口兜底杀进程之前必须有身份证据（端口可能已被无关程序接管）
  const supervisorMain = readFileSync(join(process.cwd(), "src", "supervisor", "main.ts"), "utf8");
  assert.ok(
    /export function looksLikeDsh\(/.test(supervisorMain) &&
      /if \(!looksLikeDsh\(pid\)\) \{/.test(supervisorMain),
    "killServer 在杀「监听某端口的 pid」之前必须用 looksLikeDsh 确认身份（拿不到证据就不动手）",
  );
  console.log("invariants: 端口兜底杀进程前先验身份 ✓");

  // 5.4 日志尾巴会进界面与输出通道，而 dsh 的启动公告行里带着启动令牌
  const supervisorManager = readFileSync(join(process.cwd(), "src", "dsh", "supervisorManager.ts"), "utf8");
  assert.ok(
    /function redactSecrets\(/.test(supervisorManager) && /redactSecrets\(\s*text/.test(supervisorManager),
    "logTail 必须过 redactSecrets：日志里那一行 dsh 公告带着 `?token=…`，它会印到连接条/诊断弹窗里",
  );
  console.log("invariants: 日志尾巴里的启动令牌被隐去 ✓");

  // 5.5 并发 bringUp 必须合并（两次同时跑会 spawn 两个 dsh，前一个的 pid 再也找不回来）
  assert.ok(
    /const bringUp = \(\): Promise<void> => \{/.test(supervisorMain) &&
      /if \(bringUpInFlight\) \{/.test(supervisorMain),
    "supervisor 的 bringUp 必须合并并发调用（否则 restart 撞上崩溃重起会留下一个谁也看不见的孤儿 dsh）",
  );
  console.log("invariants: supervisor 的 bringUp 合并并发调用 ✓");
}

// ---------- 6. 空态就是一条真会话（用户 2026-10-01 口径，对齐官方 DSH Web） ----------
//
// 这条口径 2026-10-01 从「点「+」不落会话记录、第一条消息才建」**改过来**：官方
// `ui-workspace` 的 `startSession` → `openWorkspace` → `reuseOrCreateBlank` 决定
// 「打开一个工作区就有一条 blank 会话」，空态页显示的每一个值（预设/模型/权限）都是
// 那条会话的真实值。**空壳的判据必须包含客户端本地的 blank 位**——官方有事件流
// （`blankBit` 在 prompt 受理那一刻翻假），本扩展只有拉的 `session/list`，缺了本地
// 这一位就会把已经说过话的会话当成空壳接回去，首条消息落进上一个对话（用户
// 2026-10-01 报的现场）。失败方式同样安静：类型系统与既有断言都不说话。
//
// 按源码钉住：
//  1. 「+」与「窗口就绪」都必须**落到本工作区那条壳**上，且**不弹**目录选择器；
//  2. 需要真会话的入口（发消息 / 加附件 / 跑命令 / 点「+」/ 菜单）都汇到 `ensureSession`，
//     只有它认识「没有工作目录就建不了壳」这条边界；
//  3. `ensureSession` 在要目录的那条路上先 `askWorkspaceDir()`，不要的那条路上先判
//     `hasWorkspaceDir()`——绝不拿宿主的 cwd 冒充工作目录；
//  4. 空壳复用判据不许多加自加的排除条件（口径 3，尤其不许排除「别的窗口正开着它」）；
//  5. 本地 blank 位必须在「prompt 受理」与「服务端说它在跑」两处点亮，并在列表刷新时
//     折进列表行（官方的 `effectiveBlank`）。
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");

  /** 抠出一个方法体：从签名到下一个同缩进的注释/成员声明（够用的边界判据）。 */
  const bodyOf = (signature: string): string => {
    const start = controller.indexOf(signature);
    assert.ok(start >= 0, `controller.ts 里找不到 ${signature}`);
    const rest = controller.slice(start + signature.length);
    const end = rest.search(/\n  \/\*\*|\n  (?:private|public|protected|async|readonly|get|set) /);
    return end < 0 ? rest : rest.slice(0, end);
  };

  const newSession = bodyOf("async newSession(");
  assert.ok(/this\.detachView\(viewId\)/.test(newSession), "「新建对话」必须先把窗口退出现有会话");
  assert.ok(
    /ensureSession\(viewId, \{ start: true, askDir: false \}\)/.test(newSession),
    "「新建对话」必须落到本工作区那条空壳会话上，且**不弹**目录选择器" +
      "（没有工作目录时窗口停在「无会话的空态」，见 ensureSession）",
  );
  assert.ok(
    !/this\.createSession\b|createSessionInWorkspace/.test(newSession),
    "「新建对话」自己不许建会话——找壳 / 建壳只有 reuseOrCreateBlank 一处",
  );
  // **先切、后建**（用户 2026-10-01 报「点 + 有明显停顿感，像是先建会话再切换」）：
  // 落壳那串往返不许挡在切换前面。这条失败起来很安静——界面照样会切过去，只是慢一两秒，
  // 没有报错、没有红断言，只有用户觉得卡。
  assert.ok(
    /this\.detachView\(viewId\);[\s\S]{0,260}?this\.emitToView\(viewId, \{ type: "state", state: this\.snapshotFor\(viewId\) \}\);[\s\S]{0,140}?await this\.ensureSession\(/.test(
      newSession,
    ),
    "「新建对话」必须先同步退回空态并推那一帧，**再** await 落壳" +
      "（否则界面要等「连后台 → 建会话 → 拉列表」整串往返）",
  );
  // 手里已经有现成空壳时更快：同步换绑，连那一帧空态都不必先推
  const syncSwitch = bodyOf("private switchToBlankSync(");
  assert.ok(
    /this\.detachView\(viewId\)[\s\S]*?this\.ensureScope\(sessionId\)[\s\S]*?this\.bindViewToSession\(viewId, sessionId, scope\)[\s\S]*?this\.emitToView\(/.test(
      syncSwitch,
    ),
    "switchToBlankSync 的次序必须是「解绑 → 建域 → 换绑 → 推帧」（与异步那条路同构）",
  );
  assert.ok(
    !/\bawait\b/.test(syncSwitch),
    "switchToBlankSync 必须是**纯同步**的：它的全部意义就是让点「+」不花任何往返，一次 await 都不许有",
  );

  for (const [signature, label] of [
    ["private async send(", "发消息"],
    ["private async runCommand(", "跑命令"],
    ["private async ingestAttachments(", "加附件"],
  ] as const) {
    const body = bodyOf(signature);
    assert.ok(
      /ensureSession\(viewId, \{ start: true, askDir: true \}\)/.test(body),
      `${label}没有会话时必须先走 ensureSession（要目录那条路：没有工作目录时问一次）`,
    );
    assert.ok(!/this\.newSession\(/.test(body), `${label}不该借 newSession 落会话（它只退出现有会话）`);
  }

  const ensure = bodyOf("private async ensureSession(");
  assert.ok(
    /askWorkspaceDir\(\)/.test(ensure),
    "落会话之前必须先确定工作目录：没有打开文件夹、也没选过目录时问一次" +
      "（拿宿主的 cwd 冒充会得到 VS Code 的安装路径，用户 2026-09-22 报的现场）",
  );
  assert.ok(
    /else if \(!this\.hasWorkspaceDir\(\)\) \{[\s\S]*?return undefined;/.test(ensure),
    "不弹目录选择器的那条路必须自判「有没有目录」：没有目录就建不了壳，" +
      "窗口停在「无会话的空态」（见 hasWorkspaceDir）",
  );

  // 菜单（`/` 命令栏、`@` 候选）要的目录同样是会话作用域的，但**不许**顺手弹目录
  // 选择器：菜单是随手打开的（用户 2026-09-24 口径）。现在空态窗口一进来就绑在壳上，
  // 这里只是兜一道「窗口就绪时还没连上」的底。
  for (const [signature, label] of [
    ["private async listCommandsForView(", "`/` 命令栏"],
    ["private async queryFiles(", "`@` 候选"],
  ] as const) {
    const body = bodyOf(signature);
    assert.ok(
      /ensureSession\(viewId, \{ start: true, askDir: false \}\)/.test(body),
      `${label}拿不到会话时要按需落壳，且不许弹目录选择器`,
    );
  }

  // 空壳的复用判据（官方 reuseOrCreateBlank 的扫描）：服务端说它空、本地 blank 位没标它
  // 说过话、落在本工作区、不是归档 / 子代理。**不许多任何自加条件**。
  const reusable = bodyOf("private reusableBlank(");
  assert.ok(
    /row\.blank !== true/.test(reusable) && /this\.engagedSessions\.has\(row\.id\)/.test(reusable),
    "空壳判据必须同时看服务端的 blank 与本地 blank 位（engagedSessions）——" +
      "只看服务端会把已经说过话的会话当空壳接回去（用户 2026-10-01 报的现场）",
  );
  assert.ok(
    /normalizePath\(row\.cwd\) !== target/.test(reusable),
    "空壳必须落在本工作区（cwd 归一后相同）",
  );
  assert.ok(
    !/viewSessions/.test(reusable),
    "空壳判据里不许有「别的窗口正开着它」这条自加排除（用户 2026-10-01 口径：" +
      "两个窗口 / 两个客户端共用同一条空壳是容许的，官方字面就是这样）",
  );

  // 本地 blank 位的两个写入点：prompt 受理（send）与服务端说它在跑（列表行 running）。
  const send = bodyOf("private async send(");
  assert.ok(
    /this\.markSessionEngaged\(scope\.sessionId\)/.test(send),
    "消息被受理那一刻必须点亮本地 blank 位（否则下一个人点「+」会接回这条已经用过的会话）",
  );
  const setRunning = bodyOf("private setSessionRowRunning(");
  assert.ok(
    /if \(running\) this\.markSessionEngaged\(sessionId\)/.test(setRunning),
    "服务端说这条会话在跑也必须点亮本地 blank 位（别的窗口 / dsh web 在里面说话这条路只有它看得见）",
  );
  // 列表刷新时把本地那一折进列表行（官方的 effectiveBlank）：少了它，刚发出第一条消息的
  // 会话会随下一次拉取从历史列表里消失一下再回来。
  assert.ok(
    /item\.blank === true && this\.engagedSessions\.has\(item\.id\) \? \{ \.\.\.item, blank: false \}/.test(
      controller,
    ),
    "session/list 刷新时必须把本地 blank 位折进列表行（effectiveBlank）",
  );

  // 空态页那一行目录的两种非锁定形态：选过 → 显示路径（盘符大写）；没选过 → 空串
  // （界面显示「未选择工作区」）。空串是真的过线的值，所以这里也钉一下它不会被
  // 回退成 cwd——没有选过目录时不得碰 `process.cwd()`。
  const workspaceView = bodyOf("private workspaceView(");
  assert.ok(
    /newSessionCwd \? upperDriveLetter\(this\.newSessionCwd\) : ""/.test(workspaceView),
    "没选过目录时 `path` 必须是空串（界面显示「未选择工作区」），不能用 process.cwd() 兜底；选过时盘符要大写",
  );

  // 连壳都还没有的那一段（没有工作目录）显示的权限 / 模型必须是「用户点过的 > 配置文件里的
  // 部署默认」。缺了默认兜底，权限胶囊会退到界面词典的硬编码档位（用户报的现场：配置默认
  // danger-full-access，空态页却显示 workspace-write），模型与思考强度则整枚消失。
  const pendingFields = bodyOf("private pendingViewFields(");
  assert.ok(
    /viewModel\.get\(viewId\) \?\? this\.defaultModel/.test(pendingFields),
    "空态页的模型显示必须回退到部署默认（defaultModel，读自 agent-default-model 配置）",
  );
  assert.ok(
    /viewPermission\.get\(viewId\) \?\? this\.defaultPermission/.test(pendingFields),
    "空态页的权限显示必须回退到配置文件的默认预设（defaultPermission，读自 permission.defaultPreset）",
  );

  // 有壳之后权限直接写在壳上（`/permission`），不再记「待建」；只有连壳都没有的那一段
  // （没有工作目录）才落到 `viewPermission`。
  const setPermission = controller.match(/case "setPermission": \{[\s\S]*?\n      \}/)?.[0] ?? "";
  assert.ok(setPermission, "controller.ts 里找不到 setPermission 分支");
  assert.ok(
    /viewPermission\.set\(viewId/.test(setPermission) &&
      /runCommand\(viewId, `\/permission \$\{message\.permission\}`\)/.test(setPermission),
    "权限要么记成落壳时的选择（没有壳），要么直接跑在壳上（有壳）",
  );

  // 会话启动时按界面显示的设定运行：空态页选过的权限与部署默认不同，落壳后要落实。
  const shell = bodyOf("private async reuseOrCreateBlank(");
  assert.ok(
    /wantedPermission && wantedPermission !== this\.defaultPermission/.test(shell) &&
      /runCommand\(viewId, `\/permission \$\{wantedPermission\}`\)/.test(shell),
    "空态页选过且不同于部署默认的权限必须在落壳后落实（否则实际与 UI 错位）",
  );
  assert.ok(
    /reusable === undefined/.test(shell),
    "「真新建」与「复用」必须分开：复用那条会话有它自己的预设与模型，不能被这次的待建值覆盖",
  );

  // **后台补壳不许抢恢复**（用户 2026-10-02 报的「重载后历史会话一闪变成空会话」）。
  //
  // 两条自动路径都会在窗口还没有会话时补一条空壳（`onConnected` 与 `ready` 尾巴）；
  // 补壳链从判据走到写绑定跨着整串往返（`ensureWorkspace` / `session/create` /
  // `refreshSessions`），而这一轮恢复可能正在接回关闭前那条历史会话。写绑定前不复查
  // 就会把它顶掉——现象是「会话内容先出现、随后一闪变成空会话」，用户看到的正是这个。
  //
  // 两道防线缺一不可，分别钉住：
  //  1. 补壳入口跳过「这一轮恢复还没结算」的窗口（`hasRestorePending`）。这条只看得到
  //     恢复，看不到**用户**在历史抽屉里点的那一下；
  //  2. `reuseOrCreateBlank` 写绑定前复查 `scopeOfView`——它挡的是这一类「读状态 →
  //     await → 写状态」的全部同类问题（用户点的那条、恢复接回的那条都算）。
  //     这条失败起来同样安静：绑定照样成功，只是绑错了会话。
  const adopt = bodyOf("private async adoptBlankForUnboundViews(");
  assert.ok(
    /hasRestorePending\(viewId\)[\s\S]{0,40}?continue;/.test(adopt),
    "后台补壳必须跳过「这一轮恢复还没结算」的窗口（抢跑就是「历史会话一闪变成空会话」）",
  );
  assert.ok(
    /scopeOfView\(viewId\)[\s\S]*?if \(bound\) return bound;[\s\S]*?this\.bindViewToSession\(viewId, created\.sessionId, scope\)/.test(
      shell,
    ),
    "空壳写绑定前必须复查窗口有没有被别的路径绑走（恢复路径、用户点历史里的一条）：" +
      "不复查就会把那条会话顶掉，且不报任何错",
  );
  console.log(
    "invariants: 空态必有壳、壳的复用判据含本地 blank 位、没有目录时不建壳、菜单按需落壳不弹框、" +
      "后台补壳让位恢复 ✓",
  );
}

// ---------- 7. 代码与文档里不许有本机专属路径（全局口径 2026-10-01） ----------
//
// 全局口径：任何项目的文档、代码中都不要有依赖本机的设置或路径。此前真实漏过的
// 形态：本仓库的落盘位置（盘符路径里带着仓库目录名，如探针里写死的 `REPO`）、
// 真实用户主目录（`C:\Users\<具体用户名>`）、夹具里出现过的本机其它项目名……
// 它们不报错、测试照绿，只在不该出现的地方泄露环境信息，换台机器就失真。
//
// 判据刻意**结构化**而不把特征串写死进仓库——把本机的用户名/项目名提交进来，
// 本身就是又一条本机痕迹。三层：
// 1. 盘符路径指向**本仓库**：包名从 package.json 现读，任何克隆位置都认得出。
//    冒号后只接一个分隔符才算路径（`https://` 这类 scheme 的 `//` 不误伤）；
// 2. 真实样式的用户主目录（`盘符:\Users\名字` 与 `/home/名字`）：`me`/`x`/`user`
//    这类占位名放行，尖括号占位符（如 `C:\Users\<用户名>`）天然不命中；
// 3. 可选的本机扩展清单 `.agent/banned-path-tokens.txt`（`.agent/` 在 gitignore
//    里，不进仓库）：一行一个字面子串，只属于某台机器的痕迹只记录在本机。
{
  const repoName = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { name?: string })
    .name ?? "";
  assert.ok(repoName, "package.json 必须有 name（第 1 条判据要用它识别本仓库的落盘位置）");

  const files = [
    ...walkFiles(join(process.cwd(), "src"), /\.tsx?$|\.css$/),
    ...walkFiles(join(process.cwd(), "scripts"), /\.tsx?$|\.mjs$|\.md$/),
    ...walkFiles(join(process.cwd(), "test"), /\.html?$/),
    ...walkFiles(join(process.cwd(), "docs"), /\.md$/),
    ...["AGENTS.md", "README.md", "CHANGELOG.md", "THIRD-PARTY-NOTICES.md"]
      .map((name) => join(process.cwd(), name))
      .filter(existsSync),
  ];

  // 冒号后「只接一个分隔符」：scheme（`https://`、`ws://`）与 `file:///C:/…` 里
  // 紧跟盘符的写法都要么被 `//` 挡掉、要么本来就是真盘符，不会把 URL 误判成路径。
  const repoPath = new RegExp(
    "(?<![A-Za-z0-9+./-])[A-Za-z]:[\\\\/](?![\\\\/])[^\\s\"']*" +
      repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi",
  );
  // 用户名段至少 2 字符：单字母（/home/x 这类夹具）天生是占位符；`...` 是注释里
  // 对真实报错做脱敏的省略号（dshLocks 的崩溃日志引用），同样放行。
  const PLACEHOLDER_NAMES = new Set(["...", "me", "user", "username", "you", "name"]);
  const userProfile = /(?<![A-Za-z0-9+./-])[A-Za-z]:[\\/](?![\\/])Users[\\/]+([A-Za-z0-9_.-]{2,})/gi;
  const homeDir = /\/home\/([A-Za-z0-9_.-]{2,})/g;

  const tokenFile = join(process.cwd(), ".agent", "banned-path-tokens.txt");
  const localTokens = existsSync(tokenFile)
    ? readFileSync(tokenFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
    : [];

  const problems: string[] = [];
  const lineAt = (text: string, at: number): number => text.slice(0, at).split("\n").length;
  /** 一条判据的完整决策：正则命中**且**不是占位符才算数（循环与自检共用这一份）。 */
  const reports = (rx: RegExp, sample: string): boolean => {
    for (const match of sample.matchAll(rx)) {
      if (!PLACEHOLDER_NAMES.has((match[1] ?? "").toLowerCase())) return true;
    }
    return false;
  };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const label = file.replace(process.cwd() + "\\", "");
    for (const match of text.matchAll(repoPath)) {
      problems.push(`${label}:${lineAt(text, match.index ?? 0)} 盘符路径指向本仓库（${match[0]}）`);
    }
    for (const match of text.matchAll(userProfile)) {
      if (PLACEHOLDER_NAMES.has((match[1] ?? "").toLowerCase())) continue;
      problems.push(`${label}:${lineAt(text, match.index ?? 0)} 真实样式的用户主目录（${match[0]}）`);
    }
    for (const match of text.matchAll(homeDir)) {
      if (PLACEHOLDER_NAMES.has((match[1] ?? "").toLowerCase())) continue;
      problems.push(`${label}:${lineAt(text, match.index ?? 0)} 真实样式的用户主目录（${match[0]}）`);
    }
    for (const token of localTokens) {
      let at = text.indexOf(token);
      while (at >= 0) {
        problems.push(`${label}:${lineAt(text, at)} 本机特征串「${token}」`);
        at = text.indexOf(token, at + token.length);
      }
    }
  }
  assert.deepStrictEqual(
    problems,
    [],
    `代码/文档里发现了本机专属路径（虚构示例请用中性名，如 demo-app / C:\\work\\demo）：\n${problems.join("\n")}`,
  );

  // 探测能力自检：三条判据对**真违规**要响、对**占位符**要哑（否则这条断言没有
  // 价值）。样例在源码里写成 `\\` 转义 / 分段拼接——否则这段自检自己就会被自己扫中。
  assert.ok(
    reports(repoPath, `D:\\dev\\${repoName}\\src\\a.ts`),
    "探测能力自检：盘符路径指向本仓库的判据必须命中",
  );
  assert.ok(reports(userProfile, "C:\\Users\\someone\\x"), "探测能力自检：用户主目录的判据必须命中");
  assert.ok(reports(homeDir, "/home/" + "someone/x"), "探测能力自检：POSIX 主目录的判据必须命中");
  for (const [label, fired] of [
    ["URL 的 scheme", () => reports(repoPath, "见 https://example.com/x")],
    ["占位用户名 me", () => reports(userProfile, "C:\\Users\\me\\demo")],
    ["省略号脱敏", () => reports(userProfile, "C:\\Users\\...\\.dsh")],
    ["单字母占位", () => reports(homeDir, "/home/" + "x/a")],
  ] as Array<[string, () => boolean]>) {
    assert.ok(!fired(), `探测能力自检：${label} 不该命中`);
  }

  console.log(
    `invariants: 本机路径清零（仓库落盘位置 / 用户主目录 / 本机扩展清单 ${localTokens.length} 条）：扫了 ${files.length} 个文件 ✓`,
  );
}

console.log("\ninvariants: all assertions passed");
