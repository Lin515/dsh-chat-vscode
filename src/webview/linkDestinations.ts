/**
 * 链接目标里 **Windows 反斜杠路径**的保护：tokenizer 层修复。
 *
 * **问题**：CommonMark 规定链接目标里「`\` + ASCII 标点」是转义序列。marked 的
 * `Tokenizer.link` 对目标串做 `href.replace(rules.inline.anyPunctuation, "$1")`，
 * 于是路径里每一个「反斜杠 + ASCII 标点」的分隔符都会丢：点目录（`\.agent`）是
 * 最常见的触发形状，`\_cache`、`\-tmp`、`\!out` 这类同样中招；后面跟字母的
 * `\dev`、`\temp` 不受影响，所以只有目录名以标点开头时才犯。
 * 模型写 `[标题](D:\app\demo\.agent\file.txt)`，到点击判定
 * （`fileLinks.parseFileLink`）手里就只剩 `D:\app\demo.agent\file.txt`，点开必然
 * 「找不到文件」；`![](D:\app\demo\.agent\图.png)` 同理，本地图片那条路按
 * `imageRef.localImagePath` 还原出来的也是错的路径，界面显示「图片加载失败」。
 * 官方 `dsh web` 的 micromark 管线走的是同一条 CommonMark 规则（同病），
 * 本扩展在此**刻意偏离官方**修复。
 *
 * **做法**：覆写 `link` tokenizer——先调默认实现拿 token，再用同一条正则取回
 * **原始**目标串；当目标呈 Windows 绝对路径形状（盘符或 `\\` UNC 开头）时，把
 * 反斜杠预先编码成 `%5C` 再交回默认渲染链（marked 的 `encodeURI` 不碰 `%5C`，
 * 点击侧的 `parseFileLink` 与图片侧的 `imageRef.localImagePath` 都用
 * `decodeURIComponent` 还原）。修复前先按默认实现重放一遍并核对产出一致，
 * **括号配平等解析分歧一律保持默认行为**——不猜、不改语义。
 *
 * **边界（刻意不修）**：
 * - 非 Windows 形状的目标保持 CommonMark 原语义（`a\.b` 仍是转义）；
 * - 参考式定义（`[x]: D:\a\.b`）不走这条 tokenizer；
 * - 正文里的**裸路径文本**与链接**文字**（标签）不修：那是 CommonMark 的文本转义，
 *   动它等于取消整条转义语义（行内代码 `` `D:\a\.b` `` 本来就不受影响）。
 *
 * 断言见 `scripts/markdown.test.ts` 的「Windows 反斜杠路径的链接 / 图片目标」一段：
 * 渲染产物喂真实 `parseFileLink`、`localImagePath` 与宿主白名单
 * （`dsh/localImages.ts` 的 `resolveLocalImagePath`），落到盘上真实文件。
 * 结论与刻意偏离官方的口径记在 `docs/audit-summary.md` 的修复一览里。
 */

import { Tokenizer, type Tokens } from "marked";

/**
 * Windows 绝对路径形状：盘符（`C:\`、`C:/`）或 UNC（`\\host`）开头。
 *
 * 为什么认这个形状：目标里出现反斜杠时，「路径分隔符」与「转义序列」本来就同形，
 * 只有 Windows 绝对路径是无歧义的路径（相对目标里的 `\` 一律按 CommonMark 转义，
 * 不动）。盘符那一支与 `shared/imageRef.ts` 的盘符判据、`fileLinks.parseFileLink`
 * 放行的 scheme 形状同一口径。
 *
 * **UNC 只在这里保住路径文本**：`parseFileLink` 与 `imageRef` 的宿主白名单照旧
 * 拒绝 UNC（那是**另一台机器**上的东西，不是本地文件），所以这一支不放松任何准入。
 */
const WINDOWS_PATH_DEST = /^(?:[a-z]:[\\/]|\\\\)/iu;

/**
 * 需要挂进 marked 实例的 tokenizer 覆写（`link` 同时处理 `[]()` 与 `![]()`）。
 *
 * @returns 传给 `new Marked({ tokenizer: ... })` 的那一组覆写。
 */
export function windowsPathTokenizers(): {
  link(this: Tokenizer, src: string): Tokens.Link | Tokens.Image | undefined;
} {
  return {
    link(this: Tokenizer, src) {
      // 默认实现先跑：括号配平、尖括号目标、引号标题、pedantic 分支都在它那里，
      // 这里不复制也不重写（`this` 是真正的 Tokenizer 实例，见 marked 的
      // `Marked.use`：覆写函数以实例为接收者调用）
      const token = Tokenizer.prototype.link.call(this, src);
      if (!token) return token;
      const cap = this.rules.inline.link.exec(src);
      if (cap?.[2] === undefined) return token;
      // 镜像默认实现的预处理（trim → 尖括号剥离）；只在能对上默认产出时才动手
      let rawHref = cap[2].trim();
      if (this.rules.other.startAngleBracket.test(rawHref)) {
        rawHref = rawHref.slice(1, -1);
      }
      if (!WINDOWS_PATH_DEST.test(rawHref)) return token;
      // 重放默认实现的那一步转义处理：对不上就说明这条目标的解析有分歧
      // （典型是括号配平被 tokenizer 改写过 cap），此时保持默认行为
      const replayed = rawHref.replace(this.rules.inline.anyPunctuation, "$1");
      if (replayed !== token.href) return token;
      // 反斜杠编码成 %5C：marked 的 encodeURI 不碰它，下游的 decodeURIComponent
      // 恰好还原出原始路径（点击判定与本地图片都走这条路）
      token.href = rawHref.replace(/\\/g, "%5C");
      return token;
    },
  };
}
