/**
 * 防漏断言：动过**用户可见面**的提交必须动过 `CHANGELOG.md`。
 *
 * 为什么值得一条断言：`CHANGELOG.md` 不是普通仓库文档——vsce 的 `ChangelogProcessor` 会把它
 * 作为 `Microsoft.VisualStudio.Services.Content.Changelog` 资产打进 vsix（包内路径
 * `extension/changelog.md`），**VS Code 扩展页的「更新日志」标签页与商店页渲染的就是它**。
 * 也就是说它是用户可见文案，漏一次就是用户看不到这次改了什么——2026-09-21 发 0.9.0 时
 * 一次漏了 3 条（另外我自己那条也漏了），所以从「靠人记」改成「靠断言」。
 *
 * ## 判据（git 的能力，不是 git 的规则）
 *
 * git 只回答集合问题，「该不该写日志」是这条断言自己定的：
 *
 * - **区间** = `<最近一个 release tag>..HEAD`，用 `git describe --tags --abbrev=0` 取 tag。
 *   这个命令取的是「从 HEAD 可达的最近 tag」，所以 HEAD 本身就是发布提交时区间为空
 *   ——那是对的（发布提交自己带了日志），不必特判。
 * - **用户可见面** = `src/**`、`package.json`、`package.nls.json`、`package.nls.zh-cn.json`
 *   （界面与宿主、清单里的命令名与配置说明）。`scripts/**`、`docs/**`、`AGENTS.md` 这些
 *   用户看不见，不算。
 * - **豁免** = 提交信息里带 `Changelog: none`（供纯重构 / 内部整理用）。要显式写而不是
 *   让脚本自己猜「这次用户看不见吗」——那件事只有作者知道（与仓库里「拿不到证据就不动手」
 *   同一条纪律）。
 *
 * ## 精度上限（git 的既定行为，不是 bug）
 *
 * `git log -- <path>` 默认走 history simplification：**合并提交默认不列出**（这里显式
 * `--no-merges`，判据因此是「非合并提交」）、**改名不跟随**（要 `--follow`，只支持单文件）。
 * 本仓库是线性提交、`CHANGELOG.md` 没改过名，所以够用；真出了偏差，报出来的也是「多报了
 * 一条」，按提示补一条日志即可。
 *
 * ## 拿不到证据时不误报
 *
 * 不在 git 仓库里、没有 git、浅克隆（历史被截断，`describe` 不可信）——三种情况都**跳过并
 * 打印原因**，不判红。这条断言的价值是「在本仓库的正常克隆里拦住漏记」。
 *
 * 运行：npm test（已在 `esbuild.scripts.mjs` 的 entries 里登记）
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";

/** 用户看得见的路径：改了这些，用户就该在扩展的「更新日志」里读到。 */
const VISIBLE = ["src/", "package.json", "package.nls.json", "package.nls.zh-cn.json"];

/** 提交信息里的豁免标记（`Changelog: none`），只给用户看不见的改动用。 */
const EXEMPT = /(^|\n)\s*changelog:\s*none\b/i;

/** 跑一条 git 命令；失败（没有 git / 不是仓库 / 命令不认识）返回 undefined。 */
function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

interface Commit {
  hash: string;
  subject: string;
  body: string;
  files: string[];
}

/**
 * 解析 `git log --format=%x02%H%x1f%s%x1f%b%x1f --name-only` 的输出。
 *
 * 记录之间用 `\x02`，字段之间用 `\x1f`（这两个字符不会出现在提交信息或文件名里），
 * 因此「文件名」就是第 3 个 `\x1f` 之后的整段（每行一个）。
 */
function parseCommits(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of raw.split("\x02")) {
    if (!chunk.trim()) continue;
    const parts = chunk.split("\x1f");
    if (parts.length < 4) continue;
    const [hash, subject, body] = parts;
    commits.push({
      hash: (hash ?? "").slice(0, 7),
      subject: subject ?? "",
      body: body ?? "",
      files: (parts[3] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    });
  }
  return commits;
}

const isVisible = (file: string): boolean =>
  VISIBLE.some((prefix) => (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix));

// ---------- 1. 先确认「能不能判」：拿不到证据就跳过 ----------

if (git(["rev-parse", "--git-dir"]) === undefined) {
  console.log("changelogGuard: 不是 git 工作区（或没有 git），跳过 ✓");
} else if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
  console.log("changelogGuard: 浅克隆的历史被截断，区间不可信，跳过 ✓");
} else {
  const tag = git(["describe", "--tags", "--abbrev=0"]);
  if (tag === undefined) {
    console.log("changelogGuard: 还没有任何 release tag，没有可比区间，跳过 ✓");
  } else {
    const range = `${tag}..HEAD`;
    const raw = git([
      "log",
      "--no-merges",
      "--format=%x02%H%x1f%s%x1f%b%x1f",
      "--name-only",
      range,
    ]);
    // `git log` 在区间为空时输出空串（不是失败）：此时没有任何未发布的提交，正常通过
    const commits = raw === undefined ? [] : parseCommits(raw);

    const violations = commits.filter(
      (commit) =>
        commit.files.some(isVisible) &&
        !commit.files.includes("CHANGELOG.md") &&
        // 豁免标记在提交信息里：标题与正文都过一遍（作者可能把它写在 trailer 之外的任何位置）
        !EXEMPT.test(`${commit.subject}\n${commit.body}`),
    );

    assert.strictEqual(
      violations.length,
      0,
      "下列提交动了用户可见面（src/ 或清单）却没动 CHANGELOG.md——它是扩展页「更新日志」" +
        "里显示给用户的那一份：\n" +
        violations
          .map(
            (commit) =>
              `  - ${commit.hash} ${commit.subject}\n` +
              `      改了：${commit.files.filter(isVisible).join(", ")}`,
          )
          .join("\n") +
        "\n两种收场：补一条日志（新提交），或在提交信息里写 `Changelog: none`（仅限用户看不见的改动）。",
    );
    console.log(
      `changelogGuard: ${range} 的 ${commits.length} 个提交都已登记或豁免 ✓`,
    );
  }
}

console.log("\nchangelogGuard: all assertions passed");
