# src/vendor/ui-trajectory/ — 轨迹包的纯决策模块

上游 `@deepseek-ai/dsh-client-ui-trajectory@0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`）
的源码副本。来源、版本与同步流程见 [../README.md](../README.md)；改写约束见 [../AGENTS.md](../AGENTS.md)。

搬的**只有纯决策**：官方整包（`TrajectoryTable.tsx` 3500+ 行、`TrajectoryView.tsx`、
`layout.ts`）搬不动，因为它们的输入是 `ui-conversation` 折出来的 `TrajectorySnapshot`，
我们没有那一层（详见 `docs/design-trajectory.md` 的「完美搬运的可行边界」）。

| 文件 | 上游对应 | 作用 | 本仓库的改动 |
|---|---|---|---|
| `trajectory-preview.ts` | 同名文件 | 有界的一行预览：取前 2048 字符 → 去 Markdown 记号 → 压平空白 → 截到 512 + `…` | import 指向同仓库的 vendor 副本 |
| `plain-text.ts` | 同名文件（`ui-primitives/markdown/`） | mdast 树 → 纯文本（剥记号、留 alt/标签/代码源文本、裸 HTML 原样） | 见 `ui-primitives/markdown/README.md` |
| `trajectory-record.ts` | 同名文件 | `trajectoryRecordId()` 稳定身份 + 两个时长格式化 | 类型壳抽掉 React / 附件 / conversation / locales 依赖；**函数体逐字相同** |
| `timeline.ts` | 同名文件 | 时间线四模式投影、轮次边界、选区命中 | import 指向 `./trajectory-turn-model` 与去掉 `.ts` 后缀 |
| `trajectory-turn-model.ts` | `layout.ts` 的**类型摘录** | `TrajectoryTurnModel` / `TrajectoryGroupModel`（只有接口，没有实现体） | 无（逐字） |
| `trajectory-search-index.ts` | 同名文件 | 增量全文索引：字段表、分词 AND、`recordId` 身份、`requestOnly` 不索引 | import 指向 `./trajectory-turn-model` 与去掉 `.ts` 后缀 |
| `inbox-state.ts` | `trajectory-message-definitions.ts` 的 `trajectory-inbox-next-step` **状态机** | 「哪些 `user/message` 是 steering」：`pending` splice 链 + `currentClaimed` 集合 | 参数类型从 `ConversationPreviousContext<InboxState>` 换成 `InboxState \| undefined`（我们没有节点装配层）；**函数体逐字相同** |
| `code-program.ts` | 同名文件 | PTC（`run_code`）的**代码程序**：从录制的参数与调用时 schema 里读出源码、描述与语言 | 去掉 `.ts` import 后缀；**函数体与常量逐字相同** |

## 消费方

- `src/webview/trajectoryDisplay.ts` — 行的显示文本与结果文本（预览投影的唯一出处）、
  PTC 行文本（`trajectoryCodeProgram()` / 程序描述）。
- `src/webview/trajectoryTimeline.ts` — 时间线（官方投影 + 归一化到 0..1）。
- `src/webview/trajectoryVendor.ts` — 账本 → 官方形状的适配层 + `trajectoryCellRecordId`。
- `src/webview/components/Trajectory.tsx` — 搜索索引的宿主（节流 3 秒重建）、检查器里
  PTC 的「代码」那一格（源码 + 语言标记 + 描述）。

## 没有搬的（都在 `docs/design-trajectory.md` 的差距清单里）

- `layout.ts` 的实现体（账本 turn → group → cell 折叠）：它的输入是 `TrajectorySnapshot`，
  我们没有那一层，**在自己的折叠层里按同一套口径折**（组标题 / steering 摆放 / 折叠摘要
  步骤数三处对齐，见 `docs/design-trajectory.md`）。
- 官方那四个**无人 import 的组件**（`TrajectoryGroupHeader` / `TrajectoryTurn` /
  `TrajectoryTurnHeader` / `TrajectoryCell`）：上游自己也没渲染它们，组头行与轮次表头四列
  在官方界面上**不存在**，所以不搬。
- 官方的**流式助手行**（`PartialAssistant`）：本扩展刻意不出（叠加层语义不同，映射错会重复行）。
- `TrajectoryTable.tsx` 的渲染与虚拟化、`locales.ts` 的 175 个 key
  （我们的文案表是 `src/webview/trajectoryTexts.ts`）。
