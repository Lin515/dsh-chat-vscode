/**
 * 抽出当前版本的更新日志，作为 GitHub Release 的正文。
 *
 * 为什么要有这一步：CHANGELOG.md 已经按「用户会看到什么变化」写好了一份（vsce 也把它作为
 * 扩展的更新日志打进 vsix），Release 正文再手写一遍就是同一件事登记两处——迟早对不上。
 *
 * 找不到这个版本那一节时**直接失败**：与其发一份正文空白的 Release，不如让流程停下来去补日志。
 *
 * 用法：node scripts/releaseNotes.mjs [版本]     （省略版本即取 package.json 的 version）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv[2] ?? manifest.version;
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);

// 版本标题形如 `## 0.9.2（2026-09-23）`（全角括号；半角也认，避免有人手滑写成半角）
const start = lines.findIndex((line) => /^##\s+/.test(line) && new RegExp(`^##\\s+${version.replace(/\./g, "\\.")}\\s*[（(]`).test(line));
if (start === -1) {
  console.error(
    `[release-notes] CHANGELOG.md 里没有 ${version} 这一节。先按「用户会看到什么变化」写好这一版，` +
      `再发 Release——不要发一份没有说明的版本。`,
  );
  process.exit(1);
}

let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (lines[index].startsWith("## ")) {
    end = index;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (body === "") {
  console.error(`[release-notes] CHANGELOG.md 的 ${version} 那一节只有标题、没有内容。`);
  process.exit(1);
}

process.stdout.write(`${lines[start].trim()}\n\n${body}\n`);
