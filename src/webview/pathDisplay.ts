/**
 * 单行标题里「路径」的拆分与省略口径。
 *
 * 用户反馈（2026-09-12）：读取节点的行号缀在**被省略的**路径后面，看起来违和——
 * `.row-detail` 用 `text-overflow: ellipsis` 从**右侧**省略，于是
 * `…/src/dsh/controller.ts` 在窄侧栏里会变成 `…/src/dsh/contro…`，后缀
 * `:100-120` 紧跟在半截文件名后面。
 *
 * 正确口径：**保住文件名**，省略发生在**路径前段**。做法是把路径拆成
 * 「目录部分 + 文件部分」，文件部分不参与压缩，目录部分在空间不足时从左被裁掉
 * （CSS 侧实现，见 `.row-detail-dir`）。行号紧跟在文件部分之后，因此永远贴在
 * 文件名右边。
 */

/** 拆分结果：目录（含结尾分隔符）与文件名。 */
export interface PathParts {
  /** 目录部分，含结尾分隔符；顶层文件（无目录）时为空串。 */
  dir: string;
  /** 最后一段（文件名 / 目录名）。 */
  name: string;
}

/**
 * 一段文本是否**像路径**——只有像路径时才做「保文件名」的省略。
 *
 * 天真的判据（「含空白就不是路径」）会误伤真实存在的带空格目录：
 * `src/sub/odd name/x.ts` 里的空白在一个**目录名中间**，它是路径。而
 * `cmake --build build-agent --parallel 8` 里的空白是**分隔参数**的，不是路径。
 *
 * 区分两者的可靠特征是**第一个 token**：
 * - 命令行 → 首个空白分隔的 token 是程序名，**不含路径分隔符**（`cmake`、`npm`）；
 * - 路径 → 首个 token 就已经含分隔符（`C:\Program`、`src/sub/odd`），
 *   因为路径的分隔符出现在空白之前。
 *
 * 另外排除 URL：`https://host/a/b` 的「末段」没有意义，主机名才有。
 */
export function looksLikePath(value: string): boolean {
  if (!value) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  const hasSeparator = value.includes("/") || value.includes("\\");
  if (!hasSeparator) return false;
  // 无空白 → 直接按路径处理（最常见的形态）
  const firstSpace = value.search(/\s/);
  if (firstSpace < 0) return true;
  // 有空白：看首个 token 里有没有分隔符。没有 → 更像命令行。
  const firstToken = value.slice(0, firstSpace);
  return firstToken.includes("/") || firstToken.includes("\\");
}

/**
 * 把一段像路径的文本拆成目录与文件名（不像路径则返回 undefined，调用方原样渲染）。
 *
 * 分隔符原样保留在 `dir` 里：Windows 路径回显 `\`、POSIX 回显 `/`，不去改写
 * 用户看到的东西。`dir` 为空串表示没有目录部分（`file.ts` 这类裸文件名）。
 */
export function splitPath(value: string): PathParts | undefined {
  if (!looksLikePath(value)) return undefined;
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  return { dir: value.slice(0, cut + 1), name: value.slice(cut + 1) };
}

/* ==================== 展示路径的根与完整路径（悬停标题） ==================== */

/**
 * 一段展示路径的「根 + 段」。
 *
 * 为什么界面自己也要一套：`@` 候选里既有服务器给的**相对路径**（`src/a.ts`），也有
 * 宿主补的**绝对路径**（`D:/dev/other/x.txt`）与 `../` 形态，还有界面自己合成的
 * 「上一层」行（`src/`、`../`、盘根回工作区的空 path）。长路径在窄侧栏里会被
 * `text-overflow: ellipsis` 截断，悬停必须能给出**完整目标**——于是要有一个不依赖
 * 宿主平台的纯字符串解析（`D:/`、`//server/share/`、`/` 三种根都认）。
 */
export interface DisplayPathParts {
  /** 根（`D:/`、`//server/share/`、`/`）；相对路径是空串。 */
  root: string;
  /** 根之后的段（`.` 与空段已去掉；`..` 原样保留，由调用方决定怎么消）。 */
  segments: string[];
}

/** 拆出展示路径的根与段（分隔符统一看成 `/`；不碰文件系统，纯字符串）。 */
export function displayPathParts(path: string): DisplayPathParts {
  const text = normalize(path);
  const drive = /^([A-Za-z]:)\//u.exec(text);
  if (drive) return { root: `${drive[1]}/`, segments: segmentsOf(text.slice(drive[0].length)) };
  const unc = /^(\/\/[^/]+\/[^/]+)\/?/u.exec(text);
  if (unc) return { root: `${unc[1]}/`, segments: segmentsOf(text.slice(unc[0].length)) };
  if (text.startsWith("/")) return { root: "/", segments: segmentsOf(text.slice(1)) };
  return { root: "", segments: segmentsOf(text) };
}

/**
 * 把候选 / 「上一层」行的展示路径解析成**完整绝对路径**（悬停标题）。
 *
 * - 目标本身已是绝对形态 → 原样（归一成正斜杠）；
 * - 相对形态 → 拼到 `cwd` 上，`.` 与 `..` 在拼接过程中消掉（`..` 到根就停）；
 * - 没有 `cwd`（旧宿主不发、或还没绑定会话）或 `cwd` 自己不是绝对形态 → `undefined`，
 *   调用方退回显示原样的相对路径（**不猜**）。
 */
export function resolveDisplayPath(cwd: string | undefined, path: string): string | undefined {
  const target = displayPathParts(path ?? "");
  if (target.root !== "") return joinDisplayPath(target.root, target.segments);
  const base = displayPathParts(cwd ?? "");
  if (base.root === "") return undefined;
  const segments = [...base.segments];
  for (const segment of target.segments) {
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return joinDisplayPath(base.root, segments);
}

function normalize(path: string): string {
  return (path ?? "").replaceAll("\\", "/");
}

function segmentsOf(text: string): string[] {
  return text.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function joinDisplayPath(root: string, segments: readonly string[]): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return `${base}${segments.join("/")}`;
}
