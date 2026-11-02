# src/vendor/code-language/ — 官方扩展名 → 语法高亮语言表

上游 `@deepseek-ai/dsh-util-code-language@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../README.md](../README.md)；改写约束见 [../AGENTS.md](../AGENTS.md)。

| 文件 | 上游对应 | 作用 | 本仓库的改动 |
|---|---|---|---|
| `index.ts` | `src/index.ts` | 扩展名 → 语法高亮语言表：`CODE_HIGHLIGHT_EXTENSIONS`、`languageForPath`、`readLangHintForPath` | 逐字搬入；仅文件头补来源说明 |

## 权威语义

- **语言 id 就是 grammar id**：表里返回的值直接交给高亮器的别名表
  （[highlight.ts](<../ui-primitives/markdown/highlight.ts>) 的 `LANG_ALIASES`），
  `languageForPath` 不做第二层改名。表外的扩展名或高亮器未注册的语言按纯文本渲染。
- **扩展名取最后一段**：路径按 `/` 与 `\` 切分，取最后一段最后一个点之后的小写文本；
  前导点仍算分隔符，所以 `.env` 解析为 `dotenv`，而 `.gitignore` 这类未列出的点文件与
  无扩展名文件返回 `undefined`。
- **大小写不敏感**：`C:\dir\main.PS1` 与 `dir/main.ps1` 得到同一个语言。
- **短 id 只影响 read 卡片**：`readLangHintForPath` 先查 `READ_LANG_BY_EXTENSION`
  （`tsx` / `jsx` / `tf` / `tfvars` / `gradle` 保留后缀本身），否则用
  `SHORT_BY_LANGUAGE` 的语言短名；已经持久化的会话值必须保持稳定。
- **Map 而不是对象**：扩展名来自文件名，`foo.constructor` / `foo.__proto__` 必须未命中，
  不能摸到 `Object.prototype` 上的成员。

## 消费方

- [webview/markdown/highlight.ts](<../../webview/markdown/highlight.ts>) — 宿主适配层：
  `languageForPath` 直接透传，`normalizeLang` 用官方别名表与路径表补全 info string。
- [Diff.tsx](<../../webview/components/Diff.tsx>)、[Rows.tsx](<../../webview/components/Rows.tsx>)、
  [WriteBody.tsx](<../../webview/components/WriteBody.tsx>) — 通过
  `webview/markdown/highlight.ts` 的再导出使用路径语言。

本地不保留第二份扩展名表；扩展名覆盖（`jsonl` / `env` / `psm1` / `vue` 等）以这份
官方表为准，本地不再另补。

## 升级

按 [../README.md](../README.md) 的流程整份同步：官方原文与本地副本只用文件头注释区分，
来源锁同时锁住原文字节、规范化摘要与 [离线见证](<../../../test/fixtures/vendor-sources/README.md>)。
