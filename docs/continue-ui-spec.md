# Continue 聊天界面复刻规格（Continue v1.3.40 / VS Code Webview）

> 目的：让没有读过 Continue 源码的工程师，能照着本文在自建 VS Code Webview 里复刻出「Continue 一样的界面」。
> 源码基线：[Continue](https://github.com/continuedev/continue) 仓库根目录，`extensions/vscode/package.json` 版本 `1.3.40`，git describe `v1.3.40-vscode-11-g5522c6f44`。
> 文中所有 `path:line` 均相对于该仓库根目录。类名为 Tailwind 原文；样式为 styled-components 的会明确标注。
> 许可证：Apache License 2.0（`LICENSE`，`Copyright 2023 Continue Dev, Inc.`）——复用时义务见 §9.4。

---

## 0. 一页速览

| 维度 | 结论 |
| --- | --- |
| 技术栈 | React 18 + Redux Toolkit + Tailwind 3（`preflight: false`）+ styled-components + TipTap 2（ProseMirror） |
| 主题 | 全部颜色走 `--vscode-*` CSS 变量，`gui/src/styles/theme.ts` 里为每个语义色列出变量候选 + 硬编码 fallback |
| 圆角 | 全局 `defaultBorderRadius = 0.5rem`（8px）；小胶囊 4px；`code` 5px；mention 3px |
| 字号 | 正文 14px（JetBrains 15px），`getFontSize()` 可被 localStorage 覆盖；工具栏 12px/11px；tooltip 10px；`text-2xs` = 11px |
| 主色 | 无自有主色，`primary` = `--vscode-button-background`（fallback `#2c5aa0`），`accent` = `#4d8bf0` |
| 招牌动画 | 输入框流式时的七彩渐变描边（GradientBorder）、`Generating...` 宽度动画省略号、6s/圈慢速 Spinner |

---

## 1. 界面解剖：从顶到底

### 1.1 顶层骨架

`gui/src/pages/gui/index.tsx:6-13`：

```tsx
<div className="flex min-h-0 w-screen flex-row overflow-x-hidden">
  <aside className="4xl:flex border-vsc-input-border no-scrollbar hidden min-h-0 w-96 overflow-y-auto border-0 border-r border-solid">
    <History />
  </aside>
  <main className="no-scrollbar flex min-h-0 flex-1 flex-col">
    <Chat />
  </main>
</div>
```

- 左侧历史栏：**`w-96`（384px）**，`hidden` + `4xl:flex` → 只有视口 ≥ **1180px** 才出现；右侧 1px 竖分隔线用 `border-vsc-input-border`。
- 右侧主区是 `flex-col`。
- 更外层 `gui/src/components/Layout.tsx:33-38` 的 `GridDiv` 用 `display:grid; grid-template-rows:1fr auto; height:100vh`，`LayoutTopDiv` 里还有 `scrollbarGutter: "stable both-edges"`。

`Chat.tsx:382-451` 的结构（自顶向下）：

```
├─ TabBar                        （仅当 config.ui.showSessionTabs && !isInEdit）
├─ FindWidget
├─ StepsDiv                      ← 消息滚动区
│   ├─ DeprecationBanner
│   ├─ 每条 history item（ErrorBoundary 包裹）
│   └─ InlineErrorMessage        （仅最后一条）
└─ div.relative.shrink-0         ← 底部固定区
    ├─ ContinueInputBox (isMainInput)
    ├─ NewSessionButton（"Last Session"，仅空会话且有上次会话）
    ├─ FatalErrorIndicator / ExploreDialogWatcher
    └─ EmptyChatBody            （仅 history.length === 0）
```

**关键点：输入框不是 `position: sticky`**，它是 `grid-template-rows: 1fr auto` 的最后一行；滚动区 `min-h-0 flex-1 overflow-y-scroll`。复刻时请照此布局，不要用 sticky。

滚动区类名（`Chat.tsx:389`）：

```
pt-[8px] ${showScrollbar ? "thin-scrollbar" : "no-scrollbar"} ${history.length > 0 ? "min-h-0 flex-1 overflow-y-scroll" : "shrink-0"}
```

`showScrollbar = showChatScrollbar ?? window.innerHeight > 5000`（`:380`，后半段是明显的历史遗留判断，正常永远为 `false` → 默认 `no-scrollbar`）。每条 item 外层 `style={{ minHeight: index === history.length - 1 ? "200px" : 0 }}`（`:399`）——**最后一条至少有 200px 高**，这是对话底部留白感的来源。

### 1.2 顶部栏

v1.3.40 的聊天页**没有传统顶部栏**。可视为顶部栏的东西只有两处：

1. **TabBar**（`components/TabBar/TabBar.tsx`，仅配置开启时）。styled-components：
   - 容器：`display:flex; flex-wrap:wrap; flex-shrink:0; margin-top:2px; max-height:100px; overflow:auto;` 隐藏滚动条。
   - 单个 Tab（`:48-83`）：`height:25px; width:100px; max-width:150px; padding:0 5px 0 12px; border:1px solid var(--vscode-border)`；选中态 `border-top:1px solid <accent>`、`border-bottom:none`；`transition: background-color 0.2s`；只有 1 个 tab 时整条隐藏（`:232`）。
   - Tab 标题 13px，关闭按钮 16×16、`visibility:hidden` → `Tab:hover` 时显示。
2. **历史页/设置页的 `PageHeader`**（`components/PageHeader.tsx:14-25`）：`sticky top-0 z-20 py-3.5`，`border border-x-0 border-b border-solid`，左边 `ArrowLeftIcon ml-3 h-3 w-3`，标题 `mx-2 font-bold`。

> 想要「顶栏 + 历史按钮」的复刻者注意：Continue 把历史入口做成了**左侧常驻历史栏（≥1180px）**，窄侧栏下用户通过命令面板/`⌘L` 新建会话、用 `History` 路由页（`pages/history/index.tsx`，`PageHeader title="Chat"`）浏览历史。若你的 UI 需要一个顶栏，这是 Continue 没有的东西，需要自己设计。

### 1.3 历史列表（左侧栏 / 历史页共用 `components/History`）

- 搜索框（`History/index.tsx:153`）：`bg-vsc-input-background text-vsc-foreground flex-1 rounded-md border border-none py-1 pl-2 pr-8 text-sm outline-none`，placeholder `"Search past sessions"`；清除按钮 `XMarkIcon h-5 w-5 absolute right-3`。
- 分组标题（`:193-197`）：`sticky mb-3 ml-2 flex h-6 text-left text-base font-bold opacity-75`，第一组 `mt-2`，后续组 `mt-8`。
- 单行（`History/HistoryTableRow.tsx:81-97`）：`hover:bg-input relative mb-2 box-border flex w-full cursor-pointer overflow-hidden rounded-lg p-3`；标题 `line-clamp-1 break-all text-sm font-semibold`；消息数徽章 `bg-vsc-background text-secondary-foreground ml-auto rounded-full px-2 py-1 text-xs font-medium`；工作区名 `text-description-muted text-xs`。
- 悬停才出现的操作条（`:151`）：`bg-input absolute right-2 top-12 rounded-full px-2 py-1 shadow-md`，内含 Edit / Save as Markdown / Delete 三个 `HeaderButtonWithToolTip`，图标 `width="1em" height="1em"`。
- 底部（`:212-227`）：`border-border border-t px-2 py-3 text-xs` 里一个 `Button variant="secondary" size="sm"` "Clear chats"，下面 `text-description text-2xs` 提示会话保存路径。

### 1.4 空态（`pages/gui/EmptyChatBody.tsx`）

```tsx
showOnboardingCard ? <div className="mx-2 mt-6"><OnboardingCard/></div>
                   : <div className="mx-2 mt-2"><ConversationStarterCards/></div>
```

`ConversationStarterCard`（`components/ConversationStarters/ConversationStarterCard.tsx:14-28`）：

```
bg-vsc-input-background mb-2 w-full rounded-md shadow-md hover:cursor-pointer hover:brightness-110
  └─ flex px-3 py-1.5
     ├─ ChatBubbleLeftIcon text-lightgray h-5 w-5（左，mr-3 self-start pt-0.5）
     └─ 标题 text-xs font-medium ／ 描述 text-lightgray text-xs
```

卡片最多渲染 5 张（`NUM_CARDS_TO_RENDER = 5`），`lg:grid lg:grid-cols-3 lg:gap-4`；「Show N more...」为 `text-lightgray mt-1 cursor-pointer text-xs hover:underline`。

### 1.5 消息列表与逐条排布

`Chat.tsx:266-378` 的 `renderChatHistoryItem` 按 `message.role` 分支：

| role | 渲染 |
| --- | --- |
| `user` | **不是一个气泡**，而是**再渲染一个 `ContinueInputBox`（`isMainInput={false}`）**，把当时的 editorState / contextItems / appliedRules 回填（`:281-295`）。所以历史里的用户消息长得和输入框一模一样。 |
| `tool` | `return null`（`:297-299`）——工具结果不单独成气泡，只通过工具调用 UI 展示。 |
| `thinking` | `ThinkingBlockPeek`，外面包一层 `opacity-50`（若在最新摘要之前）（`:337-354`）。 |
| `assistant` | `TimelineItem` + `StepContainer`，然后若 `toolCallStates` 存在再追加 `<ToolCallDiv/>`（`:301-335`）。 |
| 其他 | 同上默认分支（`:356-375`）。 |

`system` 角色在 map 前被过滤掉（`:394`）。每条外层用 `key={item.message.id}` + `ErrorBoundary`（fallback 显示 `Something went wrong` + 红色 message + 灰色栈）。

**助手消息没有头像**。`TimelineItem`（`components/gui/TimelineItem.tsx`）的 `open=true` 时直接渲染 children，折叠态才显示 `ChatBubbleOvalLeftIcon width="16px" height="16px"` + `role + " Message"`。`Chat.tsx:308-310` 传的就是这个 16px 图标，且 `onToggle` 是空函数——**折叠功能实际不可用**，图标是装饰性的。

`StepContainer`（`components/StepContainer/StepContainer.tsx:77-105`）——一条助手消息的主体：

```tsx
<div className="bg-background p-1 px-1.5 ${isBeforeLatestSummary ? "opacity-35" : ""}">
  {reasoning?.text && <ThinkingBlockPeek ... />}
  <StyledMarkdownPreview isRenderingInStepContainer source={stripImages(content)} itemIndex={index} />
  {isLast && <ThinkingIndicator historyItem={item} />}
</div>
```

- 内边距 **`p-1 px-1.5`** = 上下 4px、左右 6px。
- 被摘要压缩掉的历史消息整块 `opacity-35`。
- 外层 `Chat.tsx:79-81` 的 `.thread-message { margin: 0 0 0 1px; }`。

紧随其后的 `ResponseActions`（`StepContainer.tsx:107-120` + `ResponseActions.tsx:47`）：

```tsx
<div className="mt-2 h-7 transition-opacity duration-300 ease-in-out ...">
  <div className="text-description-muted mx-2 flex cursor-default items-center justify-end space-x-1 bg-transparent pb-0 text-xs">
```

按钮（都是 `HeaderButtonWithToolTip`，图标 **`h-3.5 w-3.5` = 14px**，配色 `text-description-muted`）：Compact conversation（`ArrowsPointingInIcon`，上下文 > 60% 时才显示 "Compact conversation" 文字标签，> 80% 或已剪枝时变 `text-warning`）→ Continue generation（`BarsArrowDownIcon`，仅内容疑似截断时）→ Delete（`TrashIcon`）→ Copy（`CopyIconButton`，`h-3.5 w-3.5 text-description-muted`，成功态 `h-3.5 w-3.5 text-success`）→ FeedbackButtons。

**截断判定**（`StepContainer.tsx:41-59`）：非流式时取纯文本，若不以 `. ? ! ``` :` 结尾且末两字符不是 emoji，则认为被截断。这是一个可以照抄的廉价启发式。

### 1.6 用户消息 / 输入框的差异

历史用户消息与底部主输入框唯一的差别是：`isMainInput` 决定是否渲染顶部的 `Lump` 缺口条（`ContinueInputBox.tsx:116`）、是否显示 `max-h-[70vh]` 上限（`TipTapEditor.tsx:269`）、以及 Enter 按钮的 variant（primary / secondary，`InputToolbar.tsx:226`）。

### 1.7 代码块与 Apply / Insert / Copy 工具栏

助手 Markdown 里**每一个 `<pre>`** 都被 `StyledMarkdownPreview` 的 rehypeReact `pre` 覆盖替换为 `<StepContainerPreToolbar>`（`components/StyledMarkdownPreview/index.tsx:292-331`），条件 `props.isRenderingInStepContainer` 为真（助手消息里始终为真）。

卡片外壳（`StepContainerPreToolbar/index.tsx:295`）：

```
outline-command-border -outline-offset-0.5 rounded-default bg-editor !my-2 flex min-w-0 flex-col outline outline-1
```

注意：用的是 `outline` 而非 `border`，配合 `outline-offset-0.5`（-0.5px）让描边内缩；`bg-editor` = `--vscode-editor-background`。

头部行（`:296-299`）：

```
find-widget-skip bg-editor sticky -top-2 z-10 m-0 flex items-center justify-between gap-3 px-1.5 py-1
  + 展开态追加 "rounded-t-default border-command-border border-b"，折叠态 "rounded-default"
  + style={{ fontSize: `${getFontSize() - 2}px` }}   // 默认 12px
```

左侧 `<div className="flex max-w-[50%] flex-row items-center">`（`:300`）：
1. 可选状态图标，固定 16×16 盒子；
2. `ChevronDownIcon`，`text-lightgray h-3.5 w-3.5 flex-shrink-0 cursor-pointer hover:brightness-125`，展开 `rotate-0` / 折叠 `-rotate-90`，`data-testid="toggle-codeblock"`；
3. `FileInfo`（有 `data-relativefilepath` 时，渲染 seti 文件图标 20×20 + 文件名 basename），否则显示语言名 `text-lightgray ml-2 select-none capitalize`。

右侧 `<div className="flex items-center gap-2.5">`（**gap 10px**），**从左到右固定顺序**：

| 顺序 | 按钮 | 图标与类名 | 出现条件 |
| --- | --- | --- | --- |
| 1 | **Insert** | `ArrowLeftEndOnRectangleIcon h-3.5 w-3.5`，tooltip "Insert Code"；外层再套 `max-2xs:hidden`（< 170px 隐藏） | `!isGeneratingCodeBlock` |
| 2 | **Copy** | `ClipboardIcon h-3.5 w-3.5`，复制成功后 2s 变 `CheckIcon h-3.5 w-3.5 text-green-500`，tooltip "Copy Code"（`useCopy`：JetBrains 走 `copyText` 消息，否则 `navigator.clipboard`） | 同上 |
| 3 | **动作槽**（六选一） | 见下 | — |

Insert + Copy 这一组外面还包了一层 `<div className="xs:flex hidden items-center gap-2.5">` —— **侧栏窄于 250px 时这两个按钮整体消失，只剩动作槽**。

动作槽分支（`renderActionButtons()`，`:242-286`）：
1. 生成中或工具调用待批准 → `<Spinner/>` 或 `text-lightgray` 的 `"{N} line(s) pending"`；
2. 是终端命令块（语言 `bash`/`sh`，或无语言且单行/以 `npm,pnpm,yarn,bun,deno,npx,cd,ls,pwd,pip,python,node,git,curl,wget,rbenv,gem,ruby,bundle` 开头）→ **Run in terminal**（`CommandLineIcon h-3 w-3` + `Run`，文字 `max-sm:hidden`，外框 `style={{color: lightGray}}`）；
3. `fileExists` 查询中 → `null`；
4. 文件已存在或无路径 → **ApplyActions**：
   - `status === "streaming"`：`bg-badge flex select-none items-center rounded pl-2 pr-1` 内 `Applying` + Spinner；
   - `status === "done"`：`bg-badge ... rounded sm:gap-1 md:px-1.5` 内 `"N diff(s)"`（`max-md:hidden`）+ 拒绝 `XMarkIcon text-error h-3.5 w-3.5` + 接受 `CheckIcon text-success h-3.5 w-3.5`，testId `codeblock-toolbar-reject` / `codeblock-toolbar-accept`；
   - 默认：`<button data-testid="codeblock-toolbar-apply" className="text-lightgray flex cursor-pointer items-center border-none bg-transparent pl-0 text-xs outline-none hover:brightness-125">`，内含 `<PlayIcon className="h-3.5 w-3.5"/>` + `<span className="xs:inline hidden">Apply</span>`（**< 250px 时只剩图标**），tooltip "Apply Code"；
5. 文件不存在 → **Create file**（`DocumentPlusIcon h-3.5 w-3.5 shrink-0` + `line-clamp-1 break-all` 的 "Create file" 文字，`data-testid="codeblock-toolbar-create"`，tooltip "Create File with Code"）。

> 三条容易被忽略的细节：
> - 只有 `relativeFilepath` 已带扩展名（`/\.[0-9a-z]+$/i`）才渲染工具栏（`:288-292`），避免流式过程中路径半截时闪出工具栏。
> - **没有 "Apply to file" 这个按钮**，v1.3.40 只有 Apply 与 Create file。
> - 折叠长代码块由 `CollapsibleContainer` 负责，`maxHeight = "max-h-40"`（160px），折叠时底部叠一层 `from-editor absolute bottom-0 h-12 bg-gradient-to-t to-transparent`（48px 渐隐）+ 居中 16px 下箭头；**没有行数阈值**。当前只有 `EditFile.tsx` 传了 `collapsible={true}`，其余代码块默认全展开。

代码本体的样式（`SyntaxHighlightedPre.tsx:18-30` + `StyledMarkdownPreview/index.tsx:64-85`）：
- `pre`：`background-color: var(--vscode-editor-background)`；`border-radius: 0 0 0.5rem 0.5rem !important`；`max-height: 40vh`；`overflow-y: scroll !important`；`padding: 8px`；`max-width: calc(100vw - 24px)`。
- 行内 `code`：`border-radius: 0.3125rem`（5px），`font-size: getFontSize() - 2` = 12px，`font-family: var(--vscode-editor-font-family)`。

### 1.8 工具调用的渲染形态

`ToolCallDiv`（`pages/gui/ToolCallDiv/index.tsx`）挂在助手 `StepContainer` 之后，输入 `toolCallStates: ToolCallState[]` 与 `historyIndex`。状态机取值（`core/index.d.ts:497-503`）：

```ts
type ToolStatus = "generating" | "generated" | "calling" | "errored" | "done" | "canceled";
```

**分支优先级（首个命中者胜出，`:40-106`）**：

| # | 条件 | 渲染 |
| --- | --- | --- |
| 1 | `mcpUiState` 存在 | `ToolCallDisplay` + `McpAppRenderer`（sandbox iframe，高度 clamp 100–800px，默认 300） |
| 2 | 工具在 `config.config.tools` 里声明了 `toolCallIcon` | `SimpleToolCallUI`（`generated` 态把 icon 换成 `ArrowRightIcon`） |
| 3 | 工具名 ∈ {`single_find_and_replace`, `multi_edit`, `run_terminal_command`} | `<div className="flex flex-col px-1">` 包住 `FunctionSpecificToolCallDiv`（**无头部状态行**，子组件自带卡片外壳） |
| 4 | 兜底 | `ToolCallDisplay`（带状态图标头） + `FunctionSpecificToolCallDiv` |

`FunctionSpecificToolCallDiv` 的 switch（`:20`）：

| 工具名 | 组件 | 关键 props |
| --- | --- | --- |
| `create_new_file` | `CreateFile` | `relativeFilepath`, `fileContents` |
| `edit_existing_file` | `EditFile` | `relativeFilePath`, `changes`, `toolCallId` |
| `single_find_and_replace` | `FindAndReplaceDisplay` | 把 `old_string/new_string/replace_all` 包成单元素 `EditOperation[]` |
| `multi_edit` | `FindAndReplaceDisplay` | `edits[]` |
| `run_terminal_command` | `RunTerminalCommand` | `command`, `toolCallState` |
| 其他 | `null`（仅剩头部状态行） | — |

**所有分支统一 `processedArgs ?? parsedArgs` 取参**：预处理过的参数优先，流式未完成时回退原始解析结果。

#### 1.8.1 通用头部 `ToolCallDisplay`（`:38-60`）

```
flex flex-col justify-center px-4
  └─ mb-2 flex flex-col
     └─ flex flex-row items-start justify-between gap-1.5
        ├─ flex min-w-0 flex-row items-center gap-2（有输出时追加 cursor-pointer hover:brightness-125）
        │   ├─ 图标盒：mt-[1px] h-4 w-4 flex-shrink-0 font-semibold（16×16）
        │   └─ ToolCallStatusMessage
        └─ ToolTruncateHistoryIcon（有 output 时；BarsArrowUpIcon h-3 w-3 opacity-60）
```

`ToolCallStatusMessage` 文案 = `Continue {intro} {message}`（`text-description line-clamp-4 min-w-0 break-words`，`data-testid="tool-call-title"`）：

| status | intro | 默认文案 |
| --- | --- | --- |
| `generating` | `will` | `use the <tool> tool` |
| `generated` | `wants to` | 同上 |
| `calling` | `is` | `calling the <tool>` |
| `done` | 空 | `used the <tool>` |
| `errored` / `canceled` | `tried to` | `use the <tool> tool` |

（工具若带 Mustache 模板 `wouldLikeTo` / `isCurrently` / `hasAlready` / `displayTitle`，则用模板渲染。）

状态图标（`utils.tsx:70-83`，永远套在固定 16×16 盒子里）：

| status | 图标 | 样式 |
| --- | --- | --- |
| `generating` / `calling` | `Spinner` | `animate-spin-slow h-3.5 w-3.5 text-gray-400` |
| `generated` | `ArrowRightIcon` | `color={vscButtonBackground}` |
| `done` | `CheckIcon` | `text-success`（`#4caf50`） |
| `errored` / `canceled` | `XMarkIcon` | `text-error`（`#f44336`） |

#### 1.8.2 多工具聚合

`shouldShowGroupedUI = toolCallStates.length > 1 && isStreamingComplete`（`:34`）。聚合容器（`:110-121`）：

```
border-border rounded-lg border px-4 py-3 pb-0
  ├─ GroupedToolCallHeader
  └─ 折叠体：overflow-y-auto transition-all duration-300 ease-in-out
             open ? "max-h-[50vh] opacity-100" : "max-h-0 opacity-0"
             └─ 每行 <div className="py-1 pl-6">
```

头部（`GroupedToolCallHeader.tsx:19-36`）：`mb-2` 包裹，行 `text-description flex cursor-pointer items-center gap-1.5 transition-colors duration-200 ease-in-out hover:brightness-125`，`FolderIcon` + `"{动词} {N} action(s)"`；动词优先级：`calling→Performing`，`generating→Generating`，`generated→Pending`，含 `done→Performed`，含 `errored|canceled→Attempted`。

扁平模式（流式中或仅一个调用）：`toolCallStates.map(... => <div className="py-1">)`。

#### 1.8.3 各工具专属形态

**CreateFile / EditFile**：不自己画 UI，而是**合成一段带路径的围栏代码块字符串**交给 `StyledMarkdownPreview`，从而复用 §1.7 的代码块工具栏。`EditFile` 传 `collapsible={true}` + `expandCodeblocks={false}`（默认折叠）、`toolCallId`；`CreateFile` 传 `disableManualApply`（文件不存在时工具栏显示 "Create file" 而非 "Apply"）。

**FindAndReplace（diff 视图，`FindAndReplace.tsx:208-260`）**：

```
mx-2 my-1 flex min-w-0 flex-col rounded-default bg-editor outline outline-1 outline-command-border -outline-offset-0.5
  └─ 头部：bg-editor sticky -top-2 z-10 flex items-center justify-between gap-3 px-1.5 py-1
           + 展开 "rounded-t-default border-command-border border-b" / 折叠 "rounded-default"
     ├─ ChevronDownIcon text-lightgray h-3.5 w-3.5 rotate-0/-rotate-90
     ├─ FileInfo（displayName + onClick→openFile）
     ├─ DiffStats：flex items-center gap-1 font-mono text-xs，"+" 用 text-success、"-" 用 text-error
     └─ ApplyActions（disableManualApply=true）
  └─ 展开体：`${showChatScrollbar ? "thin-scrollbar" : "no-scrollbar"} max-h-72 overflow-auto`
     └─ <pre className="bg-editor m-0 w-fit min-w-full text-xs leading-tight whitespace-pre(-wrap)">
```

diff 行（`:58-67`）：`px-3 py-px font-mono`，行首标记 `<span className="mr-2 select-none {diffCharClass}">{diffChar}</span>`；删除行 `border-l-4 border-red-900 bg-red-900/30` + `text-red-600`，新增行 `border-l-4 border-green-600 bg-green-600/20` + `text-green-600`。未变更上下文最多保留 2 行，其余折叠成 `<div className="text-description-muted px-3 py-1 text-left font-mono">⋯</div>`。无差异时容器内显示 `text-description-muted p-3` 的 "No changes to display"；查找失败时**不套外壳**，只渲染 `text-description mt-2 px-3` 的 "The searched string was not found in the file"。

**RunTerminalCommand → UnifiedTerminal**：

```
外层：mx-2 mb-4，data-testid="terminal-container"
      styled：bg var(--background)、font-size getFontSize()（14px）、line-height 1.5
卡片：outline-command-border rounded-default bg-editor !my-2 flex min-w-0 flex-col outline outline-1
头部：同代码块工具栏（12px），ChevronDownIcon h-3.5 w-3.5 + "Terminal"
右侧：复制 + Run in terminal
主体：<pre className="bg-editor"><code>
      命令行：<div className="text-terminal pb-2">   ← 绿 #0dbc79
      运行中无输出：BlinkingCursor（"█"，blink 1s infinite）
      输出仅显示前 15 行，超出显示 "<N> more lines" 折叠按钮 + 100px 顶部渐变遮罩
底部状态：text-description flex items-center px-2 py-2 text-xs，
         borderTop: 1px solid var(--vscode-commandCenter-inactiveBorder,#555555)
         └─ 8×8 圆点 mr-2 h-2 w-2 rounded-full，bg-success / bg-accent / bg-error，运行中加 animate-pulse
```

**SimpleToolCallUI（`SimpleToolCallUI.tsx`）**：`mt-1 flex flex-col px-4`，行 `flex min-w-0 flex-row items-center justify-between gap-2`；左侧 `text-description ... gap-1.5 text-xs` + `ToggleWithIcon` + `ToolCallStatusMessage`；右侧 `ToolTruncateHistoryIcon`；展开区 `mt-2 ... max-h-[50vh] opacity-100` / `max-h-0 opacity-0`，条目为 `ContextItemsPeekItem`。

### 1.9 底部输入框

组件链（详见 §3 组件清单）：

```
Chat → div.relative.shrink-0
  └─ ContinueInputBox (isMainInput, inputId="main-editor-input")
     └─ div.relative.flex.flex-col.px-2
        ├─ Lump                                ← 缺口条（仅主输入）
        └─ GradientBorder (padding 1px, radius 0.5rem)
           └─ InputBoxDiv (styled)
              └─ div.px-2.5.pb-1.pt-2
                 ├─ EditorContent.scroll-container.overflow-y-scroll.max-h-[70vh]
                 ├─ InputToolbar
                 └─ DragOverlay（拖拽时）
```

**A. 外框 `InputBoxDiv`**（`TipTapEditor/components/StyledComponents.ts:13-44`）：

```css
border-radius: 0.5rem;          /* 8px */
padding-bottom: 1px;
background-color: var(--vscode-input-background, #2d2d2d);
color: var(--vscode-editor-foreground, #e6e6e6);
border: 1px solid var(--vscode-commandCenter-inactiveBorder, #555555);
transition: border-color 0.15s ease-in-out;
font-size: 14px;                /* getFontSize() */
&:focus-within { border: 1px solid var(--vscode-commandCenter-activeBorder, #4d8bf0); }
&::placeholder { color: #999998cc; }
```

**B. `GradientBorder`（Continue 招牌视觉之一）**（`mainInput/GradientBorder.tsx:3-39`）：

- 结构：一层 `padding: 1px` 的 div，半径 `0.5rem`，`background-size: 200% 200%`，`animation: gradient 6s linear infinite`（loading 为 0 时动画名为空，等效关闭）。
- 空闲态：`borderColor = vscBackground` → 描边用页面背景色画，视觉上「无边框」，真正可见的是 `InputBoxDiv` 自己那圈 `#555`。
- 流式态（`isStreaming && (isLastUserInput || isInEdit)`）：`borderColor = undefined` → 显示七彩渐变，**并追加 `margin-top: 8px`**。
- 渐变原文：

```css
repeating-linear-gradient(101.79deg,
  #1BBE84 0%, #331BBE 16%, #BE1B55 33%, #A6BE1B 55%,
  #BE1B55 67%, #331BBE 85%, #1BBE84 99%)
```

关键词画 `0px 0 → 100em 0`。**注意：这是硬编码 hex，不跟随主题。**

**C. `Lump` 缺口条**（`mainInput/Lump/index.tsx:8-12`）：

```
bg-input rounded-t-default border-command-border mx-1.5 border-l border-r border-t
  └─ xs:px-2 px-1 py-0.5
```

`margin-inline: 6px` 让它比输入框窄一截、圆角只在上方 → 形成「输入框顶部长出一个圆角标签」的缺口观感。里面只有一个随状态切换的 `LumpToolbar`（优先级见下）。

**D. 工具栏 `InputToolbar`**（`mainInput/InputToolbar.tsx:79-247`）：

```
find-widget-skip bg-vsc-input-background flex select-none flex-row items-center justify-between gap-1 pt-1
  可见态追加 mt-2 cursor-text opacity-100；隐藏态 pointer-events-none h-0 opacity-0
  style.fontSize = getFontSize() - 2   // 12px
```

- 显示时机：主输入框聚焦/悬停才出现（`shouldHideToolbar` 初值 `true`），失焦 100ms 后收起；编辑模式强制常显。
- **左侧组**（`gap-1`，`xs:gap-1.5`）——顺序固定：
  1. **模式切换 `ModeSelect`**（非编辑态）：`data-testid="mode-select-button"`，class 为 `xs:px-2 text-description bg-lightgray/20 gap-1 rounded-full border-none px-1.5 py-0.5 transition-colors duration-200 hover:brightness-110`，`borderRadius: 0.5rem` 内联，字号 11px。图标 `ModeIcon` 12×12：`agent→SparklesIcon`、`plan→SwatchIcon`、`chat→ChatBubbleLeftIcon`（`background→RocketLaunchIcon`，UI 里选不到）。文字 `hidden sm:block` → **< 330px 只剩图标**；右侧 `ChevronDownIcon h-2 w-2`（8px）。三个选项 `Chat / Plan / Agent`，带 `InformationCircleIcon h-2.5 w-2.5` tooltip（"All tools disabled" / "Read-only/MCP tools available" / "All tools available"），弹层底部提示 `{⌘|Ctrl} . for next mode`。循环顺序 **chat → plan → agent → chat**。
  2. **模型下拉 `ModelSelect`**：`data-testid="model-select-button"`，`text-description h-[18px] gap-1 border-none`，11px；标题 `line-clamp-1 break-all`；chevron `hidden h-2 w-2 min-[200px]:flex`（**只有 200px 以下才隐藏箭头，标题始终显示**）。弹层 `min-w-[160px]`，头部 "Models" + 齿轮，列表 `no-scrollbar max-h-[300px] overflow-y-auto`，选中项 `bg-list-active text-list-active-foreground`，行内含 `CubeIcon h-3 w-3`，`(Missing API key)` 用 `text-[10px] italic`；底部 "Add Chat model" + `{⌘|Ctrl}' to toggle model`。
  3. **图片附件**（`supportsImages(model)` 时）：`PhotoIcon h-3 w-3 hover:brightness-125`，外层 `xs:flex ... hidden`（**< 250px 隐藏**），隐藏的 `<input type="file" accept=".jpg,.jpeg,.png,.gif,.svg,.webp">`，tooltip "Attach Image"。
  4. **@ 上下文**：`AtSymbolIcon h-3 w-3`，tooltip "Attach Context"，点击往编辑器插入一个 `@` 字符触发 mention。
  5. **推理开关**（`modelSupportsReasoning` 时）：开 `LightBulbIconSolid h-3 w-3 brightness-200`，关 `LightBulbIconOutline h-3 w-3`。
- **右侧组**（`text-description flex items-center gap-2 whitespace-nowrap`，`style.fontSize = getFontSize() - 3` = **11px**）：
  1. `ContextStatus` 上下文占用条（见 §2.5）；
  2. Active file 提示：`hidden ... md:flex`（**< 460px 隐藏**），文案 `{⌘|Ctrl}⏎ No active file` / `Active file`，按住 Meta/Ctrl/Alt 时加 `underline`；
  3. 编辑态显示 `Esc to exit Edit`（`hidden sm:flex`，≥330px）；
  4. **发送按钮**：`<Button variant={isMainInput ? "primary" : "secondary"} size="sm" data-testid="submit-input-button">`，`sm` = `px-1.5 py-0.5 text-2xs`（11px），圆角 8px，`fontFamily: system-ui, -apple-system, sans-serif`，`primary` = `bg-primary text-primary-foreground hover:enabled:brightness-125`。内容 `<span className="hidden md:inline">⏎ {enterText ?? "Enter"}</span><span className="md:hidden">⏎</span>` → ≥460px 显示 "⏎ Enter"，窄侧栏只显示 "⏎"。

> **重要更正**：Continue v1.3.40 的发送按钮**不会变成停止按钮**；流式时它只是 `disabled`。**停止**在 `Lump` 缺口条里（`StreamingToolbar` 的 "Stop ⌘⌫"）。工具栏里也**没有**历史按钮、新建会话按钮、斜杠命令按钮。

**E. 编辑器（TipTap 2 / ProseMirror）**

- 扩展清单（`utils/editorConfig.ts:150-388`）：`Document`、`History`、`Image`（扩展了粘贴图片与选中装饰）、`Placeholder`、`Paragraph`（全部键盘处理）、`Text`、自定义 `Mention`（`char:"@"`）、自定义 `SlashCommand`（`char:"/"`, `startOfLine:true`）、自定义 `PromptBlock`、自定义 `CodeBlock`（`atom:true, selectable:true`）。装了但没用到的：`@tiptap/starter-kit`、`@tiptap/extension-dropcursor`。
- `editorProps`：`class: "ProseMirror outline-none overflow-hidden"`，`style.font-size = getFontSize()`，`data-testid = "editor-input-main"`（主输入）或 `editor-input-${inputId}`。
- 字体：`font-family: inherit` → 继承 `index.css:23-41` 的 `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`，`line-height: 1.3`。段落 `my-1`。**Inter / JetBrains Mono 虽然 `@font-face` 声明了，但输入框不使用**。
- 高度：无 min-height；主输入上限 `max-h-[70vh]`。容器内边距 `px-2.5 pb-1 pt-2`（左 10、右 10、下 4、上 8）。
- Placeholder（`:32-43`）：显式传入优先（编辑模式 `"Edit selected code"`），否则 `history.length === 0 ? "Ask anything, '@' to add context" : "Ask a follow-up"`。CSS 渲染（`TipTapEditor.css:19-27`）：`color:#646464; float:left; height:0; white-space:nowrap; width:1px;`。
- 快捷键（`editorConfig.ts:231-346`）：`Enter` 提交（下拉打开时返回 `false` 换行）；`Shift+Enter` 换行；`Mod-Enter` / `Alt-Enter` 提交但**不带** active file；`Mod-Backspace` 流式中吞掉；`Mod-a` 全选含图片；`↑` 文档开头取上一条历史、`↓` 文档末尾取下一条；`Esc` 关闭下拉 / 退出编辑 / 聚焦编辑器。
- Mention 芯片（`TipTapEditor.css:1-8`）：`.mention { background-color: var(--vscode-badge-background,#bfe2b6); color: var(--vscode-badge-foreground,--vscode-foreground,#000); border-radius: 3px; font-size: 0.9em; padding: 0.05em 0.15em; transition: background-color .2s ease-in-out; }` —— **芯片内没有图标，也没有按类型分色**。
- 图片：插入永远在文档位置 0；上传前压到 ≤1024×1024 JPEG q=0.7，接受 jpeg/png/gif/svg/webp 且 < 10MB；`.tiptap img { max-width:96%; border:1px solid transparent }`，选中 `outline:3px solid var(--vscode-badge-background,#bfe2b6)`，node 属性 `object-contain max-h-[210px] max-w-full mx-1`。拖拽时 `DragOverlay`（`opacity:.5` + `bg-badge` 全屏遮罩，文案 "Hold ⇧ to drop image"）。
- 输入框里的 `@code` / `/prompt` 块：`border-radius:0.5rem`，`background-color: var(--vscode-editor-background,#1e1e1e)`，`border:0.5px solid <badge|lightGray>`，`max-height:100px`（展开 300px），头部 `border-b-command-border px-[5px] py-1.5`，字号 `getFontSize()-3` = 11px。

**F. `@` 提及下拉**（`AtMentionDropdown/index.tsx`）

- 宿主是 **tippy.js** 弹层，挂到 `div#tippy-js-div.fixed.z-50`（在 `InputBoxDiv` 内，`TipTapEditor.tsx:312`）。`placement: "bottom-start"`，`trigger: "manual"`，`interactive: true`，`maxWidth: window.innerWidth - 24`，`allowSpaces: true`。**没有引入任何 tippy 默认 CSS**，视觉全部来自下面的 styled 组件。
- 容器：
  ```css
  border-radius: 0.5rem;
  box-shadow: 0 0 0 1px rgba(0,0,0,.05), 0px 10px 20px rgba(0,0,0,.1);
  font-size: 12px; max-height: 330px; padding: 0.2rem;
  background-color: var(--vscode-input-background, #2d2d2d);
  ```
- 行：`border-radius: 0.4rem; padding: 2px 4px; border: 1px solid transparent;`，`data-testid="context-provider-dropdown-item"`；**选中态** `background-color: var(--vscode-list-activeSelectionBackground, #2c5aa050)` + `color: var(--vscode-list-activeSelectionForeground, #ffffff)`。这里只用了 `list-active`，`list-hover`（`#383838`）没用；鼠标移动即改变选中项。
- 行内容：左侧 provider 图标（`getIconFromDropdownItem`，尺寸 `1.2em`；`file`/`code` 类型改用 20×20 的 `FileIcon`）+ 标题 `whitespace-nowrap`；右侧描述默认 `opacity: 0`，**只有当前高亮行淡入**，颜色 `#999998`；子菜单 provider 追加 `ArrowRightIcon ml-2`。
- Provider 列表（`@` 菜单可见文案）：Files / Code / Current File / Folder / Codebase / Repository Map / File Tree / Open Files / Git Diff / Search / Problems / Terminal / Clipboard / Docs / URL / Web / Google / MCP / Rules / Prompts / Database / PostgreSQL / Debugger / Operating System / HTTP / Jira Issues / GitHub Issues / GitLab Merge Request / Greptile / Discord / Commits，末尾固定追加 **"Add more context providers"**。`file` 类型排在最前。
- 斜杠命令复用同一组件，无命令时追加 **"Create a prompt"** 动作。

**G. 输入框下方区域**（`ContinueInputBox.tsx:140-148`，仅当有规则或上下文项）

- `ContextItemsPeek`：`ToggleDiv` 头部 `text-description flex cursor-pointer items-center justify-start text-xs hover:brightness-125`，标题 `"N context items"` 或 `"Gathering context" + AnimatedEllipsis`；展开体 `mt-2 ... max-h-[50vh] opacity-100` / `max-h-0 opacity-0`。
  条目芯片：`mr-2 flex cursor-pointer flex-row items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-1 text-xs hover:bg-white/10`，图标 18px，名称 `line-clamp-1 max-w-[130px]`，描述 `text-description-muted`。**没有删除按钮**——删除要在编辑器里的 code block 预览上点 X。
- `RulesPeek`：`text-xs` 行 `hover:bg-white/10`，`GlobeAltIcon`/`DocumentTextIcon` 16px，名称 `max-w-[50%] truncate font-medium`，副行 `text-gray-500`（`Always applied` 或 `Pattern: {globs}`）。
- `NewSessionButton`：`width:fit-content; margin: 2px auto 8px 6px; font-size:12px; border-radius:0.5rem; padding:2px 6px; color:#999998;` `:hover { background-color:#99999833; }`，外包 `xs:inline hidden`。

### 1.10 `LumpToolbar` 状态机（缺口条里显示哪个工具栏）

`LumpToolbar.tsx:171-211`，**首个命中者胜出**：

| # | 条件 | 渲染 |
| --- | --- | --- |
| 1 | 有 applyState `status === "streaming"` | `IsApplyingToolbar`（"Applying" + "⌘⌫ Cancel"） |
| 2 | `isInEdit && editApplyState.status === "done"` | `EditOutcomeToolbar` |
| 3 | `isInEdit` | `EditToolbar` |
| 4 | `ui.ttsActive` | `TtsActiveToolbar`（"■ Stop TTS"） |
| 5 | 有 `status === "calling"` 的 `run_terminal_command` | `StreamingToolbar`，文案 `Stop Terminal` / `Stop Terminal (N)` |
| 6 | `session.isStreaming` | `StreamingToolbar`（"Stop ⌘⌫"） |
| 7 | 有 `status === "generated"` 的工具调用 | `PendingToolCallToolbar`（每行 Reject / Accept） |
| 8 | 有 `status === "done"` 的 applyState | `PendingApplyStatesToolbar` |
| 9 | 兜底 | `BlockSettingsTopToolbar`（三个图标按钮：`PencilIcon` Configure rules / `WrenchScrewdriverIcon` Configure tools / `CubeIcon` Configure models，各 `text-description-muted h-3 w-3 hover:brightness-125`，右侧 `AssistantAndOrgListbox`） |

`StreamingToolbar` 内部：`flex w-full items-center justify-between`，左侧 `GeneratingIndicator`，右侧 `text-2xs cursor-pointer px-1.5 py-0.5 hover:brightness-125`，内含 `text-description` 的 "Stop" + `text-description-muted ml-1 opacity-75` 的 "⌘⌫"（JetBrains 用 Alt）。

全局快捷键（`LumpToolbar.tsx:26-39, 124-169`）：`⌘/Ctrl+Enter` 执行第一个待批准工具调用；`⌘/Ctrl+Backspace`（JetBrains 为 `Alt+Backspace`）取消。

---

## 2. 设计语言

### 2.1 Tailwind 自定义 token（`gui/tailwind.config.cjs`）

```js
screens: { "2xs":"170px", xs:"250px", sm:"330px", int:"380px", md:"460px",
           lg:"590px", xl:"720px", "2xl":"860px", "3xl":"1000px", "4xl":"1180px" },
animation:    { "spin-slow": "spin 6s linear infinite" },
borderRadius: { default: "0.5rem" },
fontSize:     { "2xs": "0.6875rem" },       // 11px
outlineOffset:{ 0.5: "0.5px" },
corePlugins:  { preflight: false },          // 关掉 Tailwind 的 reset，避免污染 VS Code 内建样式
```

断点是为输入框工具栏专门调的（`2xs` = 侧栏最小宽度 170px，`xs` = 常见侧栏 250px，`int` = 380px 但实际几乎没用上）。

### 2.2 颜色 token 与 `--vscode-*` 的对接

`gui/src/styles/theme.ts` 是整套配色的单一真相源。每个语义色是一条 `{ vars: [...], default: "#..." }` 记录，`varWithFallback(name)` 生成**递归 CSS 变量回退链**：

```ts
// "var(--vscode-button-background, #2c5aa0)"
getRecursiveVar(["--vscode-button-background"], "#2c5aa0")
```

Tailwind 颜色项直接调用它（`tailwind.config.cjs:39-101`），所以 `bg-primary` 编译出来就是 `background-color: var(--vscode-button-background, #2c5aa0)`。**这是 Continue 与 VS Code 主题对接的核心机制，也是最值得照搬的一条。**

| Tailwind 类 | CSS 变量候选 | 暗色 fallback |
| --- | --- | --- |
| `background` | `--vscode-sideBar-background`, `--vscode-editor-background`, `--vscode-panel-background` | `#1e1e1e` |
| `foreground` | `--vscode-sideBar-foreground`, `--vscode-editor-foreground`, `--vscode-panel-foreground` | `#e6e6e6` |
| `editor` / `editor-foreground` | `--vscode-editor-background` / `-foreground` | `#1e1e1e` / `#e6e6e6` |
| `primary` / `primary-foreground` / `primary-hover` | `--vscode-button-background` / `-foreground` / `-hoverBackground` | `#2c5aa0` / `#ffffff` / `#3a6db3` |
| `secondary` / `-foreground` / `-hover` | `--vscode-button-secondaryBackground` / `-secondaryForeground` / `-secondaryHoverBackground` | `#303030` / `#e6e6e6` / `#3a3a3a` |
| `border` / `border-focus` | `--vscode-sideBar-border`+`--vscode-panel-border` / `--vscode-focusBorder` | `#2a2a2a` / `#3a6db3` |
| `command` / `-foreground` | `--vscode-commandCenter-background` / `-foreground` | `#252525` / `#e6e6e6` |
| `command-border` / `command-border-focus` | `--vscode-commandCenter-inactiveBorder` / `-activeBorder` | `#555555` / `#4d8bf0` |
| `description` / `description-muted` | `--vscode-descriptionForeground` / `--vscode-list-deemphasizedForeground` | `#b3b3b3` / `#8c8c8c` |
| `input` / `-foreground` / `-border` / `-placeholder` | `--vscode-input-background` / `-foreground` / `--vscode-input-border`+`--vscode-commandCenter-inactiveBorder` / `--vscode-input-placeholderForeground` | `#2d2d2d` / `#e6e6e6` / `#555555` / `#9e9e9e` |
| `badge` / `badge-foreground` | `--vscode-badge-background` / `-foreground` | `#4d4d4d` / `#ffffff` |
| `info` | `--vscode-charts-blue`, `--vscode-notebookStatusRunningIcon-foreground` | `#2196f3` |
| `success` | `--vscode-notebookStatusSuccessIcon-foreground`, `--vscode-testing-iconPassed`, `--vscode-gitDecoration-addedResourceForeground`, `--vscode-charts-green` | `#4caf50` |
| `warning` | `--vscode-editorWarning-foreground`, `--vscode-list-warningForeground` | `#ffb74d` |
| `error` | `--vscode-editorError-foreground`, `--vscode-list-errorForeground` | `#f44336` |
| `link` | `--vscode-textLink-foreground` | `#5c9ce6` |
| `terminal` | `--vscode-terminal-ansiGreen` | `#0dbc79` |
| `accent` | `--vscode-tab-activeBorderTop`, `--vscode-focusBorder` | `#4d8bf0` |
| `list-hover` | `--vscode-list-hoverBackground` | `#383838` |
| `list-active` / `-foreground` | `--vscode-list-activeSelectionBackground` / `-foreground` | `#2c5aa050` / `#ffffff` |
| `table-oddRow` | `--vscode-tree-tableOddRowsBackground` | `#2d2d2d` |

废弃别名（`tailwind.config.cjs:103-109`，源码里仍在用但官方注释要求逐步移除）：`lightgray`（硬编码 `#999998`）、`vsc-input-background`、`vsc-background`、`vsc-foreground`、`vsc-editor-background`、`vsc-input-border`。

非 Tailwind 的颜色出口在 `gui/src/components/index.ts:4-30`，导出 `vscBackground` / `vscForeground` / `vscInputBackground` / `vscEditorBackground` / `vscBadgeBackground` / `vscListActiveBackground` / `vscFocusBorder` … 以及 `defaultBorderRadius = "0.5rem"`、`lightGray = "#999998"`、`greenButtonColor = "#189e72"`，供 styled-components 使用。

### 2.3 暗色 / 亮色如何工作

Continue **自己不实现明暗主题**，完全交给 VS Code：

1. VS Code 会向 webview 注入当前主题的全部 `--vscode-*` 变量 → 上表所有颜色自动跟随。
2. 只有语法高亮需要额外通道：宿主 `getTheme()` 把当前配色主题（含 `include` 链）解析成 Monaco 主题对象，通过 `setTheme` 消息 + `window.fullColorTheme` 下发；webview 侧 `context/VscTheme.tsx` 用 `hljsToTextMate` 映射表把 TextMate scope 颜色翻成 `.hljs-*` 类名颜色。拿不到时按 `--vscode-editor-background` 亮度选一套明/暗兜底调色板。
3. JetBrains 平台没有 `--vscode-*`，改走 `jetbrains/getColors → jetbrains/setColors`，用 `setDocumentStylesFromTheme()` 把值写回同名 CSS 变量（`theme.ts:226-266`）。
4. 细节：`setDocumentStylesFromTheme` 会**剥掉 hex 的 alpha 通道**（`#RRGGBBAA` → `#RRGGBB`，注释说带 alpha 会出坏色），并把值缓存进 localStorage 供非 VS Code IDE 冷启动。

### 2.4 字体与字号尺度

- 全局（`index.css:23-41`）：`font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif`；`line-height: 1.3`；`body { padding:0; margin:0; color: var(--vscode-editor-foreground) }`。
- `@font-face` 只声明了两个：`Inter`（InterDisplay-Light 300，`/fonts/Inter/InterDisplay-Light.woff2`）和 `JetBrains Mono`（Light 300，`/fonts/JetBrainsMono/JetBrainsMono-Light.woff2`）。它们用在快捷键徽标（`components/gui/Shortcut.css`），**聊天正文与输入框都不用**。
- 正文字号：`getFontSize()` = localStorage `fontSize` ?? (JetBrains ? 15 : 14)（`util/index.ts:50-52`）；`fontSize(n)` = `getFontSize() + n`。Markdown 正文用它，`code` 用 `-2`。
- 尺度一览：正文 14 / 代码 12 / 工具栏左 12、右 11 / `text-2xs` 11 / dropdown 12 / tooltip 10 / Markdown 标题 1.25em·1.15em·1.05em·1em·.95em·.9em（`StyledMarkdownPreview/index.tsx:40-62`）。
- Markdown 段落与列表 `line-height: 1.5`；`ul/ol` 缩进 2em（`index.tsx:102-105`）。

### 2.5 Continue 特有观感的构成要素

1. **七彩渐变描边**（#1BBE84 → #331BBE → #BE1B55 → #A6BE1B）只在流式时出现，6s 一圈，是「正在生成」最强的视觉信号。
2. **`Lump` 缺口条**：`margin-inline: 6px` + 仅上圆角，让输入框顶部「长出一个标签页」。
3. **代码块使用 `outline` + `-outline-offset-0.5` 而不是 border**，描边细且贴边；卡片背景是 `--vscode-editor-background`（比页面背景更暗/更亮一档），形成「内嵌编辑器」的观感。
4. **无头像、无气泡**：助手消息就是 Markdown 正文 + 一行右下角操作条；用户消息复用输入框组件。
5. **极窄侧栏适配**：250px 以下隐藏大量元素（模式文字、图片按钮、Apply 文字），只保留图标——这套响应式是围绕 VS Code 侧栏宽度设计的。
6. **上下文占用只用一个 5–7px 宽的小竖条**（`ContextStatus.tsx:93-98`）：

```tsx
<div className="border-command-border relative h-[14px] w-[7px] rounded-[1px] border-[0.5px] border-solid md:h-[10px] md:w-[5px]">
  <div className={`transition-height absolute bottom-0 left-0 w-full duration-300 ease-in-out ${isPruned ? "bg-error" : "bg-description"}`}
       style={{ height: `${percent}%` }} />
```

   仅当 `percent >= 60` 或 `isPruned` 时出现；tooltip 里给 `"{percent}% of context filled."` 以及 "Compact conversation" / "Start a new session" 两个下划线动作。

### 2.6 全局 CSS 工具类（`gui/src/index.css`）

| 类 | 作用 |
| --- | --- |
| `.fade-in-span` | `fadeIn 0.3s ease-in-out`（透明度 0→1） |
| `.thin-scrollbar` | `scrollbar-width: thin` |
| `.no-scrollbar` | 隐藏滚动条（webkit + `-ms-overflow-style`） |
| `.truncate-start` | 从**开头**截断的省略号（`direction: rtl; text-overflow: ellipsis`） |
| `.scroll-container` | `overflow-y:auto; scrollbar-width:thin; padding-right:4px`；webkit 滚动条宽 8px，轨道 `#f1f1f1` 圆角 4px，滑块 `#888`→hover `#555`，仅在 `:hover/:focus` 显示 |
| `*:focus { outline: none }` | 干掉 VS Code 默认的橙色 focus ring |
| `.rerender-flash` / `.render-count` | 仅调试用 |

`aria`/测试钩子类 `find-widget-skip` 出现在 4 处但**没有任何 CSS 定义**，只是给查找控件做标记。

---

## 3. 组件清单

### 3.1 核心渲染链（自顶向下）

| 组件 | 路径 | 职责 | 关键 props / state | 依赖层级 |
| --- | --- | --- | --- | --- |
| `GUI` | `pages/gui/index.tsx` | 左历史栏 + 右主区两栏布局 | — | 纯展示 |
| `Chat` | `pages/gui/Chat.tsx` | 组装消息列表与输入框；`sendInput` 派发流式 thunk | `stepsDivRef`, `isStreaming`, `history`, `MAIN_EDITOR_INPUT_ID` | redux + IdeMessenger |
| `Layout` | `components/Layout.tsx` | 100vh grid、路由 Outlet、全局 webview 监听 | — | redux + 路由 |
| `StepsDiv` | `Chat.tsx:71-82` | styled：滚动容器 + `.thread-message` 左边距 1px | — | 纯展示 |
| `TimelineItem` | `components/gui/TimelineItem.tsx` | 折叠态显示 16px 气泡图标 + `"{role} Message"` | `item, open, onToggle, children, iconElement` | 纯展示 |
| `StepContainer` | `components/StepContainer/StepContainer.tsx` | 一条助手消息主体：reasoning、Markdown、截断检测、压暗 | `item, index, isLast, latestSummaryIndex` | redux |
| `StyledMarkdownPreview` | `components/StyledMarkdownPreview/index.tsx` | remark/rehype 管线；`pre`→工具栏、`code`→符号链接、`img`→安全图片 | `source, itemIndex, isRenderingInStepContainer, showToolCallStatusIcon, disableManualApply, toolCallId, expandCodeblocks, collapsible` | redux |
| `SyntaxHighlightedPre` | `.../SyntaxHighlightedPre.tsx` | styled `pre`，`max-height:40vh`，`border-radius: 0 0 .5rem .5rem` | — | VscTheme context |
| `StepContainerPreToolbar` | `.../StepContainerPreToolbar/index.tsx` | 代码块卡片 + 头部 + Insert/Copy/动作槽 | 见 §1.7 | redux（`session.history`、applyState、fileExists 请求） |
| `ResponseActions` | `components/StepContainer/ResponseActions.tsx` | 压缩/续写/删除/复制/反馈一排 14px 图标 | `isTruncated, onDelete, onContinueGeneration, index, item, isLast` | redux |
| `ThinkingIndicator` | `components/StepContainer/ThinkingIndicator.tsx` | 仅 o1 系模型：`Thinking.` + 点数每 600ms | `historyItem` | redux |
| `ThinkingBlockPeek` | `components/mainInput/belowMainInput/ThinkingBlockPeek.tsx` | 思考块折叠面板，`max-h-[50vh] opacity-100` / `max-h-0 opacity-0` | `content, redactedThinking, index, inProgress, signature` | redux |
| `InlineErrorMessage` | `components/mainInput/InlineErrorMessage.tsx` | "Message exceeds context limit." 卡片（`rounded-md border p-4`） | — | redux + IdeMessenger |
| `EmptyChatBody` | `pages/gui/EmptyChatBody.tsx` | 空态：引导卡或会话起始卡 | `showOnboardingCard` | 纯展示 |
| `ConversationStarterCard(s)` | `components/ConversationStarters/` | 最多 5 张卡，`rounded-md shadow-md px-3 py-1.5` | `command, onClick` | redux（父层） |
| `TabBar` | `components/TabBar/TabBar.tsx` | 25px 高会话标签条 | — | redux |
| `History` / `HistoryTableRow` | `components/History/` | 历史搜索 + 分组列表 | `sessionMetadata, index` | redux + IdeMessenger |

### 3.2 输入框相关

| 组件 | 路径 | 职责 | 关键 props / state | 依赖层级 |
| --- | --- | --- | --- | --- |
| `ContinueInputBox` | `mainInput/ContinueInputBox.tsx` | 输入框外壳，`:focus-within`、GradientBorder、下方 peek | `isMainInput, isLastUserInput, onEnter, editorState, contextItems, appliedRules, hidden, inputId` | redux |
| `GradientBorder` | `mainInput/GradientBorder.tsx` | 1px 渐变描边层 | `borderRadius, borderColor, loading: 0\|1` | **纯展示（仅 styled-components）** |
| `TipTapEditor` | `mainInput/TipTapEditor/TipTapEditor.tsx` | 编辑器实例 + 拖拽 + 工具栏 | `editorState, onEnter, placeholder, isMainInput, availableContextProviders, availableSlashCommands, historyKey, toolbarOptions, inputId` | TipTap + redux |
| `InputBoxDiv` | `mainInput/TipTapEditor/components/StyledComponents.ts` | 真正带边框的盒子 | — | 纯展示 |
| `InputToolbar` | `mainInput/InputToolbar.tsx` | 模式/模型/图片/@/推理 + 发送 | `activeKey, toolbarOptions, disabled, isMainInput, onAddContextItem, onImageFileSelected, onEnter` | redux |
| `HoverItem` | `mainInput/InputToolbar/HoverItem.tsx` | `padding: 0 4px; padding-{top,bottom}: 2px; cursor:pointer` + 200ms 过渡 | `px` | **纯展示** |
| `ModeSelect` / `ModeIcon` | `components/ModeSelect/` | chat/plan/agent 胶囊 + 弹层 | 内部 `store.session.mode` | redux |
| `ModelSelect` | `components/modelSelection/ModelSelect.tsx` | `h-[18px]` 模型按钮 + 弹层 | — | redux |
| `ContextStatus` | `mainInput/ContextStatus.tsx` | 上下文占用小竖条 | — | redux |
| `Lump` / `LumpToolbar` | `mainInput/Lump/` | 缺口条 + 9 分支工具栏 | — | redux |
| `StreamingToolbar` / `GeneratingIndicator` | `.../LumpToolbar/` | "Generating…" + "Stop ⌘⌫" | `onStop, displayText` | **接近纯展示**（数据由父层注入） |
| `AnimatedEllipsis` | `components/AnimatedEllipsis.tsx` | 宽度动画省略号 | — | **纯展示** |
| `AtMentionDropdown` | `mainInput/AtMentionDropdown/index.tsx` | `@`/`/` 下拉 | TipTap 命令接口 | redux（少量） |
| `ContextItemsPeek` / `RulesPeek` | `mainInput/belowMainInput/` | 输入框下方上下文/规则 peek | `contextItems, isCurrentContextPeek` | redux |
| `ToggleDiv` | `components/ToggleDiv.tsx` | 通用折叠容器 | `title, icon, children, testId` | **纯展示** |
| `NewSessionButton` | `mainInput/belowMainInput/NewSessionButton.tsx` | "Last Session" | `onClick, className` | **纯展示** |

### 3.3 工具调用相关

| 组件 | 路径 | 依赖层级 |
| --- | --- | --- |
| `ToolCallDiv` | `pages/gui/ToolCallDiv/index.tsx` | redux（`state.config.config.tools`） |
| `FunctionSpecificToolCallDiv` | `.../FunctionSpecificToolCallDiv.tsx` | **仅 core 类型** |
| `ToolCallDisplay` | `.../ToolCallDisplay.tsx` | core + IdeMessenger |
| `SimpleToolCallUI` | `.../SimpleToolCallUI.tsx` | core + IdeMessenger |
| `CreateFile` / `EditFile` | `.../CreateFile.tsx`, `EditFile.tsx` | **仅 core 工具函数** |
| `FindAndReplace` | `.../FindAndReplace.tsx` | redux（`selectToolCallById`, `selectApplyStateByToolCallId`）+ `diff` 库 |
| `RunTerminalCommand` | `.../RunTerminalCommand.tsx` | core |
| `UnifiedTerminal` | `components/UnifiedTerminal/UnifiedTerminal.tsx` | redux（`moveTerminalProcessToBackground`） |
| `ToolCallStatusMessage` | `.../ToolCallStatusMessage.tsx` | **仅 core 类型** |
| `GroupedToolCallHeader` | `.../GroupedToolCallHeader.tsx` | **纯展示** |
| `ToggleWithIcon` | `.../ToggleWithIcon.tsx` | **纯展示** |
| `IndicatorBar` | `.../IndicatorBar.tsx` | **纯展示** |
| `ToolbarButtonWithTooltip` | `StyledMarkdownPreview/StepContainerPreToolbar/ToolbarButtonWithTooltip.tsx` | **纯展示** |
| `CollapsibleContainer` | `.../CollapsibleContainer.tsx` | **纯展示** |
| `ApplyActions` | `.../ApplyActions.tsx` | core 类型 + Spinner/ToolTip |
| `CopyButton` / `InsertButton` / `CreateFileButton` / `RunInTerminalButton` / `FileInfo` | 同上目录 | 仅 IdeMessenger / core 工具函数 |
| `ToolTruncateHistoryIcon` | `.../ToolTruncateHistoryIcon.tsx` | redux（`truncateHistoryToMessage`） |

**可直接搬的纯展示件**（无 redux / 无 core）：`GradientBorder`、`HoverItem`、`AnimatedEllipsis`、`ToggleDiv`、`NewSessionButton`、`TimelineItem`、`ToggleWithIcon`、`IndicatorBar`、`CollapsibleContainer`、`ToolbarButtonWithTooltip`、`GroupedToolCallHeader`、`ui/Button`、`ui/Card`、`ui/Divider`、`ui/EmptyState`、`ui/Listbox`、`ui/Popover`、`ui/Toggle`、`ui/SpoilerButton`、`gui/Tooltip`、`FileInfo`、`SyntaxHighlightedPre`。

其中三个基础原子值得单独抄下来：

```tsx
// ui/Button.tsx —— 五个 variant，sm/lg 两档，圆角 0.5rem，fontFamily: system-ui, -apple-system, sans-serif
primary   : "border-none text-primary-foreground bg-primary hover:enabled:brightness-125"
secondary : "border-none text-foreground bg-border hover:enabled:brightness-125"
outline   : "border border-solid border-description text-foreground bg-transparent hover:enabled:bg-input"
ghost     : "border-none text-foreground bg-inherit hover:enabled:bg-input"
icon      : "border border-solid border-description text-description rounded-full p-0 hover:enabled:text-foreground"
sm = "px-1.5 py-0.5 text-2xs"        lg = "px-2 py-1 text-sm"

// ui/Card.tsx     : "bg-editor rounded-default space-y-0 px-4 py-3"
// ui/Divider.tsx  : "border-command-border my-2 border-[0.5px] border-b border-solid opacity-20"
// ui/EmptyState   : "flex flex-col items-center justify-center p-1" + "text-description text-sm"
// gui/Tooltip     : fontSize: 10px; padding: 4px 8px; outline: 0.5px solid var(--vscode-descriptionForeground,#b3b3b3);
//                   max-width: 80vw; z-index: 1000; delayShow: 200ms; noArrow
// ui/SpoilerButton: background: vscBackground; margin: 8px 6px 0 2px; font-size: 12px;
//                   border: 0.5px solid #999998; border-radius: 0.5rem; padding: 4px 8px; color: #999998;
//                   box-shadow: 0 4px 6px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.08); transition: box-shadow .3s ease
```


**必须重写的耦合件**：任何 `useAppSelector`/`useAppDispatch`（约 20 个）、任何 `useContext(IdeMessengerContext)`、`StyledMarkdownPreview` 的 rehype 覆盖（依赖 `session.history`/`symbols`/`selectUIConfig`，改成 props 即可）。

**源码里明确是死代码、不要照抄的**：`ToolCallDiv/ToolCallArgs.tsx`（无导入者）、`TerminalCollapsibleContainer.tsx`、`IndicatorBar.tsx`（无外部导入者）、`ToolCallDisplay` 里 SimpleToolCallUI 的 "No tool call output" 分支不可达。另外 `ToolbarButtonWithTooltip.tsx:25` 的 `hover:description-muted/30` 和 `CreateFileButton.tsx:16` 的 `text-[${vscForeground}]` 都是**无效 Tailwind 类**（前者不是合法工具类，后者无法被扫描器静态提取）。

---

## 4. 消息协议（webview ↔ 扩展宿主）

### 4.1 信封

`core/protocol/messenger/index.ts`：

```ts
export interface Message<T = any> { messageType: string; messageId: string; data: T; }
```

双向都是这个形状。协议表定义在 `core/protocol/*.ts`，每条是 `[请求类型, 响应类型]` 元组，命名规则 **`ToXFromYProtocol` = 「从 Y 发往 X 的消息」**：

```ts
type FromWebviewProtocol = ToIdeFromWebviewProtocol & ToCoreFromWebviewProtocol;
type ToWebviewProtocol   = ToWebviewFromIdeProtocol & ToWebviewFromCoreProtocol & ToWebviewOrCoreFromIdeProtocol;
```

### 4.2 响应包裹（`core/protocol/util.ts`）

```ts
{ status: "error",   done: true,  error: string }
{ status: "success", done: true,  content: T }     // 单次请求的最终结果
{ status: "success", done: false, content: T }     // 生成器的中间产出（可多次）
```

流式就是靠 `done` 标志实现的，**不需要第二种消息类型**。

### 4.3 关键消息清单（按用途分组，供设计自己的 IPC 参考）

**流式与 LLM**
| 类型 | 请求 | 响应 | 路由 |
| --- | --- | --- | --- |
| `llm/streamChat` | `{ messages: ChatMessage[], completionOptions, title, messageOptions?, legacySlashCommandData? }` | `AsyncGenerator<ChatMessage, PromptLog>` | 流式 |
| `streamDiffLines` | `StreamDiffLinesPayload` | `AsyncGenerator<DiffLine>` | 流式 |
| `llm/compileChat` | `{ messages, options }` | `{ compiledChatMessages, didPrune, contextPercentage }` | 请求 |
| `llm/complete` / `llm/listModels` | `{prompt, completionOptions, title}` / `{title}` | `string` / `string[]?` | 请求 |
| `abort` | `undefined`（沿用**流本身的 messageId**） | `void` | 单向 |
| `ping` | `"ping"` | `"pong"` | 请求 |

**会话历史**：`history/list` `{offset?, limit?, workspaceDirectory?} → BaseSessionMetadata[]`、`history/load` `{id} → Session`、`history/save` `Session`、`history/delete` `{id}`、`history/clear`、`history/share` `{id, outputDir?}`。

**工具/进程**
| 类型 | 请求 | 响应 |
| --- | --- | --- |
| `tools/call` | `{ toolCall: ToolCall }` | `{ contextItems, errorMessage?, errorReason?, mcpUiState? }` |
| `tools/evaluatePolicy` | `{ toolName, basePolicy, parsedArgs, processedArgs? }` | `{ policy: ToolPolicy, displayValue? }` |
| `tools/preprocessArgs` | `{ toolName, args }` | `{ preprocessedArgs?, errorReason?, errorMessage? }` |
| `process/killTerminalProcess` / `markAsBackgrounded` | `{ toolCallId }` | `void` |
| `process/isBackgrounded` | `{ toolCallId }` | `boolean` |

**配置/上下文/索引**：`config/addModel`、`config/deleteModel`、`config/openProfile`、`config/getSerializedProfileInfo`、`config/refreshProfiles`、`config/updateSelectedModel`、`config/updateSharedConfig`、`context/getContextItems` `{name, query, fullInput, selectedCode, isInAgentMode} → ContextItemWithId[]`、`context/getSymbolsForFiles`、`context/loadSubmenuItems`、`context/addDocs|removeDocs|indexDocs`、`indexing/reindex|abort|setPaused`、`docs/*`、`mcp/*`、`models/fetch`、`stats/getTokensPerDay|PerModel`、`conversation/compact`、`chatDescriber/describe`。

**IDE 侧能力**（webview 与 core 都能调，`core/protocol/ide.ts`）：`getIdeInfo`、`getWorkspaceDirs`、`readFile`/`writeFile`/`saveFile`/`fileExists`/`listDir`/`getFileStats`、`openFile`/`showVirtualFile`/`showLines`、`readRangeInFile`、`getCurrentFile`/`getOpenFiles`/`getPinnedFiles`、`getProblems`、`runCommand`、`getTerminalContents`、`getSearchResults`/`getFileResults`、`getDiff`、`getBranch`/`getRepoName`/`getGitRootPath`、`gotoDefinition`/`getReferences`/`getDocumentSymbols`/`getSignatureHelp`、`readSecrets`/`writeSecrets`、`showToast`、`reportError`、`closeSidebar`。

**Webview 专属命令**（`ideWebview.ts` `ToIdeFromWebviewProtocol`）：`applyToFile`、`overwriteFile`、`insertAtCursor`、`copyText`、`acceptDiff`/`rejectDiff` `{filepath?, streamId?}`、`showFile`、`focusEditor`、`toggleDevTools`、`reloadWindow`、`toggleFullScreen`、`edit/sendPrompt`、`edit/addCurrentSelection`、`edit/clearDecorations`、`session/share`。

**宿主 → webview**
| 类型 | 载荷 | 触发方 |
| --- | --- | --- |
| `configUpdate` | `{ result: ConfigResult<BrowserSerializedContinueConfig>, profileId, profiles }` | core |
| `indexProgress` / `indexing/statusUpdate` | `IndexingProgressUpdate` / `IndexingStatus` | core |
| `addContextItem` | `{ historyIndex, item: ContextItemWithId }` | core |
| `toolCallPartialOutput` | `{ toolCallId, contextItems }` | core（工具执行过程增量输出） |
| `refreshSubmenuItems`、`didCloseFiles`、`sessionUpdate`、`setTTSActive`、`getWebviewHistoryLength`、`getCurrentSessionId`、`isContinueInputFocused` | 见 `core/protocol/webview.ts:11-44` | core / 宿主 |
| `setTheme` | `{ theme: any }` | 宿主（主题变更） |
| `setInactive` | `undefined` | 宿主（取消流） |
| `updateApplyState` | `ApplyState` | diff / apply manager |
| `newSession`、`newSessionWithPrompt`、`focusContinueInput(WithoutClear/WithNewSession)`、`focusContinueSessionId` | — | 宿主命令 |
| `highlightedCode`、`setCodeToEdit`、`addToChat`、`navigateTo`、`addModel`、`focusEdit`、`exitEditMode`、`openOnboardingCard`、`setupApiKey`、`setupLocalConfig`、`incrementFtc`、`applyCodeFromChat` | — | 宿主命令 |

### 4.4 IdeMessenger（webview 侧 API）

`gui/src/context/IdeMessenger.tsx:26-60`：

```ts
interface IIdeMessenger {
  post<T>(messageType, data, messageId?): void;                    // 单向
  respond<T>(messageType, data, messageId): void;                  // 回复宿主
  request<T>(messageType, data): Promise<WebviewSingleProtocolMessage<T>>;  // 一次性请求
  streamRequest<T>(messageType, data, cancelToken?): AsyncGenerator<...[]>; // 流式
  llmStreamChat(msg, cancelToken): AsyncGenerator<ChatMessage[], PromptLog | undefined>;
  ide: IDE;   // 所有 IDE 方法被包成 request()
}
```

- 发送：`_postToIde` → `vscode.postMessage({ messageId, messageType, data })`。`post` 失败会以 `2^attempt * 1000` ms 退避重试 **5 次**。
- `request`：注册 `window.addEventListener("message", ...)`，比对 `event.data.messageId`，命中即 resolve 并移除监听。**没有超时、没有 reject 路径**（消息丢失就是永远 pending）——自建时建议补超时。
- `streamRequest`：`post` 后把 `done === false` 的 `content` 推入 buffer，**每 50ms 轮询**一次并 `yield buffer.slice(index)`；`done === true` 时记录返回值并结束。注意 yield 出来的是**数组**（注释里明确说明了这一点）。
- 取消：`cancelToken.addEventListener("abort", () => this.post("abort", undefined, messageId))` —— 复用同一个 messageId，宿主据此找到在途请求。
- React 注入：`IdeMessengerContext = createContext<IIdeMessenger>(new IdeMessenger())`，**生产环境直接用默认值**（`App.tsx` 并没有挂 `IdeMessengerProvider`，它只被测试用来注入 `MockIdeMessenger`）。消费方统一 `useContext(IdeMessengerContext)`。
- 监听宿主消息：`hooks/useWebviewListener.ts` —— 注册 window `message` 监听，调用 handler 后自动 `respond` 回去；`hooks/useIdeMessengerRequest.ts` 是 `{result, isLoading, refresh}` 的封装。

### 4.5 宿主侧

`extensions/vscode/src/webviewProtocol.ts`（`VsCodeWebviewProtocol`，约 170 行）是整个 VS Code 传输层：

- `set webview(v)` 时销毁旧订阅并挂 `onDidReceiveMessage(handleMessage)`。
- `handleMessage`：校验 `messageType`/`messageId` → 按 type 取 handler 列表 → **若返回值是 async iterable**，逐条 `respond({done:false, content})`，最后 `respond({done:true, content})`；否则直接 `respond({done:true, content})`。异常时先 `respond({done:true, status:"error"})`（**故意不带 error 字段**，让 UI 正常收尾不弹错误组件），再带 `error` 回一条。
- `send(messageType, data, messageId?)` → `webview.postMessage({messageType, data, messageId})`。
- `request(messageType, data, retry=true)`：等 webview 就绪（最多 10 次，前 5 次 500ms、之后 1000ms），发送后订阅 `onDidReceiveMessage` 比对 messageId 取首个匹配。

`extensions/vscode/src/extension/VsCodeMessenger.ts`：**没有 switch 派发表**，全部在构造函数里用三个辅助方法注册：

```ts
onWebview<T>(type, handler)        // webview → 扩展
onCore<T>(type, handler)           // core → 扩展
onWebviewOrCore<T>(type, handler)  // 两边都注册
```

其中 webview → core 有 **`WEBVIEW_TO_CORE_PASS_THROUGH` 白名单（76 个字符串，`core/protocol/passThrough.ts`）**统一转发；core → webview 有 **`CORE_TO_WEBVIEW_PASS_THROUGH`（12 条）**。**不在白名单又没单独注册的消息会被静默丢弃**，webview 侧的 Promise 永远不 settle —— 这是自建时应避免的失败模式（建议按前缀约定路由 + 未知类型明确拒绝）。

`MockIdeMessenger`（`gui/src/context/MockIdeMessenger.ts`）实现了 `IIdeMessenger`，提供 `responses` 缺省响应表、`chatResponse` + `chatStreamDelay` 驱动 `llmStreamChat`，以及 `mockMessageToWebview()` 伪造宿主消息——写测试时很有参考价值。

---

## 5. Redux 状态形状

### 5.1 `SessionState`（`gui/src/redux/slices/sessionSlice.ts:203-226`）

```ts
type SessionState = {
  lastSessionId?: string;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  history: ChatHistoryItemWithMessageId[];      // 核心
  isStreaming: boolean;                          // 唯一的"正在生成"标志
  title: string;
  id: string;
  streamAborter: AbortController;
  mainEditorContentTrigger?: JSONContent;
  symbols: FileSymbolMap;
  mode: MessageModes;                            // "chat" | "agent" | "plan" | "background"
  isInEdit: boolean;
  codeBlockApplyStates: { states: ApplyState[]; curIndex: number };
  newestToolbarPreviewForInput: Record<string, string>;
  hasReasoningEnabled?: boolean;
  isPruned?: boolean;
  contextPercentage?: number;
  inlineErrorMessage?: InlineErrorMessageType;   // "out-of-context"
  compactionLoading: Record<number, boolean>;
};
```

初值 `mode: "agent"`。`ChatHistoryItemWithMessageId = ChatHistoryItem & { message: ChatMessage & { id: string } }` —— **`ChatHistoryItem` 本身没有 id，React key 靠 `message.id`**。`history` **不持久化**（`store.ts` 的 persist 过滤只留 `id/lastSessionId/title/mode`）。

### 5.2 `ChatHistoryItem` / `ChatMessage`（`core/index.d.ts:534-545`、`440-445`）

```ts
interface ChatHistoryItem {
  message: ChatMessage;
  contextItems: ContextItemWithId[];
  editorState?: any;              // TipTap JSONContent
  modifiers?: InputModifiers;     // { useCodebase, noContext }
  promptLogs?: PromptLog[];
  toolCallStates?: ToolCallState[];
  isGatheringContext?: boolean;
  reasoning?: { active: boolean; text: string; startAt: number; endAt?: number };
  appliedRules?: RuleMetadata[];
  conversationSummary?: string;
}

type ChatMessageRole = "user" | "assistant" | "thinking" | "system" | "tool";
type MessagePart = { type: "text"; text: string } | { type: "imageUrl"; imageUrl: { url: string } };
type MessageContent = string | MessagePart[];
```

- `UserChatMessage { role:"user"; content: MessageContent; metadata? }`
- `AssistantChatMessage { role:"assistant"; content; toolCalls?: ToolCallDelta[]; usage?; metadata? }`
- `ThinkingChatMessage { role:"thinking"; content; signature?; redactedThinking?; toolCalls?; reasoning_details? }`
- `SystemChatMessage { role:"system"; content: string }`
- `ToolResultChatMessage { role:"tool"; content: string; toolCallId: string }`

**注意 v1.3.40 的 `MessagePart` 只有 text 和 imageUrl 两种**（没有 reasoning / citation part）。渲染用的扁平化函数在 `core/util/messageContent.ts`：`stripImages()`、`renderChatMessage()`、`renderContextItems()`、`normalizeToMessageParts()`。

### 5.3 工具调用状态机

```ts
type ToolStatus = "generating" | "generated" | "calling" | "errored" | "done" | "canceled";

interface ToolCallState {
  toolCallId: string;
  toolCall: ToolCall;             // { id, type:"function", function:{ name, arguments } }
  status: ToolStatus;
  parsedArgs: any;                // 增量解析结果（可能不完整）
  processedArgs?: Record<string, any>;
  output?: ContextItem[];
  tool?: Tool;
  mcpUiState?: McpUiState;
}
interface ToolCallDelta { id?: string; type?: "function"; function?: { name?: string; arguments?: string } }
```

- 参数**增量**同时保留两份：原始字符串累加在 `toolCall.function.arguments`（流式中可能是非法 JSON），`parsedArgs` 由 `incrementalParseJson`（`partial-json`）尽力解析（`gui/src/util/toolCallState.ts:8-70`）。
- 写入点（**注意 `setToolCallState` / `updateToolCallDelta` 在 1.3.40 里并不存在**）：`streamUpdate`（累加）、`handleToolCallsInMessage`、`setToolGenerated`（→`generated` 并挂上 `config.config.tools` 里的 `tool`）、`setToolCallCalling`、`acceptToolCall`（→`done`）、`errorToolCall`（→`errored`）、`cancelToolCall`（→`canceled`）、`updateToolCallOutput`（写 `output` + `mcpUiState`，同时改写 `role:"tool"` 那条历史消息）、`setProcessedToolCallArgs`。

### 5.4 `UIState` 与其它 slice

`uiSlice.ts:20-32`：`showDialog`、`dialogMessage: JSX.Element | undefined`、`onboardingCard`、`isExploreDialogOpen`、`hasDismissedExploreDialog`、`shouldAddFileForEditing`、`toolSettings: ToolPolicies`、`toolGroupSettings`、`ruleSettings`、`reasoningSettings`、`ttsActive: boolean`。

> **`uiSlice` 里没有流式标志**，全 UI 只读 `state.session.isStreaming`。

其它：`editState { codeToEdit, applyState, returnToMode, lastNonEditSessionWasEmpty, previousModeEditorContent }`；`tabsSlice { tabs }`；`configSlice` + 选择器 `selectSelectedChatModel`、`selectUIConfig`。`store.ts:122` 设了 `serializableCheck: false`。

---

## 6. 流式渲染

### 6.1 端到端链路

```
Chat.sendInput                                    Chat.tsx:160-231
  └─ dispatch(streamResponseThunk)                redux/thunks/streamResponse.ts
     ├─ streamThunkWrapper（错误处理 + 重试）      streamThunkWrapper.tsx:20-61
     ├─ submitEditorAndInitAtIndex                 sessionSlice:357-413（追加 user + 空 assistant，isStreaming=true）
     ├─ resolveEditorContent                       （"Gathering context" 提示）
     └─ streamNormalInput                          streamNormalInput.ts:72-397
        ├─ llm/compileChat（上下文超限 → inlineErrorMessage + setInactive）
        ├─ ideMessenger.llmStreamChat(payload, aborter.signal)   → 每 50ms 一批 ChatMessage[]
        ├─ dispatch(streamUpdate(batch))          ← 唯一的累加入口 sessionSlice:524-685
        └─ 结束后：setToolGenerated → evaluateToolPolicies → callToolById / streamResponseAfterToolCall
```

### 6.2 增量如何进 store（`streamUpdate`，`sessionSlice.ts:524-685`）

- **thinking 与正文靠 `<think>` / `</think>` 标签切分**：
  - 遇到 `</think>` → 把标签前的内容追加到 `reasoning.text`，`active=false`，`endAt=Date.now()`，标签后内容作为正文 `+=`；
  - 处于 thinking 中 → 追加到 `lastItem.reasoning.text`；
  - 否则 → `lastMessage.content += messageContent`（**纯字符串拼接**，不维护 parts 数组）。
- 新的 `redactedThinking` → 新建一条 `role:"thinking"` 历史项。
- 角色变化或 `role === "tool"` → 新建历史项。
- 正文每来一批就整体重渲染 Markdown。
- 额外写入：`message.signature`、`reasoning_details`（`mergeReasoningDetails`）、`metadata.responsesOutputItemId`。

### 6.3 完成 / 取消 / 错误

- 完成：`setInactive()` → `isStreaming = false`；若有工具调用则进入 `evaluateToolPolicies` 分支（无需批准 → 直接 `callToolById`；需批准 → 停在 `generated` 等用户点 Accept）。
- 取消：`cancelStream` thunk = `setInactive` + `abortStream`（`streamAborter.abort()`）+ `clearDanglingMessages`（把 `generating`/`generated` 的工具调用改成 `canceled`）。触发点：`⌘/Ctrl+Backspace`、宿主 `setInactive` 消息、工具栏 Stop、组件挂载时。
- 错误：`streamThunkWrapper` 对 `"overloaded" | "529"` 重试 3 次（`2000 * 2^attempt` ms），否则弹 `StreamErrorDialog`。`StreamError.tsx` 按 statusCode 429/404/401/403 分别给文案，并带一个「重新发送」按钮（在最后一个 user/tool 索引处重发 `streamResponseThunk`）。

### 6.4 "正在生成"的视觉反馈（全部实现细节）

| 组件 | 文件 | 实现 |
| --- | --- | --- |
| **AnimatedEllipsis** | `components/AnimatedEllipsis.tsx` | `width: 1em` 的 `inline-block` span，`::after { content:"..."; overflow:hidden; vertical-align:bottom; width:0; animation: 2s infinite }`；关键帧 `0%→width:0`、`33%→0.33em`、`66%→0.66em`、`100%→1em` |
| **GeneratingIndicator** | `LumpToolbar/GeneratingIndicator.tsx` | `<div className="text-description flex items-center"><span className="text-xs">Generating</span><AnimatedEllipsis/></div>` |
| **Spinner** | `components/gui/Spinner.tsx` | `<svg className="animate-spin-slow h-3.5 w-3.5 text-gray-400">`，`circle` `opacity-25`，`path` `opacity-75`；`animate-spin-slow` = `spin 6s linear infinite`（**比常规 spin 慢 6 倍**，是 Continue 的手感来源） |
| **ThinkingIndicator** | `StepContainer/ThinkingIndicator.tsx` | 每 600ms 递增点数，渲染 `` `Thinking.${".".repeat(n)}` ``，容器 `px-2 py-2`，文字 `text-lightgray`；**只在 `isStreaming && !isGatheringContext && !hasContent` 且模型名以 `o1` 开头时显示** |
| **ThinkingBlockPeek** | `mainInput/belowMainInput/ThinkingBlockPeek.tsx` | 进行中显示 "Thinking" + ellipsis，完成显示 "Thought for Xs"；展开体 `max-h-[50vh] opacity-100` / `max-h-0 opacity-0`，`transition-all duration-300 ease-in-out` |
| **GradientBorder** | `mainInput/GradientBorder.tsx` | 见 §1.9B；激活条件 `isStreaming && (isLastUserInput || isInEdit)` |
| **BlinkingCursor** | `UnifiedTerminal.tsx` | `::after { content:"█"; animation: blinkCursor 1s infinite }`，0–50% 不透明、51–100% 透明 |
| **BlinkingDot / Loader / RingLoader** | `components/loaders/` | 6px 点 `blink 3s infinite` + `box-shadow 0 0 2px 1px`；28px 方块 `flash 1.2s infinite`；40px 环 `stroke-dashoffset 100→12`，6s |

**没有任何打字机效果**。唯一的淡入是 `ResponseActions`/`StepContainer` 的 `transition-opacity duration-300`。

### 6.5 `useAutoScroll`（`pages/gui/useAutoScroll.ts`）

签名：`useAutoScroll(ref: React.RefObject<HTMLDivElement>, history: ChatHistoryItemWithMessageId[]): void`

- 内部状态：`userHasScrolled`。
- `numUserMsgs` 只统计 `role === "user"` 的条数，作为 memo 依赖；**用户消息数变化时重置 `userHasScrolled = false`**（即一次新的提问会重新打开自动滚动；工具响应消息不会）。
- 滚动监听阈值：`Math.abs(scrollHeight - scrollTop - clientHeight) < 1`（**1px**）判定为「在底部」；不在底部就置 `userHasScrolled = true`，滚回底部自动恢复。
- 用 `ResizeObserver` 监听**容器本身 + 所有直接子元素**，尺寸变化且未手动上滚时 `elem.scrollTop = elem.scrollHeight`。因为 Chat.tsx 里每条消息都包了一层 `div`，所以「直接子元素」正好覆盖每条消息的高度变化。
- 用法（`Chat.tsx:117,134,387-413`）：`stepsDivRef` → `useAutoScroll(stepsDivRef, history)`；滚动容器就是 `StepsDiv`。

---

## 7. 构建方式（webview bundle）

### 7.1 Vite 配置（`gui/vite.config.ts`）

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],          // react = @vitejs/plugin-react-swc
  build: {
    sourcemap: true,
    rollupOptions: {
      input: { index: ".../index.html", indexConsole: ".../indexConsole.html" },
      output: {
        entryFileNames: `assets/[name].js`,   // 关键：去掉 hash
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
  server: { cors: { origin: "*", ... } },
  test: { globals: true, environment: "jsdom", setupFiles: "./src/util/test/setupTests.ts", ... },
});
```

- **`base`、`outDir`、`inlineDynamicImports`、`define`、`resolve.alias` 都没设**，全部用默认值（`base:"/"`，`outDir:"dist"`）。
- **去掉文件名 hash 是刻意的**：宿主侧 HTML 硬编码 `gui/assets/index.js` / `index.css` / `indexConsole.js` / `indexConsole.css`。
- 开发服务器端口用默认 **5173**，并且硬编码在两个 ViewProvider 里 —— **没有 `server.port` / `strictPort`**，端口被占用就会静默漂移并导致开发态白屏。
- `tailwindcss()` 同时作为 Vite 插件和 PostCSS 插件（`gui/postcss.config.cjs`）配置，配置在 `gui/tailwind.config.cjs`。

### 7.2 构建脚本链

```jsonc
// gui/package.json
"dev": "vite",
"build": "tsc && vite build",        // tsc 只做类型门禁（tsconfig noEmit），产物由 vite build 出
"tsc:check": "tsc -p ./ --noEmit",

// extensions/vscode/package.json —— 扩展侧是两套独立打包
"main": "./out/extension.js",
"esbuild-base": "node scripts/esbuild.js",
"vscode:prepublish": "npm run esbuild-base -- --minify",
"esbuild-watch": "npm run esbuild-base -- --sourcemap --watch",
"prepackage": "node scripts/prepackage.js",     // ← 把 gui/dist 搬进扩展
"package": "node scripts/package.js",           // ← npx @vscode/vsce package --out ./build --no-dependencies
"e2e:build": "npm --prefix ../../gui run build && npm run package"
```

根 `package.json` **没有 build 脚本**，只有 `tsc:watch:gui|vscode|core|binary` 与格式化；真正的引导脚本是 `scripts/install-dependencies.sh`：装依赖 → `build-packages.js` → core `npm link` → gui `npm run build` → vscode `npm run package` → binary 构建。

**webview 与扩展确实是分离构建的**：webview 走 Vite（SWC），扩展宿主走 esbuild（`scripts/esbuild.js`：`entryPoints: ["src/extension.ts"]`，`bundle:true`，`outfile:"out/extension.js"`，`format:"cjs"`，`platform:"node"`，`external:["vscode", ...]`，`supported:{"dynamic-import":false}`，`loader:{".node":"file"}`，`inject:importMetaUrl`）。

### 7.3 产物如何进扩展包

1. `gui` 构建 → `gui/dist/index.html`、`gui/dist/assets/index.js|index.css|indexConsole.js|indexConsole.css`、`dist/fonts`、`dist/logos`。
2. `extensions/vscode/scripts/prepackage.js`：`chdir` 到 `gui`，先 `ncp("dist", "../extensions/intellij/src/main/resources/webview")`（JetBrains 用，先备份再还原它的 `index.html`），再 `ncp("dist", "../extensions/vscode/gui")`；随后**断言 `gui/assets/index.js` 与 `gui/assets/index.css` 存在**，否则抛 `gui build did not produce index.js`。之后才复制 onnxruntime / tree-sitter wasm / tiktoken worker / sqlite3 / lance / ripgrep 等原生资产，最后 `validateFilesPresent([...])`。
3. 打包：`vsce package`。`.vscodeignore` 里**没有忽略 `gui/**`**，所以 webview 产物随 VSIX 一起发布到 `<extension>/gui`（扩展用 `.vscodeignore` 而非 `files` 字段）。
4. 开发流程（`.vscode/tasks.json`）：`tsc:watch` + `prepackage`（一次性复制）+ `esbuild-watch` + `gui:dev`；launch 用 `--extensionDevelopmentPath=.../extensions/vscode`。因为 `ExtensionMode.Development`，Provider 会从 `http://localhost:5173` 加载 GUI，`gui/dist` 只是用来过 `prepackage.js` 的断言。

### 7.4 Webview 容器（`extensions/vscode/src/ContinueGUIWebviewViewProvider.ts`）

- `viewType = "continue.continueGUIView"`；`package.json` 里注册在 Activity Bar 容器 `continue` 下：`{ type:"webview", id:"continue.continueGUIView", name:"Continue", icon:"media/sidebar-icon.png", visibility:"visible" }`。
- 注册方式（`VsCodeExtension.ts:254-262`）：

```ts
vscode.window.registerWebviewViewProvider("continue.continueGUIView", this.sidebar,
  { webviewOptions: { retainContextWhenHidden: true } })
```

- `webview.options`：

```ts
{
  enableScripts: true,
  localResourceRoots: [ Uri.joinPath(extensionUri, "gui"), Uri.joinPath(extensionUri, "assets") ],
  enableCommandUris: true,
  portMapping: [{ webviewPort: 65433, extensionHostPort: 65433 }],
}
```

- **`asWebviewUri` 用法**：`panel.webview.asWebviewUri(Uri.joinPath(extensionUri, "gui/assets/index.js")).toString()`。生产态 `<link href=...index.css>` + `<script type="module" nonce=... src=...index.js>`；开发态换成 `http://localhost:5173/src/main.tsx` / `src/index.css`，并额外注入 Vite 的 react-refresh preamble。**没有 `<base>` 标签，所以所有资源 URL 必须绝对。**
- **CSP：宿主 HTML 里完全没有 `<meta http-equiv="Content-Security-Policy">`**（仓库里唯一的 CSP 出现在 `MCPAppRenderer.tsx`，是给 MCP iframe 的 sandbox）。`getNonce()` 生成了 32 位随机串并挂在 script 标签上，但**没有任何东西校验它**；访问范围实际由 `localResourceRoots` 限定。**自建时应写成真正的 CSP（`webview.cspSource` + nonce），并给 dev 分支放开 `script-src/connect-src`。**
- 初始状态通过一串内联 `<script>` 注入：`localStorage.setItem("ide", '"vscode"')`、`vsCodeUriScheme`、`extensionVersion`（值都被 JSON 引号包住，因为 webview 侧 `getLocalStorage` 会 `JSON.parse`）、`window.windowId`、`window.vscMachineId`、`window.vscMediaUrl`、`window.ide`、`window.fullColorTheme`（初始主题，避免首帧闪色）、`window.colorThemeName = "dark-plus"`（**硬编码**）、`window.workspacePaths`、`window.isFullScreen`，以及可选的 `window.edits` / `window.location.pathname`。
- **没有 `onDidDispose` / `onDidChangeViewState`**；`isVisible` getter 无调用点。全屏面板（`continue.openInNewWindow`）复用同一个 `VsCodeWebviewProtocol` 实例，通过重新赋值 `.webview` 切换目标，关闭时 `resetWebviewProtocolWebview()` 指回侧栏；`getSidebarContent` 里每次调用都会 `vscode.workspace.onDidChangeConfiguration(...)` 注册一个**新的**监听器（轻微泄漏），并在主题变化时 `webviewProtocol.request("setTheme", { theme: getTheme() })`。

### 7.5 主题同步链路

`extensions/vscode/src/util/getTheme.ts`：读 `workbench.colorTheme`（fallback `"Default Dark Modern"`）以及 6 个 `autoDetect*` / `preferred*ColorTheme` 设置，遍历 `vscode.extensions.all` 找 `contributes.themes` 里 id/label 匹配的项，读文件 → 去注释 → 解析内部的 `include` 链并递归合并 → `convertTheme()`（`monaco-vscode-textmate-theme-converter`）转成 Monaco 主题，并强制 `base` 为 `vs` / `vs-dark` / `hc-black`。下发见 §7.4；webview 侧应用见 §2.3。

---

## 8. 复刻检查清单（照着做就能长得像）

**必须照搬的数值**

| 项 | 值 |
| --- | --- |
| 全局圆角 | `0.5rem`（8px） |
| 输入框 | 半径 8px；`border: 1px solid var(--vscode-commandCenter-inactiveBorder, #555)`；`:focus-within` 换 `--vscode-commandCenter-activeBorder, #4d8bf0`；内边距 `10px 10px 4px`（编辑区再加 `pt-2`）；字体 14px |
| 输入框外壳 | `padding: 1px` 的渐变层，空闲用页面背景色，流式启用七彩渐变 + `margin-top: 8px` |
| 缺口条 | `margin-inline: 6px`，仅上圆角，`border-l/r/t`，`padding: 2px 4px`（≥250px 时 `px-2`） |
| 工具栏 | 上间距 8px；左图标 12px、左字号 12px；右字号 11px；发送按钮 11px、`padding: 2px 6px` |
| 消息区 | 顶部 8px；每条助手消息 `padding: 4px 6px`；最后一条最小高度 200px；正文左右各 8px 内边距 |
| 助手操作条 | 顶部间距 8px，固定高度 28px，图标 14px，右对齐，`gap: 4px` |
| 代码块卡片 | `outline: 1px`（`outline-offset: -0.5px`），半径 8px，背景 `--vscode-editor-background`，上下外边距 8px；头部 `padding: 4px 6px`，字号 12px，右侧按钮 `gap: 10px`，图标 14px（Run 为 12px） |
| 折叠代码块 | 高度上限 160px，渐变遮罩高 48px，箭头 16px |
| diff 视图 | 卡片 半径 8px，`margin: 4px 8px`；滚动区最高 288px；行 `padding: 1px 12px`；增删左侧 4px 色条 |
| 工具调用头部 | 左侧 16px 图标盒 + `gap: 8px`；`px-4`；聚合容器 `px-4 py-3`，子行 `pl-6` |
| 模式胶囊 | `rounded-full`，`bg: rgba(153,153,152,0.2)`，字号 11px，`padding: 2px 6px`（≥250px 时 `px-2`），图标 12px，箭头 8px |
| 模型按钮 | 高 18px，无边框，字号 11px，箭头 8px |
| 下拉弹层 | 半径 8px，行半径 6.4px，`padding: 0.2rem`，最高 330px，字号 12px，选中 `list-active` |
| 上下文占用条 | 14×7px（≥460px 时 10×5px），`border-radius: 1px`，`border: 0.5px` |
| 断点 | 170 / 250 / 330 / 380 / 460 / 590 / 720 / 860 / 1000 / 1180 px |
| 慢速 spinner | `6s linear infinite` |
| 省略号动画 | `2s infinite`，宽度 0 → 0.33em → 0.66em → 1em |

**必须照搬的主题机制**：`varWithFallback` 递归变量链 + Tailwind 颜色 token；`--vscode-editor-background` 用作代码块/卡片背景以形成「内嵌编辑器」层次。

**建议改进的点**：加真正的 CSP 与 nonce 校验；给 `request` 加超时与未知类型的显式错误；不要照抄 76 条白名单路由；不要照抄「主题监听器注册在 `getSidebarContent` 里」；`createWebviewPanel` 与侧栏共享 protocol 实例的写法在多 webview 场景会串消息。

---

## 9. 可借鉴性结论

### 9.1 最值得照搬的 5 个视觉特征

1. **流式时的七彩渐变输入框描边**（`#1BBE84/#331BBE/#BE1B55/#A6BE1B`，`101.79deg`，6s 一圈，`padding: 1px` 外壳 + 8px 上间距）—— Continue 最容易被一眼认出的元素。
2. **代码块 = `--vscode-editor-background` 卡片 + `outline`（非 border）+ `-0.5px` offset**，头部 12px、右侧 14px 图标按钮（Insert / Copy / Apply 或 Create file / Run）。
3. **无气泡、无头像的消息排布**：助手就是 Markdown + 右下角一排 14px 灰色操作图标；用户消息直接复用输入框组件，"thread-message" 只有 1px 左边距。
4. **`Lump` 缺口条**：比输入框窄 6px、只有上圆角的状态标签条，"Generating…" 与 "Stop ⌘⌫" 都住在这里，是 Continue 的状态中枢。
5. **6 秒一圈的慢速 spinner + 宽度动画省略号 + 5×14px 上下文占用小竖条**——低成本但辨识度极高的「Continue 节奏」。

### 9.2 应该吸收的机制

| 机制 | 采纳建议 |
| --- | --- |
| `{messageType, messageId, data}` 单信封 + `{done, status, content\|error}` 响应包裹，流式靠 `done:false` 复用同一 messageId | **强烈建议照搬**，是这套协议里最优雅的部分 |
| 宿主对 async-iterable handler 自动 drain 成流式响应 | 照搬，省掉一套流式专用消息类型 |
| `varWithFallback` 递归变量链 + Tailwind 颜色 token | 照搬，是低成本换全主题适配的关键 |
| `asWebviewUri` + 无 hash 产物名 + `prepackage` 复制步骤 + `retainContextWhenHidden: true` | 照搬 |
| 流式渲染状态放 session store（单一 `isStreaming`），UI 全量从中读 | 照搬；比分散在多个 flag 里好维护 |
| `useAutoScroll`：ResizeObserver 观察容器 + 直接子元素，1px 阈值判定在底部，仅在用户消息数变化时重置 | 照搬，约 60 行解决自动滚动全部问题 |
| `MockIdeMessenger` 风格的假宿主 | 照搬，前端可完全脱离扩展开发 |
| 工具调用状态机 `generating/generated/calling/errored/done/canceled` + `parsedArgs/processedArgs` 双份参数 | 照搬这套语义，它同时覆盖了流式、审批、失败重试 |

### 9.3 应该抛弃的 Continue 专属业务

- **多 IDE 抽象**：`IMessenger`、`InProcessMessenger`、`MessageIde`、`postIntellijMessage`、`jetbrains/*` 消息、76 条 `WEBVIEW_TO_CORE_PASS_THROUGH` 白名单（还手工同步到了 Kotlin 侧）。单扩展单 UI 场景下直接按前缀约定路由即可。
- **重业务逻辑**：`@continuedev/core`、config-yaml、profiles/assistants、MCP UI 渲染（含 sandbox iframe 与授权浮层）、codebase/docs 索引、`nextEdit/*`、autocomplete、TTS、`@continuedev/terminal-security` 的 `ToolPolicy`。
- **原生二进制与随之而来的一整套复制/校验机制**（onnxruntime、sqlite3、LanceDB、ripgrep、tree-sitter wasm）—— 除非你也要做本地索引。
- **redux-persist** 与 `subscriptions` 迁移逻辑。
- **`getTheme()` 的磁盘遍历 + `monaco-vscode-textmate-theme-converter`**：如果不需要精确的代码高亮配色，直接用 VS Code 注入的 `--vscode-*` 与 CSS 变量即可。
- 零散的坏味道：`window.innerHeight > 5000` 的滚动条判断、`window.colorThemeName = "dark-plus"` 硬编码、`hover:description-muted/30` 之类的无效类名、无超时的 `request`、死代码（`ToolCallArgs`、`TerminalCollapsibleContainer`、`IndicatorBar`）。

### 9.4 许可证与复用义务

- Continue 仓库根 `LICENSE` 为 **Apache License, Version 2.0**，版权行 `Copyright 2023 Continue Dev, Inc.`（`LICENSE` 末尾）。`gui/package.json:6` 也标注 `"license": "Apache-2.0"`。仓库根**没有 NOTICE 文件**（已确认）。
- 复用代码时的义务（Apache-2.0 §4）：
  1. 向所有使用者提供许可证副本（保留 `LICENSE`）；
  2. 修改过的文件需**显著标注你做了修改**；
  3. 保留所有版权、专利、商标与归属声明；
  4. 若原仓库存在 `NOTICE` 文件，需在分发中包含其中的归属声明（本仓库没有）；
  5. 可以商用、闭源分发，但**不得使用 Continue 的商标/品牌**（§6 明确不授予商标许可）—— 所以「Continue 风格」可以复刻，但不要用它的名字、Logo（`gui/public/logos/*`、`components/svg/ContinueLogo.tsx`）做产品标识；
  6. 分发时需附带免责声明（§7、§8）。
- 实践建议：**把本文件当作「视觉与交互规格」参考来重写实现**，比逐文件拷贝更省事，也更容易满足「标注修改」的要求。若确实要拷贝具体文件，在被拷贝文件头部加上来源与修改说明。
- 第三方资产另有许可：`gui/public/fonts/Inter/LICENSE.txt`、`gui/public/fonts/JetBrainsMono/OFL.txt`（SIL OFL，嵌入分发须随附）。图标来自 `@heroicons/react`（MIT），文件图标来自 `seti-file-icons`。

---

## 附录 A：关键文件索引

```
gui/tailwind.config.cjs                       设计 token（颜色/断点/动画/圆角/字号）
gui/src/styles/theme.ts                       颜色变量表 + varWithFallback + 主题注入
gui/src/index.css                             全局样式、字体、工具类
gui/src/components/index.ts                   styled 常量出口（defaultBorderRadius 等）
gui/src/pages/gui/index.tsx                   两栏骨架
gui/src/pages/gui/Chat.tsx                    消息列表 + 输入框组装 + sendInput
gui/src/pages/gui/EmptyChatBody.tsx           空态
gui/src/pages/gui/useAutoScroll.ts            自动滚动
gui/src/components/StepContainer/*.tsx        助手消息主体 + 操作条 + 截断检测
gui/src/components/StyledMarkdownPreview/     Markdown 管线 + 代码块工具栏
gui/src/components/mainInput/ContinueInputBox.tsx
gui/src/components/mainInput/GradientBorder.tsx
gui/src/components/mainInput/InputToolbar.tsx
gui/src/components/mainInput/Lump/            缺口条 + 9 分支工具栏
gui/src/components/mainInput/TipTapEditor/    编辑器与样式
gui/src/components/mainInput/AtMentionDropdown/
gui/src/pages/gui/ToolCallDiv/                工具调用全部形态
gui/src/components/UnifiedTerminal/           终端卡片
gui/src/redux/slices/sessionSlice.ts          SessionState + streamUpdate 累加器
gui/src/redux/slices/uiSlice.ts               对话框/工具策略/tts
gui/src/context/IdeMessenger.tsx              webview 侧 IPC 客户端
gui/src/hooks/useWebviewListener.ts           宿主消息监听
gui/vite.config.ts                            webview 构建
core/protocol/*.ts                            全部消息类型表
core/index.d.ts                               ChatMessage / ToolCallState / ChatHistoryItem
extensions/vscode/src/webviewProtocol.ts      宿主侧传输
extensions/vscode/src/extension/VsCodeMessenger.ts
extensions/vscode/src/ContinueGUIWebviewViewProvider.ts
extensions/vscode/src/util/getTheme.ts
extensions/vscode/scripts/prepackage.js       gui/dist → 扩展
LICENSE                                       Apache-2.0
```
