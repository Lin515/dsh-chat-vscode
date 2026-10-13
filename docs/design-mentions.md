# 引用补全：查询、抑制与候选交接

修改 `@` 触发、目录导航、文件 / 会话候选或 `/` 菜单查询前读本文。引用的提交表示见[附件设计](<design-attachments.md>)，平台路径与显示安全见[消息设计](<design-messages.md>)及[安全边界](<design-security.md>)。

## 查询块与浏览入口

光标所在 `@` 内容块由 `findTrigger` / `mentionBlockAt` 判定，查询串取整块，不能随光标在块内的位置变化。普通片段（如 `@web`、裸会话 id）仍可检索会话；候选由服务端按 id / cwd / 标题作大小写不敏感的子串匹配。

裸 `@` 与以 `/` 或 `\` 结尾的路径是浏览入口，恒可展开；目录不存在时显示空表，而不是阻止打开。判据唯一来源为 `shared/mentions.ts` 的 `isBrowseQuery`，宿主和界面共用，不能各维护一份正则。

## 已解析引用抑制补全

普通块是否弹列表由宿主 `controller.mentionResolves` 判断“整块是否已能引用到有效内容”，不是只猜文本形状：

| 内容 | 判据 |
|---|---|
| 文件 / 不带尾分隔符的目录 | 去掉行号区间后 stat；绝对路径原样，相对路径按会话 cwd 解析 |
| `[标题](dsh-session:…)` 或裸 `dsh-session:…` | 解出会话 id，并检查 `this.sessions` |
| 裸 `session-…` id | 不是服务端认可的引用 token，仍属会话检索 |
| 无 cwd、解析失败或未知 stat 错误 | 没有肯定证据，不抑制 |

文件被删 / 改名后可以再次弹出候选。已有目录 `@src` 被抑制，浏览它须写 `@src/`。选中会话插入规范 token `@[标题](dsh-session:…)`。

判定随 `files/list` 的同批 `query` 与 `resolved` 返回。可抑制块不发服务端候选查询，直接回空帧；界面 `mentionSuppressed` 在判定到达前先不弹，避免进入已有引用时闪列表，浏览入口不等待判定。旧宿主不发 `resolved` 时按 false 收，只多弹、不误阻断。

焦点重新进入输入框视为新编辑动作：`onFocus` 清除 ESC / 选中后“已关闭”的记忆并重算触发词。记忆以文本、光标匹配，只依赖文本或光标改变会让原位置重新聚焦永远不弹。

### 关键决策与取舍

只开放裸 `@` 与目录块虽然能避免已有引用弹列表，也会同时禁掉会话 id / 名字片段检索。两种需求无法单靠形状区分，因此保留普通块触发，以宿主的有效内容证据作抑制。未知证据宁可多弹，普通片段重新开启模糊查询是这项选择的结果，不应顺手禁掉。

抑制块可直接回帧；未抑制块需等待查询判定，接受短暂延迟以避免闪烁。官方文件索引仅首次遍历工作区，之后可由陈旧索引当场作答，不把首次成本推广到每次查询。

## 文件先发、会话候选后到

文件候选调用 `fileReferences/list`，会话候选调用 `sessionReferenceResolver/candidates`。后者须扫描项目与会话日志头，显著慢于目录读取；既有 339 条会话样本中，目录约 0.1ms、会话检索超过 130ms。该观察解释分帧选择，不是当前性能保证。

- 两个 RPC 并行发起，`files/list` 先发文件，`files/sessions` 随后独立发会话，两帧都带 query。只串发帧顺序，不串 RPC。
- 界面 `files/list` 只换文件部分，旧会话候选按 stale-while-revalidate 暂留；`files/sessions.query` 与当前查询不符就整帧丢弃。
- `controller.menuQueries` 每次查询作废上一句柄，兼作取消入口与当前批次判据；窗口下线时作废并清表。网关将客户端断开传给请求 signal，服务端扫描可逐步中止，因此取消不只是丢弃结果。
- `composerCompletion.tsx` 的查询串 effect 独占 `@` 重取；导航与选中不另发查询。`/` 目录只在命令通道打开时取一次，查询串过滤在本地做。

### 关键决策与取舍

- 不用 `Promise.all` 等两源一起返回，避免快速文件候选被慢会话扫描阻塞。
- 取消旧 RPC 与界面 query 拒旧帧两道防线都保留：取消不能保证已经在途的帧不会迟到。
- 会话候选有意只在工作区根目录列，偏离官方按查询串在目录内继续筛历史会话的行为。查询串出现分隔符时，宿主连查都不查；界面 `rankCandidates` 的 `isDirectoryQuery` 同步隐藏该组，不等待往返。
- 根目录暂留旧会话候选，避免列表先塌再长；进入目录后整组不可见。目录查询不发 `files/sessions`，状态可保留上一次根目录结果，返回根目录时先显示旧结果再替换。
- 若恢复官方目录内检索，须同时移除宿主与界面判据；不能只改一侧。

## 实现与回归

入口为 controller 的 menuQueries / mentionResolves、`shared/mentions.ts`、`composerCompletion.tsx` 与 IPC 的 files/list / files/sessions。回归见 mentionCandidates 与 mentionNav，覆盖过期批次、目录判据、整块查询、有效引用抑制、未知证据放行与焦点重开；宿主 / webview 帧改动须双端构建。
