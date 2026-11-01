import {
  Fragment,
  createElement,
  useEffect,
  useRef,
  useState,
  type Key,
  type ReactNode,
} from "react";
import type {
  Definition,
  FootnoteDefinition,
  FootnoteReference,
  ImageReference,
  Link,
  LinkReference,
  List,
  ListItem,
  RootContent,
  Table,
  TableRow,
} from "mdast";
import { isRemoteImageRef } from "../../shared/imageRef";
import { post } from "../bridge";
import { CodeBlock } from "../components/CodeBlock";
import { MathView } from "../components/MathView";
import { externalLinkUrl, fileOpenIntent, parseFileLink, type FileLinkPort } from "../fileLinks";
import { openImagePreview } from "../imagePreview";
import {
  failedImageText,
  localImageCacheValue,
  localImageScopeReady,
  resolveLocalImage,
  useLocalImageScopeVersion,
} from "../localImages";
import { externalLinkHoverTitle, fileLinkHoverTitle, mergeHoverTitle } from "../linkHovers";
import type { Texts } from "../texts";
import type { MarkdownDocument } from "./parse";
import { mathFenceSource, mathSourceOf, type MathSource } from "./math";
import { codePayload, sourceFallback, type CodeSource } from "./source";
import type { MarkdownPhase } from "./types";

/**
 * mdast → React 文档树。
 *
 * 这是阶段 2 的唯一渲染入口：标准 Markdown、GFM 表格 / 任务列表 / 删除线、
 * 脚注、行内代码文件按钮、链接与图片都由 React 节点直接拥有，不再生成整篇 HTML、
 * 不再用 `dangerouslySetInnerHTML`，也不在渲染后 hydrate / replaceChildren。
 *
 * 原始 HTML（mdast `html` 节点）按官方约定作为字面文本输出，不进入 DOM 解析。
 * 未知节点用源码片段安全回退，不沿用官方“默认渲染空”的吞内容行为。
 */

interface RenderContext {
  readonly source: string;
  readonly definitions: ReadonlyMap<string, Definition>;
  readonly footnotes: ReadonlyMap<string, FootnoteDefinition>;
  readonly codeSources: ReadonlyMap<number, CodeSource>;
  readonly fileLinks: FileLinkPort | undefined;
  readonly cwd: string | undefined;
  readonly texts: Texts;
  readonly phase: MarkdownPhase;
  readonly inLink: boolean;
  readonly inBlockquote: boolean;
  /** 首次引用顺序；渲染引用时按文档序累积。 */
  readonly footnoteOrder: string[];
  /** identifier → 被引用次数（回跳箭头个数）。 */
  readonly footnoteCounts: Map<string, number>;
}

export interface RenderMarkdownOptions {
  readonly phase: MarkdownPhase;
  readonly fileLinks?: FileLinkPort;
  readonly cwd?: string;
  readonly texts: Texts;
}

/** 渲染一份已解析文档（正文 + 文末脚注区）。 */
export function renderMarkdownDocument(
  document: MarkdownDocument,
  options: RenderMarkdownOptions,
): ReactNode {
  const context: RenderContext = {
    source: document.source,
    definitions: document.definitions,
    footnotes: document.footnotes,
    codeSources: document.codeSources,
    fileLinks: options.fileLinks,
    cwd: options.cwd,
    texts: options.texts,
    phase: options.phase,
    inLink: false,
    inBlockquote: false,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  };
  return (
    <>
      {renderBlocks(document.root.children, context, "md")}
      {renderFootnotesWithSeparator(context)}
    </>
  );
}

/**
 * 脚注区前补一个换行文本节点：旧管线把脚注区接在正文 HTML 之后时自带换行。
 * 查找（FindBar）把相邻文本节点拼起来搜，没有这层分隔会把最后一段正文与
 * 脚注标题粘成一个词。
 */
function renderFootnotesWithSeparator(context: RenderContext): ReactNode {
  const section = renderFootnoteSection(context);
  if (section === null) return null;
  return (
    <>
      {"\n"}
      {section}
    </>
  );
}

/**
 * 语义单元之间补换行文本节点。
 *
 * 查找按文档序收集文本节点并把相邻内容拼起来搜索；`<li>a</li><li>b</li>` 或
 * `<td>a</td><td>b</td>` 在 DOM 里没有空白文本节点时会被拼成 `ab`，让
 * 「跨两个不相邻视觉单元」的查询出现假命中。旧 HTML 管线的换行正好充当边界，
 * 这里显式补同形的文本节点（纯空白，不产生布局盒子）。
 */
function separated(nodes: ReactNode[]): ReactNode[] {
  const result: ReactNode[] = [];
  for (const node of nodes) {
    if (result.length > 0) result.push("\n");
    result.push(node);
  }
  return result;
}

/** 首尾也带换行：与旧 HTML 的 `<ul>\n<li>…</li>\n</ul>` / `<tr>\n<td>…` 同形。 */
function wrapped(nodes: ReactNode[]): ReactNode[] {
  return ["\n", ...separated(nodes), "\n"];
}

/**
 * 块级序列：块之间补一个换行文本节点。
 *
 * 这既让相邻的原始 HTML 文本节点保持分开（否则会粘成一行），也让服务端渲染的
 * 结果更接近旧 HTML 管线的空行；`.md > *` 的边距选择器只命中原生元素，不受影响。
 */
function renderBlocks(nodes: readonly RootContent[], context: RenderContext, prefix: string): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const child = renderNode(node, `${prefix}:${index}`, context);
    if (child === null) continue;
    if (rendered.length > 0) rendered.push("\n");
    rendered.push(child);
  }
  return rendered;
}

function renderChildren(nodes: readonly RootContent[], context: RenderContext, prefix: string): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${prefix}:${index}`, context));
}

/** 段落内的一段：普通 inline 内容，或一个被切出来的 display 公式。 */
type InlinePart =
  | { readonly kind: "inline"; readonly nodes: RootContent[] }
  | { readonly kind: "display"; readonly source: MathSource };

/** 包装节点（strong / emphasis / link 等）被切开后的单段。 */
type WrappedPart =
  | { readonly kind: "inline"; readonly node: RootContent }
  | { readonly kind: "display"; readonly source: MathSource };

/**
 * 读取 `inlineMath` 的 display 事实：`$$…$$` 与 `\\[…\\]` 即使仍是
 * inlineMath 节点也按产品契约显示成块级公式。
 */
function displayMathSourceOf(node: RootContent): MathSource | undefined {
  if (node.type !== "inlineMath") return undefined;
  const source = mathSourceOf(node);
  return source?.form === "display" ? source : undefined;
}

/**
 * 递归切开 inline 子树，把 display 公式提升成段落级边界。
 *
 * `strong` / `emphasis` / `delete` / `link` 以及已解析定义的 `linkReference`
 * 会按公式两侧拆成多个同形包装；未解析的引用保持原样，避免复制 `[…][id]`
 * 括号或吞掉回退文本。公式两侧的文本、链接与脚注引用各自只渲染一次。
 */
function splitInlineChildren(
  nodes: readonly RootContent[],
  prefix: string,
  context: RenderContext,
): InlinePart[] {
  const parts: InlinePart[] = [];
  let inline: RootContent[] = [];
  const flush = (): void => {
    if (inline.length === 0) return;
    parts.push({ kind: "inline", nodes: inline });
    inline = [];
  };
  for (const [index, node] of nodes.entries()) {
    const display = displayMathSourceOf(node);
    if (display !== undefined) {
      flush();
      parts.push({ kind: "display", source: display });
      continue;
    }
    const wrapped = splitInlineWrapper(node, `${prefix}:${index}`, context);
    if (wrapped === undefined) {
      inline.push(node);
      continue;
    }
    for (const part of wrapped) {
      if (part.kind === "display") {
        flush();
        parts.push(part);
      } else {
        inline.push(part.node);
      }
    }
  }
  flush();
  return parts;
}

function splitInlineWrapper(
  node: RootContent,
  prefix: string,
  context: RenderContext,
): WrappedPart[] | undefined {
  if (node.type !== "strong"
    && node.type !== "emphasis"
    && node.type !== "delete"
    && node.type !== "link"
    && node.type !== "linkReference") {
    return undefined;
  }
  if (node.type === "linkReference" && !context.definitions.has(node.identifier.toUpperCase())) {
    return undefined;
  }
  const inner = splitInlineChildren(node.children as readonly RootContent[], prefix, context);
  if (!inner.some((part) => part.kind === "display")) return undefined;
  return inner.map((part): WrappedPart => part.kind === "display"
    ? part
    : { kind: "inline", node: { ...node, children: part.nodes } as RootContent });
}

/**
 * 段落渲染：没有 display 时保持原来的单个 `<p>`；有 display 时切成
 * `<p>…</p>` + 块级公式 + `<p>…</p>`，不产生空段落，也不把块级内容塞回 p。
 */
function renderParagraph(
  node: Extract<RootContent, { type: "paragraph" }>,
  key: Key,
  context: RenderContext,
): ReactNode {
  const parts = splitInlineChildren(node.children, `${String(key)}:p`, context);
  if (!parts.some((part) => part.kind === "display")) {
    return <p key={key}>{renderChildren(node.children, context, `${String(key)}:p`)}</p>;
  }
  const output: ReactNode[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.kind === "display") {
      output.push(renderMathSource(part.source, context));
    } else {
      output.push(
        <p key={`${String(key)}:p${index}`}>
          {renderChildren(part.nodes, context, `${String(key)}:p${index}`)}
        </p>,
      );
    }
  }
  return <Fragment key={key}>{separated(output)}</Fragment>;
}

function renderMathSource(source: MathSource, context: RenderContext): ReactNode {
  return <MathView key={`math:${source.start}`} source={source} phase={context.phase} />;
}

/** 没有解析事实（缺位置 / 未确认）时只把源码作为文本回退，不补定界符。 */
function renderMathFallback(raw: string, form: "inline" | "display", key: Key): ReactNode {
  if (form === "inline") {
    return (
      <span key={key} className="math-view math-view-inline math-view-source" data-math-view="inline">
        {raw}
      </span>
    );
  }
  // display 即使落在不可拆容器（heading / 表格单元格 / 回退引用）里，也用
  // 文本节点把两侧内容隔开，后继 FindBar 不会把 before / after 与公式拼词。
  return (
    <Fragment key={key}>
      {"\n"}
      <span className="math-view math-view-display math-view-source" data-math-view="display">
        {raw}
      </span>
      {"\n"}
    </Fragment>
  );
}

function renderInlineMath(node: RootContent, key: Key, context: RenderContext): ReactNode {
  const source = mathSourceOf(node);
  if (source === undefined) {
    return renderMathFallback(sourceFallback(node, context.source), "inline", key);
  }
  if (source.form === "display") {
    return (
      <Fragment key={key}>
        {"\n"}
        {renderMathSource(source, context)}
        {"\n"}
      </Fragment>
    );
  }
  return renderMathSource(source, context);
}

function renderFlowMath(node: RootContent, key: Key, context: RenderContext): ReactNode {
  const source = mathSourceOf(node);
  if (source === undefined) {
    return renderMathFallback(sourceFallback(node, context.source), "display", key);
  }
  return renderMathSource(source, context);
}

function renderNode(node: RootContent, key: Key, context: RenderContext): ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "paragraph":
      return renderParagraph(node, key, context);
    case "heading":
      return createElement(
        `h${node.depth}`,
        { key },
        ...renderChildren(node.children, context, `${String(key)}:h`),
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {renderBlocks(node.children, { ...context, inBlockquote: true }, `${String(key)}:q`)}
        </blockquote>
      );
    case "thematicBreak":
      return <hr key={key} />;
    case "break":
      return (
        <Fragment key={key}>
          <br />
          {"\n"}
        </Fragment>
      );
    case "strong":
      return <strong key={key}>{renderChildren(node.children, context, `${String(key)}:s`)}</strong>;
    case "emphasis":
      return <em key={key}>{renderChildren(node.children, context, `${String(key)}:e`)}</em>;
    case "delete":
      return <del key={key}>{renderChildren(node.children, context, `${String(key)}:d`)}</del>;
    case "inlineCode":
      return renderInlineCode(node.value, key, context);
    case "inlineMath":
      return renderInlineMath(node, key, context);
    case "math":
      return renderFlowMath(node, key, context);
    case "html":
      // 不解析 HTML：模型给的标签、注释、属性都只是文字。
      return node.value;
    case "code": {
      // math 围栏在 settled 才转公式；tex / latex 永不进入，仍走精确 CodeBlock。
      if (context.phase === "settled" && (node.lang ?? "").trim().toLowerCase() === "math") {
        const fence = mathFenceSource(node, context.source, context.codeSources);
        if (fence !== undefined) {
          return <MathView key={`math-fence:${fence.start}`} source={fence} phase={context.phase} />;
        }
      }
      return (
        <CodeBlock
          key={codeKey(node, key)}
          lang={node.lang ?? undefined}
          code={codePayload(node, context.source, context.codeSources).text}
          phase={context.phase}
        />
      );
    }
    case "list":
      return renderList(node, key, context);
    case "listItem":
      return renderListItem(node, true, key, context);
    case "table":
      return renderTable(node, key, context);
    case "link":
      return renderAnchor(node, key, context);
    case "linkReference":
      return renderLinkReference(node, key, context);
    case "image":
      return (
        <MarkdownImage
          key={`${String(key)}:${node.url}`}
          src={node.url}
          alt={node.alt ?? ""}
          title={node.title ?? undefined}
          context={context}
        />
      );
    case "imageReference":
      return renderImageReference(node, key, context);
    case "footnoteReference":
      return renderFootnoteReference(node, key, context);
    case "definition":
    case "footnoteDefinition":
      return null;
    default:
      return renderUnknown(node, key, context);
  }
}

function codeKey(node: Extract<RootContent, { type: "code" }>, fallback: Key): string {
  const offset = node.position?.start.offset;
  // 围栏起点在流式追加时不变：同一代码卡从 streaming 到 settled 不重挂，
  // 用户已选的折展状态才能保住。offset 只作同一文档内的稳定键，不跨消息复用。
  return offset === undefined ? `code:${String(fallback)}` : `code:${offset}`;
}

function renderInlineCode(value: string, key: Key, context: RenderContext): ReactNode {
  // mdast 的 inlineCode 保留换行；HTML 行内代码按空格显示（官方同一口径）。
  const text = value.replace(/\r\n|\r|\n/gu, " ");
  const mention = context.inLink ? undefined : context.fileLinks?.resolve(text);
  if (mention !== undefined) {
    return (
      <code key={key}>
        <button
          type="button"
          className="file-mention"
          title={fileLinkHoverTitle(context.cwd, mention, context.texts)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMarkdownFile(mention, undefined, event, context);
          }}
        >
          {text}
        </button>
      </code>
    );
  }
  return <code key={key}>{text}</code>;
}

function renderList(node: List, key: Key, context: RenderContext): ReactNode {
  const loose = (node.spread ?? false)
    || node.children.some((item) => item.spread ?? item.children.length > 1);
  const properties: { start?: number } = {};
  if (node.ordered && typeof node.start === "number" && node.start !== 1) properties.start = node.start;
  return createElement(
    node.ordered ? "ol" : "ul",
    { key, ...properties },
    ...wrapped(node.children.map((item, index) => renderListItem(item, loose, `${String(key)}:${index}`, context))),
  );
}

interface ListEntry {
  paragraph?: ReactNode[];
  element?: ReactNode;
  display?: MathSource;
}

function renderListItem(item: ListItem, loose: boolean, key: Key, context: RenderContext): ReactNode {
  const entries: ListEntry[] = [];
  for (const [index, child] of item.children.entries()) {
    if (child.type === "paragraph") {
      // 段落里的 display 也要在 tight / loose 列表内切成块级公式；不能只在
      // 外层 paragraph 分支处理，否则 `- before $$x$$ after` 会被塞回同一个 p。
      const parts = splitInlineChildren(child.children, `${String(key)}:p${index}`, context);
      if (!parts.some((part) => part.kind === "display")) {
        entries.push({
          paragraph: renderChildren(child.children, context, `${String(key)}:p${index}`),
        });
      } else {
        for (const [partIndex, part] of parts.entries()) {
          if (part.kind === "display") {
            entries.push({ display: part.source });
          } else {
            entries.push({
              paragraph: renderChildren(part.nodes, context, `${String(key)}:p${index}:${partIndex}`),
            });
          }
        }
      }
    } else {
      const element = renderNode(child, `${String(key)}:${index}`, context);
      if (element !== null) entries.push({ element });
    }
  }

  if (typeof item.checked === "boolean") {
    const checkbox = (
      <input
        key={`${String(key)}:task`}
        type="checkbox"
        checked={item.checked}
        disabled
        readOnly
      />
    );
    const first = entries[0];
    if (first !== undefined && first.paragraph !== undefined) {
      const nodes = first.paragraph;
      entries[0] = {
        paragraph: nodes.length > 0 ? [checkbox, " ", ...nodes] : [checkbox],
      };
    } else {
      entries.unshift({ paragraph: [checkbox] });
    }
  }

  const parts: ReactNode[] = [];
  for (const [index, entry] of entries.entries()) {
    const paragraph = "paragraph" in entry;
    if (loose || index !== 0 || !paragraph) parts.push("\n");
    if (!paragraph) parts.push(entry.display !== undefined ? renderMathSource(entry.display, context) : entry.element);
    else if (loose) parts.push(<p key={`${String(key)}:p${index}`}>{entry.paragraph}</p>);
    else parts.push(<Fragment key={`${String(key)}:p${index}`}>{entry.paragraph}</Fragment>);
  }
  const tail = entries[entries.length - 1];
  if (tail !== undefined && (loose || !("paragraph" in tail))) parts.push("\n");
  return <li key={key}>{parts}</li>;
}

function renderTable(node: Table, key: Key, context: RenderContext): ReactNode {
  const [head, ...body] = node.children;
  const sections: ReactNode[] = [];
  if (head !== undefined) {
    sections.push(<thead key={`${String(key)}:head`}>{renderTableRow(head, "th", `${String(key)}:head`, context)}</thead>);
  }
  if (body.length > 0) {
    sections.push(
      <tbody key={`${String(key)}:body`}>
        {separated(body.map((row, index) => renderTableRow(row, "td", `${String(key)}:${index}`, context)))}
      </tbody>,
    );
  }
  return <table key={key}>{separated(sections)}</table>;
}

function renderTableRow(
  row: TableRow,
  cellTag: "th" | "td",
  key: string,
  context: RenderContext,
): ReactNode {
  const cells = row.children.map((cell, index) =>
    createElement(
      cellTag,
      { key: `${key}:${index}` },
      ...renderChildren(cell.children, context, `${key}:${index}`),
    ),
  );
  return <tr key={key}>{wrapped(cells)}</tr>;
}

function renderAnchor(node: Link, key: Key, context: RenderContext): ReactNode {
  const children = renderChildren(
    node.children,
    { ...context, inLink: true },
    `${String(key)}:a`,
  );
  const file = parseFileLink(node.url);
  const external = file === undefined ? externalLinkUrl(node.url) : undefined;
  const hint = file !== undefined
    ? fileLinkHoverTitle(context.cwd, file.path, context.texts)
    : external === undefined
      ? undefined
      : externalLinkHoverTitle(external);
  const title = mergeHoverTitle(node.title, hint);

  if (file !== undefined) {
    return (
      <a
        key={key}
        href={node.url}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMarkdownFile(file.path, file.line, event, context);
        }}
      >
        {children}
      </a>
    );
  }
  if (external !== undefined) {
    return (
      <a
        key={key}
        href={node.url}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          // 必须掐断冒泡：VS Code 的 webview 外层页会把同一个锚点再转成
          // 一次 did-click-link，且不检查 defaultPrevented。一次点击只开一次。
          event.stopPropagation();
          post({ type: "openExternal", url: external });
        }}
      >
        {children}
      </a>
    );
  }
  if (node.url.startsWith("#")) {
    // 页内锚点交给浏览器滚，不 preventDefault（外层页也放行）。
    return <a key={key} href={node.url} title={node.title ?? undefined}>{children}</a>;
  }
  // 危险 / 未认可 scheme：保留链接外观，但不给 href，点下去不导航。
  return <a key={key} title={node.title ?? undefined}>{children}</a>;
}

function renderLinkReference(node: LinkReference, key: Key, context: RenderContext): ReactNode {
  const definition = context.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) {
    return (
      <Fragment key={key}>
        {"["}
        {renderChildren(node.children, context, `${String(key)}:r`)}
        {referenceSuffix(node)}
      </Fragment>
    );
  }
  return renderAnchor(
    {
      type: "link",
      url: definition.url,
      title: definition.title ?? null,
      children: node.children,
      position: node.position,
    },
    key,
    context,
  );
}

function renderImageReference(node: ImageReference, key: Key, context: RenderContext): ReactNode {
  const definition = context.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) {
    // 定义缺失时按原文整体回退（不手拼 `![alt][label]`）：解析器认定的节点范围
    // 才是唯一可信的源码片段，手拼容易在折叠 / 快捷引用上漏字符。
    return <Fragment key={key}>{sourceFallback(node, context.source)}</Fragment>;
  }
  return (
    <MarkdownImage
      key={`${String(key)}:${definition.url}`}
      src={definition.url}
      alt={node.alt ?? ""}
      title={definition.title ?? undefined}
      context={context}
    />
  );
}

function referenceSuffix(node: LinkReference | ImageReference): string {
  if (node.referenceType === "collapsed") return "][]";
  if (node.referenceType === "full") return `][${node.label ?? node.identifier}]`;
  return "]";
}

function renderFootnoteReference(
  node: FootnoteReference,
  key: Key,
  context: RenderContext,
): ReactNode {
  const identifier = node.identifier.toUpperCase();
  const seen = context.footnoteCounts.get(identifier);
  if (seen === undefined) context.footnoteOrder.push(identifier);
  context.footnoteCounts.set(identifier, (seen ?? 0) + 1);
  const number = context.footnoteOrder.indexOf(identifier) + 1;
  return <sup key={key}>{String(number)}</sup>;
}

function renderFootnoteSection(context: RenderContext): ReactNode {
  const items: ReactNode[] = [];
  for (let index = 0; index < context.footnoteOrder.length; index += 1) {
    const identifier = context.footnoteOrder[index]!;
    const definition = context.footnotes.get(identifier);
    if (definition === undefined) continue;
    const count = context.footnoteCounts.get(identifier) ?? 1;
    const backrefs: ReactNode[] = [];
    for (let reference = 1; reference <= count; reference += 1) {
      if (backrefs.length > 0) backrefs.push(" ");
      backrefs.push("↩");
      if (reference > 1) backrefs.push(<sup key={`${identifier}:b${reference}`}>{String(reference)}</sup>);
    }

    const children = definition.children;
    const body: ReactNode[] = [];
    for (const [childIndex, child] of children.entries()) {
      if (child.type === "paragraph" && childIndex === children.length - 1) {
        // 脚注的最后一段也要按 display 切开；回跳箭头只放到最后一段 inline
        // 内容之后，纯公式结尾时作为裸文本追加，避免重复引用计数。
        const parts = splitInlineChildren(child.children, `${identifier}:p`, context);
        if (!parts.some((part) => part.kind === "display")) {
          body.push(
            <p key={`${identifier}:p`}>
              {renderChildren(child.children, context, `${identifier}:p`)}
              {" "}
              {backrefs}
            </p>,
          );
        } else {
          const renderedParts = parts.map((part, partIndex) => {
            if (part.kind === "display") return renderMathSource(part.source, context);
            return (
              <p key={`${identifier}:p${partIndex}`}>
                {renderChildren(part.nodes, context, `${identifier}:p${partIndex}`)}
                {partIndex === parts.length - 1 ? <>{" "}{backrefs}</> : null}
              </p>
            );
          });
          body.push(...separated(renderedParts));
          if (parts[parts.length - 1]?.kind === "display") {
            body.push(" ");
            body.push(...backrefs);
          }
        }
      } else {
        const rendered = renderNode(child, `${identifier}:${childIndex}`, context);
        if (rendered !== null) body.push(rendered);
      }
    }
    if (children.length === 0 || children[children.length - 1]!.type !== "paragraph") {
      if (body.length > 0) body.push(" ");
      body.push(...backrefs);
    }
    items.push(
      <li key={identifier} id={`user-content-fn-${slug(identifier)}`}>
        {body}
      </li>,
    );
  }
  if (items.length === 0) return null;
  return (
    <section key="footnotes" data-footnotes="" className="footnotes">
      <h2 id="footnote-label" className="sr-only">{context.texts.markdownFootnotes}</h2>
      <ol>{items}</ol>
    </section>
  );
}

function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]+/gu, "")
    .replace(/\s+/gu, "-");
}

function renderUnknown(node: RootContent, key: Key, context: RenderContext): ReactNode {
  const fallback = sourceFallback(node, context.source);
  if (fallback !== "") return <Fragment key={key}>{fallback}</Fragment>;
  if ("children" in node) {
    return <Fragment key={key}>{renderChildren(node.children, context, `${String(key)}:u`)}</Fragment>;
  }
  return null;
}

function openMarkdownFile(
  path: string,
  line: number | undefined,
  event: { readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean },
  context: RenderContext,
): void {
  const intent = fileOpenIntent(event, path);
  if (intent === "browser") {
    post({ type: "openFileInBrowser", path });
    return;
  }
  post({
    type: "openFile",
    path,
    line,
    link: true,
    ...(intent === "real" ? { real: true } : {}),
  });
  void context;
}

interface ImageState {
  readonly version: number;
  readonly kind: "pending" | "ready" | "failed";
  readonly src: string;
  readonly ref: string;
}

function initialImageState(src: string, version: number): ImageState {
  if (!isRenderableImage(src)) return { version, kind: "failed", src, ref: src };
  if (isRemoteImageRef(src)) return { version, kind: "ready", src, ref: src };
  const cached = localImageCacheValue(src);
  if (cached !== undefined) {
    return cached === ""
      ? { version, kind: "failed", src, ref: src }
      : { version, kind: "ready", src: cached, ref: src };
  }
  return { version, kind: "pending", src, ref: src };
}

/**
 * 图片地址的准入：只放行浏览器 / 宿主实际支持的目标形状。
 *
 * `isRemoteImageRef` 只回答「要不要交给宿主读盘」，**不是**安全允许表——它把
 * `javascript:`、`data:` 等都算“远程”。旧链路由 DOMPurify 的 URI 白名单剥掉
 * 危险 scheme 的 `src`；新的 React 叶节点直接写属性，所以这里补同一档准入：
 * `https:` / `http:`（明文由 CSP 拒绝加载）、`data:`、`file:`、盘符与无 scheme
 * 的本地引用；其它 scheme 一律当作加载失败，不把不可信 scheme 放进 DOM。
 */
function isRenderableImage(src: string): boolean {
  const value = src.trim();
  if (value === "") return false;
  // 盘符目标可能是原文 `D:\`，也可能已经被 Windows 目标修复编码成 `D:%5C`。
  if (/^[a-z]:(?:[\\/]|%5c)/iu.test(value)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value);
  if (scheme === null) return true;
  const name = scheme[1]!.toLowerCase();
  return name === "data" || name === "http" || name === "https" || name === "file";
}

/**
 * 正文图片叶节点。
 *
 * pending / ready / failed 由组件自己持有：宿主回帧之前的浏览器失败不是结论
 * （原始本地引用在 webview 里必然加载失败），只有缓存或宿主回答之后才允许降级。
 * 范围（连接 + 会话）变化时按新版本重挂状态；旧请求的回调由 `cancelled` 挡住，
 * 不会写进新范围。图片节点完全由 React 渲染，没有 replaceWith / innerHTML。
 */
function MarkdownImage({
  src,
  alt,
  title,
  context,
}: {
  src: string;
  alt: string;
  /** 作者写的图片 title（`![alt](url "title")` / 参考定义）：保留标准悬停效果。 */
  title?: string;
  context: RenderContext;
}) {
  const scopeVersion = useLocalImageScopeVersion();
  const [state, setState] = useState<ImageState>(() => initialImageState(src, scopeVersion));
  const current = state.version === scopeVersion ? state : initialImageState(src, scopeVersion);
  const remote = isRemoteImageRef(src);
  // 范围切换时按版本换一颗新的 DOM 节点：旧请求的加载失败可能在新范围已经成功
  // 之后才派发，若沿用同一颗 `<img>`，同一个组件状态会被那次迟到事件降级。
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const version = scopeVersion;
    const initial = initialImageState(src, version);
    setState(initial);
    if (initial.kind !== "pending") {
      return () => {
        cancelled = true;
      };
    }
    if (!localImageScopeReady()) {
      // 范围还没齐：不发请求，也不降级。范围帧到达后版本号 +1，本 effect 重跑。
      return () => {
        cancelled = true;
      };
    }
    void resolveLocalImage(src).then((url) => {
      if (cancelled) return;
      setState(url === undefined
        ? { version, kind: "failed", src, ref: src }
        : { version, kind: "ready", src: url, ref: src });
    });
    return () => {
      cancelled = true;
    };
  }, [src, scopeVersion]);

  if (current.kind === "failed") {
    return (
      <span className="image-failed" title={current.ref}>
        {failedImageText(context.texts, current.ref)}
      </span>
    );
  }

  return (
    <img
      key={scopeVersion}
      ref={imgRef}
      src={current.src}
      alt={alt}
      title={title}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={(event) => {
        // 范围切换后旧 `<img>` 的迟到失败不能降级新范围里的新图：只接受当前
        // 节点的失败（旧节点已被 key 换掉，ref 指向新节点）。
        if (imgRef.current !== event.currentTarget) return;
        setState((previous) => {
          const active = previous.version === scopeVersion
            ? previous
            : initialImageState(src, scopeVersion);
          // 本地引用在等宿主回帧：浏览器这次失败不是结论。
          if (active.kind === "pending" && !remote) return previous;
          if (active.kind === "failed") return previous;
          return { version: scopeVersion, kind: "failed", src: active.src, ref: src };
        });
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openImagePreview(current.src, alt || context.texts.messageImageAlt);
      }}
    />
  );
}
