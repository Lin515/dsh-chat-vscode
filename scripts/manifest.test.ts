/**
 * 扩展清单（package.json）的图标口径：编辑器标题栏（文件组右上角）的
 * 「在本分组新建对话窗口」必须是**鲸鱼**——与活动栏 / 扩展图标同一只 DeepSeek
 * 鲸鱼，不许退回会话气泡 codicon（`$(comment-discussion)`，正是被换掉的那个）。
 *
 * 用户 2026-09-15 口径：这个按钮要用鲸鱼图标，不要会话图标。
 *
 * 为什么是 `{light, dark}` 两份单色 SVG：VS Code 1.83.0 曾把命令文件图标改成
 * mask 着色，1.83.1 又回退成按 SVG 原色渲染（microsoft/vscode#194710），所以
 * 浅色主题给黑、深色主题给白，两份各管一边（VS Code 的 Command icon 规范：
 * 16×16、单色、SVG）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  main: string;
  icon: string;
  l10n: string;
  files?: string[];
  contributes?: {
    commands?: { command: string; icon?: unknown }[];
  };
};

// 兼容既有的 `pkg` 命名（下面第一节读的是同一次解析结果）
const pkg = manifest;

// ---------- 1. 命令图标指向鲸鱼的两份 SVG，不是 codicon ----------
const command = pkg.contributes?.commands?.find(
  (entry) => entry.command === "dshChat.newSessionInGroup",
);
assert.ok(command, "package.json 必须有 dshChat.newSessionInGroup 命令");
const icon = command.icon as { light?: string; dark?: string } | string | undefined;
assert.ok(
  typeof icon === "object" && icon !== null,
  "newSessionInGroup 的图标必须是 {light, dark} 两份文件（深浅主题各一份单色鲸鱼）",
);
const { light, dark } = icon as { light?: string; dark?: string };
assert.strictEqual(light, "media/whale-light.svg", "浅色主题的图标应是 media/whale-light.svg");
assert.strictEqual(dark, "media/whale-dark.svg", "深色主题的图标应是 media/whale-dark.svg");
for (const path of [light, dark]) {
  assert.ok(
    !/^\$\(/.test(path as string),
    "图标不许退回 $(…) codicon——会话气泡（comment-discussion）正是被换掉的那个",
  );
}

// ---------- 2. 两份 SVG 必须真的在，且是「同一只鲸鱼」 ----------
//
// vsix 打包靠 `media/` 整目录进包，这里少一份按钮就哑成空白；路径数据与
// `media/icon.svg`（活动栏 / 扩展图标那只鲸鱼）逐字一致，只是尺寸（16×16）
// 与颜色（浅色黑 / 深色白）不同。
const brandD = /d="([^"]+)"/.exec(readFileSync(join(process.cwd(), "media", "icon.svg"), "utf8"))?.[1];
assert.ok(brandD, "media/icon.svg 里应当能取到鲸鱼的路径数据");
for (const [name, fill] of [
  ["media/whale-light.svg", "#000"],
  ["media/whale-dark.svg", "#fff"],
] as const) {
  const svg = readFileSync(join(process.cwd(), name), "utf8");
  assert.strictEqual(
    /d="([^"]+)"/.exec(svg)?.[1],
    brandD,
    `${name} 必须与 media/icon.svg 是同一只鲸鱼（路径数据一致）`,
  );
  assert.ok(svg.includes(`fill="${fill}"`), `${name} 的填充色应是 ${fill}（浅色黑 / 深色白）`);
  assert.ok(
    /width="16" height="16"/.test(svg),
    `${name} 应声明 16×16（命令图标规范：14×14 内容 + 1px 边距）`,
  );
}

console.log("manifest: newSessionInGroup = 鲸鱼图标（两份单色 SVG，与品牌鲸同形）✓");

// ---------- 3. 发布包用白名单 ----------
//
// `package.json` 的 `files` 是**白名单**（没列的不进包），`.vscodeignore` 是黑名单（没列的一律进包）。
// 黑名单已经漏过三次：`AGENTS.md`、四张测试截图、以及会话里随手写的 `ToDo.md`，每次都靠人记得补一行。
// 两条实测事实：
// ① vsce **不允许**两者共存——同时存在直接 exit 1（所以这个文件必须不存在）；
// ② `files` 里写错或过期的模式会让 vsce 退出 1 并点名，所以「写错」不会静默。
// 反过来，白名单会**静默漏掉需要的文件**：实测漏掉过 `CHANGELOG.md` 与 `LICENSE`（vsce 的
// readme / changelog / license 处理器只处理**通过了过滤**的文件，漏掉时不报错、包照出）。
// 所以下面按清单里真正被引用的位置逐条钉——删掉任何一条都会在这里变红。
{
  const root = process.cwd();
  assert.ok(
    !existsSync(join(root, ".vscodeignore")),
    "仓库里不许再出现 .vscodeignore：vsce 不允许它与 files 白名单共存，同时存在会让 npm run package 直接失败",
  );

  const files = manifest.files ?? [];
  assert.ok(files.length > 0, "package.json 必须有非空的 files 白名单，否则等于没有过滤");
  // 白名单模式一律用 `/`（npm/vsce 的约定），而 `join()` 在 Windows 上给反斜杠——断言必须两边都对，
  // 否则本地绿、Linux CI 红（或反之）
  const covered = (rawTarget: string): boolean => {
    const target = rawTarget.replace(/\\/g, "/");
    return files.some((pattern) => pattern === target || target.startsWith(`${pattern}/`));
  };

  // 由清单自己推导出「必须进包」的位置，而不是抄一份清单（抄的那份迟早与清单脱节）
  const required: [string, string][] = [
    [manifest.main, "main 指向的入口"],
    [manifest.icon, "扩展图标"],
    [join(manifest.l10n.replace(/^\.\//, ""), "bundle.l10n.zh-cn.json"), "VS Code 原生 UI 的中文译文"],
    ["package.nls.json", "package.json 里 %key% 的英文源串"],
    ["package.nls.zh-cn.json", "package.json 里 %key% 的中文串"],
    ["docs/demo.png", "README 引用的演示图（扩展详情页）"],
    ["CHANGELOG.md", "扩展页与商店页渲染的更新日志"],
    ["LICENSE", "许可证"],
    ["THIRD-PARTY-NOTICES.md", "随包第三方依赖的许可归属"],
  ];
  for (const [target, why] of required) {
    assert.ok(covered(target.replace(/^\.\//, "")), `files 白名单必须覆盖 ${target}（${why}）`);
  }
}
console.log("manifest: 发布包走 files 白名单，且清单引用的位置都被覆盖 ✓");
