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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  contributes?: {
    commands?: { command: string; icon?: unknown }[];
  };
};

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
