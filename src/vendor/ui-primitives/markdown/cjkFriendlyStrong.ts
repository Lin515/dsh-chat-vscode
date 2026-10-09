/**
 * 【vendor】上游 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `src/markdown/cjkFriendlyStrong.ts`，随 `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`
 * 同步（检出 tag `dsh-v0.2.0-rc.2`）。
 *
 * **不要手改**：上游升级时按 `src/vendor/README.md` 的流程重新 diff。
 * 本仓库唯一的改动是 import 路径去掉 `.ts` 后缀（我们的构建不启用
 * `allowImportingTsExtensions`），语义与上游逐字相同。
 *
 * 让星号粗体在「标点后紧接 CJK 文字（其间没有空白）」时也能闭合——CommonMark
 * 的空白规则会把 `**粗体**中文` 里的后一个星号判成不可闭合。
 */

import { attention } from 'micromark-core-commonmark'
import { unicodePunctuation } from 'micromark-util-character'
import { classifyCharacter } from 'micromark-util-classify-character'
import { codes, constants } from 'micromark-util-symbol'
import type { Construct, Extension, State, Tokenizer } from 'micromark-util-types'

const cjkCharacter = new RegExp([
  '\\p{Script_Extensions=Han}',
  '\\p{Script_Extensions=Hiragana}',
  '\\p{Script_Extensions=Katakana}',
  '\\p{Script_Extensions=Hangul}',
  '\\p{Script_Extensions=Bopomofo}',
].join('|'), 'u')

function isCjkCharacter(code: number | null): boolean {
  return code !== null && code >= 0 && cjkCharacter.test(String.fromCodePoint(code))
}

const tokenizeCjkFriendlyAttention: Tokenizer = function (effects, ok, nok) {
  const configuredAttentionMarkers = this.parser.constructs.attentionMarkers.null
  if (configuredAttentionMarkers === undefined) {
    throw new Error('micromark CommonMark attention markers are unavailable')
  }
  const attentionMarkers = configuredAttentionMarkers
  const previous = this.previous
  const before = classifyCharacter(previous)
  let marker: number | null = codes.eof

  return start

  function start(code: number | null): State | undefined {
    /* v8 ignore next -- this text construct is dispatched only for an asterisk. */
    if (code !== codes.asterisk) return nok(code)
    marker = code
    effects.enter('attentionSequence')
    return inside(code)
  }

  function inside(code: number | null): State | undefined {
    if (code === marker) {
      effects.consume(code)
      return inside
    }

    const token = effects.exit('attentionSequence')
    const after = classifyCharacter(code)
    const open = !after || (after === constants.characterGroupPunctuation && Boolean(before))
      || attentionMarkers.includes(code)
    const commonMarkClose = !before
      || (before === constants.characterGroupPunctuation && Boolean(after))
      || attentionMarkers.includes(previous)
    const markerCount = token.end.offset - token.start.offset
    const cjkStrongClose = markerCount >= 2
      && unicodePunctuation(previous)
      && isCjkCharacter(code)
    const close = commonMarkClose || cjkStrongClose

    token._open = open
    token._close = close
    return ok(code)
  }
}

const cjkFriendlyAttention: Construct = {
  name: 'cjkFriendlyAttention',
  resolveAll: attention.resolveAll,
  tokenize: tokenizeCjkFriendlyAttention,
}

const cjkFriendlyStrongExtension: Extension = {
  text: { [codes.asterisk]: cjkFriendlyAttention },
}

/**
 * Extend CommonMark asterisk strong emphasis for punctuation-delimited CJK
 * prose, as a micromark syntax extension for `fromMarkdown`.
 * @returns The micromark syntax extension.
 */
export function cjkFriendlyStrong(): Extension {
  return cjkFriendlyStrongExtension
}
