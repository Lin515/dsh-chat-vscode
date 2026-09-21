# 审计报告：DSH Chat 扩展 vs 官方 DSH Web 前端 —— 输入 / 提交 / 队列 / 附件

> **这是原始分报告**（由子代理产出，覆盖面比主报告广）。其中的高影响结论已由主线复核并
> 汇总进 [`audit-summary.md`](audit-summary.md)——**以那份为准**；本文件保留完整证据与
> 未复核条目。复核状态标注：`[实测]` 起真实服务器验证过 / `[契约]` 官方类型声明逐字引用 /
> `[代码]` 本仓库代码事实 / `[存疑]` 未验证。
>
> ⚠️ **本文的判定定格在审计当时，不随修复更新**：下面的「**不一致**」多数已经修好
> （当前状态见 `audit-summary.md` 的「零、修复状态」），**不要照着本文去重复修一遍**。
> 它的价值是证据（官方 `path:line` 引用）与仍未处理的差异。
>
> **2026-09-14 状态更新（本轮修的，别再重复修）**：
> - §1.1「扩展恒为 queue、从不读 `ui-conversation`」→ **已修且补齐**：`resolveSubmitMode`
>   逐字移植官方；冷启动也读设置；`running` 判定移到乐观置位之前；见 CHANGELOG 未发布第六节。
> - §1.2「加速手势无区分」→ **已修**：Cmd/Ctrl+Enter 走 `gesture:"accelerated"`，
>   运行中取 `busyEnter` 的相反值；忽略 `event.repeat`。
> - §1.2 的「无 steerQueue / 无队列行插话」→ 队列行插话**已做**（`session/updateQueue`
>   的 `{kind:'steer'}`）；「空草稿 + 加速手势 → 整队插话」**仍未做**。
> - §2.1/§2.3「队列重新编辑用 remove + 本地回填」→ 仍是现状（未做官方 `action{kind:'edit'}`）。
> - §3.1「官方从不内联文件正文」→ 已对齐；**2026-09-14 进一步细化**：`@` 变成正文里的
>   `@path` token（不再生成附件栏芯片），上传只留给「模型可直接读的文本」。
> - §3.4「拖放 / 粘贴文件不落地」→ **已过期**：`Composer.tsx` 的 `onDrop` 现在真的读字节
>   上传（`attachBytes`）；**2026-09-21 粘贴也落地了**：全页 `paste` 监听接住剪贴板里的
>   文件 / 图片，与拖放同一个字节通道（`src/webview/attachIntake.ts`）。本节现在只剩
>   「官方还有图片数量/大小校验、有 DropOverlay」这类细节差异。
>
> **2026-09-18 状态更新**：本文多处把队列的唯一来源写成 `session/control` 的
> `SessionQueuedItem` 帧（§2.3、§6.1 等）。服务端 2026-09-09 起删掉了那条通道，队列改由
> **`inbox` 投影**承载（`{'next-turn':…,'next-step':…}`）；扩展当时只读旧帧，表现为
> **待发列表整体消失**（用户 2026-09-18 报的）。现在扩展**双读**：新投影与旧帧都读，
> 折算见 `src/dsh/queueView.ts`。本节关于「停止/取消与队列」的语义结论不受影响。
>
> 主线实测补充（本报告未覆盖）：`scripts/planCommandProbe.ts` 用真实服务器证实了
> 「`/plan` 走 prompt 正文无效、必须走 `commands/execute`」，见 `audit-summary.md` §3.1。

**范围**：input / submission / queue / attachments 六个面（提交策略、队列编辑、上下文与附件表示、选区上下文、斜杠命令、停止语义）。

**证据口径**：先读官方 `.d.ts` 契约，再回 `lib/client.js`（或对应 `lib/*.js`）确认实现；扩展侧按本仓库当前源码。所有结论都给了 `path:line`。
**未做**：没有真正跑起官方 Web UI 或扩展做运行时对拍；凡属运行期行为推断的地方都标注了置信度与「无法确认」。官方包根目录记为 `$DSH = C:\Users\Cueio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`。

**本机配置事实**（扩展与官方都会读到、但只有一个读它）：
`C:\Users\Cueio\.dsh\settings.yaml:57-58` → `ui-conversation:` / `  busyEnter: steer`。

---

## 0. 速览

| # | 面 | 结论 | 用户可感知度 |
|---|---|---|---|
| 1.1 | 提交模式永远 `queue`，从不 `steer` | **不一致** | 高（本机 `busyEnter: steer` 被完全忽略） |
| 1.2 | 加速手势（Ctrl/Cmd+Enter）无区分 | **不一致** | 中 |
| 1.3 | 客户端自铸 `requestId` | **一致** | — |
| 2.1 | 队列编辑：本地摘除+回填 vs 服务端 `{kind:'edit'}` | **不一致** | 中高 |
| 2.2 | 编辑所需「原文」靠本地 map（TTL/条数上限） | **不一致** | 中 |
| 2.3 | 扩展把 `steering` 行当普通排队行展示/编辑 | **不一致** | 中 |
| 3.1 | 文件内容内联成文本 vs 上传回执 / `@` 路径 | **不一致** | 高 |
| 3.2 | 内容块顺序：图片在文本之后 vs 之前 | **不一致** | 低 |
| 3.3 | 仅附件（无文本）不能发送 | **不一致** | 中 |
| 3.4 | 拖放/粘贴文件不落地 | **不一致**（2026-09-21 两条路都已落地） | 中 |
| 4.1 | 「选区」内联文本：官方无对应表示 | **不一致** | 中 |
| 5.1 | 用户手打 `/xxx` 走 prompt 而不是 `commands/execute` | **不一致** | 高 |
| 5.2 | `commands/execute` 第三参数名 | **一致**（`submittedAttachments`）；`images` 回退是死代码 | 低 |
| 6.1 | 停止时排队消息的处理 | **不一致** | 中高 |

---

## 1. Prompt 提交：queue vs steer

### 1.1 官方按 `ui-conversation.busyEnter` + 运行状态 + 手势解析投递模式；扩展恒为 `queue` —— **不一致**

**官方行为**

- 设置字段就是提交模式词汇本身：
  - `$DSH\dsh-client-ui-conversation\lib\types\submission-settings.d.ts:4-10`
    ```ts
    export declare const CONVERSATION_SETTINGS_NAMESPACE = "ui-conversation";
    export declare const BUSY_ENTER_FIELD = "busyEnter";
    export declare const BUSY_ENTER_BEHAVIORS: readonly ["queue", "steer"];
    export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number];
    ```
  - `...\lib\types\client\contract\composer-submission.d.ts:5` → `export type InputSubmitMode = BusyEnterBehavior;`
- 解析函数（`$DSH\dsh-client-ui-conversation\lib\client.js:13577-13581`）：
  ```js
  function resolveSubmitMode(preferred, running, gesture, steeringAvailable) {
      if (!running || !steeringAvailable) return "queue";
      if (gesture === "enter") return preferred;
      return preferred === "queue" ? "steer" : "queue";
  }
  ```
  默认值是 `queue`（同文件 `:13556`），但会被 Host 用户设置覆盖（`ComposerSubmissionPolicy.adopt`，同文件 `:13620-13624`）。
- 两个消费者都用它：Enter/Send 按钮 `client.js:15995`、`client.js:16023`；按钮文案还会预告会发生什么（`client.js:16025`，`input.send.steer` / `input.send.queue`）。
- `steeringAvailable` = 本会话支持插话（非子代理，或 continuable 子代理）`client.js:15862`。

**扩展行为**

- 提交模式是写死的字面量，且两处调用点都是 `"queue"`：
  - `src\dsh\controller.ts:1483-1484`
    ```ts
    // dsh 自身维护队列：运行中提交即排队（steer 需要显式打断语义，首期不用）
    await this.client.prompt(this.currentSessionId, content, "queue", requestId);
    ```
  - `src\dsh\controller.ts:1819`（ESC 重发路径）同样 `"queue"`。
- `src\dsh\client.ts:272-291` 的 `prompt()` 虽然暴露了 `mode` 参数（默认 `"queue"`），但仓库内没有第二处传 `"steer"`（全仓 grep `steer` 仅命中 docs、类型声明与注释）。
- 扩展从不读 `ui-conversation` 命名空间：`src\dsh\controller.ts:2098` 把 `settings/describe` 的**所有**命名空间原样丢给设置面板（`describeSettings` → `buildSettingsSection`），所以设置面板里能改到 `busyEnter`，但发送路径完全不看它。
- 也没有 steer 入口：`src\webview\components\Composer.tsx` 全文没有 steer 相关分支；队列 UI 只有「重新编辑 / 取消」两个动作（`Composer.tsx:700-718`）。

**后果**：本机用户已把 `busyEnter` 设为 `steer`（`~\.dsh\settings.yaml:57-58`）。在 Web UI 里「agent 跑着时按 Enter」= 打断当前轮并插话；在扩展里同一个手势只是排队，必须等整轮结束。而且用户如果从扩展的设置面板把该值改成 `steer`，界面会显示已保存、行为不变（静默失效）。

**置信度**：高（两侧代码都是直读，且本机设置文件可读）。

### 1.2 加速手势（Ctrl/Cmd+Enter）—— **不一致**

**官方**：`registerComposerKeymap` 的 `submit(accelerated)`（`$DSH\dsh-client-ui-conversation\lib\types\client\input\editor\keymap.d.ts:27-28`：``/** The Enter gesture after every guard passed; `accelerated` = Ctrl/Cmd held. */``）。
- 空草稿 + 可 steer 队列时，加速 Enter 是「把整个队列插话发出去」：`client.js:15987-15990`
  ```js
  if (accelerated && g.canSteerQueue) { keyboard.steerQueue(); return; }
  ```
  （`canSteerQueue` 定义 `client.js:15863`）
- 否则加速 Enter 取相反模式：`client.js:15995` → `resolveSubmitMode(..., accelerated ? "accelerated" : "enter", ...)`。

**扩展**：`Composer.tsx:241`
```tsx
if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
```
没有 `ctrlKey/metaKey` 判断，也没有空草稿特判 → Ctrl+Enter 与 Enter 完全相同（一律 queue）。扩展也没有 `steerQueue`（把整队插话）这个操作。

**后果**：习惯用 Ctrl+Enter 的用户在扩展里得到「排队」而不是官方语义的「插话 / 反向模式」；空草稿 Ctrl+Enter 在官方是「插话发送全部排队消息」，在扩展里因为草稿空而什么都不发生。

**置信度**：高（代码直读）。**无法确认**：VS Code webview 是否会先把某些组合键吞掉（未实测）。

### 1.3 自铸 `requestId` —— **一致**

**官方**：客户端铸 UUID，并非服务端下发 —— `$DSH\dsh-api-session-controller\lib\types\client\sessions\session.js:141` → `const requestId = randomUUID();`（`beginSubmission`）；契约也写着「Client-minted identity」（`...\lib\types\types.d.ts:293`）。该 id 会落到 durable `user/message` 的 `source.rpcId`，并作为队列项的 `rpcId` 回传（`types.d.ts:491-492`）。重复提交同一 id 幂等（`...\lib\types\commands.js:292-293`）。
**扩展**：`src\dsh\controller.ts:1481` + `src\dsh\client.ts:276` 都是 `randomUUID()`；`clientTimeZone` 也照发（`client.ts:286`，官方 `session.js:178-184` 同样发）。
**后果**：无。
**置信度**：高。

---

## 2. 队列消息的「重新编辑」

### 2.1 官方用服务端 `QueueAction{kind:'edit'}`；扩展用 `remove` + 本地回填 —— **不一致**

**官方行为**

- 队列行编辑直接提交 `edit`，内容只含文本：
  `$DSH\dsh-client-ui-conversation\lib\client.js:14112-14121`
  ```js
  const saveEdit = async () => {
      if (editing === null || editing.text.trim() === "") return;
      if (await applyAction(editing.id, {
          kind: "edit",
          content: [{ type: "text", text: editing.text }]
      }, t("queue.editFailed"))) setEditing(null);
  };
  ```
- 服务端语义 `session/updateQueue` + `{kind:'edit'}`：
  - 只接受文本块：`$DSH\dsh-api-session-controller\lib\types\commands.js:388-395`
    ```js
    if (request.action.kind === 'edit') {
        if (request.action.content.some(block => block.type !== 'text')) {
            throw new RemoteError('session/attachment-invalid', 'queue edits accept text content only', { reason: 'QUEUE_EDIT_NON_TEXT' });
        }
    ```
  - **原地替换**（队列项 id、位置不变）：`commands.js:422-427`
    ```js
    case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage({ ...message, content: [...request.action.content] }));
    ```
- 编辑态是队列行内的**单行 input**，Enter 保存 / Esc 取消：`client.js:14171-14191`。
- 编辑入口的原文来自权威队列行自身（`row.text`），无文本的行直接禁用编辑按钮：
  - 行结构：`$DSH\dsh-api-session-controller\lib\types\client\contract\snapshot.d.ts:10-19`（`content` / `preview` / `text: string | null` / `rpcId`）
  - `client.js:14247` → `disabled: busy !== null || row.text === null`，tooltip `queue.edit.unsupported`（`:14246`），`setEditing({id: row.id, text: row.text})`（`:14249-14252`）。
- 官方编辑不碰输入框草稿，也不改附件芯片（附件在行内以缩略图展示：`client.js:14192-14201`；编辑保存后这些附件被服务端**丢弃**，因为 content 被纯文本整体替换）。

**扩展行为**

- `src\dsh\controller.ts:1891-1922` `editQueuedMessage`：先 `updateQueueRemove`（`:1895`），成功后才把文本**追加**进当前草稿（`:1906-1909`）并把原来记录的附件重新塞回芯片（`:1911-1915`）。失败即 `reportError("取回排队消息失败（可能已经开始发送）")` 并返回（`:1896-1899`）。
- 文本来源不是权威队列行，而是本地提交记录 `submissions`（`:106-109` 字段声明、`:1715-1736` `rememberSubmission`），通过 `queueOrigin` 按 rpcId 关联（`:816-828`）；队列行回显文本只在没有本地记录时兜底（`src\dsh\queueView.ts:67-73`）。
- `src\dsh\client.ts:301-305` 只实现了 `{kind:'remove'}`，扩展里没有任何地方发 `kind:'edit'` 或 `kind:'steer'`。

**可观测差异**

1. **队列位置**：官方原地替换，位置不变；扩展摘除后若用户再发送，它排到队尾（其后新排的项会被顶到前面）。对依赖 FIFO 的用户可见。
2. **草稿被污染**：官方编辑只在队列行内进行；扩展会把内容**追加**到当前输入框草稿（`:1908`），用户此时若已有草稿，两者被拼接成一条。
3. **附件命运相反**：官方 edit 会丢附件（服务端只收文本）；扩展尽可能把附件还原回输入框。扩展这在功能上更"不丢东西"，但结果状态与官方不同（官方是队列行内容被改成纯文本；扩展是队列行消失 + 输入框里带附件）。
4. **行内单行 vs 全功能输入框**：官方只能编辑单行、不能加附件；扩展等价于"取回重写"。
5. 扩展的「重新编辑」没有乐观锁：它先 remove 再回填；若用户在 `remove` 与回填之间切了会话，回填会落到 `sessionKey()` 当前会话（`:1904`）——注意 `sessionKey()` 是 `currentSessionId`（`:158-160`），而 `itemId` 属于 remove 时的会话，跨会话竞态下内容会写进错误会话的草稿。官方不存在这个窗口（无本地回填）。**置信度**：中（代码路径可读，竞态未实测）。

**置信度**：高（1/2/3/4 均为两侧语义直读）。

### 2.2 官方不需要本地"原文"缓存；扩展受 TTL/条数上限影响 —— **不一致**

**官方**：编辑用权威行的 `row.text`（`client.js:14249-14252`），没有任何本地缓存；队列行本身带完整 `content: readonly ContentBlock[]`。

**扩展**：`src\dsh\controller.ts:51-53`
```ts
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const MAX_SUBMISSIONS = 50;
```
超期（`:1722-1724`）或超条数（`:1725-1729`）即淘汰；淘汰后 `originFor` 返回 undefined（`:1701-1706`），`queueView.ts:67-73` 回退到**线上正文**——而线上正文里已经被 `buildContextText` 塞进了内联文件内容（见 §3.1）。扩展自己也在注释里承认这一点（`queueView.ts:36-38`：「线格式正文里已内联了文件上下文…直接显示会很吓人」）。

**后果**：长会话（>50 条提交）或超过 30 分钟后，用户点「重新编辑」会把「文件 X 的内容：```…``` + 正文」整坨倒回输入框；附件也找不回来（`:1919-1921` 仅弹 `@queueAttachmentsLost` 警告）。官方不存在这种退化。

**置信度**：高。

### 2.3 扩展把 `placement:'steering'` 的行当普通排队行 —— **不一致**

**官方**
- 队列面板只取 `queued`：`client.js:14073` → `inbox.filter((row) => row.placement === "queued")`。
- `steering` 是「已插进当前轮、待被 loop 取用」的在途项：`InputState.queue` 注释 `...\contract\input.d.ts:319`（"including pending steering"）；`placement` 语义见 `$DSH\dsh-api-session-controller\lib\types\types.d.ts:490`。它在转写里以 steering 节点呈现（`...\contract\context-provenance.d.ts:5-9`）。
- 每行「插话发送」走 `{kind:'steer'}`：`client.js:14272-14288`；整队插话 `client.js:13518-13528`。
- `{kind:'steer'}` 只在「还在 next-turn 且 agent 正在运行」时可用，否则 `session/steer-unavailable`：`commands.js:418-419`。

**扩展**
- `src\dsh\queueView.ts:54` → `if (item.placement !== "queued" && item.placement !== "steering") continue;`（只滤掉 `context`），`steering` 行会作为「排队中」列出。
- UI 文案是「排队中（尚未发送）」：`src\webview\components\Composer.tsx:692-702`，并提供编辑/取消按钮（`:703-716`）。
- 没有任何 `{kind:'steer'}` 调用。

**后果**：一条已经插进当前轮的插话消息，在扩展里显示成"还没发出去的排队消息"，并可被编辑/删除；用户可"编辑"它（其实是摘掉+回填，导致插话内容被吞掉，因为原 steering 项已被移除）。另外 §6 的 ESC 流程会把它当排队消息摘出并以 `mode:"queue"` 重发，**把插话语义降级成排队**（`controller.ts:1819` 写死 `"queue"`）。

**置信度**：高（代码直读；"steering 行已进入当前轮"的判断依据是契约注释与 placement 定义）。

---

## 3. 上下文 / 附件在线上的表示

### 3.1 官方从不内联文件正文；扩展把文件读成文本塞进 prompt —— **不一致**

**官方行为（文件只有三条通道，全部不内联）**

1. **`@` 路径引用**（选择文件/目录走的就是这条）
   - 拾取时只构造一个"引用芯片"，其可粘贴/模型形式就是 `@path`：
     `$DSH\dsh-client-ui-reference\lib\client.js:129-148`
     ```js
     return { insert: { source: "reference", ref: value.mention, label: ..., appearance: ...,
                        clipboardText: value.mention } };
     ...
     codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(ref) }
     ```
     即**模型侧形态 == `@relative/path`**（`formatFileMention`，同文件 `:17-23`：`@path` / `@"path with space"` / 目录 `@"dir/`）。
   - 模型侧含义由系统提示段定义：`$DSH\dsh-file-reference\lib\types\index.d.ts:13`
     > `Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading.`
2. **文件上传回执**（拖放/选择"文件"时）
   - 浏览器把原始 Blob 上传：`$DSH\dsh-client-ui-conversation\lib\client.js:3012-3057`（`beginFileUpload` → `ctx.fileUpload.upload(sessionId, attachment.file, ...)`）→ 得到 `receiptId`（`$DSH\dsh-client-file-upload\lib\types\types.d.ts:11-16`）。
   - 提交时只发回执：`client.js:2920-2926`
     ```js
     const serializeAttachments = () => Promise.all(attachments.map(async (attachment) => attachment.kind === "image"
         ? { type: "image", ...await this.encodeImage(attachment.file) }
         : { type: "file", receiptId: uploadFor(attachment).receiptId }));
     ```
   - 线格式：`$DSH\dsh-api-session-controller\lib\types\types.d.ts:59-75` `PromptContentPart = text | image{mediaType,data,name?} | file{receiptId}`。
   - 服务端**逐字节**保存、无大小/内容限制、不做 UTF-8 解码：`$DSH\dsh-attachment\lib\index.js:269-279`
     > `Files carry no admission limits: any byte content and length is accepted, and the stored object is the exact submitted bytes.`
   - 模型看到的是一段**句柄文本**（指向已保存的只读副本路径 + 让模型自己去读）：
     `$DSH\dsh-llm\lib\index.js:599-603`
     ```js
     const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`;
     if (readonlyPath === void 0) return `[${identity} was uploaded, but the current execution environment cannot access a readable path. ...]`;
     return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; ...]`;
     ```
     （`projectFilesToText` 是所有请求组装的必经投影，同文件 `:632-649`。）
3. **会话引用**是 canonical mention 文本 `@[label](dsh-session:…)`，由 Host 侧 resolver 展开：`$DSH\dsh-session-reference\lib\types\types.d.ts:60-63`、`...\lib\types\index.d.ts:30-38`、`...\lib\types\uri.d.ts:19-23`。

**扩展行为**

- `src\dsh\attachments.ts:98-141` `classifyPath`：能内嵌的（合法图片 / 合法 UTF-8 且 ≤512KB）做成附件；否则**只把带引号的绝对路径插到输入框**（`controller.ts:1647-1680`，`formatPathList` → `"C:\path"`）。
- 发送时把每个文件读成文本内联：
  `src\dsh\controller.ts:1509-1533`
  ```ts
  parts.push(`文件 ${this.relativePath(attachment.path)} 的内容：\n\`\`\`\n${decoded.text}\n\`\`\``);
  ```
  过大的：`` `文件 ${...} 过大（${...} KB），未内联。绝对路径：${attachment.path}` ``（`:1513-1515`）；二进制/非 UTF-8：`notInlinedNote(...)`（`:1521-1523`）。上限 `INLINE_TEXT_MAX_BYTES = 512 * 1024`（`attachments.ts:38`）。
- 设计上明确放弃上传：`controller.ts:1493-1494` 注释「把文件/文件夹附件折叠成上下文文本（**不做文件上传**，保持简单可靠）」。
- `@` 提及也走这条路，而且**刻意不把 `@path` 留在文本里**：`src\webview\components\Composer.tsx:197-205`
  ```tsx
  // 文件作为附件芯片加入，文本里不留 @token
  const next = `${before}${after}`;   // 把 @query 从草稿里删掉
  ...
  post({ type: "addMention", path: file.path, kind: file.kind });
  ```
- 扩展**完全没有**上传/回执概念：全仓 grep `upload|receipt|maxImages|imageLimits` 无命中（仅注释里的 "不上传"）。

**后果（用户可见）**

1. **上下文用量与费用**：官方把文件放服务端、prompt 里只有一行句柄；扩展把全文灌进 prompt（单文件上限 512KB，多文件可叠加），token 占用和上下文压力明显更高，且小上下文模型更容易被撑爆。
2. **模型可见性差异**：官方模型必须自己 `read`（有工具调用开销，但读的是逐字节副本）；扩展模型"免费"看到文本，但**看不到二进制/超大文件的正文**（被降级成一句路径提示），而官方那两类文件照样可读。
3. **`@` 的语义消失**：官方的 `@path` 是模型侧可识别的引用标记（有配套系统提示），扩展把 token 删掉、只留内联内容 —— 模型无法得知"这是用户显式引用的工作区路径"，也无法区分「引用的文件」与「随手贴的文本」。
4. **`git diff` 语义/路径**：扩展内联时用相对路径做小标题，但引号路径插入用的是绝对路径（`:149-155`），两处口径不一致（一处相对、一处绝对），对用户可见（草稿里出现绝对路径）。
5. 队列编辑退化见 §2.2（内联文本会倒回输入框）。

**置信度**：高。

### 3.2 内容块顺序：官方「附件 → 文本」，扩展「文本 → 图片」 —— **不一致**

**官方**：`client.js:2950-2953`
```js
content = [...await serializeAttachments(), ...text === "" ? [] : [{ type: "text", text }]];
```
（子代理分支同序：`client.js:2927-2932`。）
**扩展**：`src\dsh\controller.ts:1448-1460`
```ts
if (contextText) content.push({ type: "text", text: contextText });
if (text.trim()) content.push({ type: "text", text: text.trim() });
for (const attachment of attachments) { ... content.push({ type: "image", ... }); }
```
**后果**：同一轮的图片在官方位于文本之前、在扩展位于文本之后，并且扩展会多出一个"上下文文本"块在最前。对多数多模态模型影响很小，但它是线格式差异（做消息对比/审计时会不一样）。
**置信度**：高（顺序直读）；用户可感知影响：低。

### 3.3 官方允许"只有附件、没有文本"的发送；扩展按钮直接禁用 —— **不一致**

**官方**：`client.js:15821`
```js
const empty = draft.trim() === "" && attachments.length === 0;
```
`primaryDisabled = primaryStops ? ... : empty || disabled || ...`（`:16021`）→ 只有附件时 Send 可用。提交机还有专门的 `send-committed` 事件处理"空草稿的纯附件发送"（`...\contract\input.d.ts:385-388`）。
**扩展**：`src\webview\components\Composer.tsx:165`
```tsx
const canSend = draft.trim().length > 0 && state.connection === "ready";
```
→ 只挂了图、没打字时发送按钮为 disabled，Enter 也被 `send()` 的 `if (!canSend) return;`（`:167-168`）挡掉。注意宿主侧其实能发（`controller.ts:1453-1461`：只要有图片块，`content.length > 0` 就继续），所以这是**纯 UI 限制**。
**后果**：想"只发一张图/一个文件"的用户在扩展里做不到（除非随便打一个字）。官方可以。
**置信度**：高。

### 3.4 拖放 / 粘贴文件不落地 —— **不一致**（2026-09-21 起两条路都已落地）

**官方**：拖放与粘贴文件都进 `intakeFiles`：`client.js:15920-15941`（含图片数量/大小校验）、keymap 的 `intakeFiles: (files) => gate.current.intakeFiles(files)`（`client.js:15997-15999`，`keymap.d.ts:29-30`）；并有专门的 `DropOverlay`（`$DSH\dsh-client-ui-attachment\lib\types\DropOverlay.d.ts`）。
**扩展（审计当时）**：`src\webview\components\Composer.tsx:382-392` 只高亮、不读 `event.dataTransfer.files`；`textarea` 也没有 `onPaste`。
**后果**：扩展会显示拖放高亮（`app.css:1228` `.composer-box.is-drop-target`），但松手后什么都没发生——比不支持拖放更容易误导。粘贴图片同理无入口。
**置信度**：高（代码直读）。

**2026-09-21 复修**：两条路都接上了，落点在 `src/webview/attachIntake.ts`（App 的
`usePageFileDrop` / `usePagePaste` 各挂一个 window 监听）。粘贴这条路的关键机制
（本机 VS Code `resources/app/out` 逐行读过）：桌面版 `webview/browser/pre/index.html` 的
`handleInnerKeydown` 对 `Ctrl+C/V/X`（含 `Shift+Insert`）**一律 `preventDefault()`**，再把
按键交给宿主；宿主 `WebviewElement.handleKeyEvent` 把它重新派发到主窗口，键位解析到
`paste` → `WebviewElement.paste()` → `_send("execCommand","paste")`；webview 的 pre 脚本收到后
对**内容文档**执行 `execCommand("paste")`（iframe 上的 `allow="clipboard-read; clipboard-write"`
就是这条权限），于是 webview 文档里真的触发一次 `paste` 事件。所以**不要自己挂 keydown 抢
`Ctrl+V`**——那会在宿主之前吃掉按键，反而让它不再补发。

**粘贴时剪贴板到底给了什么（2026-09-21 实测，Playwright + 真实 Windows 剪贴板，
复制目录 / 无扩展名文件 / png 各一遍）**：

| 复制的东西 | `types` | `text/uri-list` | `text/plain` | `files[0]` |
|---|---|---|---|---|
| 目录 `docs` | `["Files"]` | **空串** | **空串** | `{name:"docs", type:"", size:0}`，字节读不出来（`A requested file or directory could not be found…`） |
| 文件 `LICENSE` | `["Files"]` | **空串** | **空串** | `{name:"LICENSE", type:"", size:2001}` |
| 图片 `icon.png` | `["Files"]` | **空串** | **空串** | `{name:"icon.png", type:"image/png", size:15471}` |

结论：**webview 侧没有路径**（`text/uri-list` 这条最常用的路子在这里是空的），
`File.name` 只有 basename、`File.path` 自 Electron 32 起已移除。所以「目录 → 路径、
大文件 → 与添加附件同样不限大小」只能由宿主去**系统剪贴板**取真路径：新增
`src/dsh/clipboardPaths.ts`（Windows：`powershell.exe -Sta` + WinForms
`Clipboard.GetFileDropList()`；显式 UTF-8 输出、5 秒超时、`windowsHide`；非 Windows
或读不到返回空）。取到路径后按**类别**分流：**目录 → `insertMention` 的 `@目录/` 引用**
（写进正文的路径，与资源管理器右键文件夹同一条路；用户 2026-09-21 第二轮明确
「粘贴文件夹不该变成附件」）、**文件 → 附件通道**（图片内容块 / 其余不限大小地上传）；
取不到路径才退回字节通道（截图那类）。顺序在 `controller.handle` 的 `attachBytes` 分支里，
`scripts/attachments.test.ts` 有断言。

**仍未对齐的细节**：官方 `intakeFiles` 自带图片数量/大小校验、有整屏 `DropOverlay`；
本扩展的字节通道（**拖放**、以及粘贴里剪贴板只有位图的那些）仍受单文件 8 MB 限制
（`ATTACH_BYTES_LIMIT`），浮层只有拖放那一条路有。路径读取目前**只在 Windows** 可用。

---

## 4. 选区上下文

### 4.1 官方没有「编辑器选区」这种表示；扩展把选区正文内联 —— **不一致**

**官方**：我把三处契约的联合类型都过了一遍，没有任何 selection/quote 附件形态：
- 提交内容只有 `text | image | file(receiptId)`：`$DSH\dsh-api-session-controller\lib\types\types.d.ts:64-75`。
- 命令附件只有 `image | file(receiptId)`：`$DSH\dsh-client-ui-conversation\lib\types\client\contract\input.d.ts:22-30`、`$DSH\dsh-commands\lib\types\types.d.ts:13-18`。
- 结构化引用只有 `ReferenceInsert{source,ref,label,appearance:'session'|'file'|'folder',clipboardText}`：`...\contract\input.d.ts:55-61`（`appearance` 只有这三种）。
- `selection` 在官方里只表示**编辑器内的光标/选区区间**（`EditSelection`，`...\contract\input.d.ts:269-273`），与"把选中代码发给模型"无关。
- 使用者引用工作区内容的官方方式就是 `@` 路径（§3.1）——模型自己去 read。

**扩展**：`src\dsh\extension.ts:122-129`（编辑器右键 → `dshChat.addSelection`，`package.json:124-130` 菜单）→ `controller.addSelection`（`controller.ts:1924-1929`，`kind: "selection"`）→ 发送时内联：
`controller.ts:1505-1507`
```ts
if (attachment.kind === "selection" && attachment.text) {
  parts.push(`以下是来自 ${attachment.name} 的选中代码：\n\`\`\`\n${attachment.text}\n\`\`\``);
  continue;
}
```
（`AttachmentKind` 定义见 `src\shared\chat.ts:17`：`"file" | "image" | "selection" | "context"`。）

**后果**：这是扩展独有的能力（官方 Web UI 没有编辑器，所以也没有对应物）。差异是**语义性的**：官方那套里"用户引用了某个文件"是可追踪的路径引用（模型自己读、能读到完整且最新的内容）；扩展发的是"某一刻的选区快照"，且没有行号、没有文件路径 token（只有文件相对路径写在自然语言标题里）。若选区内容在发送前变化，模型看到的是过期快照，且不会有任何提示。反过来，扩展这套对"只想发一小段代码"的用户更省 token。是否算缺陷取决于产品取向——但**与官方不一致是确定的**。
**置信度**：高（联合类型穷举 + 代码直读）。

---

## 5. 斜杠命令

### 5.1 官方把 `/xxx` 当命令执行（`commands/execute`），扩展把它当普通消息发给模型 —— **不一致（重大）**

**官方行为**

- 输入机在 Enter 时对 `/` 开头的草稿进入 adjudication，而不是直接发送：`$DSH\dsh-client-ui-conversation\lib\client.js:11699-11710`
  ```js
  const trimmed = draft.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("/")) {
      const attempt = this.beginAttempt(mode, draft);
      this.phase = "adjudicating";
      return [{ type: "adjudicate", attempt, draft }];
  }
  ```
  只有 adjudication 返回 `undefined`（没有任何 source 认领）时才落到 default sink（= `session/prompt`）：同文件 `:11725-11729`；契约注释 `...\input\facade.d.ts:29-30`（"absent/undefined answer = every '/' line falls to the default sink"）也确认了这条兜底。
- `/` 源是 `command`（`$DSH\dsh-client-ui-commands\lib\client.js:526-536`），它的 Enter 裁决：
  `client.js:712-759`（`matchEnter`）→ 有 `input` 描述的命令返回 `{ claim: this.leadingClaim(desc, session) }`（`:749`）或无 input 的 host 命令走 `runDetached`（`:757`）。
- claim 的提交事务就是 `commands/execute`：`client.js:774-783`
  ```js
  leadingClaim(desc, session) {
      const token = `/${desc.name} `;
      return { token, ...desc.input?.attachments === true ? { attachments: true } : {},
               submit: (args, _actx, attachments) => this.execute(session, token + args, attachments) };
  }
  ```
  以及 `client.js:795-796` → `this.ctx.remote.commands.execute(session.sessionId, line, attachments)`。
- Host 侧 `/` 命令确实是"不进模型"的：`$DSH\dsh-commands\lib\types\index.d.ts:111-112`
  > `Parse and execute a known command without sending it to the model.`
- 查遍了 Host：`parseCommand` 只在 `dsh-commands` 内部被使用（`$DSH\dsh-commands\lib\index.js:319`、`...\lib\types\index.js:301`），没有任何前置步骤去解析"用户消息文本里的 `/命令`"。也就是说 **聊天正文里的 `/plan` 不会被 Host 当作命令**。
- 具体命令的例子（`/plan`）：`$DSH\dsh-plan-mode\lib\index.js:180-227`
  ```js
  name: "plan", description: "Enter or leave plan mode",
  input: { hint: "[off|message]", attachments: true },
  handler: ({ agent, rawInput, attachments }) => { ... this.set(agent, true) ... }
  ```
  官方 UI 的 plan 芯片退出时也走命令通道：`$DSH\dsh-client-ui-plan\lib\client.js:126` → `ctx.remote.commands.execute(sessionId, "/plan off", [])`。

**扩展行为**

- `commands/execute` 只被一个地方调用：`src\dsh\controller.ts:1567-1590` `runCommand`，而 `runCommand` 的唯一调用点是 `controller.ts:1313-1314`（权限胶囊 → `/permission <id>`）。全仓 grep `runCommand|commands/execute` 只有这两处。
- 用户在输入框里敲的 `/xxx` 走的是普通发送：`Composer.tsx:167-177`（`send()` 恒发 `{type:'send', text}`）→ `controller.ts:1443-1491` `send()`（**没有任何 `/` 分支**）→ `prompt(...)`。
- 计划模式也在这条路上：进入计划模式是把 `/plan` 前缀拼进消息正文（`Composer.tsx:79-82`、`:169-172`），退出计划模式发的是 `"/plan"`（`Composer.tsx:517-519`）。
- 命令目录只用来做补全：`Composer.tsx:151`、`:186-195`（选中命令只是把 `/name` 填进草稿，仍需用户回车）。

**后果（用户可见）**

1. `/compact`、`/export`、`/feedback`、`/goal` 等**所有**内置命令在扩展里都不会执行——它们会作为一句普通用户消息发给模型。用户看到的不是命令卡片/流程节点（官方 `command/run`+`command/done` 会渲染成持久流程节点，`$DSH\dsh-commands\lib\types\types.d.ts:88-117`），而是一句被模型读到的怪话。
2. `/plan` 这条尤其严重：进入计划模式在扩展里只是"给模型发一句 `/plan 任务…`"，**Host 侧的 plan 状态不会被置位**——因为 plan 的激活只发生在 `/plan` 命令 handler 里（`dsh-plan-mode\lib\index.js:214`），而 `plan:policy` 系统提示段又以该状态为条件（同文件 `:170-177`）。因此扩展的 plan 胶囊读到的 `plan` 投影（`controller.ts:846-851`）几乎不会变 true，界面上会永远停在"未进入计划模式"。
3. 扩展里 `Composer.tsx:519` 用 `"/plan"`（而非 `"/plan off"`）表示**退出**计划模式；按官方语义 `"/plan"` 是**进入**。即使将来把 `/xxx` 接到 `commands/execute`，这个方向也是反的。

**置信度**：高（两侧路由代码与命令注册都可直读；`/plan` 不生效这一条是**代码推断**，我没有跑运行时对拍——见 §7「无法确认」）。

### 5.2 `commands/execute` 参数名与形状 —— **一致**（`images` 回退是死代码）

**官方**（权威 typert face）
- `$DSH\dsh-commands\lib\typert.host.js:44-92`：`id: '@deepseek-ai/dsh-commands#commands/execute'`，`scope.wire: 'agentId'`，参数依次为 `agentId`(lookup) / `line`(json) / **`submittedAttachments`**(json，`:76-84`)。remote-client 同构：`...\lib\typert.remote-client.js:73-81`。
- 第三参数 schema：`...\lib\typert.host.js:6-15`
  ```js
  z.array(z.union([ z.intersection(z.object({type: z.literal("image")}), z.object({mediaType: ..., data: z.string(), name: z.string().optional()})),
                    z.object({type: z.literal("file"), receiptId: z.string()}) ]))
  ```
- 方法签名与语义：`$DSH\dsh-commands\lib\types\index.d.ts:130-139`（`@param submittedAttachments - encoded images and staged file receipts accompanying the line, in submission order; empty for a plain invocation.`）。
- 客户端调用：`$DSH\dsh-api-session-controller\lib\types\client\sessions\session.js:292-296` → `this.remote.commands.execute(this.sessionId, line, [])`；UI 命令源 `$DSH\dsh-client-ui-commands\lib\client.js:795-796`。

**扩展**
- `src\dsh\controller.ts:1567-1571`
  ```ts
  const attempt = (attachmentsKey: "submittedAttachments" | "images") =>
    this.client!.request("commands/execute", { agentId, line, [attachmentsKey]: [] });
  ```
  先试 `submittedAttachments`（`:1570-1574`、`:1593`），命中 `gateway/arguments-invalid` 才回退 `images`。
- 线信封：`src\dsh\client.ts:130-147`（`{type:'client-request', method, payload:{args}}` → `POST /api/<method>`）。

**结论**：`submittedAttachments` 就是当前正确且唯一的名字，`[]` 形状对"纯命令调用"也正确；扩展传的 `agentId/line/submittedAttachments` 与 typert face 完全吻合 → **一致**。
`images` 回退：我在整个已安装树里只找到一处 `args.images`，且它位于 **fixture 测试替身** 里（`$DSH\dsh-client-connection\lib\client.js:5949` 所在函数 `:5940-5942` 明确写着 `fixture connection RPC channel`；同文件 `:2031-2032` 有 `lib/types/client/fixture.js` 区块）——不是生产网关。因此我**没有**找到任何一个会接受 `images` 名字的生产面；该回退分支对当前版本应属死代码（保留无害）。**置信度**：高（`submittedAttachments` 一侧）；"没有任何生产端接受 `images`"**置信度**：中（我只能证明唯一出现处是 fixture，无法证明历史版本没有别的名字——这正是扩展注释 `controller.ts:1562-1566` 所描述的 0.1.5 改名）。
**另外**：扩展永远传 `[]`，而官方把草稿附件一起提交（`client.js:781`），并且 `/plan` 声明了 `input.attachments: true`（`dsh-plan-mode\lib\index.js:185`）。所以"带图片执行 `/plan`"在官方成立、在扩展不可能（扩展既不走命令通道、也不做上传）。

---

## 6. 停止 / 取消与排队消息

### 6.1 官方：`cancel` 保留队列并由 Host 按 FIFO 续跑；扩展：先摘空队列、再 cancel、再重发 —— **不一致**

**官方行为（契约 + 实现）**

- `$DSH\dsh-api-session-controller\lib\types\client\contract\session.d.ts:102-109`
  ```ts
  /**
   * Cancel the running turn. Pending queued work remains and resumes in FIFO
   * order after the Host reaches cancellation quiescence.
   */
  cancel(): Promise<RemoteResult<{ accepted: true }>>;
  ```
- Host 实现：`$DSH\dsh-api-session-controller\lib\types\commands.js:451-461`
  ```js
  cancel(request) { ... agent.cancel({ kind: 'user' }, { keepInbox: true }); return { accepted: true }; }
  ```
- 官方 UI 的停止就是这一个调用，不碰队列：`$DSH\dsh-client-ui-conversation\lib\client.js:16804-16805`
  ```js
  stop: () => { scopedConversation(sessions, sessionId).cancel().catch(() => {}); },
  ```
  （`conversation.cancel()` 见 `client.js:3161-3163`。）
- 队列的显示/变更完全由服务端队列帧驱动（`SessionQueuedItem`，`$DSH\dsh-api-session-controller\lib\types\types.d.ts:487-498`；UI 的 `QueueDock` 以 `useSession((s) => s.queue)` 为唯一来源）。
- 与停止相关的队列操作是**显式的**：每行 Steer（`client.js:14284` → `{kind:'steer'}`）、整队 Steer（`client.js:13518-13528`）。官方没有"停止后自动把队列第一条发出去"的语义。

**扩展行为**

- 扩展自己指出与契约相反的实测结论：`src\dsh\controller.ts:1738-1751`
  > 1. 只 `cancel` **不会**让队列自动接续…；2. 服务端是否顺带继续**取决于中止时刻落在哪一步**…
  > 所以做法是：先把**整条队列**摘空…再中止、等空闲，然后按原顺序重新提交。
- 实现：`controller.ts:1752-1796`
  ```ts
  const pending = this.queueItems.map(...).filter(...);           // 含 steering
  for (const entry of pending) { await this.client.updateQueueRemove(sessionId, entry.id); ... }  // :1771-1783
  await this.cancelTurn();                                        // :1786 → client.cancel
  if (!(await this.waitUntilIdle())) { ... @queueDispatchFailed }  // :1787-1792（上限 8s，:1857）
  await this.resubmit(removed);                                   // :1795 → 逐条 prompt(..., "queue", 新 requestId)
  ```
- `cancelTurn` 是普通 `session/cancel`（`:1847-1854`）；`resubmit` 每条都自铸新 requestId（`:1813`）并写死 `"queue"`（`:1819`），失败时把剩余内容回填输入框（`:1826-1828`）。
- 队列为空但拿不到可重发内容时会弹 `@queueContentLost`（`:1760-1766`）。

**可观测差异**

1. **语义冲突**：契约写的是"cancel 后待办保留并自动 FIFO 续跑"，扩展的注释写的是"cancel 不会续跑"。二者必有一方在当前版本上不符合事实，我没跑运行时验证（见 §7）。**这一条是本次审计里最需要实测确认的分歧点。**
2. **ESC 不是"停止"，而是"停止+续发队首"**：扩展把队首重新提交（`resubmit` 的第一条会成为新一轮），官方 ESC/停止不改变队列（等 Host 静默后由 Host 自己续跑）。用户感受：扩展里按停止会立刻看到队首消息被"发出去"；官方里则是本轮结束后队列自然被消费。
3. **多 RPC + 有损窗口**：扩展一次停止要发 N 次 `remove` + 1 次 `cancel` + N 次 `prompt`，并在中间等待最多 8 秒。若第 2..N 条的 remove 失败，它会把已摘的重新排回（`:1776-1782`）——但"重新排回"其实也是 `prompt`（`requeue` → `resubmit`，`:1835-1838`），会**换掉 requestId 与队列顺序**。若扩展在"摘空之后、重发之前"退出/重载，这些消息（只存在于 `queueOrigin`/`submissions` 内存里）就彻底丢了；官方路径下不可能丢（消息从未离开服务端）。
4. **`steering` 被降级**：`queueItems` 含 `steering`（`queueView.ts:54`），`resubmit` 一律 `"queue"`（`:1819`）→ 在途插话被改成"排队等下一轮"。
5. **顺序防御的代价**：扩展注释说，若不先摘空，中止后立刻提交的新消息会被"abort 后唤醒"锁存进 `next-turn`，排在仍留在队列里的消息**之后**（顺序倒置，`:1744-1746`）。这是扩展为了绕开竞态而付出的复杂度；官方把这件事留在 Host 侧。

**置信度**：高（差异本身与实现方式直读）；"哪一方的续跑事实成立"**无法确认**（见 §7）。

---

## 7. 无法确认 / 证据缺口（明确声明）

1. **`cancel` 之后队列是否自动 FIFO 续跑**：官方契约明确说会（`contract\session.d.ts:102-109`），扩展注释说不会且给了探针脚本名字（`controller.ts:1741` 提到 `scripts/queueContinueProbe.ts`）。**该脚本在本仓库不存在**（`scripts/` 下只有 `queueEscE2E.ts`、`probe.ts` 等，grep 无 `queueContinueProbe`）。仓库里唯一的 E2E（`scripts\queueEscE2E.ts:126-159`）只验证了扩展自己那套"先摘空"的流程，**没有**验证"只 cancel"这一分支（注释 `:4` 也只是说"复刻 stopRunning 的三步"）。所以扩展侧那个关键前提目前**在本仓库里没有可复现的证据**。我没有跑起服务器做实测。
2. **用户手打 `/plan` 是否真的不进模型**：我从"Host 无正文命令解析"（`parseCommand` 只在 `dsh-commands` 内）+"/plan 状态只在命令 handler 里置位"推断出"扩展的 plan 模式不会真正激活"。这是代码推断，未运行验证。
3. **VS Code webview 的拖放/图片粘贴能力**：扩展没有实现这条路径（可证），但"官方那条路径在 VS Code webview 里能否等价实现"我未验证。
   → **2026-09-21 部分解决**：机制已在 VS Code 源码里读到（`Ctrl+V` 被 `preventDefault` 后由宿主补发 `execCommand("paste")`，见 §3.4），实现已接上；但「剪贴板里的**文件**（CF_HDROP）在 Electron 的 `execCommand("paste")` 里会不会被投递成 `clipboardData.files`」**仍未实测**——图片那条有先例（VS Code 里 Jupyter 笔记本能粘贴截图），文件那条只有浏览器侧的先例。
4. **`images` 是否曾在某个历史版本被接受**：我只能证明当前安装树中唯一出现处是 fixture 替身（`dsh-client-connection\lib\client.js:5949`），无法回溯历史版本。
5. **跨会话编辑竞态**（§2.1 第 5 点）与 **8 秒 waitUntilIdle 超时**的具体发生率：代码路径可读，未实测。
6. 我没有逐个核对扩展的 `Attachment.kind === "context"`（`shared\chat.ts:17`）在发送路径里的处理——`buildContextText`（`controller.ts:1502-1537`）只处理 `selection` 与 `file`，`context` 既不内联也不报错，属于静默忽略；但我在源码里没找到任何创建 `context` 附件的地方，因此**无法确认该分支是否有实际入口**。

---

## 8. 排序：真正影响用户的差异 vs 无害选择

**A. 会影响用户、建议优先处理**

1. **`busyEnter: steer` 被完全忽略**（§1.1）；本机设置正是 `steer`。同一手势在两处行为不同，且扩展设置面板里改这个值会"保存成功但不生效"。同时缺少 Ctrl/Cmd+Enter 反向手势与"整队插话"（§1.2）。
2. **手打的斜杠命令不执行**（§5.1）：`/compact`、`/export`、`/goal`、`/plan` 等全部变成给模型的一句普通文本；`/plan` 还导致扩展的计划模式实际不置位、退出按钮发的是"进入"指令（`Composer.tsx:519`）。
3. **文件上下文全量内联进 prompt**（§3.1）：token/成本与上下文压力显著高于官方；二进制/超大文件反而拿不到内容；`@` 的模型侧语义被抹掉（`@token` 被删）。并直接导致 §2.2 的队列编辑退化（超 50 条或 30 分钟后"重新编辑"把内联文本倒回输入框）。
4. **停止语义与官方相反**（§6.1）：ESC/停止变成了"停止+摘空队列+按序重发"，多 RPC、8 秒等待、有有损窗口，并把在途插话降级成排队；且扩展赖以成立的关键前提（cancel 不续跑）在本仓库没有可复现证据。
5. **队列编辑的落点与官方不同**（§2.1）：官方原地改、不碰输入框、服务端丢附件；扩展摘掉队列项、把内容（和附件）追加进当前草稿、位置改到队尾——用户可能得到"顺序变了"和"草稿被拼了东西"两种意外。且 `steering` 行被当作"排队中"展示（§2.3）。
6. **只有附件不能发**（§3.3）与**拖放/粘贴文件不落地**（§3.4）：都是"看起来支持、其实无声失败"的形态。
   → **§3.4 已于 2026-09-21 修好**（拖放 + 粘贴都落地，`src/webview/attachIntake.ts`）；§3.3（只挂附件不能发）仍待处理。

**B. 有差异但影响很小 / 基本无害**

7. 内容块顺序（附件与文本的先后，§3.2）。
8. `images` 回退分支（§5.2）——死代码，无害。
9. `requestId` 自铸、`clientTimeZone` 上报（§1.3）——与官方一致，无差异。
10. `/permission` 走 `commands/execute`（`controller.ts:1313-1314`）——与官方同类操作（`ui-permission-presets\lib\client.js:491`、官方 `session.command()`）语义一致，参数名也正确。

**C. 扩展独有的能力（官方无对应物，不算"错误"，但属于不一致）**

11. 「选区」作为附件内联（§4.1）：官方没有任何对应表示；扩展多了一条能力，代价是选区内容无行号/无路径 token、可能过期，且与官方"让模型自己 read"的哲学相反。
12. `notInlinedNote`、`@attachmentNotInlined` 等提示：官方没有这些概念（因为官方不做内联判定），属于扩展自造词汇。
