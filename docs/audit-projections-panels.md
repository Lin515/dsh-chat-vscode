# DSH Chat (VS Code extension) vs 官方 DSH Web 前端：投影与面板一致性审计

> **这是原始分报告**（由子代理产出，覆盖面比主报告广）。其中的高影响结论已由主线复核并
> 汇总进 [`audit-summary.md`](audit-summary.md)——**以那份为准**；本文件保留完整证据与
> 未复核条目。复核状态标注：`[实测]` 起真实服务器验证过 / `[契约]` 官方类型声明逐字引用 /
> `[代码]` 本仓库代码事实 / `[存疑]` 未验证。
>
> 主线已独立复核本报告的 `goal` 嵌套形状与 `subagentCatalog` 缺 `kind`/`activity` 两条
> （读官方 `types.d.ts` + 本仓库 `controller.ts` 对拍），结论成立，见 `audit-summary.md` §3.3/§3.4。

审计范围：仅 **projections & panels**。官方源码为只读权威，路径记为 `@dsh/<pkg>/...`，
其中 `@dsh` = `C:\Users\Cueio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`。
扩展源码在 `d:\dev\dsh-chat`。

结论记号：**一致** / **不一致** / **无法确认**。所有条目均给出 `path:line` 与代码原文。

---

## 0. 线格式投影键的完整清单 vs 扩展消费情况

`SessionProjectionMap`（合并声明）的权威快照见
`@dsh/dsh-api-session-controller/lib/typert.host.js:1800-1801`：

```
"export interface SessionProjectionMap {\n    inbox: InboxWireState;\n    agentPreset: string | null;\n
 title: string | null;\n    todos: TodoItem[] | null;\n    sessionListMetadata: SessionListMetadata;\n
 imageLimits: ImageAttachmentLimits;\n    modelSelection: ModelSelectionProjection;\n
 subagentCatalog: SubagentCatalogEntry[];\n    subagentTiming: SubagentTimingProjection;\n
 subagent: SubagentIdentityProjection | null;\n    goal: GoalProjection | null;\n}"
```

另有 9 个键由别的包 `declare module` 合并进来（`SessionProjectionMap` 声明所在文件已逐一核对）：
`permissions`（`@dsh/dsh-permission-presets/lib/types/types.d.ts:32-39`）、
`plan`（`@dsh/dsh-plan-mode/lib/types/types.d.ts:42-44`）、
`tokenUsage` / `contextPressure` / `contextBreakdown`（`@dsh/dsh-token-meter/lib/types/projection.d.ts:63-72`）、
`sessionStats`（`@dsh/dsh-session-stats/lib/types/types.d.ts:37-39`）、
`turnOutline`（`@dsh/dsh-session-turn-outline/lib/types/types.d.ts:40-42`）、
`schedule`（`@dsh/dsh-schedule/lib/types/types.d.ts`，`interface SessionProjectionMap { schedule: readonly ScheduleRecord[] }`）、
`agentPreset`（`@dsh/dsh-agent-presets/lib/types/types.d.ts:71-73`）。

共 **20 个 client 可见键**。

扩展的 `applyProjection` 只处理 **10 个**键
（`src/dsh/controller.ts:831-989`，`case` 分支：`modelSelection` `permissions` `plan` `todos` `title`
`contextPressure` `contextBreakdown` `sessionStats` `subagentCatalog` `goal`）。

`jobs` 不走投影，走 `session/control` 的 `jobs` 帧（`src/dsh/controller.ts:802-805`、`:993-1025`），
与官方一致——官方 jobs 面板也读 control 帧的 list mirror
（`@dsh/dsh-client-ui-jobs/lib/types/client/index.d.ts`：*"The data arrives entirely through the
`jobsBySession` list mirror, so the plugin issues no RPC"*）。

**官方 UI 真正读投影的地方**（全量枚举，`useProjection(` 调用点）：

| 键 | 官方读取点 |
|---|---|
| `turnOutline` | `@dsh/dsh-client-ui-chat/lib/client.js:2076` |
| `tokenUsage` | `@dsh/dsh-client-ui-chat/lib/client.js:4081` |
| `sessionStats` | `@dsh/dsh-client-ui-chat/lib/client.js:4083` |
| `contextPressure` / `contextBreakdown` | `@dsh/dsh-client-ui-conversation/lib/client.js:15414-15415` |
| `plan`（含 `pending` 谓词） | `@dsh/dsh-client-ui-conversation/lib/client.js:15815`；`@dsh/dsh-client-ui-plan/lib/client.js:34` |
| `goal` | `@dsh/dsh-client-ui-conversation/lib/client.js:15816`；`@dsh/dsh-client-ui-goal/lib/client.js:365` |
| `imageLimits` | `@dsh/dsh-client-ui-conversation/lib/client.js:15836` |
| `permissions` | `@dsh/dsh-client-ui-conversation/lib/client.js:15852`；`@dsh/dsh-client-ui-permission-presets/lib/client.js:403-404` |
| `todos` | `@dsh/dsh-client-ui-conversation/lib/client.js:16446` |
| `schedule` | `@dsh/dsh-client-ui-schedule/lib/client.js:125` |
| `title` | `@dsh/dsh-api-session-controller/lib/client.js:2895`（列表行） |
| `agentPreset` | `@dsh/dsh-client-ui-agent-preset/lib/client.js:191`（经 session-list `projectionValues`） |
| `subagentTiming` | `@dsh/dsh-client-ui-subagent/lib/client.js:108`（经 session-list `projectionValues`） |
| `subagentCatalog` | 官方 UI **不直接读**；`subagent/list` RPC 返回同构行（见 §6） |

**扩展完全丢弃的投影（官方 UI 用户可见）**：
`tokenUsage`、`turnOutline`、`imageLimits`、`schedule`、`agentPreset`、`sessionListMetadata`、`inbox`、
`subagentTiming`、`subagent`（身份）。

---

## 1. `modelSelection`

**一致（选择值）/ 不一致（默认值与可路由性）**

- 官方 wire 形态：`{lastUsed, next}`，且
  `@dsh/dsh-api-session-controller/lib/types/model-selection-projection.js`：
  ```js
  wire: { viewSchema: modelSelectionProjectionSchema,
          view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }) }
  ```
  （`next` 已经是 `pending ?? lastUsed`）。
- 官方 UI 取值：`@dsh/dsh-client-ui-model-selection/lib/client.js:225`
  `const current = projected.next ?? catalog.value.default;`
- 扩展：`src/dsh/controller.ts:689` `const used = value?.next ?? value?.lastUsed;`
  → 与官方等价（wire 上 `next` 为 null 时 `lastUsed` 必为 null）。**一致**。
- **不一致 1（默认模型来源）**：官方回退到 `session/modelCatalog` 的 `catalog.default`
  （`@dsh/dsh-api-session-controller/lib/types/types.d.ts:127-133`）。扩展的
  `modelCatalog()` 只声明 `{groups, failures}`（`src/dsh/client.ts:326`），`loadModels` 只读 `catalog.groups`
  （`src/dsh/controller.ts:1183-1193`），完全丢弃 `default` / `routableProviders` / `failures`；
  默认模型改为读设置命名空间（`src/dsh/controller.ts:1210-1232`，`client.ts:330-339`）。
  用户可见后果：若 `agent-default-model` 设置与 `catalog.default` 不一致（例如运行时被别的调用方改过），
  扩展开场显示的模型胶囊可能与实际会用的模型不同；目录缺失的 provider 在扩展里也不会提示。
  置信度：中（两处通常同源，但契约上不等价）。
- **不一致 2（不可路由阻断）**：官方把 `routableProviders.includes(current.provider)` 记入 `routable`
  并在不可路由时阻断输入区（`@dsh/dsh-client-ui-model-selection/lib/client.js:229-233`、`:310`：
  `conversation.blocks.set(sessionId, directory.store.getSnapshot().routable === false ? { reason: blockReason() } : void 0)`）。
  扩展没有对应逻辑（`src/...` 全仓无 `routable`）。用户可见后果：选到不可路由的 provider 时扩展不提示，
  要等发送后由服务端报错。置信度：高。
- **不一致 3（contextWindow 来源）**：官方模型目录的 `ModelCatalogModel` 契约里没有 `contextWindow`
  （`@dsh/dsh-api-session-controller/lib/types/types.d.ts:108-113`），扩展的 `ModelOptionView.contextWindow`
  （`src/shared/chat.ts:247`）在 `loadModels` 里从不赋值，唯一来源是 `contextPressure.contextWindow`
  （`src/dsh/controller.ts:892-895`）——即官方明确要求"不必与压力原子配对"的那个字段（见 §5）。
  用户可见后果：模型悬停/占用条分母偶尔是旧 provider 的容量。置信度：中。

---

## 2. `permissions`（权限胶囊）

**不一致**

- 官方契约 `PermissionSelect`（`@dsh/dsh-permission-presets/lib/types/types.d.ts:12-39`）：
  ```ts
  export interface PresetOption { value: string; name: string; description?: string }
  export interface PermissionSelect { options: PresetOption[]; currentValue: string }
  ```
  注释：*"Switchable presets, plus `custom` appended exactly while it is current"*。
- 官方 UI **完全由投影驱动**：`@dsh/dsh-client-ui-permission-presets/lib/client.js:407-420`
  ```js
  function optionsOf(value, t) {
      return value.options.filter((option) => option.value !== "custom").map((option) => ({
          id: option.value,
          label: displayPermissionPreset(option.value, option.name, t),
          ...option.description !== void 0 ? { detail: option.description } : {},
          ...option.value === value.currentValue ? { active: true } : {},
          ...option.value === "danger-full-access" ? { confirmation: {...} } : {}
      }));
  }
  ```
  即：选项集合、显示名、描述都来自投影；派生的 `custom` 从菜单里剔除（但仍可能等于 `currentValue`）。
  官方默认预设表只有 **两条**（`@dsh/dsh-permission-presets/lib/index.js:81-94`）：
  `workspace-write`、`danger-full-access`。
- 扩展：`src/dsh/controller.ts:836-844` **只读 `currentValue`**，`options` 整个丢弃：
  ```ts
  case "permissions": {
    const current = (value as { currentValue?: string } | null)?.currentValue;
    if (typeof current === "string" && current) { this.permission = current; ... }
  ```
  菜单则硬编码三条（`src/webview/components/Composer.tsx:23-41`）：
  `read-only` / `workspace-write` / `danger-full-access`，标签与描述取自扩展自己的词典
  （`Composer.tsx:490-507`）。当前值取值：`Composer.tsx:263-264`
  ```ts
  const currentPermission = permissions.find((item) => item.id === state.permission) ?? permissions[1];
  ```
- 用户可见后果：
  1. 部署自定义预设表（改名、加减条目、只配 `read-only`）时，扩展显示的仍是这三条，且名字/描述与宿主不一致；
  2. `currentValue === "custom"` 时（宿主明确会派生这个值），胶囊静默退化为 `workspace-write`（`?? permissions[1]`），
     用户看到的是一个**错误**的当前权限；
  3. `read-only` 不在官方默认预设表里 —— 若部署未配置该预设，扩展仍会把它作为可选项发 `/permission read-only`
     （`Composer.tsx:499` → `controller.ts:1313-1314` → `runCommand`）。
  置信度：高（代码级确定）；对具体部署的严重性取决于其预设表配置。

---

## 3. `plan`（计划模式）

**不一致（`pending` 被丢弃）**

- 官方契约 `PlanProjection`（`@dsh/dsh-plan-mode/lib/types/types.d.ts:19-22` + 注释）：
  *"`active` is the logged state in force …; `pending` is true while a logged `/plan` selection targets a state
  other than `active`, has not failed …, and no later `plan/mode` event has recorded that state."*
- 官方 UI 用 **有效目标态** 判定，而不是 `active`：
  `@dsh/dsh-client-ui-plan/lib/client.js:28-45`
  ```js
  * only while the effective target is plan mode (`pending ? !active : active`
  * — a folded host value, not client optimism)
  function PlanChip({ useProjection, ... }) {
    const plan = useProjection("plan");
    ...
    if (plan === void 0) return null;
    if (!(plan.pending ? !plan.active : plan.active)) return null;
  ```
  同谓词也用在输入区：`@dsh/dsh-client-ui-conversation/lib/client.js:15815`。
- 扩展：`src/dsh/controller.ts:846-851` 只取 `active`，`pending` 从未读取：
  ```ts
  case "plan": {
    const active = Boolean((value as { active?: boolean } | null)?.active);
    this.planMode = active; ...
  ```
  扩展转而用**客户端乐观态**补足：`src/webview/components/Composer.tsx:82`
  `const [pendingPlan, setPendingPlan] = useState<string | undefined>(undefined);`
  仅在 UI 点击"进入计划模式"时设置（`Composer.tsx:79-82`、`:313-322`、`:510-529`）。
- 用户可见后果：进入计划模式的过渡窗口内，官方立刻显示计划模式 chip（`pending=true, active=false`），
  扩展不显示；反过来，通过 `/plan` 命令（而非按钮）或另一客户端发起的切换，扩展的 `pendingPlan`
  为空，UI 直到 `plan/mode` 落地才有反应。退出计划模式时官方同样按 `pending` 处理，扩展在
  `active` 为真的整个窗口都显示"已进入"。置信度：高。

---

## 4. `todos`

**一致**

- 官方契约（`@dsh/dsh-tool-todo/lib/types/types.d.ts:20-44`）：`TodoItem { content: string; status: 'pending'|'in_progress'|'completed' }`，
  投影为 `TodoItem[] | null`，*"No id, priority, or `activeForm`"*。
- 扩展：`src/dsh/controller.ts:853-867`
  ```ts
  const items = Array.isArray(value) ? value : [];
  this.todos = items.map((todo, index) => ({
    id: String(item?.id ?? index),
    content: String(item?.content ?? item?.text ?? ""),
    status: item?.status === "completed" ? "completed" : item?.status === "in_progress" ? "in_progress" : "pending",
  }));
  ```
  状态词表与官方**逐字一致**；`null` → `[]` 与官方 UI 的 `useProjection("todos") ?? []`
  （`@dsh/dsh-client-ui-conversation/lib/client.js:16446`）等价。`id` 为扩展自造（官方 UI 用 `item.content` 做 key，
  同文件 `:16438`），仅是渲染 key 的差异，无语义影响。
- 渲染：扩展 `src/webview/App.tsx:304-322`（每条一个状态点），官方 `@dsh/dsh-client-ui-conversation/lib/client.js:16425-16439`
  （`data-status` + 状态字形 + 可折叠头）。**无数据语义差异**。

---

## 5. `contextPressure` / `contextBreakdown` / `contextOccupancy`（上下文占用条）

**不一致（分子口径 + `projectedTokens` 丢弃）**

- 官方：`context-occupancy` **就是** `contextPressure` 投影的一个客户端派生
  （`@dsh/dsh-token-meter/lib/types/usage-projection.d.ts:150`：*"Token-meter's context-occupancy projection unit."*）。
  投影定义 `@dsh/dsh-token-meter/lib/types/usage-projection.js:142-186`：
  ```js
  key: 'contextPressure',
  ...
  const pressureFrom = (usage) => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  ...
  view: ({contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens}) => ({
      ...pressureTokens === undefined || sampledSurfaceTokens === undefined
          ? {} : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) },
  })
  ```
  即 `pressureTokens` = **prompt 侧**（uncached input + cache read + cache write），**不含 output**；
  `projectedTokens` = 该样本 + 其后 surface 的带符号增量（压缩会使它下降）。
  契约注释 `@dsh/dsh-token-meter/lib/types/projection.d.ts:28-45` 明确：三者**不是同一次请求的原子观测**，
  *"Switching models can therefore pair a fresh capacity with the previous route's pressure"*。
- 官方 `contextOccupancy`：`@dsh/dsh-client-ui-conversation/lib/client.js:15328-15336`
  ```js
  function contextOccupancy(pressure) {
      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
      if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;
      return { percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)), usedTokens, contextWindow: pressure.contextWindow };
  }
  ```
  消费点 `:15414`、`:15418`、`:15439`（`context === null` 时整条 meter `return null`）。
- 扩展：
  - `contextPressure` 分支**只读 `contextWindow`**，且把它写进 `this.model`（而不是占用条分母）：
    `src/dsh/controller.ts:890-898`
    ```ts
    case "contextPressure": {
      const contextWindow = (value as { contextWindow?: number } | null)?.contextWindow;
      if (typeof contextWindow === "number" && contextWindow > 0 && this.model) {
        this.model = { ...this.model, contextWindow }; ...
    ```
    `pressureTokens` / `projectedTokens` **从未读取**（全仓 grep 无此标识符）。
  - 分子自己算：`src/dsh/adapter.ts:542-559`
    ```ts
    private refreshOccupancy(): void {
      const lastMessage = this.messages.at(-1);
      const usedTokens = lastMessage?.usage?.totalTokens;
      const window = this.contextWindow?.tokens;
      if (typeof usedTokens !== "number" || typeof window !== "number" || window <= 0) return;
      this.contextOccupancy = { percent: Math.min(100, Math.round((usedTokens / window) * 100)), usedTokens, contextWindow: window };
    ```
    `totalTokens` 的定义见 `@dsh/dsh-llm/lib/types/types.d.ts:139-146`：
    *"Exact full-call total including aggregate prompt and output tokens."* → **含 output**。
    分母 `this.contextWindow` 来自 `request/context` 事件（`src/dsh/adapter.ts:438-448`），不是投影。
- **不一致 A（分子口径）**：官方 = prompt 侧（不含本轮输出），扩展 = prompt + output。
  `toUsage` 的兜底 `usage.totalTokens ?? usage.inputTokens + usage.outputTokens`（`src/dsh/adapter.ts:99`）
  在 provider 未给 `totalTokens` 时同样含 output。
  用户可见后果：占用条系统性偏高，幅度≈最近一步的 output token 数（典型 0.3%–2%）。
  置信度：高（口径差异确定），幅度取决于步长。
- **不一致 B（压缩/替换不可见）**：`projectedTokens` 专门用于让占用条在压缩后立刻下降
  （契约 `projection.d.ts:36-43`：*"which `pressureTokens` alone cannot do, since compaction reports no usage of its own"*）。
  扩展完全不消费它，分子只在 `assistant/message` 到达时更新（`src/dsh/adapter.ts:529-534` 调用 `refreshOccupancy`）。
  用户可见后果：自动/手动压缩之后，官方占用条立刻下落，扩展仍显示压缩前的占用，直到下一轮助手消息落地。
  置信度：高。
- **不一致 C（显示门限）**：官方必须有 `usedTokens` **且** `contextWindow` 才渲染 meter。
  扩展 `CtxText` 的 `used` 有第二兜底：`src/webview/components/Composer.tsx:657-663`
  ```tsx
  <CtxText percent={state.contextOccupancy?.percent}
           used={state.contextOccupancy?.usedTokens ?? lastMessage?.usage?.totalTokens}
           total={state.contextOccupancy?.contextWindow ?? state.contextWindow?.tokens ?? state.model?.contextWindow} .../>
  ```
  `primitives.tsx:148-151` 在 `percent` 缺失时本地重算 `Math.min(100, Math.round(usedValue / total * 100))`。
  用户可见后果：扩展可能在官方不显示 meter 的状态下显示一个百分比（用模型目录/`request/context` 的分母）。
  置信度：中（需要"有 used、无 contextWindow"这一具体组合）。
- `contextBreakdown` **一致**：`{systemTokens, toolsTokens, messageTokens}` 三个字段名与官方
  `ContextBreakdownProjection`（`@dsh/dsh-token-meter/lib/types/projection.d.ts:56-62`）逐一对应，
  扩展校验三者均为 number 后使用（`src/dsh/controller.ts:900-916`），
  渲染用 `~` 前缀（`src/webview/components/primitives.tsx:161-165`）与官方
  `@dsh/dsh-client-ui-conversation/lib/client.js:15530`（`` `~${formatTokens(...)}` ``）一致。
  官方契约明确"三者相加不等于 `projectedTokens`，只能当构成近似呈现"（`projection.d.ts:46-53`），
  扩展也没有把它们相加（`primitives.tsx:161-165` 只逐行显示）——**一致**。

---

## 6. `subagentCatalog` / `subagent` / `subagentTiming` / 子代理面板

**不一致（投影形状用错 + `mode` 丢弃）**

- 官方 wire 形态 `SubagentCatalogEntry`（`@dsh/dsh-subagent/lib/types/projection-types.d.ts:8-17`）：
  ```ts
  export type SubagentCatalogEntry = { readonly id: SessionId; readonly createdAt: number }
    & ({ readonly mode: 'one-shot'; readonly label?: string }
     | { readonly mode: 'continuable'; readonly label: string });
  ```
  投影定义 `@dsh/dsh-subagent/lib/index.js:1487-1497`，`wire: { viewSchema, view: subagentCatalogEntries }`。
  **没有 `kind` 字段，也没有 `activity` 字段。**
- `kind: 'child'` / `activity: 'running'|'inactive'` 属于**另一个契约**：`subagent/list` RPC 的返回行
  `SubagentListEntry`（`@dsh/dsh-subagent/lib/types/control-types.d.ts:30-54`），
  以及 `SubagentCatalog { entries; parentAvailable }`（同文件 `:71-75`）。
- 扩展把**列表行**的过滤逻辑套在**投影**上：`src/dsh/controller.ts:947-966`
  ```ts
  case "subagentCatalog": {
    const entries = Array.isArray(value) ? value : [];
    this.subagents = entries
      .filter((entry) => (entry as { kind?: string })?.kind === "child")     // 投影上恒为 undefined
      .map((entry) => { const child = entry as { id: string; mode?: string; activity?: string; label?: string };
        return { id: child.id, label: child.label ?? child.id,
                 activity: child.activity === "running" ? "running" : "inactive" }; });  // activity 恒为 undefined
    this.emit({ type: "subagents/list", entries: this.subagents, parentAvailable: this.subagents.length > 0 });
  ```
  `SubagentCatalogEntry` 没有 `kind`，过滤结果**恒为空数组**。
  而同一个扩展在 RPC 路径上用的是正确形状：`src/dsh/controller.ts:1973-1983`（同样按 `kind === "child"` 过滤
  `subagents/list` 的 `entries`）——**两处形状被混用**。
- 触发频率：`follow()` 的 snapshot 会遍历全部投影调 `applyProjection`
  （`src/dsh/controller.ts:660-663`），`onControlFrame` 的 baseline 与 projection 帧同样会
  （`src/dsh/controller.ts:787-790`、`:807-809`）。因此每次（重）连接 / 每次 `subagentCatalog` 变化，
  子代理列表都被重置为空，并广播 `parentAvailable: false`。
- 用户可见后果：子代理面板（`src/webview/components/Panels.tsx:49-76`，空态文案见 `:61-62`）
  在投影刷新后显示"无子代理"，直到用户再点一次按钮走 RPC 路径；`parentAvailable` 恒 false。
  置信度：高（形状不匹配是确定的；是否被 RPC 结果短暂覆盖取决于时序）。
- 官方 UI 的 `activity` 来自 `subagent/list` 行（`@dsh/dsh-client-ui-subagent/lib/client.js:281`、`:345`），
  时长来自 **`subagentTiming` 投影**（同文件 `:106-111`：`const timing = summary.projectionValues?.subagentTiming;`）。
  扩展不读 `subagentTiming`（全仓无此标识符），面板不显示运行时长。
- 官方还有 `subagent` 身份投影（`projection-types.d.ts:36-55`，`SubagentIdentityProjection | null`），
  宿主用它校验地址模式（见下）。扩展不读。
- **不一致（`mode` 硬编码）**：`src/dsh/controller.ts:2025`
  ```ts
  address: { kind: "subagent", parentSessionId, childSessionId, mode: "continuable" },
  ```
  扩展在两条路径都丢弃了 `mode`（`controller.ts:1977` 的 `mode?: string` 声明后未使用；
  `controller.ts:953` 的 `mode?: string` 同样未使用）。
  宿主会严格校验：`@dsh/dsh-api-session-controller/lib/index.js:1593`
  ```js
  if (identity.mode !== address.mode) throw new RemoteError("subagent/unauthorized",
      "subagent mode does not match the supplied address", { childSessionId: address.childSessionId });
  ```
  用户可见后果：打开任何 `one-shot` 子代理的对话记录会被宿主拒绝（`subagent/unauthorized`），
  扩展只表现为面板内容为空。置信度：高（宿主校验代码确定；扩展此处硬编码确定）。
  另：扩展用 `assistantStream: false` + 800ms/8s 定时收尾（`controller.ts:2026-2044`），
  官方是有实时流的只读输入区（`SubagentReadOnlyComposer`），这是刻意的静态快照设计差异。

---

## 7. `jobs`（后台任务面板）

**一致（数据词表）/ 不一致（入口可见性与状态色）**

- 官方 wire `SessionJob`（`@dsh/dsh-api-session-controller/lib/types/types.d.ts:499-508`）：
  ```ts
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  ```
  宿主侧同义：`@dsh/dsh-jobs/lib/types/types.d.ts:14` `JobStatus = 'running'|'stopping'|'completed'|'killed'|'failed'`。
- 扩展 `src/dsh/controller.ts:1005-1012` 逐个枚举这五个值，**词表逐字一致**；
  字段名 `id/kind/label/status/detail/startedAt/finishedAt` 与官方契约一一对应（`controller.ts:996-1004`）。
  唯一细微差异：未知状态兜底为 `"completed"`（`controller.ts:1012`），官方是穷举围栏直接抛错
  （`@dsh/dsh-client-ui-jobs/lib/client.js:44-46` `throw new Error(\`unhandled job status: ...\`)`）。
  生产上词表不会不匹配，视为**一致**。
- **不一致（入口可见性）**：官方 `JobListAction` 只在会话有任务时渲染
  （`@dsh/dsh-client-ui-jobs/lib/types/client/JobListAction.d.ts`：*"It renders nothing at all until the session has
  at least one job"*），并带 live/idle 计数（`client.js:140-168`）。
  扩展的按钮常驻（`src/webview/App.tsx:69-76`），无计数徽标；空态显示"无后台任务"
  （`src/webview/components/Panels.tsx:128-129`）。用户可见后果：视觉噪音，无数据错误。置信度：高。
- **不一致（状态色）**：官方 `dotState`（`client.js:49-61`）注释为
  *"`stopping` and `killed` share the attention color"* → `stopping → "warning"`、`killed → ?`（同一 attention 色）。
  扩展 `src/webview/components/Panels.tsx:106-112`：
  ```ts
  const JOB_TONE = { running: "dot-running", stopping: "dot-running", completed: "dot-ok", killed: "", failed: "dot-error" };
  ```
  `stopping` 被画成"运行中"的蓝色而不是警告色，`killed` 无色调。用户可见后果：被取消/正在停止的任务
  在扩展里看起来仍在正常运行。置信度：高。

---

## 8. `sessionStats`

**一致（数据）/ 不一致（呈现位置与门限）**

- 官方契约 `SessionStatsProjection`（`@dsh/dsh-session-stats/lib/types/types.d.ts:18-35`）字段：
  `turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens`。
- 扩展 `src/dsh/controller.ts:919-945` 读取**全部八个字段**，名称与语义逐字对应
  （`src/shared/chat.ts:446-459` 的注释也与官方 doc 一致：`ttftSteps` 是分母、`decodeMs/decodeTokens` 同批步）。
  **一致**。
- **不一致（呈现）**：官方把它做成输入区一个**可见胶囊**（仪表图标 + `turns/steps` + tok/s），
  点击弹出对话框（`@dsh/dsh-client-ui-chat/lib/client.js:3938-3976`、`:4090-4098`），
  且投影缺失时回退到 `deriveStats(settledNodes)`（`:4084`）。
  扩展只在 **tps 悬停标题**里显示（`src/webview/components/Composer.tsx:292-306`、`:654-656`）：
  ```tsx
  {tps !== undefined ? (<span className="ctx-speed" title={statsTitle || undefined}>{tps.toFixed(1)} tps</span>) : null}
  ```
  用户可见后果：`tps` 为 undefined 时（宿主 `lastSpeed` 与最后一条消息都没有 `tokensPerSecond`，
  `Composer.tsx:290`），整个 `sessionStats` 的入口消失——全日志统计在扩展里没有任何常驻可见入口。
  扩展也不显示 `turns`/`steps`（官方胶囊的主标签就是这两个计数）。置信度：高。

---

## 9. `tokenUsage`

**不一致（完全丢弃）**

- 官方契约 `TokenUsageProjection`（`@dsh/dsh-token-meter/lib/types/projection.d.ts:12-23`）：
  *"Durable cumulative provider usage for a complete session log. The four buckets are disjoint."*
  → `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`；
  wire view = `state.totals`（`usage-projection.js:118`），即**全会话累计**，不是单步。
- 官方 UI 用它渲染"用量胶囊"：`@dsh/dsh-client-ui-chat/lib/client.js:4081`、`:4085`、
  `:3941-3942 `billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens``、
  `:4016-4019` `total = billedInputTokens(usage) + usage.outputTokens`，并在对话框里逐桶展开
  （`:4065-4072`）。
- 扩展：`tokenUsage` 键**完全未消费**（`src/dsh/controller.ts:831-989` 无该 case；全仓无该标识符）。
  扩展唯一的用量显示是 `CtxText` 悬停里的**单步**缓存命中率
  （`src/webview/components/primitives.tsx:154-158`、`:314-323`）。
- 用户可见后果：扩展没有"本会话累计消耗多少 token / 缓存命中率多少"的展示。
  注意区分：`MessageView.usage` 是**最后一步**的用量（`src/dsh/adapter.ts:524-534` 每次都覆盖
  `message.usage = usage`），而官方单轮用量是整轮所有 attempt 的聚合
  （`@dsh/dsh-token-meter/lib/types/turn-usage.d.ts:24-32` `deriveTurnTokenUsage`，"every attempt in one completed Turn"）。
  所以扩展里连"本轮总量"也拿不到。置信度：高。

---

## 10. `contextPressure` → 见 §5。`turnOutline`

**不一致（完全丢弃）**

- 官方契约 `TurnOutlineEntry`（`@dsh/dsh-session-turn-outline/lib/types/types.d.ts:12-26`）：
  `{turn, seq, prompt, response}`，投影 wire = `readonly TurnOutlineEntry[]`（`:40-42`），
  语义是"整日志每个已开始轮次的大纲，与客户端分页进来多少无关"。
- 官方 UI 用它拼轮次导航轨：`@dsh/dsh-client-ui-chat/lib/client.js:2076-2077`
  ```js
  const turnOutline = useProjection("turnOutline");
  const railItems = useMemo(() => mergeTurnRailItems(turnNavigationItems, turnOutline), [turnNavigationItems, turnOutline]);
  ```
  `mergeTurnRailItems`（同文件）把 outline 条目的 `prompt`/`response`/`anchor:{kind:'unloaded',seq}` 与已加载节点合并。
- 扩展：未消费（全仓无 `turnOutline`）。扩展也没有任何轮次导航/大纲 UI
  （`src/webview` 无 `rail`/`outline` 相关渲染）。用户可见后果：无法在长会话里按轮次跳转、
  看不到未加载轮次的预览。置信度：高。

---

## 11. `imageLimits`

**不一致（完全丢弃，无客户端预校验）**

- 官方契约 `ImageAttachmentLimits`（`@dsh/dsh-attachment/lib/types/types.d.ts`）：
  `{maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, maxImageDimension, mediaTypes}`；
  wire `imageLimits: ImageAttachmentLimits`（`@dsh/dsh-api-session-controller/lib/types/types.d.ts:24`），
  由 `@dsh/dsh-api-session-controller/lib/types/list.js:68-80` 注册（`view: () => attachmentCtx.attachments.imageLimits`）。
- 官方 UI 拿它做**入队前**校验：`@dsh/dsh-client-ui-conversation/lib/client.js:15920-15931`
  ```js
  if (imageLimits !== void 0) {
      const mediaTypes = imageLimits.mediaTypes;
      const images = files.filter((file) => mediaTypes.includes(file.type));
      const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
      if (imageAttachments.length + images.length > imageLimits.maxImagesPerMessage) return t("image.tooMany", ...);
      if (images.some((file) => file.size > imageLimits.maxImageBytes)) return t("image.fileTooLarge", ...);
      if (... > imageLimits.maxMessageImageBytes) return t("image.totalTooLarge", ...);
  }
  ```
  并用同一投影把服务端 `session/attachment-invalid` 的 reason 翻译成带具体限额的文案
  （`:15836`、`:15840`）。
- 扩展：**不消费 `imageLimits`**（全仓无此标识符）。图片准入只看两个自造条件：
  扩展名映射（`src/dsh/attachments.ts:23-29`）与"当前模型是否接受图片"
  （`attachments.ts:103-118`，`acceptsImage` 来自设置命名空间解析，`src/dsh/controller.ts:1133-1177`），
  以及非图片文本的 512 KiB 内联上限（`attachments.ts:38`、`:129`）。**没有任何字节数/张数/总大小上限**
  （grep 无 `maxImageBytes|maxImagesPer|maxMessageImage`）。
- 用户可见后果：超出宿主限额的图片会被加进输入框并编码成 base64（`attachments.ts:107-117`，无大小检查），
  直到发送才由宿主拒绝；错误文案是原始服务端 reason，而不是官方那种带具体限额的本地化提示。
  置信度：高。

---

## 12. `title` / `sessionListMetadata` / 会话列表

**`title` 一致；会话列表筛选 不一致**

- 官方 `title` 投影 = `string | null`（`@dsh/dsh-session-title/lib/types/types.d.ts:70`、`:80`），
  列表行也读它：`@dsh/dsh-api-session-controller/lib/client.js:2895-2899`
  ```js
  const title = projectionStore?.get("title");
  ... ...typeof title === "string" && title !== "" ? { title } : {},
  ```
- 扩展两处都读：RPC 列表行 `src/dsh/controller.ts:557`（`item.projections?.values?.title`），
  以及投影推送 `src/dsh/controller.ts:872-888`。**一致**。
  （唯一小差异：`title` 变为 `null` 时扩展不清理旧标题，`controller.ts:873` 只在 truthy 时动作。）
- `sessionListMetadata` = `{blank: boolean, lastPromptAt: number|null}`
  （`@dsh/dsh-api-session-controller/lib/types/types.d.ts:39-44`，定义 `:10-13`）。
  扩展不消费该投影键，但用的是服务端已折算好的 `SessionSummary.blank`
  （`src/dsh/controller.ts:566`；`@dsh/dsh-api-session-controller/lib/types/list.js:94`、`:133` 说明 `blank` 就是从该投影投影出来的），
  所以**数据本身不丢**。
- **不一致（blank 会话可见性）**：官方列表明确隐藏 blank 会话（仅当前选中的那条可见）：
  `@dsh/dsh-client-ui-workspace/lib/client.js:338-340`
  ```js
  function sessionVisible(session, current, archived) {
      return session.origin !== "subagent" && !archived.has(session.id) && (!session.blank || session.id === current);
  }
  ```
  并把 blank 行的标题本地化为"新建会话"（`:346-348`、`:611-613`）。
  扩展**计算了 `blank` 但从不用它**：`SessionSummaryView.blank`（`src/shared/chat.ts:232`）
  与 `controller.ts:566` 写入后，`src/webview` 里 grep `blank` 无任何匹配。
  用户可见后果：每次 `newSession`（`controller.ts:570-576` 立刻 `refreshSessions`）后，
  历史列表里会插入一条空标题会话，且不会像官方那样等它被使用后才出现。
  置信度：高（代码级确定该字段未被使用）。
- **一致（子代理会话过滤）**：官方 `session.origin !== "subagent"`（同上），扩展 `controller.ts:440`
  `.filter((item) => !item.origin && !item.parentSessionId)`。**一致**。
- **不一致（归档与工作区过滤）**：官方归档由 `archived` 集合控制（同 `:339`），
  扩展另有本地删除集合与 **cwd 过滤**（`controller.ts:439-445`：只显示 `cwd === 当前工作区` 的会话）。
  用户可见后果：其他 cwd 的会话在扩展里完全不可见（官方按工作区分组展示）。置信度：高（行为确定），
  是否符合扩展定位属设计判断。
- **不一致（列表顺序与 lastPromptAt）**：官方 `updatedAt = Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)`
  （`@dsh/dsh-api-session-controller/lib/types/list.js:284-286`），列表按 `updatedAt` 降序（`:122`）。
  扩展直接用 `item.updatedAt`（`controller.ts:563`），而服务端已经把 `lastPromptAt` 折进去了，
  所以**实际等价**；但扩展自己也从未读 `lastPromptAt`。视为**一致（经服务端折算）**。
- **无法确认**：官方工作区列表还有一个"活跃定时任务"指示（`@dsh/dsh-client-ui-workspace/lib/client.js:349-351`
  `hasActiveSchedule(session)` 读 `session.projectionValues?.schedule?.length`）与折叠条数上限
  （`:1291-1298`，`COLLAPSED_SESSION_LIMIT = 5`）。扩展两者都没有，但这两个是否算"官方用户可见的必要行为"
  取决于产品判断，我不将其列为严格不一致。

---

## 13. `inbox`（排队消息）与 steering 呈现

**关于任务描述的一处更正**：扩展**并不消费 `inbox` 投影**，`inbox` 键在 `applyProjection` 中没有 case。
`queued`/`steering`/`context` 的过滤发生在 **`session/control` 的 `queue` 帧**上
（`src/dsh/controller.ts:797-800` → `src/dsh/queueView.ts`）。

- 官方契约 `SessionQueuedItem`（`@dsh/dsh-api-session-controller/lib/types/types.d.ts:487-498`）：
  ```ts
  readonly placement: 'queued' | 'steering' | 'context';
  readonly rpcId?: SessionRequestId;
  readonly message: { readonly id: MessageId; readonly content: readonly JsonValue[] };
  ```
  与官方 `inbox` 投影（`@dsh/dsh-agent/lib/types/types.d.ts:25-50`：
  `{ 'next-turn': JsonValue[]; 'next-step': JsonValue[] }`）是**两个东西**：队列帧是投递前的权威快照，
  `inbox` 是持久化 splice 折出来的两段待投递列表。
- **一致（`context` 丢弃）**：`src/dsh/queueView.ts:54`
  ```ts
  if (item.placement !== "queued" && item.placement !== "steering") continue;
  ```
  官方两个呈现面都不渲染 `context`：QueueDock 只取 `queued`
  （`@dsh/dsh-client-ui-conversation/lib/client.js:14073`：`inbox.filter((row) => row.placement === "queued")`），
  steering 面只取 `steering`（`@dsh/dsh-client-ui-chat/lib/client.js:2114`）。
  **与官方一致**，`queueView.ts:3-11` 的注释描述也准确。
- **不一致 1（steering 的呈现位置与计数）**：官方把待投递的 steering 作为**对话流内联气泡**渲染：
  `@dsh/dsh-client-ui-chat/lib/client.js:2114`（`pendingSteering`）→ `:2557`
  ```js
  pendingSteering.map((item) => jsx(PendingSteeringBubble, { ... }))
  ```
  扩展把 `queued` 与 `steering` **合并成输入框上方的一条"排队中"状态条**：
  `src/webview/components/Composer.tsx:692-719`
  ```tsx
  if (state.queueItems.length > 0) {
    return (<div className="queue">
      <span className="queue-head">{fill(texts.queued, { n: state.queueItems.length })}</span>
      {state.queueItems.map((item) => ( ... ))}
  ```
  而且 `queueItems` 含 steering（`queueView.ts:54`），`src/webview` 里 grep `placement` **无任何匹配**
  → 界面从不区分两者。
  用户可见后果：插话消息在扩展里显示成"排队的用户消息"并计入"N 条排队中"，
  位置在输入框上方而不是它真正插入的对话位置；官方让它在流里出现在对应轮次。
  置信度：高。
- **不一致 2（用户消息 vs steering 的分类）**：官方按 inbox 认领集把 `user/message` 分成 `steering` 或 `user`：
  `@dsh/dsh-client-ui-chat/lib/client.js:6058-6076`
  ```js
  if (event.data.source.kind !== "user") return { kind: "context", ... provenance: contextProvenance(...), form: contextForm(...) };
  return reader.previous("inbox-next-step")?.state.currentClaimed.has(String(event.data.id)) === true
      ? { kind: "steering", messageId: event.data.id, ... }
      : { kind: "user", ... };
  ```
  扩展只有两分法：`source.kind` 为 `user`/`user-rpc` → 普通用户消息，其余 → `injected`
  （`src/dsh/adapter.ts:340-377`）。**扩展没有 steering 分类**（全仓 `src/dsh` 无 `steering`）。
  注意：`'user-rpc'` 是 `MessageSourceMap` 的**键**，其 `kind` 字段是 `'user'`
  （`@dsh/dsh-api-session-controller/lib/types/types.d.ts:346-354`），所以扩展的 `kind === "user-rpc"` 判断
  在线上不会命中，属多余分支——不构成可见差异，但说明该处基于误解。
  用户可见后果：历史里的插话消息与普通用户消息在扩展里完全同形，没有"插话"语义。
  置信度：高。

---

## 14. `context` 注入节点（durable 非用户消息）

**不一致（字段名与派生标签）**

- 官方节点 `ContextMessageNode`（`@dsh/dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:98-110`）：
  ```ts
  kind: 'context'; seq; time; content; source;
  provenance: ContextProvenanceView;   // { role: 'inject' | 'recall'; label: string | null }
  form: KnownContextForm | null;       // 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'
  ```
  派生逻辑在 `@dsh/dsh-client-ui-chat/lib/client.js:4203-4232`（`contextProvenance`：按
  `session-reference` / `agent-instructions` / `plugin` / `skill-invocation` 分派 role 与 label）
  与 `:4193-4197`（`contextForm`：读 `source.form` 并**校验**是否属于 6 个已知形态，未知→`null` 走不透明呈现）。
- 扩展：`src/dsh/adapter.ts:744-761`
  ```ts
  const origin = (source ?? {}) as { kind?: unknown; plugin?: unknown; form?: unknown };
  const injected: InjectedView = {
    sourceKind: typeof origin.kind === "string" ? origin.kind : "unknown",
    plugin: typeof origin.plugin === "string" ? origin.plugin : undefined,
    form: typeof origin.form === "string" ? origin.form : undefined,
    text,
  };
  ```
  `form` **不做白名单校验**（未知形态会被当成已知形态透传）；`role`/`label` 概念不存在，
  改为界面侧按 `sourceKind`/`plugin` 硬映射
  （`src/webview/components/Rows.tsx:206-231`，识别 `system` / `agent-instructions` / `skill-catalog` / `plugin`
  四个 kind + 一个 `@deepseek-ai/dsh-system-prompt` + `snapshot` 特例）。
- 用户可见后果：跨会话 recall（官方 `role: 'recall'`，label 是会话标题列表）与普通注入在扩展里
  同样显示为"自动载入"；未知的 `form` 会被原样显示成 detail 文本而不是"不透明"。置信度：高。

---

## 15. `present` 交付文件（deliverables）

**不一致（解析了但从不渲染；且缺少 produced 派生物）**

- 官方 wire 事件 `deliverables/presented`（`@dsh/dsh-tool-present/lib/types/types.d.ts`）：
  ```ts
  interface PresentedFile { path: string; description?: string }
  'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] };
  ```
- 官方面板展示 **两类**文件，挂在**轮次尾部**（turn tail）：
  `@dsh/dsh-client-ui-deliverables/lib/types/client/turn-deliverables.d.ts`
  ```ts
  export interface DeliverablesTurnData { readonly produced: readonly ProducedPath[]; readonly presented?: readonly PresentedPath[] }
  ```
  `produced` 的语义（同文件注释）：*"The source is the arguments of successful `write`, `edit`, and mutating
  `str_replace_editor` calls, not the closing prose: a produced file must be listed whether or not the model
  remembered to name it."*；选择器 `selectDeliverables(owner)`（`Deliverables.d.ts`）按**闭合轮次**认领。
- 扩展：
  - 解析正确但**没有消费者**：`src/dsh/adapter.ts:468-477`
    ```ts
    case "deliverables/presented": {
      const files = Array.isArray(data.files) ? data.files : [];
      const message = this.currentAssistantMessage() ?? this.ensureAssistantMessage(event.time);
      message.deliverables = files.map((file: any) => ({ path: String(file?.path ?? ""), description: ... }));
    ```
    `MessageView.deliverables`（`src/shared/chat.ts:213`）在全仓只被**写入**这一处：
    `grep '\.deliverables'` 在 `src/` 下唯一命中就是 `adapter.ts:471`。
    `src/webview/components/Message.tsx:56-99` 渲染 segments / error / 复制按钮，**不渲染 `deliverables`**。
  - 同族的 `ToolCallView.files`（`src/shared/chat.ts:113`）在 `Rows.tsx:142-155` 有渲染分支，
    但**从未被赋值**（`grep '\.files|files:'` 在 `adapter.ts` 只命中 468/471 两行的局部变量）。
  - 没有任何 `write`/`edit`/`str_replace_editor` 参数 → produced 路径的派生逻辑（`adapter.ts:150` 的注释只提到
    diff 预览，`grep -i produced` 全仓无匹配）。
  - 挂载位置也不同：扩展挂到"事件到达时的当前助手消息"（`adapter.ts:470`），官方按**轮的闭合尾**认领
    （`selectDeliverables(owner)` / `presentedForClosing`）。
- 用户可见后果：`present` 工具声明的文件在扩展里**完全不可见**（既无轮尾文件行，也无工具卡片上的文件芯片）；
  `write`/`edit` 产出的文件也不会有官方的"本轮产物"清单。置信度：高。
  （用户仍可在轨迹面板看到 `present` 工具行本身，但看不到被声明的路径清单。）

---

## 16. `schedule`

**不一致（完全丢弃）**

- 官方契约：`schedule: readonly ScheduleRecord[]`
  （`@dsh/dsh-schedule/lib/types/types.d.ts`，`ScheduleRecord = AfterScheduleRecord | AtScheduleRecord | EveryScheduleRecord`，
  含 `id/prompt/scheduledAt/state`），由 `schedule/change` 事件折叠。
- 官方两处用户可见：定时提醒目录 `@dsh/dsh-client-ui-schedule/lib/client.js:125`
  `const records = useProjection("schedule") ?? EMPTY_RECORDS;`；
  以及工作区列表的"有待触发提醒"指示 `@dsh/dsh-client-ui-workspace/lib/client.js:349-351`
  ```js
  function hasActiveSchedule(session) { return (session.projectionValues?.schedule?.length ?? 0) > 0 }
  ```
- 扩展：未消费（全仓无 `schedule` 标识符，除 `@dsh` 字符串外的 grep 命中为零）。
  用户可见后果：模型通过调度工具创建的提醒在扩展里没有任何入口可以查看。置信度：高。

---

## 17. `agentPreset`

**不一致（完全丢弃）**

- 官方：`agentPreset: string | null`（`@dsh/dsh-agent-presets/lib/types/types.d.ts:69-73`，投影定义见
  `session.d.ts` `agentPresetProjectionDefinition`），注释强调
  *"Reconstruction reads the `agentPreset` Session projection, never the header alone."*
- 官方 UI 读它：`@dsh/dsh-client-ui-agent-preset/lib/client.js:191`
  ```js
  const value = state.byId[sessionId]?.projectionValues?.agentPreset;
  ```
  （`AgentPresetLabel`），并有新会话的 `AgentPresetSeat` 选择入口。
- 扩展：`agentPreset` 只作为**声明过但未使用的字段**存在：
  `src/dsh/protocol.ts:54`（`header.agentPreset?`）、`src/dsh/client.ts:258`（`createSession` 返回类型）、
  `src/dsh/client.ts:412`（wire 类型）。`createSession` **不传** `agentPreset`
  （`client.ts:259-261` 只传 `cwd`/`sessionId`），也没有 `agent-preset/selected` 的消费
  （虽然它在 `RENDERED_EVENT_TYPES` 里，`protocol.ts:201`，但 `adapter.ts:299-503` 的 switch 没有该 case
  → 落到 `default` 且因为在渲染白名单里所以不报警）。
- 用户可见后果：用户无法看到当前会话运行在哪个 agent preset 下，也无法在新建时选择。置信度：高。

---

## 18. 投影消费的框架语义：seq 水位线

**不一致（官方按 seq 丢弃过期值，扩展不丢弃）**

- 官方：`@dsh/dsh-api-session-controller/lib/types/client/sessions/projection-store.js`
  - 帧应用 `:62-68`
    ```js
    apply(key, value, seq) {
        const row = this.rows.get(key);
        if (row !== undefined && seq <= row.seq) return;   // higher seq wins; replays and stale frames drop
        this.rows.set(key, { value, seq }); this.changed(key);
    }
    ```
  - 基线播种 `:77-91`：`this.apply(key, values[key], baseline.asOfSeq)`，并**清掉基线未携带、
    且 seq 不高于 asOfSeq 的键**（*"a key the block omits is capability-absent as of the cut"*）。
  - 世代替换 `:99-106` `truncate(lastSeq)`：丢掉高于新基线水位的行。
- 扩展：设计注释宣称有该规则但代码没有：
  `src/dsh/controller.ts:775-777`
  ```
  比客户端自己重放日志省事得多。每次重连以一个 `baseline` 开场，其后是逐条
  `projection` 增量；两者都按「seq 更小者不覆盖」的规则消费。
  ```
  实际实现：`controller.ts:807-809`
  ```ts
  if (frame.type === "projection" && frame.sessionId === this.currentSessionId) {
    this.applyProjection(String(frame.key ?? ""), frame.value);   // 完全没有读 frame.seq
  ```
  baseline 分支（`controller.ts:787-790`）与 follow snapshot 分支（`controller.ts:660-663`）
  同样只遍历 `values`，**从不读 `asOfSeq`**，也不清理缺失键。`seq` 字段虽在
  `src/dsh/protocol.ts:91` 声明，全仓未被使用。
- 用户可见后果：`session/follow` 的快照（带自己的 `asOfSeq` 切点）与 `session/control` 的实时
  projection 帧属于两条流，投递顺序无保证；快照先于某些帧到达后再被应用，会把更旧的 `permissions` /
  `plan` / `modelSelection` / `todos` / `contextBreakdown` / `goal` 写回界面，
  直到下一次同键变更才纠正。重连（新 baseline）也不会清掉基线里已消失的能力键。
  置信度：中高（代码级差异确定；触发需要具体的流交错时机，我无法在此环境实测）。

---

## 排序：真正重要的差异

1. **`goal` 双向失效** —— 契约是**嵌套**的 `{goal:{...}, roundsStarted, createdAt, updatedAt}`
   （`@dsh/dsh-goal/lib/types/types.d.ts:90-97`、`:113-120`；wire view `view: (state) => state.current`
   见 `@dsh/dsh-goal/lib/index.js:448-451`；官方 UI 读 `projection.goal`，
   `@dsh/dsh-client-ui-goal/lib/client.js:365-366`），扩展却按**扁平**读
   `{objective, phase, rounds, maxRounds}`（`src/dsh/controller.ts:968-985`），
   `goal?.objective` 恒为 undefined → `this.goal` 恒被清空；**而且** `src/webview` 里 grep `goal` 零命中，
   整个目标面板/条从未被渲染。两处叠加＝目标功能完全不可见。置信度：高。
2. **`subagentCatalog` 形状用错 + `mode` 硬编码** —— 在投影上按 `kind === "child"` 过滤
   （`controller.ts:951`）对 `SubagentCatalogEntry` 恒为空；`mode` 在两条路径都被丢弃，
   打开 `one-shot` 子代理固定发送 `mode: "continuable"`（`controller.ts:2025`），
   宿主 `identity.mode !== address.mode` 直接报 `subagent/unauthorized`
   （`@dsh/dsh-api-session-controller/lib/index.js:1593`）。置信度：高。
3. **交付文件（presented / produced）完全不可见** —— `adapter.ts:468-477` 写入的
   `message.deliverables` 在全仓唯一出现处就是写入行本身；`Message.tsx` 不渲染它，
   `ToolCallView.files` 有渲染分支但从未赋值；也没有官方那套"从 write/edit 参数派生本轮产物"的逻辑。置信度：高。
4. **上下文占用分子口径错** —— 官方 `projectedTokens ?? pressureTokens`（prompt 侧，不含 output，
   且含压缩后的 surface 增量），扩展用 `usage.totalTokens`（含 output）并丢弃 `projectedTokens`
   （`adapter.ts:550` vs `dsh-client-ui-conversation/lib/client.js:15329`）。占用条系统性偏高且对压缩无反应。置信度：高。
5. **`imageLimits` 未消费** —— 无张数/单图字节/总字节预校验，超限图片一路编码到发送才被拒。置信度：高。
6. **`permissions.options` 未消费 + `custom` 静默误显示** —— 硬编码三条
   （`Composer.tsx:23-41`），`currentValue === "custom"` 时回退成 `workspace-write`（`Composer.tsx:264`）。置信度：高。
7. **`tokenUsage` 未消费** —— 没有全会话累计用量/缓存命中率展示；扩展连"本轮聚合用量"也没有
   （`message.usage` 是最后一步，官方是整轮 attempt 聚合）。置信度：高。
8. **排队消息与插话的呈现混淆** —— steering 被并进"排队中"计数与位置（`Composer.tsx:694-718` +
   `queueView.ts:54`），官方把 steering 作为流内气泡（`dsh-client-ui-chat/lib/client.js:2114`、`:2557`），
   `QueueDock` 只显示 `queued`（`dsh-client-ui-conversation/lib/client.js:14073`）。
   另：扩展完全没有 `user/message → steering` 的分类（官方按 inbox 认领集判定）。置信度：高。
9. **投影 seq 水位线缺失** —— 注释宣称有，代码没有；过期快照可覆盖新值。置信度：中高。
10. **`turnOutline` / `schedule` / `agentPreset` / `subagentTiming` / `subagent` 未消费** ——
    分别缺失轮次导航轨、提醒目录与列表指示、preset 标签与选择、子代理运行时长、子代理身份。置信度：高。
11. **blank 会话列表策略** —— 扩展不用 `blank`，官方隐藏非当前的 blank 行并本地化标题。置信度：高。
12. **`sessionStats` 只在 tps 悬停标题里** —— 官方是常驻胶囊 + 对话框（含 turns/steps）；
    扩展在 `tps === undefined` 时连入口都没有。置信度：高。
13. **`jobs` 面板细节** —— 按钮常驻（官方无任务时不渲染）、无 live/idle 计数、`stopping` 用"运行中"蓝点
    而官方与 `killed` 共用 attention 色。置信度：高。
14. **模型目录的 `default`/`routableProviders`/`failures` 被丢弃** —— 默认模型改用设置命名空间推导，
    不可路由时无阻断提示。置信度：中高。

## 官方 UI 展示、扩展整项丢弃的投影

| 投影键 | 官方用途（证据） | 扩展 |
|---|---|---|
| `tokenUsage` | 会话累计用量胶囊 + 分桶对话框（`dsh-client-ui-chat/lib/client.js:4081`、`:4016`、`:4065-4072`） | 无 |
| `turnOutline` | 轮次导航轨（`dsh-client-ui-chat/lib/client.js:2076-2077`） | 无 |
| `imageLimits` | 附件入队前张数/大小校验与错误文案（`dsh-client-ui-conversation/lib/client.js:15923-15931`、`:15840`） | 无（改用设置里的模型模态） |
| `schedule` | 定时提醒目录（`dsh-client-ui-schedule/lib/client.js:125`）；工作区列表活跃提醒指示（`dsh-client-ui-workspace/lib/client.js:349-351`） | 无 |
| `agentPreset` | preset 标签（`dsh-client-ui-agent-preset/lib/client.js:191`）、新会话 preset 选择位 | 无（仅声明未用的字段） |
| `sessionListMetadata` | 冷会话列表的 `blank` / `lastPromptAt` 提示源（`dsh-api-session-controller/lib/types/list.js:63-67`、`:94`、`:284-286`） | 无（用服务端已折算的 `SessionSummary.blank`，但该字段本身在 webview 未被使用） |
| `inbox` | `next-step` 认领集用于把 `user/message` 分类为 steering（`dsh-client-ui-chat/lib/client.js:6058-6076`） | 无 |
| `subagentTiming` | 子代理面板的运行时长（`dsh-client-ui-subagent/lib/client.js:106-111`、`:288`） | 无 |
| `subagent` | 宿主地址模式校验（`dsh-api-session-controller/lib/index.js:1582-1593`）；官方 UI 侧会话身份 | 无（且因此把 `mode` 硬编码） |
| `permissions.options` | 权限菜单的选项集合/名称/描述（`dsh-client-ui-permission-presets/lib/client.js:407-420`） | 只读 `currentValue`，选项硬编码 |
| `contextPressure.pressureTokens` / `.projectedTokens` | 占用条分子（`dsh-client-ui-conversation/lib/client.js:15329`） | 不读（只读 `contextWindow`），分子自算 |
| `plan.pending` | 计划模式 chip 的有效目标态（`dsh-client-ui-plan/lib/client.js:30-45`；`dsh-client-ui-conversation/lib/client.js:15815`） | 不读（改用客户端乐观态） |

### 已确认**基本一致**的部分（便于对照，不必再查）

- `todos`（词表与 `null` 处理）、`sessionStats`（八字段语义）、`title`（`string|null` 与列表行取值）、
  `modelSelection`（`next ?? lastUsed` 选择值）、`jobs`（`SessionJob` 五态词表与字段名）、
  `contextBreakdown`（三字段名与"不求和"口径）、
  `queued`/`steering`/`context` 三种 placement 的**丢弃 `context`** 这一条、
  以及控制帧 `baseline`/`queue`/`jobs`/`projection` 的帧类型与 `Record<SessionId, ...>` 取值路径
  （`dsh-api-session-controller/lib/types/types.d.ts:509-536` vs `src/dsh/controller.ts:782-810`）。

### 明确**无法确认**的事项

- 官方工作区列表渲染器对 `depth`（谱系缩进）与 `completed`（完成提醒）的具体呈现：
  我确认了 `flattenLineage` 产出 `depth`/`completed`
  （`@dsh/dsh-api-session-controller/lib/types/client/sessions/lineage.js:36-40`、
  `client.js:2893-2902`）与 `sessionVisible` 的可见性规则，但**没有**在已安装产物里定位到消费
  `depth`/`completed` 的渲染代码（`dsh-client-ui-*` 各包 grep 无命中），因此不对其呈现细节下结论。
- 扩展所在部署的 `permission-presets.presets` 实际配置（`@dsh/dsh-permission-presets/lib/index.js:76-95`
  只是 schema 默认值），因此"`read-only` 是否真的不存在于该部署"无法确认；
  可确认的是扩展**永不读取** `options`，所以显示必然与宿主配置解耦。
- `contextPressure.contextWindow` 与扩展 `request/context` 分母在真实会话中的分歧频率（静态代码无法判定）。
