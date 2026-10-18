/**
 * 中文标点收尾的 `**加粗**`：在 tokenizer 层放宽闭合判据。
 *
 * **问题**：CommonMark 的「定界符 run」规则要求闭合 `**` 是 right-flanking——前一字符
 * 不是标点，或者前一字符是标点但**后一字符是空白或标点**。中英混排最常见的收尾形状
 * `…不够。**分页…` 两条都不满足（前是 `。`，后是汉字），于是这一对星号只能当字面文本：
 * 界面上加粗失效、星号露出来，而同一段里其它加粗（闭合符后是换行 / 标点的）照常生效，
 * 看着像模型把标记写错了。
 *
 * **官方口径**：官方 `dsh web` 的渲染链为这条规则补过扩展
 * （`packages/client/ui-primitives/src/markdown/cjkFriendlyStrong.ts`）：星号数 ≥ 2、
 * 前一字符是 Unicode 标点、后一字符属 CJK 文字系统时，允许该 run 闭合。本扩展用
 * marked，走的是同一条 CommonMark 规则（同病），所以在 tokenizer 层补上同一判据，
 * 属于**向官方对齐**（对比 `linkDestinations.ts` 那处刻意偏离官方）。
 *
 * **做法**：覆写 `emStrong`——默认实现先跑，出了 token 就原样返回（嵌套强调、`***`、
 * `_` 强调、GFM 的 `~` 例外全部保持 marked 原语义）；只有默认实现**找不到闭合 run**
 * 时，才按官方判据自己定位一次闭合位置，产出与 marked 同形的 `strong` token。屏蔽串
 * （`maskedSrc`，marked 用来挡住参考式链接、反斜杠转义与块级跳过的区域）与默认实现吃
 * 同一份，偏移口径一致；token 内部的 `tokens` 仍交 `lexer.inlineTokens` 递归。
 *
 * **边界（刻意不动）**：
 * - 只放宽正好两个星号的 `**`：`*斜体。*后续`、`***粗斜。***后续` 仍是 CommonMark 原语义；
 * - 只放宽「前是 Unicode 标点、后是 CJK 文字」：`**Period.**next` 这类西文相邻不受影响；
 * - 默认实现能解析出的形状一律不碰（负向对照见 `scripts/markdown.test.ts`）。
 */

import { Tokenizer, type Tokens } from "marked";

/**
 * 官方判据里的 CJK 文字系统，与 `cjkFriendlyStrong` 逐条一致（Han / 平假名 / 片假名 /
 * 谚文 / 注音）。
 */
const CJK_SCRIPTS = [
  "\\p{Script_Extensions=Han}",
  "\\p{Script_Extensions=Hiragana}",
  "\\p{Script_Extensions=Katakana}",
  "\\p{Script_Extensions=Hangul}",
  "\\p{Script_Extensions=Bopomofo}",
].join("");

/**
 * 宽松闭合形状：**前一个字符是 Unicode 标点或符号**（与 marked 的 `punct` 同一类），
 * 后跟正好两个星号，星号后面**紧跟** CJK 文字（不跳过空白）。
 *
 * `(?!\*)` 与 marked 默认正则里的 `(?!\*)punct` 同义：避免把 `***` 的尾两个星号当成
 * 这里的闭合 run。正则不带 `g`，`exec` 无跨次调用的 `lastIndex` 残留。
 */
const CJK_STRONG_CLOSE = new RegExp(`(?!\\*)([\\p{P}\\p{S}])(\\*{2})(?=[${CJK_SCRIPTS}])`, "u");

/**
 * 默认实现找不到闭合 run 时的兜底：按官方判据再找一次闭合位置。
 *
 * 开场条件逐条复刻默认实现（左定界符、`_` 的字母相邻例外、以及「后随标点时须前接
 * 空白/标点/行首」那一条），保证只有**默认实现本来就想开、却找不到闭合**的形状才走到
 * 这里；这里也只认正好两个星号的开场 run。
 */
function relaxedStrongClose(
  this: Tokenizer,
  src: string,
  maskedSrc: string,
  prevChar: string,
): Tokens.Strong | undefined {
  const open = this.rules.inline.emStrongLDelim.exec(src);
  if (!open) return undefined;
  if (open[3] && prevChar.match(this.rules.other.unicodeAlphaNumeric)) return undefined;
  const nextChar = open[1] || open[2] || "";
  if (nextChar && prevChar && !this.rules.inline.punctuation.exec(prevChar)) return undefined;
  // 只放宽正好两个星号：`lLength` 按默认实现的算法取（`[^\s*]` 会连带吃掉后一个字符）
  if (open[0][0] !== "*" || [...open[0]].length - 1 !== 2) return undefined;
  // 与默认实现同一份屏蔽串、同一段偏移：丢掉开场 run 之后剩下的部分
  const close = CJK_STRONG_CLOSE.exec(maskedSrc.slice(-1 * src.length + 2));
  if (!close) return undefined;
  const lastCharLength = [...close[0]][0]!.length;
  const raw = src.slice(0, 2 + close.index + lastCharLength + 2);
  const text = raw.slice(2, -2);
  return { type: "strong", raw, text, tokens: this.lexer.inlineTokens(text) };
}

/**
 * 需要挂进 marked 实例的 tokenizer 覆写。
 *
 * @returns 传给 `new Marked({ tokenizer: ... })` 的那一组覆写（与
 *   `windowsPathTokenizers()` 展平合并）。
 */
export function cjkStrongTokenizers(): {
  emStrong(
    this: Tokenizer,
    src: string,
    maskedSrc: string,
    prevChar?: string,
  ): Tokens.Em | Tokens.Strong | undefined;
} {
  return {
    emStrong(this: Tokenizer, src, maskedSrc, prevChar = "") {
      // 默认实现先跑：能出 token 就完全按 marked 原语义走（含嵌套与 `***` / `_`）
      const token = Tokenizer.prototype.emStrong.call(this, src, maskedSrc, prevChar);
      if (token) return token;
      return relaxedStrongClose.call(this, src, maskedSrc, prevChar);
    },
  };
}
