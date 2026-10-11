/**
 * 草稿区 `@` 引用的**渲染镜像**与命中判定（`src/webview/composerMention.ts`）。
 *
 * 用户 2026-10-10 口径：草稿里的引用要渲成**蓝色链接**，按住 Ctrl / Cmd 时再补
 * **下划线**、鼠标移上去变手指光标。输入框是 `<textarea>`——里面是一段连续纯文本，CSS
 * 选不中「其中某几个字」——所以可见的字全部由镜像层画、文本域自己的字透明，两层用同一个
 * 类名对齐排版（见 `styles/app.css`）。
 *
 * 这里钉两件事：
 * 1. **逐字相同**：切段拼回去必须与草稿一字不差。镜像层多一个字、少一个字，后面所有字
 *    的位置都会跟着漂，用户看到的就是一串错位的蓝字；
 * 2. **谁上色**：只有解得开目标的引用上链接色（解不开会话 id 的那种点不开，也不该看着
 *    像链接）。纯切段函数不改变输入；会话标题投影与绑定由会话草稿端口另行验证。
 *
 * 另有一组样式 / 接线断言：镜像层必须复用 `.composer-input` 的排版（自己另写一份字号 /
 * 行高 / 内边距就一定会与文本域漂开）、文本域字形透明但光标可见、选区半透明（不透明会把
 * 镜像层那些字整个盖住）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { draftSegments, hitsAnyRect } from "../src/webview/composerMention";

/**
 * 会话引用的**原始 token**（草稿 / 提交给服务端的就是它；服务端落盘时才折成 `@标题`）。
 *
 * 负载是 id 的 UTF-8 JSON 再 base64url——与 `shared/mentions.ts` 的解码同一条口径
 * （这里真走一遍编码，而不是喂一个刚好长得像的字符串）。
 */
const sessionToken = (label: string, id: string): string =>
  `@[${label}](dsh-session:${Buffer.from(JSON.stringify(id), "utf8").toString("base64url")})`;

// ---------- 1. 逐字还原：镜像层与文本域是同一个文本 ----------
{
  const drafts = [
    "帮我看看这个文件",
    "先看 @src/a.ts 再改别的",
    "@AGENTS.md",
    "见 @src/a.ts。",
    '读一下 @"my file.txt" 和第 12 行',
    "整个 @src/ 目录",
    `接上 ${sessionToken("昨天的排查", "sess-9")} 继续`,
    "接上 @[某个旧会话](dsh-session:%%%%) 继续",
    "两处引用 @src/a.ts 和 @src/b.ts 都在",
    "换行\n也要对上 @src/a.ts\n第三行",
  ];
  for (const draft of drafts) {
    const joined = draftSegments(draft)
      .map((segment) => segment.text)
      .join("");
    assert.strictEqual(
      joined,
      draft,
      `切段必须逐字还原草稿（镜像层与文本域共用同一个文本）：${JSON.stringify(draft)}`,
    );
  }
  assert.deepStrictEqual(draftSegments(""), [], "空草稿不渲染任何镜像片段");
  console.log("composerMention: 镜像层文本与草稿逐字相同 ✓");
}

// ---------- 2. 谁上链接色：只有可打开的引用 ----------
{
  assert.deepStrictEqual(
    draftSegments("先看 @src/a.ts 再改别的").map((segment) => [segment.text, segment.link]),
    [
      ["先看 ", false],
      ["@src/a.ts", true],
      [" 再改别的", false],
    ],
    "普通文本不上色、引用上色（蓝字只覆盖引用那一段）",
  );
  assert.ok(
    draftSegments("看看 src/a.ts 就行").every((segment) => !segment.link),
    "不带 `@` 的路径是普通文本，不能上色（看着像链接却点不开）",
  );
  console.log("composerMention: 只有可打开的引用上链接色 ✓");
}

// ---------- 3. 会话引用：上色的是**原文 token**，不是折好显示的 `@标题` ----------
{
  const token = sessionToken("昨天的排查", "sess-9");
  const marked = draftSegments(`接上 ${token} 继续`).filter((segment) => segment.link);
  assert.strictEqual(marked.length, 1, "整条会话引用上色（就是一段）");
  assert.strictEqual(
    marked[0]?.text,
    token,
    "上色的文本必须是原文 token：草稿里显示的就是它（折成 `@标题` 只发生在正文气泡里，" +
      "镜像层一折就会与文本域错位）",
  );
  assert.notStrictEqual(marked[0]?.text, "@昨天的排查", "不许把显示还原搬到草稿镜像层");
  console.log("composerMention: 会话引用按原文 token 上色 ✓");
}

// ---------- 4. 解不开的会话引用：只显示、不上色 ----------
{
  const draft = "接上 @[某个旧会话](dsh-session:%%%%) 继续";
  const segments = draftSegments(draft);
  assert.ok(
    segments.every((segment) => !segment.link),
    "解不开会话 id 的引用不做成链接（点了也不知道开哪一条），自然也不上链接色",
  );
  assert.strictEqual(
    segments.map((segment) => segment.text).join(""),
    draft,
    "不上色也要逐字渲染（那段文字照旧看得见）",
  );
  console.log("composerMention: 解不开的会话引用只显示不上色 ✓");
}

// ---------- 5. 每段的 `at` 是它在草稿里的起始下标（React 列表键） ----------
{
  const draft = "两处 @src/a.ts 和 @src/b.ts 都在";
  let offset = 0;
  const seen = new Set<number>();
  for (const segment of draftSegments(draft)) {
    assert.strictEqual(segment.at, offset, "`at` 必须是这一段在草稿里的起始下标");
    assert.ok(!seen.has(segment.at), "`at` 在原文里唯一（同一个键不能出现两次）");
    seen.add(segment.at);
    offset += segment.text.length;
  }
  console.log("composerMention: 切段的键就是原文下标且唯一 ✓");
}

// ---------- 6. 命中判定：读文字实际画出来的矩形 ----------
{
  const first = { left: 10, right: 40, top: 5, bottom: 20 };
  const second = { left: 0, right: 30, top: 21, bottom: 36 };
  assert.ok(hitsAnyRect([first], 25, 12), "矩形中间算命中");
  assert.ok(hitsAnyRect([first], 10, 5) && hitsAnyRect([first], 40, 20), "边界上算命中（闭区间）");
  assert.ok(!hitsAnyRect([first], 41, 12), "右边一点不算命中");
  assert.ok(!hitsAnyRect([first], 25, 4), "上一行不算命中");
  assert.ok(!hitsAnyRect([], 25, 12), "没有任何矩形时不算命中");
  assert.ok(
    hitsAnyRect([first, second], 12, 30),
    "一条引用跨行时有多个矩形：落在第二行的那个上同样算命中",
  );
  console.log("composerMention: 命中判定按实际矩形（含跨行多矩形）✓");
}

// ---------- 7. 样式：镜像层复用文本域的排版，字色与选区都安排明白 ----------
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  /** 取一条规则体（选择器按字面匹配）。 */
  const rule = (selector: string): string => {
    const found = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(css);
    assert.ok(found, `app.css 里必须有 ${selector} 的规则`);
    return found[1] ?? "";
  };

  const field = rule(".composer-field");
  assert.ok(/position:\s*relative/.test(field), "外层给镜像层当定位基准");
  assert.ok(
    /display:\s*flex/.test(field) && /flex-direction:\s*column/.test(field),
    "外层必须是列向 flex：文本域在普通块容器里会退回 inline-block，基线间隙让输入区凭空变高",
  );

  const mirror = rule(".composer-mirror");
  assert.ok(/position:\s*absolute/.test(mirror), "镜像层绝对定位（与文本域重合）");
  assert.ok(/pointer-events:\s*none/.test(mirror), "镜像层不接鼠标事件（事件归文本域，命中读它的矩形）");
  for (const property of ["font-size", "line-height", "padding", "font-family"]) {
    assert.ok(
      !new RegExp(`(^|[;{\\s])${property}\\s*:`).test(mirror),
      `镜像层不许自己写 ${property}：它必须复用 .composer-input 的排版，另写一份就会与文本域漂开`,
    );
  }

  assert.ok(
    /\.composer-mirror \.mention-mark\s*\{[^}]*color:\s*var\(--link\)/.test(css),
    "引用取链接色（与正文里的 `.mention-link` 同一档）",
  );
  assert.ok(
    /\.composer-mirror\.is-modifier \.mention-mark\s*\{[^}]*text-decoration:\s*underline/.test(css),
    "按住 Ctrl / Cmd 时给引用补下划线：静止态的颜色说明「这是引用」，下划线说明" +
      "「现在按下去会打开」（用户 2026-10-10 口径）",
  );
  assert.ok(
    /textarea\.composer-input\s*\{[^}]*-webkit-text-fill-color:\s*transparent/.test(css),
    "文本域的字形透明（看得见的字来自镜像层；只给文本域，镜像层是 div 不受影响）",
  );
  assert.ok(
    /textarea\.composer-input\s*\{[^}]*caret-color:/.test(css),
    "插入点必须显式给颜色（字形透明不该把光标一起干掉）",
  );
  const selection = rule(".composer-input::selection");
  assert.ok(
    /background:[^;]*(color-mix\([^;]*transparent|rgba\([^;]*,\s*0?\.\d+\s*\))/.test(selection),
    "选区底色必须半透明：不透明的话它会把镜像层那些字整个盖住，选中之后一片空白",
  );
  assert.ok(
    /\.composer-input::placeholder\s*\{[^}]*-webkit-text-fill-color:/.test(css),
    "占位符要把「字形透明」显式还回来，否则空输入框的提示语看不见",
  );
  console.log("composerMention: 镜像层复用排版、选区半透明、占位符可见 ✓");
}

// ---------- 8. 接线：镜像渲染、几何同步、命中判定的那几处不能各写一份 ----------
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /sessionDraft\.segments\(\)/.test(composer) && /value=\{displayDraft\}/.test(composer),
    "镜像层和文本域共用会话草稿端口的可见投影（绑定与渲染只有一处）",
  );
  assert.ok(
    /className=\{`composer-input composer-mirror\$\{modifierHeld \? " is-modifier" : ""\}`\}/.test(
      composer,
    ),
    "镜像层必须**共用** `composer-input` 这个类（字号 / 行高 / 内边距只有那一处，" +
      "只写 `.composer-mirror` 的话两层排版各按默认值走：实测 14px/20.3px 对 13px/normal），" +
      "并在按住 Ctrl / Cmd 时挂 `is-modifier`——下划线是渲染结果，必须由状态驱动",
  );
  assert.ok(
    /mirror\.style\.width = `\$\{el\.clientWidth\}px`/.test(composer),
    "镜像层的宽度从文本域同步：出滚动条时文本域的内容宽度会窄一条，不同步就错位",
  );
  assert.ok(
    /mirror\.scrollTop = el\.scrollTop/.test(composer),
    "草稿长过上限内滚时，镜像层跟着滚（否则蓝字停在原处）",
  );
  assert.ok(
    /new ResizeObserver\(\(\) => syncMirror\(\)\)/.test(composer),
    "文本域尺寸变了（拖侧栏 / 开合面板）也要重新对齐：那种改动不动草稿，" +
      "绘制前那一处不会重跑，镜像层会停在旧宽度上整段错位",
  );
  assert.ok(
    /hitsAnyRect\(mark\.getClientRects\(\), x, y\)/.test(composer),
    "命中判定读引用**实际画出来**的矩形（按字符位置估在等宽 + CJK 混排下必偏）",
  );
  assert.ok(
    /const next = modifierHeld && hitsMentionAt\(x, y\) \? "pointer" : "";/.test(composer),
    "手指光标与下划线同一个判据（按着 Ctrl / Cmd 且命中引用），不能各写一份",
  );
  console.log("composerMention: 镜像渲染 / 几何同步 / 命中判定各自只有一处 ✓");
}

console.log("\ncomposerMention: all assertions passed");
