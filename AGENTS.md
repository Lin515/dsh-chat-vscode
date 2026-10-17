# 项目 AI 约定（DSH Chat）

本文件约束本仓库的 AI 会话，项目约定优先于用户级约定。改动前先读；与约定冲突时先问用户。

## 中英双语

新增或修改用户可见文字，必须同时提供中文与英文。开发者日志与内部技术文档使用中文，标识符使用英文。

| 载体 | 语言来源 | 登记位置 |
|---|---|---|
| webview 界面 | `dshChat.language`；`auto` 跟随 VS Code 显示语言 | `src/webview/messages.ts` 的 `MESSAGES`，词典由 `texts.ts` 派生 |
| VS Code 命令与配置说明 | VS Code 显示语言 | `package.nls.json` / `package.nls.zh-cn.json`；清单使用 `%key%` |
| VS Code 原生通知 | VS Code 显示语言 | `vscode.l10n.t(...)` 与 `l10n/bundle.l10n.zh-cn.json`；清单保留 `"l10n": "./l10n"` |
| 宿主发给 webview 的文案 | webview 解析 | 发送 `@key` 或 `@key:arg`，不写死中文 |

- `MESSAGES` 的条目必须有 `zh` / `en`；带参数用函数，不拼接句子。`DerivedDictionary` 检查 `Texts` 成员完整性，`scripts/i18n.test.ts` 检查登记表、宿主发射点和两层 VS Code 译文。
- `resolveText()` 只翻译 `@` 标记；模型与服务端的原始文本不翻译。标记必须有登记与实际发射点，不保留死文案。可能进入原生通知的条目标 `vscode: true`，必要时用 `l10n:` 指定占位符，由 `hostText.ts` 与 bundle 对齐。
- 配置说明只写作用与特殊值效果，不写实现历史、通用重载提示或 `**` 加粗。
- 布局须容纳英文：按钮、胶囊与标签使用 `white-space: nowrap` 和 `text-overflow: ellipsis`，用 flex/grid，不按中文字数或固定宽度布局。界面改动用 `npm run preview` 检查窄侧栏。

## 官方契约与兼容

本扩展自绘界面，但能力与数据语义须与官方 `dsh web` 一致。

- 协议改动先读[服务端契约](<docs/dsh-server-api.md>)，再按[技术文档导航](<docs/README.md>)选择对应主题的消费规则与边界，核对目标版本 API 包的 `lib/types/**/*.d.ts`、`lib/client.js`。不猜载荷形状；需要实测时遵守「构建与验证」的批准要求。
- 投影的已提交值与 `pending` / `wanted` 待提交值须组合解读，例如 plan 为 `pending ? !active : active`。线格式与视图模型不可混用：`toUsage` 读取 `cacheReadTokens`，不是视图字段 `cachedTokens`。
- 官方版本、渠道、发布去向与兼容层统一登记在 `docs/dsh-compat.md`。新版先跑 `npm run dsh:watch`，再逐版 `npm run dsh:check -- <版本>`。差异处理完成后才推进基准；涉及发布的用户可见变化写入该版 CHANGELOG，不另建文档台账。
- P0 是消费面的端点、事件或类型被删除、改名或改变形状，必须处理；只有 P2 时不改代码、不发版；P1 是否跟进是产品决策。兼容分支采用新名优先并记住可用名，或双读且新通道权威。
- 每条兼容层登记起算日与两个月后的移除期限。`dsh:watch` 提示到期后，确认再删；不得因到期自动删除。

## 构建与验证

常规改动运行 `npm run typecheck`、`npm test`、`npm run build`，不启动真实 DSH、不发送真实消息。

- **未经用户当次明确批准，禁止运行消耗模型 token 的 smoke、探针或 e2e。** 即使用户要求验证，默认也只跑上述三项。需要重验证时先说明脚本、必要性与预计耗时；一次批准只对应一次运行。
- 连接链路改动才考虑 `npm run smoke`；plan / goal / subagent / 工具行 / 队列 / 投影契约改动才考虑对应探针，获批后改前、改后取基线。`command-e2e` 可用于 plan / goal / subagent / 工具行基线。纯界面、文案、样式不跑这些探针。
- 探针定位以文件头为准；`supervisorProbeEnv.ts` 提供一次性隔离环境。长探针须留足前台超时。
- 新增测试登记到 `esbuild.scripts.mjs` 的 `entries`，否则 `npm test` 不执行。检查构建中的 `[duplicate-case]` 与重复键警告，类型检查不能覆盖它们。
- **走文件系统解析的夹具路径必须按宿主平台算绝对**（用 `join(tmpdir(), …)` 拼），不能写死 Windows 形态：`node:path` 的 `isAbsolute` 是平台相关的，`C:\…` 在 Linux 上会被当成相对路径。只做字符串断言（分隔符清洗之类）的夹具不受此限。
- 界面预览夹具须来自真实输出。跨宿主与 webview 的改动须同时更新 `dist/extension.js` 与 `dist/webview.js`；需要安装验收时用 `npm run package` 和 `npm run install:vsix`，核对两份产物均已更新。
- 发布包采用 `package.json` 的 `files` 白名单，不与 `.vscodeignore` 共存。新增发布资源须入白名单，包括更新日志、许可证、译文与第三方声明；`scripts/manifest.test.ts` 检查资源覆盖。

## 实现边界

- `autoConnect` 只限制自动路径；用户显式发送、新建、切会话、启动、连接或重启内部 DSH 均可启动后台。「启动内部」与「连接内部」同一逻辑，有则连接、无则启动；连接外部不启动进程。自动路径不切换粘性目标。
- 认证按 `ownership === "external"` 分叉，peer 窗口也用会合令牌换 cookie。连接条区分 `stopped` 按钮态、需用户动作的 `error` 与持续重试的 `connecting`。选路见 `connectTarget.chooseTarget`，完整规则见 `docs/design-supervisor.md`。
- JSON 帧清空字段必须发 `null`，不能发会被序列化丢弃的 `undefined`；宿主 `jsonSafeFrame` 与界面 `mergeWirePatch` 配套，见 `src/shared/wire.ts` 和 `scripts/wire.test.ts`。
- 一条交互链只暴露一个端口对象，合并容器 ref 与动作；参考 `AutoScrollPort`。不要拆成多个 prop 后分散维护规则。
- 本地图片解析回帧之前的加载失败不能触发最终降级；见 `hydrateLocalImages` 与 `scripts/imageHydrate.test.ts`。
- 附件的 base64 只在需要它的地方过线：草稿列表的整份下发剥掉 `dataUrl`（`withoutAttachmentDataUrls`，芯片不读它），`send` 帧不带附件、发送取宿主账本（`attachments.list`），粘贴编码走 `FileReader`。界面与宿主是两条 IPC，几 MB 的字符串来回搬运会直接变成用户可感知的等待。
- 进不了内容块的**图片**一律**改按文件上传**（附件变文件、立即上传），**不**用正文里的 `@` 引用当退路：引用依赖「执行世界能读到本地路径」，远端部署下是空头支票；上传副本还按 sha256 去重、且是快照。提示只报上限（像素按「6400万」这类缩写，不报实测像素数），并照实说副本能不能被模型直接读：逐图超限（内联字节 / 像素 / 单边）的副本模型也得先缩小，整批超限（张数 / 总字节）的副本可直接读。
- CSS 同特异性遵循后者覆盖前者；样式改动为同语义元素补一致性断言，例如活性指示器动画开关。
- 文档和注释引用栏目名、函数名，不用节号或行号；不写本机专属路径。源码目录按层建立 README，只说明本目录文件与直属子目录；根目录导航放本文件，根 README 面向用户。目录级 README 管清点与职责；**只有当该目录存在「动手前就必须知道的约束」时才另建目录级 `AGENTS.md`**，它会被常驻注入，因此保持短小，不把文件清点搬进去。

## 安全

- 执行命令或决定凭据去向的配置必须是 `machine` 作用域，禁止工作区覆盖；当前包括 `dshChat.command` 与 `dshChat.url`，由 `scripts/invariants.test.ts` 检查。
- 外部输入逐字段验形状。删除会话目录同时检查 `isSafeSessionId` 与解析后的路径包含性；socket 状态由 `decodeServerMessage` 的 `checkState` 校验。
- 进程操作只依据肯定证据（`=== true`）。端口清理先确认 `looksLikeDsh`，孤儿锁与 PID 复用同样验证身份；证据不足不操作。进程查询异步，避免同步调用阻塞扩展宿主。
- 行缓冲必须有上限，超限断开；会话或事件索引的 Map 必须有清理路径。展示日志先经 `redactSecrets`，包括含启动令牌的 DSH stdout。
- `ensure()` / `bringUp()` 等启动入口须幂等并合并并发调用，避免遗失重复启动的进程。

## 协作与发布

- 并行编辑先划定文件所有权，同一文件仅一个写入者。
- 完成声明附文件位置或断言名。断言只固定确定事实；不稳定的探针分布作为观察报告，不写硬断言。注入式验证先读回确认注入生效。
- `CHANGELOG.md` 仅在更新版本号时修改：汇总上次发布后的最终用户可见效果，每条一句，不写实现字段、函数、配置键或个人环境例子。涉及官方对齐时注明 DSH 版本。
- 发布：标题 `## <版本>（日期）`，`npm version x.y.z --no-git-tag-version`，验证三项，再打 `git tag -a v<x.y.z>`（发版口径：版本号、CHANGELOG 与 tag 三者一起到位）。推 tag 触发 `.github/workflows/release.yml`，校验版本、验证、打包并发布 GitHub Release；含 `-` 的 tag 为预发布。商店仍手动发布，以官方 npm `latest` 为对齐基准。

## 根目录导航

| 入口 | 用途 |
|---|---|
| `README.md` | 中英文安装、连接、配置与功能说明 |
| `CONTEXT.md` | 项目领域词表 |
| `ToDo.md` | 尚未处理或待复现的问题 |
| `CHANGELOG.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md` | 发布记录、许可证与来源披露 |
| `package.json`、`package-lock.json` | 扩展清单、命令与依赖锁定 |
| `package.nls*.json`、`l10n/` | VS Code 原生文案与翻译 |
| `esbuild.mjs`、`esbuild.scripts.mjs` | 扩展和离线脚本构建入口 |
| `tsconfig*.json` | 宿主、webview 与脚本的类型检查范围 |
| `src/`、`scripts/`、`test/` | 源码、工具与测试夹具；各目录 README 提供分层导航 |
| `docs/` | 长期主题设计、契约、兼容与验证边界；入口见[文档导航](<docs/README.md>) |
| `media/`、`.vscode/`、`.github/` | 品牌资源、调试配置与发布流程 |
| `.agent/` | 临时脚本、报告与任务材料，不作为长期文档 |
