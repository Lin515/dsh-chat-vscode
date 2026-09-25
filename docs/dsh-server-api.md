# DSH 本地服务器 API 参考（供第三方客户端 / VS Code 扩展使用）

> 目标版本：**`@deepseek-ai/dsh` 0.1.5-rc.1**（`dsh --version` 输出 `0.1.5-rc.1`）
>
> **版本追踪**：本文是某一版的逐字摘录，会随官方发版而落后。官方发新版后怎么核对、怎么判定
> 影响面、怎么决定发扩展商店还是只发 GitHub，见 `docs/dsh-compat.md`（含 `npm run dsh:watch` /
> `dsh:check` 两个命令、当前对齐基准与兼容层登记）。本文点名的类型名也算作本扩展的消费面。
>
> 依据：官方 npm 包 `@deepseek-ai/dsh`（含约 239 个 `@deepseek-ai/dsh-*` 子包）的安装产物，
> 以及对一个运行中服务器的只读探测（`GET /`、`GET /favicon.svg`、`HEAD /assets/*.js`）。
> 交叉验证：[DeepSeek-Harness-for-VS-Code](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code)
> 的 `src/dsh/apiClient.ts`（已跑通的第三方实现，MIT）。
>
> **路径简写**（下文一律使用）：
> - `⟨D⟩` = 全局安装的 `@deepseek-ai/dsh` 包根目录
>   （`npm root -g`/`@deepseek-ai/dsh`，例如 `$(npm root -g)/@deepseek-ai/dsh`）
> - `⟨P⟩` = `⟨D⟩/node_modules/@deepseek-ai`
> - `⟨W⟩` = `DeepSeek-Harness-for-VS-Code` 仓库根（`src/dsh/apiClient.ts` 所在处）
>
> 行号取自安装产物的**打包后文件**（`lib/*.js` / `lib/types/*.d.ts`），换版本后行号会漂移，
> 但符号名（函数名 / 类型名 / 端点名）稳定，可直接 grep 复核。

---

## 0. TL;DR —— 契约速查

| 项目 | 结论 |
|---|---|
| 传输 | **HTTP POST（一元 RPC）+ 单条 WebSocket（多路复用流）**。无 SSE、无轮询。 |
| 一元端点 | `POST http://<host>:<port>/api/<namespace>/<method>`，`content-type: application/json` |
| 流端点 | `WS ws://<host>:<port>/api/remote.mux`，文本帧 JSON，逻辑流多路复用 |
| 鉴权 | 浏览器 cookie（`dsh-auth-<sha256(authority) base64url>`），由 `GET /?token=<启动令牌>` 换取；**没有 Authorization 头、没有 query token 二次使用** |
| 握手 | 启动令牌由 `dsh web` 打印在 `dsh web: http://127.0.0.1:PORT/?token=...` 这一行 |
| 编解码 | JSON（不是行分隔；WebSocket 一帧一条 JSON 消息） |
| 请求信封 | `{type:'client-request', rpcId, method, payload:{args:{...}}}` |
| 响应信封 | `{type:'server-response', rpcId, result:{ok:true,value} \| {ok:false,error:{code,message,details}}}` |
| 流帧 | `{type:'open'\|'cancel', streamId, endpoint, payload}`（C→S）；`{type:'item'\|'end'\|'error', streamId, ...}`（S→C） |
| 审批/提问 | 唯一的人机交互通道是 `$events` 逻辑流上的 `waterfall` 帧；回复走 `POST /api/$events/result` |
| 版本协商 | **没有**。协议无 version 字段，只有持久化日志的 `SESSION_FORMAT_VERSION`（本文摘录时是 3，0.1.6 起是 4） |

---

## 0.5 后续版本的契约变更（本文正文按 0.1.5-rc.1 摘抄）

正文与下文各节写的是 0.1.5-rc.1 的形状；本扩展已经在跟后面几版，这里是**改掉的部分**。
本扩展当前对齐到哪一版、以及每条兼容代码的登记与退役期限，见 `docs/dsh-compat.md`。
读下面任何一节时先扫一眼这张清单。

- **后台任务换了通道**（0.1.7-alpha.1）：`session/control` 的 `jobs` 字段与 `type:'jobs'` 增量帧
  删除（`SessionJob` 类型同去），改由 `@deepseek-ai/dsh-api-job-controller` 的 `job` 命名空间承载：
  `job/list`（流，逐帧整表替换 `{type:'rows', jobs: JobView[]}`）、`job/follow`（流，单任务输出、
  以 `status` 帧收尾）、`job/kill`（一元，人的停止请求，参数 `{sessionId, jobId}`）。请求体一律
  `{request: {…}}`。
- **消息来源不再有通用 `plugin` 成员**（0.1.7-alpha.1）：每个生产者声明自己的 kind ——
  `user` / `model` / `tool` / `system-prompt` / `runtime-context` / `agent-instructions` /
  `skill-catalog` / `skill-invocation` / `session-reference` / `compact-checkpoint` / `ptc-mode` /
  `tool-jobs` / `goal` / `webhook` / `team-message` / `agent-message` / `subagent-report` /
  `subagent-settled` / `coordinator` / `dsh-session-title-llm`；第三方插件落成 `plugin:<包名>`。
  durable 消息的 `source` 必须是对象、`kind` 非空且**不等于 `plugin`**，否则服务端拒绝写入
  （`format v4 message requires a producer-owned source kind`）；系统提示词插件的旧形态
  （`{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt'}`）被拆成 role `system` 的
  `system-prompt` 与 role `user` 的 `runtime-context`。`form` 仍是 `ContextForm`
  （instructions / catalog / snapshot / notice / relay / recall）。
- **工具结果改成一等消息**（0.1.7-alpha.1）：`ToolResultMessage =
  {role:'tool', source:{kind:'tool', callId}, toolCallId, content: ContentBlock[], isError?}`，
  `tool/result` 事件是 `{turn, step, message, error?, meta?}`（`error` 只在 `isError` 为真时出现）。
  内容块里的 `tool-result` 信封被删除（V3→V4 迁移会把历史日志抬升成新消息，新格式下再出现它
  会被判退役语法）；新增的 `tool-addition` / `tool-removal` 属于 `role:'developer'` 消息，
  官方标注「生产者与消费者一起实现之前不产生」。
- **新增 durable 事件 `developer/message`**（`{turn, step, message, headerSeq?}`，role `developer`）。
- **`subagents/list` 端点删除**（0.1.7-alpha.1，`SubagentCatalog` / `SubagentListEntry` 类型同去）：
  子代理目录由 `subagentCatalog` 投影（`{id, createdAt, mode, label?}`，`mode` 多一个 `unknown`）
  与 `subagent/catalog` durable 事件承载，端点只剩 `subagents/prompt` /
  `subagents/interruptByParent`。
- **预设端点随包改名**：`agentPresets/*` 从 `@deepseek-ai/dsh-agent-presets` 迁到
  `@deepseek-ai/dsh-agent-preset-registry`（端点名与参数未变），0.1.7-rc.1 另加
  `agentPresets/read`。
- **`SessionSummary`**：`completed` 删除、新增 `retainedBy`；`session/control` 的 baseline 不再带
  `queues`（0.1.6-alpha.2 起）与 `jobs`（0.1.7-alpha.1 起）——两者分别由 `inbox` 投影与
  `job/list` 流承载。
- **预设 roster 不再带选择策略**（0.1.7-rc.2）：`AgentPresetRoster` 只剩 `presets`，
  `modeSelectionEnabled` 删除（注册表插件配置里的同名字段一并删掉，存量的 profile patch 值变成
  惰性数据、既不读也不重写）。**选择可见性搬到了客户端**：官方前端用「代码工作工具」开关
  （rc.2 之前的界面名是「开发者工具」，内部标识是宿主持久化命名空间 `ui-settings` 的 `enabled`，
  schema 默认 `true`）决定要不要显示新会话的预设选择入口；服务端的 `defaultId` 不再受该开关
  影响，恒为 `selectedDefault ?? default`。
- **审批请求多了本地化展示文案**（0.1.7-rc.2）：`ApprovalRequestEvent.displayReason` =
  `{en: string, [locale]: string}`，**只用于展示、不落审计**（审计里仍是英文的 `reason`）。
  官方界面「有它就用它、没有才用 `reason`」。
- **新增端点 `session/initializeDefaultModel`**（0.1.7-rc.2，未消费）；**`workspace/initializeDefault`
  改成无参**——它原来收一个请求体对象（里面那个 `request` 参数的形状）连同其类型名一起删除
  （未消费）。

---

## 1. 启动与连接

### 1.1 `dsh web` 命令行

`dsh` 本身是「profile 启动器」，`dsh web` 是 `--profile web` 的别名（`⟨D⟩\lib\bin.js`，`dsh --help` 实测输出）。

```
dsh web [options] [args...]
  --host <host>          绑定地址（默认 127.0.0.1）
  --port <port>          端口；0 表示由 OS 分配（默认 3080）
  --no-open              启动后不自动打开浏览器
  --trusted-host <authority...>   额外的 /api 信任 authority（host 或 host:port，可重复）
  -h, --help
```

> 选项清单**取自源码而非 `dsh web --help` 输出**：commander 选项定义在
> `⟨P⟩\dsh-web-app\lib\startup.js:31-44`（`webCommand()`，与运行时同源，故可信），但**未做
> 命令行实测**——在受限沙箱里 `dsh web --help` 会在 profile 准备阶段以
> `EPERM: operation not permitted, open '<用户 home>/.dsh/profiles/web/cordis.yml'` 退出
> （沙箱禁止写用户 home），拿不到帮助文本；普通终端里可正常输出。

约束（`⟨P⟩\dsh-web-app\lib\startup.js:47-56`）：

- `--host 0.0.0.0` **被显式拒绝**，错误信息：`error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`。
- `--port` 必须是纯数字：`error: --port must be a number, got ${JSON.stringify(options.port)}`。

默认值来自 profile 补丁层 `⟨P⟩\dsh-web-app\cordis.patch.yml:135-141`：`webserver` 条目里
`host: ctx.webStartup.host ?? '127.0.0.1'`、`port: ctx.webStartup.port ?? 3080`。
**用户 profile 可以覆盖端口**——`<用户 home>/.dsh/profiles/web/cordis.patch.yml` 里若写了
`port: !!js ctx.webStartup.port ?? <其他端口>`，默认端口就会被改掉（某些部署还会顺便调大
`cookieMaxAgeDays`）。**第三方扩展不要硬编码 3080**，必须从启动日志解析实际端口。

**没有 `--print-url` 开关**，但 URL 行总是打印（`printUrl: true` 硬编码在补丁里，见
`⟨P⟩\dsh-web-app\cordis.patch.yml:159`；打印实现在 `⟨P⟩\dsh-web-app\lib\index.js:198-203`，
形如 `console.log(\`dsh web: ${authenticatedUrl}${lanUrl === void 0 ? "" : \` (LAN: ${lanUrl})\`}\`)`）。
期望输出形如（**由源码推导**——外部启动的实例拿不到 stdout，故未做端到端实测）：

```
dsh web: http://127.0.0.1:20000/?token=<43 字符 base64url>
dsh web: opening the default browser; pass --no-open to disable
```

第二行只在 `openBrowser` 为真时出现；加 `--no-open` 就没有。解析正则建议宽松些：`/^dsh web: (http:\/\/\S+?)\/\?token=([A-Za-z0-9_-]+)/`（LAN 变体在同一行以 ` (LAN: ...)` 结尾，不会影响该正则）。

### 1.2 从外部程序最小代价启动一个可连接的服务器

推荐做法（也是第三方扩展已在用的做法）：

1. 用 `child_process.spawn` 启动 `dsh web --no-open`（`--no-open` 避免弹浏览器；扩展自己也不需要页面）。
2. **stdout/stderr 逐行扫描**，正则取 token：
   `^dsh web: (http://[^\s]+)\?token=([A-Za-z0-9_-]+)`
3. 用该 URL 做一次 `GET /?token=...`（`redirect: 'manual'`）拿 `set-cookie` 的 `dsh-auth-*`，后续所有 HTTP/WS 请求带上。
4. **不要**自己另起一个服务进程去连另一个已在跑的实例——启动令牌是**进程级**的（见 1.4），跨进程拿不到。

判定「服务器就绪」的三种方式，按可靠性排序：

| 方式 | 做法 | 说明 |
|---|---|---|
| A（推荐） | 扫 stdout 的 `dsh web: <url>?token=` | 这是**唯一**能拿到启动令牌的途径，出现在 webserver 绑定成功后 |
| B | TCP 连接 `127.0.0.1:<port>` 成功 | 只证明端口被占，不证明是 DSH |
| C | `POST /api/session/list`，读 `result.ok` | 需要已有 cookie；适合「复用外部已启动且已授权」的场景 |

`⟨P⟩\dsh-web-app\lib\index.js:186-204`（就绪通告的实现，注意它要等 loader settle）：

```js
const announceReady = () => {
	if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return;
	const webUrl = localWebUrl(connectionCtx);
	const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl);
	...
	if (config.printUrl) console.log(`dsh web: ${authenticatedUrl}...`);
	...
};
const settled = connectionCtx.get("loader")?.await();
if (settled === void 0) announceReady();
else settled.then(() => { if (connectionCtx.get("webServer") !== void 0 && connectionCtx.get("connection") !== void 0) announceReady(); }, () => {});
```

即：**打印 URL 时服务已完全就绪**。

### 1.3 鉴权（详细）

三层，顺序执行：

**(a) Host/Origin 信任栅栏** —— `⟨P⟩\dsh-client-connection\lib\index.js:201-215`：

```js
function isTrustedApiRequest(request, trustedHosts) {
	const host = header$1(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header$1(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch { return false; }
}
```

→ 非浏览器客户端（Node `fetch`/`ws`）只要 `Host: 127.0.0.1:<port>` 且不带 `Origin` 就通过。失败返回 **403**。

**(b) 浏览器会话 cookie** —— 常量在 `⟨P⟩\dsh-client-connection\lib\index.js:218-225`：

```js
const AUTH_RECORD_KEY = credentialKey("client-connection", "browser-session");
const DAY_MILLISECONDS = 1440 * 60 * 1e3;
const SECRET_BYTES = 32;
const TOKEN_QUERY = "token";
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION = 1;
```

启动令牌是**每个进程随机生成的 32 字节 base64url**，存在内存 WeakMap 里（`processLaunchToken`，`⟨P⟩\dsh-client-connection\lib\index.js:240-246`），**永不落盘**。cookie 名 `dsh-auth-` + `base64url(sha256(authority))`，签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录里。

换取 cookie（`authorizeIndex`，`⟨P⟩\dsh-client-connection\lib\index.js:386-425`）——只有 `GET /?token=...`（**恰好一个** `token` 参数、路径必须 `/`）才返回：

```
HTTP/1.1 303 See Other
location: /
cache-control: no-store
referrer-policy: no-referrer
set-cookie: dsh-auth-<hash>=<signed payload>; Max-Age=...; Path=/; HttpOnly; SameSite=Strict
```

拿不到 cookie 时返回 **401**，body 固定为 `dsh web authentication required; reopen the URL printed by dsh web.`（`⟨P⟩\dsh-client-connection\lib\index.js:442-448`）。

客户端只需要 `set-cookie` 的第一个 `;` 之前部分作为 `cookie` 头值。

**(c) 静态资源是公开的**（`⟨P⟩\dsh-client-connection\README.md`「Static assets remain public」）。实测：

| 请求 | 结果 |
|---|---|
| `GET /` | 401（需要 cookie） |
| `GET /favicon.svg` | **200** |
| `HEAD /assets/index-DuF6ti6g.js` | **200** |
| `POST /api/session/list` | 401（无 cookie） |

### 1.4 已知限制

- **没有登出操作**；清 cookie 只结束一个浏览器会话，删掉凭据记录 + 重启 `dsh` 才能吊销全部。
- cookie **没有 `Secure`**（loopback HTTP 是本机默认传输）。
- **跨进程复用不可能**：启动令牌在进程内存里，另一个进程既拿不到也猜不到。若用户已有一个外部 `dsh web` 在跑，第三方客户端只能提示用户重启，或由用户手工把 cookie 喂进来。

---

## 2. 传输层

### 2.1 HTTP 一元 RPC

**路径**：`POST /api/<namespace>/<method>`（`API_PATH = "/api"`，`⟨P⟩\dsh-client-connection\lib\types\api-path.d.ts:6`）。

**请求体**（`⟨P⟩\dsh-client-connection\lib\types\rpc.d.ts:31-36`）：

```ts
export interface ClientRequest {
    readonly type: 'client-request';
    readonly rpcId: RpcId;
    readonly method: string;
    readonly payload: unknown;
}
```

**响应体**（`⟨P⟩\dsh-client-connection\lib\types\rpc.d.ts:38-43`）：

```ts
export interface ServerResponse {
    readonly type: 'server-response';
    readonly rpcId: RpcId;
    readonly result: ConnectionRpcResult<unknown>;
}
export type ConnectionRpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ConnectionRpcFailure };
export interface ConnectionRpcFailure { readonly code: string; readonly message: string; readonly details: object; }
```

**真实 HTTP 往返示例**（`session/list`）：

```http
POST /api/session/list HTTP/1.1
Host: 127.0.0.1:20000
content-type: application/json
cookie: dsh-auth-<hash>=<signed>

{"type":"client-request","rpcId":"a1b2c3d4-...","method":"session/list","payload":{"args":{"_request":{}}}}
```

```json
{"type":"server-response","rpcId":"a1b2c3d4-...","result":{"ok":true,"value":{"items":[]}}}
```

失败时：

```json
{"type":"server-response","rpcId":"a1b2c3d4-...","result":{"ok":false,"error":{"code":"session/not-found","message":"...","details":{"sessionId":"..."}}}}
```

**传输层硬性规则**（`rpcFetchHandler`，`⟨P⟩\dsh-client-connection\lib\index.js:635-664`）：

| 情形 | HTTP 状态 | body |
|---|---|---|
| 非 POST / 端点段不合法 | 404 | `not found` |
| `content-type` 去掉 `;...` 后小写 ≠ `application/json` | 415 | `content type must be application/json` |
| body 不是 JSON | 400 | `body is not JSON` |
| 信封校验失败 | 200 | `{result:{ok:false,error:{code:'gateway/bad-request',message:'invalid client-request message',details:{issues:[...]}}}}` |
| `message.method !== 路径末段` | 200 | `code:'gateway/bad-request'`，message 为 `method "X" does not match endpoint "Y"` |
| handler 抛异常 | 500 | `handler failure: ...` |

即：**业务错误在 HTTP 200 里，传输错误才是 4xx/5xx**。

### 2.2 `payload.args` 的确切形状（最容易踩的坑）

Typert 网关对参数名做**严格**校验（`assertExactArguments`，`⟨P⟩\dsh-api-gateway\lib\index.js:1040-1052`）：

```js
function assertExactArguments(args, descriptor, endpoint) {
	if (!isPlainObject(args)) throw new TypertGatewayError("gateway/arguments-invalid", endpoint, "args must be a plain object");
	const expected = new Set(descriptor.parameters.map((parameter) => parameter.wire));
	if (descriptor.invocation.kind === "context") expected.add(descriptor.invocation.wire);
	const extra = Reflect.ownKeys(args).filter((key) => typeof key !== "string" || !expected.has(key));
	const acceptsMissing = new Set(descriptor.parameters.filter((parameter) => parameter.source === "json" && (parameter.acceptsUndefined === true || parameter.codec.mode === "src-json")).map((parameter) => parameter.wire));
	const missing = [...expected].filter((key) => !Object.hasOwn(args, key) && !acceptsMissing.has(key));
	if (extra.length === 0 && missing.length === 0) return;
	...
	throw new TypertGatewayError("gateway/arguments-invalid", endpoint, `args fields do not match the descriptor: ...`);
}
```

**多一个字段、少一个字段都会被拒**，错误码 `gateway/arguments-invalid`（旧名 `gateway/arguments-invalid`，第三方实现在 `⟨W⟩\src\dsh\apiClient.ts:448` 里按这个码做参数名回退）。

正确的 `args` 写法取决于端点的**位置参数名**，源码里在 `lib/typert.host.js` 的 descriptors 中逐个列出。例：

- `session/prompt` → `{"args":{"request": {...}}}`（参数名 `request`，`⟨P⟩\dsh-api-session-controller\lib\typert.host.js:989-1013`）
- `session/list` → `{"args":{"_request":{}}}`（参数名是 **`_request`**，带下划线！`⟨P⟩\dsh-api-session-controller\lib\typert.host.js:896-903`）
- `commands/execute` → `{"args":{"agentId":..., "line":..., "submittedAttachments":[...]}}`（`⟨P⟩\dsh-commands\lib\typert.host.js:44-93`，注意第三参数 0.1.5 已改名为 `submittedAttachments`，0.1.2 叫 `images`）
- `agentPresets/select` → `{"args":{"agentId":..., "agentPreset":"..."}}`（无 `request` 包裹）

> 全量端点位置参数名清单见 §9.2。**这是写客户端时最容易出错的地方**：同一批端点里有的包 `request`，有的直接平铺。

### 2.3 WebSocket 多路复用流

**唯一 WS 路径**：`/api/remote.mux`（`⟨P⟩\dsh-api-gateway\lib\index.js:11`）。

```js
/** Exact WebSocket route carrying every Typert Remote stream. */
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
```

连接方式：`new WebSocket('ws://127.0.0.1:<port>/api/remote.mux', { headers: { cookie } })`（Node `ws` 允许自定义头；浏览器不能，所以浏览器靠同源 cookie 自动携带）。**升级请求同样过 1.3 的栅栏**，失败会以 plain HTTP 401/403 拒绝升级（`rejectRemoteStreamUpgrade`，`⟨P⟩\dsh-api-gateway\lib\index.js:373-395`）。

**心跳**：服务端每 `websocketHeartbeatIntervalMs`（默认 **2000ms**，`⟨P⟩\dsh-api-gateway\lib\index.js:398`）发一个 WS **Ping 控制帧**；连续 `MAX_MISSED_HEARTBEATS = 2` 次没收到 Pong 就 `terminate()`（`⟨P⟩\dsh-api-gateway\lib\index.js:197, 251-267`）。`ws` 库自动回 Pong，所以 Node 客户端不用管；自实现 WS 必须回 Pong。

**消息是 JSON 文本帧**，不是行分隔。服务端明确拒绝二进制（`⟨P⟩\dsh-api-gateway\lib\client.js:479`：`"api gateway: Remote stream WebSocket requires text messages"`）。

#### 客户端 → 服务端

`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:131-140`：

```ts
export type RemoteStreamClientMessage = {
    readonly type: 'open';
    readonly streamId: string;
    readonly endpoint: string;
    readonly payload: unknown;
} | {
    readonly type: 'cancel';
    readonly streamId: string;
};
```

实际发送（`⟨P⟩\dsh-api-gateway\lib\client.js:355-360` 与 `:376-379`）：

```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"..."},"assistantStream":true}}}}
{"type":"cancel","streamId":"<uuid>"}
```

`streamId` 是客户端 `randomUUID()` 生成的，`payload` 必须是**恰好一个 `args` 字段的 plain object**（`remoteRequest`，`⟨P⟩\dsh-api-gateway\lib\index.js:925-936`）：

```js
if (!isObject(payload) || !isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "args") || !isObject(payload.args) || !isPlainObject(payload.args)) throw new Error("Remote payload must contain exactly one plain-object args field");
```

#### 服务端 → 客户端

`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:147-159`（形态）：

| 帧 | 形状 | 含义 |
|---|---|---|
| `item` | `{type:'item', streamId, value}` | 一个流元素（`value` 可缺省 = `undefined`） |
| `end` | `{type:'end', streamId}` | 流正常结束 |
| `error` | `{type:'error', streamId, error:{code,message,details}}` | 流终止失败 |

客户端的解码器对**键集做精确匹配**（`parseRemoteStreamServerMessage`，`⟨P⟩\dsh-api-gateway\lib\client.js:111-130`）——`item` 只允许 `{type,streamId}` 或 `{type,streamId,value}`，多一个字段直接判定为非法帧并关闭 socket（`4002 invalid Remote stream frame`）。

**连接级语义**：一条 WS 承载任意多条逻辑流，`streamId` 区分；socket 断开 → 该 socket 上所有逻辑流以 `stream/socket-closed` 失败，客户端必须对所有「长活流」重新 `open`。第三方实现的重连策略是 1s 起、指数退避到 15s（`⟨W⟩\src\dsh\apiClient.ts:311-313`），并在 `open` 成功前把逻辑流排队（`pendingOpens`，`⟨W⟩\src\dsh\apiClient.ts:322-352`）。

> **不要求** `streamId` 是 UUID；服务端只校验非空字符串。但客户端必须自己保证唯一。

---

## 3. 会话生命周期

### 3.1 `session/list` —— 会话列表

```json
POST /api/session/list
{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{"_request":{}}}}
```

响应（`SessionListValue`，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:240-242`）：

```json
{"ok":true,"value":{"items":[
  {"sessionId":"01J...","updatedAt":1757500000000,"running":false,"blank":false,
   "cwd":"D:\\dev\\dsh-chat",
   "projections":{"asOfSeq":42,"values":{"title":"修一个 bug","agentPreset":"standard"}}}
]}}
```

`SessionSummary`（逐字，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:144-154`）：

```ts
export interface SessionSummary {
    readonly sessionId: SessionId;
    readonly updatedAt: number;
    readonly running: boolean;
    readonly blank: boolean;
    readonly parentSessionId?: SessionId;
    readonly origin?: 'subagent';
    readonly cwd?: string;
    readonly projections?: SessionProjectionHints;
}
```

> 激活策略：**只读存储 header + 投影缓存行**，不会唤起 Agent（`⟨P⟩\dsh-api-session-controller\README.md`「Each endpoint states its activation policy」）。
> 这是第三方实现用来做「服务器存活探测」的端点（`⟨W⟩\src\dsh\apiClient.ts:212-235`）——因为老版本 0.1.1 的 `host.describe` 已移除。

### 3.2 `session/create` —— 新建会话

```json
POST /api/session/create
{"type":"client-request","rpcId":"<uuid>","method":"session/create","payload":{"args":{"request":{
  "cwd":"D:\\dev\\dsh-chat","agentPreset":"standard"}}}}
```

`SessionCreateRequest` / `SessionCreateValue`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:252-263`）：

```ts
export interface SessionCreateRequest {
    readonly workspaceId?: WorkspaceId;
    readonly cwd?: string;
    readonly sessionId?: SessionId;     // 传入即"幂等收养"一个已知 id
    readonly agentPreset?: string;
}
export interface SessionCreateValue { readonly sessionId: SessionId; readonly agentPreset?: string; }
```

响应：`{"ok":true,"value":{"sessionId":"01J...","agentPreset":"standard"}}`

`sessionId` 是创建响应里唯一的会话身份来源——`create` 之后**必须**用它来发 prompt。

### 3.3 `session/prompt` —— 发送用户消息

```json
POST /api/session/prompt
{"type":"client-request","rpcId":"<uuid>","method":"session/prompt","payload":{"args":{"request":{
  "requestId":"<client-uuid>",
  "sessionId":"01J...",
  "mode":"queue",
  "content":[{"type":"text","text":"你好"}],
  "clientTimeZone":"Asia/Shanghai"
}}}}
```

`SessionPromptRequest`（逐字，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:291-304`）：

```ts
export interface SessionPromptRequest {
    /** Client-minted identity persisted on the exact accepted user message. */
    readonly requestId: SessionRequestId;
    readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';
    /** At least one non-whitespace text part or attachment. */
    readonly content: readonly PromptContentPart[];
    readonly clientTimeZone?: string;
}
export interface SessionPromptValue { readonly accepted: true; }
```

`PromptContentPart`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:59-75`）：

```ts
export type PromptContentPart = {
    readonly type: 'text';
    readonly text: string;
} | {
    readonly type: 'image';
    readonly mediaType: ImageMediaType;   // 'image/png'|'image/jpeg'|'image/webp'|'image/gif'
    readonly data: string;                // canonical base64
    readonly name?: string;
} | {
    readonly type: 'file';
    readonly receiptId: Branded<'file-upload-receipt-id'>;   // 来自 fileUploads/upload
};
```

语义要点：

- `mode: 'queue'` 追加一轮；`mode: 'steer'` 打断当前轮并插话（`⟨P⟩\dsh-api-session-controller\lib\types\client\contract\session.d.ts` 的 `prompt(content, mode, signal, requestId)`）。
- `requestId` 是**客户端铸造**的关联身份：Host 把它写进 durable `user/message` 的 `source.rpcId`（`MessageSourceMap['user-rpc']`，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:346-355`）。队列里的那一条也带它——当前版本是 `inbox` 投影消息的 `source.rpcId`，2026-09-09 之前是 `SessionQueuedItem.rpcId`。**重试同一个 `requestId` 不会重复插入消息**（README：「Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message」）。
- 内容既无空白以外的文本也无附件 → 直接拒绝（不唤起 Agent）。
- `clientTimeZone` 非法 → `session/invalid-time-zone`（details `{value}`）。
- 端点有 `cancellation: {parameter:'signal'}`（`⟨P⟩\dsh-api-session-controller\lib\typert.host.js:1006`）——`signal` 是**描述符元数据，不是线上参数**，HTTP 客户端断连即取消。

响应：`{"ok":true,"value":{"accepted":true}}`。

**附件两条路**：

1. **图片**：直接内联 base64（上面的 `type:'image'`），Host 在创建消息前用 `ctx.attachments.admitPromptContent()` 提升为 durable 引用。
2. **文件**：先上传拿 `receiptId`，再用 `{type:'file',receiptId}` 引用。两个上传端点：
   - `POST /api/fileUploads/upload`，args `{agentId, request:{data, name?}}`（base64，`⟨P⟩\dsh-client-file-upload\lib\typert.remote-client.d.ts:13-22`）→ `{receiptId, file: FileAttachmentRef}`
   - `POST /api/session/uploadFileBinary?sessionId=<id>&name=<n>`，**流式**，`content-type: application/octet-stream`，body 为裸字节；响应固定 HTTP 200 + `{ok:true,value:{receiptId,file}}` 或 `{ok:false,error}`（`⟨P⟩\dsh-client-file-upload\lib\index.js:13-56`，路径常量 `FILE_UPLOAD_PATH = "/api/session/uploadFileBinary"` 在 `:73`）。**推荐用后者**：不经过 base64，也不吃 300 MiB 的 JSON body 缓冲上限。

### 3.4 `session/cancel` —— 打断当前轮

```json
POST /api/session/cancel
{"...","method":"session/cancel","payload":{"args":{"request":{"sessionId":"01J..."}}}}
```

`SessionCancelRequest` / `Value`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:325-332`）：

```ts
export interface SessionCancelRequest { readonly sessionId: SessionId; }
export interface SessionCancelValue { readonly accepted: true; }
```

语义：取消**运行中的那一轮**；待处理的排队消息保留，Host 达到取消静默后按 FIFO 继续。

### 3.5 `session/updateQueue` —— 排队消息的编辑 / 删除 / 插话

```json
{"...","method":"session/updateQueue","payload":{"args":{"request":{
  "sessionId":"01J...","itemId":"<MessageId>","action":{"kind":"steer"}}}}}
```

`QueueAction`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:134-143`）：

```ts
export type QueueAction = {
    readonly kind: 'edit';
    readonly content: readonly ContentBlock[];   // 仅非空纯文本内容
} | {
    readonly kind: 'remove';
} | {
    readonly kind: 'steer';
};
```

失败码：`session/queue-item-not-found`（details `{itemId}`）、`session/steer-unavailable`（details `{itemId}`）。
前置条件：**需要活 Agent**（不会 resume 冷会话）；子代理另有更窄的例外规则。

### 3.6 `session/follow` —— 实时事件流（核心）

WS 逻辑流，`endpoint: "session/follow"`：

```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow",
 "payload":{"args":{"request":{
   "address":{"kind":"session","sessionId":"01J..."},
   "maxMessages":50,
   "assistantStream":true}}}}
```

`SessionFollowRequest`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:416-422`）：

```ts
export interface SessionFollowRequest {
    readonly address: SessionAddress;
    readonly maxMessages?: number;
    /** Include process-local assistant presentation frames for the Web client. */
    readonly assistantStream?: true;
}
export type SessionAddress = {
    readonly kind: 'session';
    readonly sessionId: SessionId;
} | {
    readonly kind: 'subagent';
    readonly parentSessionId: SessionId;
    readonly childSessionId: SessionId;
    readonly mode: 'one-shot' | 'continuable';
};
```

**`assistantStream: true` 是拿到逐 token 流式增量的唯一途径**——不传就只有 durable 事件（`assistant/message` 一次性提交）。

> **`assistantStream` 是字面量 `true`，不是布尔开关**（2026-09-22 实测）。写 `false`
> 会被网关的边界校验把**整条** `request` 拒掉：
> `gateway/input-invalid: typert gateway: session/follow: wire field "request" failed boundary validation`
> （`details: {endpoint:'session/follow', field:'request'}`）。这条报错**只说明 request 整体不合法**，
> 不点名是哪个字段——排查时按「字段名对不对得上契约」逐个试（去掉它 / 改成 `true` 各试一次即可定位）。
> 同样的道理，`beforeSeq` 只在 `session/page` 的请求里存在，**不要**塞进 follow 请求。

`SessionFollowFrame`（逐字，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:474-486`）——收到的每个 `item` 的 `value` 是它之一：

```ts
export type SessionFollowFrame = {
    readonly type: 'snapshot';
    readonly header: SessionWireHeader;
    readonly cursor: number;
    readonly records: readonly SessionHistoryRecord[];
    readonly hasMore: boolean;
    readonly projections: SessionProjectionBaseline;
    readonly assistantStream?: SessionAssistantStreamBaseline;
} | SessionEventEntry | {
    readonly type: 'assistant-stream';
    readonly frame: SessionAssistantStreamFrame;
};
```

**开帧顺序保证**：第一帧必然是 `snapshot`（含完整开窗 + 投影基线 + 可选的活跃 attempt 基线），其后是**严格连续（gap-free）**的 durable 事件帧，中间夹着可选的 `assistant-stream` 帧。gap-free 是硬保证（`⟨P⟩\dsh-api-session-controller\lib\index.js:1501-1505`）：

```js
const expectedSeq = SessionSeq(nextOffset);
if (item.event.seq < expectedSeq) continue;
if (item.event.seq !== expectedSeq) throw new RemoteError("gateway/internal", `session event stream skipped seq ${String(expectedSeq)}`, {});
nextOffset = SessionLogOffset(nextOffset + 1);
yield entryFor(item.event);
```

真实帧示例（脱敏）：

```json
{"type":"item","streamId":"7f3a...","value":{"type":"snapshot","header":{"version":3,"id":"01J...","createdAt":1757500000000,"cwd":"D:\\dev\\dsh-chat","isSeeded":false,"agentPreset":"standard"},"cursor":17,"hasMore":false,"records":[{"type":"event","event":{"type":"turn/start","seq":0,"time":1757500000100,"data":{"turn":0}}}],"projections":{"asOfSeq":17,"values":{"title":null,"plan":{"active":false,"pending":false}}}}}
{"type":"item","streamId":"7f3a...","value":{"type":"event","event":{"type":"user/message","seq":18,"time":1757500000200,"data":{"id":"msg_...","role":"user","content":[{"type":"text","text":"你好"}],"source":{"kind":"user-rpc","rpcId":"<client-uuid>"}},"surfaceOp":"append"}}}
{"type":"item","streamId":"7f3a...","value":{"type":"assistant-stream","frame":{"type":"start","attemptId":"att_...","revision":1,"startedAfterSeq":18,"turn":0,"step":0}}}
{"type":"item","streamId":"7f3a...","value":{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"att_...","revision":1,"index":0,"time":1757500000300,"chunk":{"type":"text-delta","index":0,"text":"你"}}}}
{"type":"item","streamId":"7f3a...","value":{"type":"assistant-stream","frame":{"type":"end","attemptId":"att_...","revision":1,"index":5,"outcome":{"kind":"committed","eventType":"assistant/message","seq":19}}}}
{"type":"item","streamId":"7f3a...","value":{"type":"event","event":{"type":"assistant/message","seq":19,"time":1757500001000,"data":{"turn":0,"step":0,"message":{...},"stream":[...],"usage":{"inputTokens":1200,"outputTokens":88}},"surfaceOp":"append"}}}
```

关闭流：

```json
{"type":"cancel","streamId":"7f3a..."}
```

**重连语义**：socket 断 → 流以 `error {code:'stream/socket-closed'}` 结束 → 客户端必须**重新 open 一条新流**，Host 会重发 `snapshot` 并从头给基线；客户端要用 `snapshot.cursor` 与已有 durable 游标做**去重/补齐**（重连可能重发已见过的 seq）。

### 3.7 `session/page` —— 历史回放（分页）

```json
POST /api/session/page
{"...","method":"session/page","payload":{"args":{"request":{
  "address":{"kind":"session","sessionId":"01J..."},
  "throughSeq":42,
  "beforeSeq":30,
  "maxMessages":50}}}}
```

`SessionPageRequest` / `SessionPage`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:408-415, 469-473`）：

```ts
export interface SessionPageRequest {
    readonly address: SessionAddress;
    /** Inclusive log cut obtained from the corresponding follow opening frame. */
    readonly throughSeq: number;
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
}
export interface SessionPage { readonly records: readonly SessionHistoryRecord[]; readonly hasMore: boolean; }
```

响应：`{"ok":true,"value":{"records":[{"type":"event","event":{...}}],"hasMore":true}}`

**关键约束**：`throughSeq` **必须**来自同一会话某次 `session/follow` 开帧的 `snapshot.cursor`；不传或来自别处会校验失败。第三方实现记录了 0.1.2 起的这条契约（`⟨W⟩\src\dsh\apiClient.ts:467-470`）。

分页按**消息对齐**：默认 50 条消息（`DEFAULT_MAX_MESSAGES = 50`），只保留 `user/message` / `assistant/message` 中 `surfaceOp === 'append'` 的（`⟨P⟩\dsh-api-session-controller\lib\index.js:1329, 1602-1623`），并按 `sourceEventSeqs` 分组——所以一页返回的 `records` 条数 ≠ 消息条数。

### 3.8 `session/control` —— 全局控制流（后台任务 / 投影；队列经 `inbox` 投影）

WS 逻辑流，`endpoint: "session/control"`，`payload: {"args":{}}`（无参数）。

**当前版本**（逐字，`packages/api/session-controller/src/types.ts`——即本地构建 `dsh.bat`
所跑的那份）：

```ts
export interface SessionControlBaseline {
    readonly jobs: Readonly<Record<SessionId, readonly SessionJob[]>>;
    readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>;
}
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | { readonly type: 'jobs'; readonly sessionId: SessionId; readonly jobs: readonly SessionJob[] }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate);
```

**队列没有自己的帧**：待发消息在 **`inbox` 投影**里——baseline 的
`projections[sid].values.inbox` 全量下发，之后是 `{type:'projection', key:'inbox', value}`
增量。值的形状是 `{'next-turn': UserMessage[], 'next-step': UserMessage[]}`
（`packages/core/agent-loop/src/inbox.ts` 的 `inboxProjectionDefinition`）：
`next-turn` = 排队等下一轮，`next-step` = 等下一个 step 的插话。消息体自带
`id` / `content` / `source:{kind,rpcId?}`——其中 `next-step` 里 `source.kind !== 'user'`
的是插件注入的环境上下文，不是用户消息。

> **2026-09-09 之前**（提交 `72f2e71070` 删除）的版本另有一条队列通道，扩展**同时兼容**：
> baseline 里多一个 `queues: Readonly<Record<SessionId, readonly SessionQueuedItem[]>>`，
> 增量是 `{readonly type:'queue'; sessionId; items}`；`SessionQueuedItem` =
> `{id, placement:'queued'|'steering'|'context', rpcId?, message:{id, content}}`。
> 两者**同源同值**（旧帧当年就是由 `inbox` 投影派生的，见 `8b0ea3e461` 的
> `queueItemsFromInbox()`），只是形状不同。扩展双读的实现在 `src/dsh/queueView.ts` 与
> `src/dsh/controller.ts` 的 `onControlFrame`。

**每一代（每次重连）必定以恰好一个 `baseline` 开始**，其后是增量帧。进程本地的队列/任务状态因此可安全重建。

### 3.9 `session/rename` / `session/fork` / `workspace/archiveSession`

```json
{"...","method":"session/rename","payload":{"args":{"request":{"sessionId":"01J...","title":"新标题"}}}}
→ {"ok":true,"value":{"title":"新标题","seq":33}}
```

`SessionRenameValue = {title: string; seq: number}`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:277-281`）。显式改名会**钉住**标题，停止自动生成。

```json
{"...","method":"session/fork","payload":{"args":{"request":{"sessionId":"01J...","atSeq":33}}}}
→ {"ok":true,"value":{"sessionId":"01K..."}}
```

`SessionForkRequest = {sessionId, atSeq?}`；切点规则：`atSeq` 之后**第一个 `turn/end`** 为边界；落在开放轮次内部的锚点直接判定不可用（不会向前裁切）。失败码 `session/fork-unavailable`（details `{sessionId}`）。客户端封装里另有 `increaseTitle` 选项（`⟨P⟩\dsh-api-session-controller\lib\types\client\contract\sessions.d.ts`），但**线上端点没有这个字段**。

归档（不是删除会话，而是从工作区分组里移出）：

```json
{"...","method":"workspace/archiveSession","payload":{"args":{"request":{"sessionId":"01J..."}}}}
→ {"ok":true,"value":{"archivedSessionIds":["01J..."]}}
```

`WorkspaceArchiveSessionRequest = {sessionId}`，`WorkspaceArchiveValue = {archivedSessionIds: readonly SessionId[]}`（`⟨P⟩\dsh-api-workspace-controller\lib\types\types.d.ts`）。
**注意：seam 没有删除会话的 API**——日志文件只增不减（`⟨P⟩\dsh-session-persistence-jsonl\README.md`「Nothing deletes session files」）。

### 3.10 `session/search` —— 全文检索

```json
{"...","method":"session/search","payload":{"args":{"request":{"query":"关键词"}}}}
→ {"ok":true,"value":{"items":[{"sessionId":"01J...","snippet":"…关键词…"}],"hasMore":false}}
```

常量（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:160-163`）：`SESSION_SEARCH_RESULT_LIMIT = 20`，`SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240`。

---

## 4. 模型与配置

### 4.1 `session/modelCatalog` —— 模型目录（无参数）

```json
{"...","method":"session/modelCatalog","payload":{"args":{}}}
```

`ModelCatalog`（逐字，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:107-133`）：

```ts
export interface ModelReasoningEffort { readonly id: string; readonly name: string; readonly description?: string; }
export interface ModelReasoning { readonly efforts: readonly ModelReasoningEffort[]; readonly defaultEffort?: string; }
export interface ModelCatalogModel { readonly id: string; readonly name: string; readonly description?: string; readonly reasoning?: ModelReasoning; }
export interface ModelProviderGroup { readonly id: string; readonly name: string; readonly models: readonly ModelCatalogModel[]; }
export interface ModelCatalogFailure { readonly id: string; readonly name: string; readonly message: string; }
export interface ModelCatalog {
    readonly default: ModelSelection;
    readonly routableProviders: readonly string[];
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}
export interface ModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string; }
```

响应示例：

```json
{"ok":true,"value":{
  "default":{"provider":"deepseek","model":"deepseek-v4.1-flash","reasoningEffort":"medium"},
  "routableProviders":["deepseek"],
  "groups":[{"id":"deepseek","name":"DeepSeek","models":[
    {"id":"deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","description":"…",
     "reasoning":{"efforts":[{"id":"low","name":"Low"},{"id":"medium","name":"Medium"},{"id":"high","name":"High"}],"defaultEffort":"medium"}}]}],
  "failures":[]}}
```

> 无参数端点也必须发 `"args":{}`——`assertExactArguments` 要求 `args` 是 plain object（空对象合法）。

### 4.2 `session/selectModel` —— 切换模型 / 思考深度

```json
{"...","method":"session/selectModel","payload":{"args":{"request":{
  "sessionId":"01J...","provider":"deepseek","model":"deepseek-v4.1-flash","reasoningEffort":"high"}}}}
→ {"ok":true,"value":{"selected":{"provider":"deepseek","model":"deepseek-v4.1-flash","reasoningEffort":"high"}}}
```

`SessionSelectModelRequest extends ModelSelection { sessionId }`，`SessionSelectModelValue = {selected: ModelSelection}`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:264-271`）。
`reasoningEffort` 省略即用适配器的 `defaultEffort`。
切换会**显式 resume** 会话；路由已下线 → `session/model-unavailable`（details `{provider, model}`）。
写入的 durable 事件是 `model/selection`（log-only，不进模型历史），折叠投影键 `modelSelection`：

```ts
export interface ModelSelectionProjection {
    readonly lastUsed: ModelSelection | null;   // 最近一次被请求消费的选择
    readonly next: ModelSelection | null;       // 下一次请求将使用的选择（回退到 lastUsed）
}
```

### 4.3 Agent preset

```
POST /api/agentPresets/list      {"args":{}}                                    → AgentPresetRoster
POST /api/agentPresets/select    {"args":{"agentId":"01J...","agentPreset":"standard"}} → string（生效的 preset id）
POST /api/agentPresets/read      {"args":{"agentPreset":"standard"}}            → AgentPresetDocument
POST /api/agentPresets/copy      {"args":{"from":"standard","id":"my-preset","name":"我的"}} → void
POST /api/agentPresets/deletePreset {"args":{"id":"my-preset"}}                 → void
```

`AgentPresetRoster` / `AgentPresetRow`（0.1.7-rc.2 的形状，`⟨P⟩\dsh-agent-preset-registry\lib\types\types.d.ts`）：

```ts
export interface AgentPresetRow {
    readonly id: string;
    readonly isDefault: boolean;
    readonly name?: string;
    readonly description?: string;
    readonly broken?: string;
}
export interface AgentPresetRoster {
    readonly presets: readonly AgentPresetRow[];
}
export interface AgentPresetDocument {
    readonly agentPreset: string;
    readonly content: string;           // composition 原文（YAML）
    readonly name?: string;
    readonly description?: string;
}
```

> 版本差异（第 0.5 节）：0.1.6-alpha.2 及更早的 `AgentPresetRow` 带 `trust`、roster 带
> `authorable` 与 `modeSelectionEnabled`；0.1.7-alpha.1 起只剩 `modeSelectionEnabled`；
> 0.1.7-rc.2 起两个都删掉，**选择可见性改由客户端偏好决定**（宿主持久化命名空间
> `ui-settings` 的 `enabled`）。本扩展两代都读（见 `docs/dsh-compat.md` 的兼容层登记）。

> 展示名：随产品交付的那四个（`standard` / `ptc` / `minimal` / `cordis`）由**客户端**按当前
> 语言给名与描述（官方 `dsh-agent-preset-registry/display` 的 `presetDisplayText` 走词典），
> 行里的 `name` / `description` 是**不翻译**的文件元数据。**「哪几个是内置」的判据**：0.1.6-alpha.2
> 及更早看行的 `trust === 'system'`，之后改用官方 `isBuiltInPreset`——**不发布 `name` 的已知 id
> 就是内置**（否则用户自写的同名预设会被静默改名）。
> 本扩展照这一条实现（`src/webview/presetDisplay.ts`）。

**关键约束**：`select` **只在会话「仍为空白」时有效**（未产生任何轮次），否则 `agent-preset/locked`（details `{sessionId, agentPreset}`）。其他错误：`agent-preset/not-found`（details `{agentPreset, available: string[]}`）、`agent-preset/invalid`（details `{agentPreset, reason}`）、`agent-preset/read-only`（details `{agentPreset, reason}`）。

创建时也可以直接指定：`session/create` 的 `request.agentPreset`（与 `workspaceId` / `cwd` 并列，可同时给）。

### 4.4 权限模式（read-only / workspace-write / full-access）

**没有直接写权限的端点。** 权限是「预设名 → 两个独立旋钮」的映射，读取走会话投影 `permissions`，写入走 `/permission` **命令**。

投影值（逐字，`⟨P⟩\dsh-permission-presets\lib\types\types.d.ts`）：

```ts
export interface PresetOption { readonly value: string; readonly name: string; readonly description?: string; }
export interface PermissionSelect {
    /** Switchable presets, plus `custom` appended exactly while it is current. */
    readonly options: PresetOption[];
    /** The effective current value: a preset table key, or `custom`. */
    readonly currentValue: string;
}
```

字段名 **`currentValue` 已核实**（不是 `effectiveValue`）。运行时构造（`⟨P⟩\dsh-permission-presets\lib\index.js:230-235`，逐字）：

```js
selectFor(state) {
    const currentValue = this.derive(state);
    return {
        options: [...this.names.map((name) => this.optionOf(name)), ...currentValue === "custom" ? [this.optionOf(CUSTOM_PRESET)] : []],
        currentValue
    };
}
```

对应的投影 state schema（`⟨P⟩\dsh-permission-presets\lib\index.js:136`）：`currentValue: z$1.string().min(1)`。

发送命令（等价于网页端点权限芯片）：

```json
POST /api/commands/execute
{"...","method":"commands/execute","payload":{"args":{
  "agentId":"01J...","line":"/permission workspace-write","submittedAttachments":[]}}}
→ {"ok":true,"value":{"commandId":"cmd_...","result":{"kind":"success","text":"…"}}}
```

底座映射（`⟨P⟩\dsh-permission-presets\lib\types\index.d.ts` 的 `Config` JSDoc）：

| preset | sandbox | approval |
|---|---|---|
| `read-only` | `read-only` | `ask` |
| `workspace-write` | `workspace-write` | `ask` |
| `danger-full-access` | `danger-full-access` | `never` |

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';   // ⟨P⟩\dsh-sandbox\lib\types\index.d.ts:19
export type ApprovalPolicy = 'ask' | 'never';                                        // ⟨P⟩\dsh-user-approval\lib\types\index.d.ts:46
```

`dsh web` 部署默认（`⟨P⟩\dsh-base\cordis.patch.yml`，`dsh-web-app` 依赖链）：

```yaml
- id: approval
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

即环境变量 `DSH_PERMISSION_MODE` 只影响 approval 旋钮，不影响 sandbox。

> **未确认**：`PermissionSelect` 的第二个字段名。源码 `⟨P⟩\dsh-permission-presets\lib\types\types.d.ts` 我读到的是 `currentValue`，但同一包的 `index.d.ts` 的 `selectFor` JSDoc 用的是「effective current value」。两个 `lib/types` 输出（`.d.ts` 与 `.js`）应当一致，但我在本机只读校验时未做运行时比对。**推测依据**：类型声明文件是构建产物，以 `.d.ts` 里的 `currentValue` 为准；写代码时建议同时兼容 `currentValue ?? effectiveValue`。

### 4.5 设置读写

| 端点 | args | 说明 |
|---|---|---|
| `settings/describe` | `{}` | 全部命名空间的脱敏视图 |
| `settings/update` | `{ns, patch, expectedRevision}` | 合并进用户层 |
| `settings/replace` | `{ns, section, expectedRevision}` | 整体替换用户层 |
| `settings/mutate` | `{ns, ops, expectedRevision}` | 按路径编辑 |
| `settings/openSettingsDocument` | `{}` | 在系统编辑器里打开设置文件 |
| `settings/canOpenAgentPresetDirectory` | `{}` | |
| `settings/openAgentPresetDirectory` | `{agentPreset}` | |

`expectedRevision` 可省略（省略即无条件写）。**注意**：`update`/`replace`/`mutate` 的位置参数是**三个平铺参数**，不是 `request` 包裹（`⟨P⟩\dsh-api-settings-controller\lib\typert.remote-client.d.ts`）：

```ts
update: (ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined) => Promise<RemoteResult<SettingsNamespaceView>>
```

所以请求体是：

```json
{"...","method":"settings/update","payload":{"args":{
  "ns":"llm-deepseek","patch":{"apiKey":"sk-..."},"expectedRevision":7}}}
```

`expectedRevision` **可以整个省略**——生成器在它上面打了 `acceptsUndefined: true`（`⟨P⟩\dsh-api-settings-controller\lib\typert.host.js:255-262`，逐字）：

```js
{
  name: 'expectedRevision',
  wire: 'expectedRevision',
  source: 'json',
  acceptsUndefined: true,
  codec: { mode: 'strict', typeSymbol: '...settings/mutate:expectedRevision', schema: ... },
}
```

`assertExactArguments` 对这些参数放行缺失（`acceptsMissing`，`⟨P⟩\dsh-api-gateway\lib\index.js:1045`），所以 `{"ns":..., "patch":...}` 与 `{"ns":..., "patch":..., "expectedRevision":null}` 都合法。传具体数字才能获得乐观并发保护（冲突 → `settings/conflict`）。

`SettingsNamespaceView`（逐字，`⟨P⟩\dsh-settings\lib\types\types.d.ts`）：

```ts
export interface SettingsNamespaceView {
    ns: string;
    schema: JsonValue;              // schema.toJSON()
    value: JsonValue;               // 脱敏后的解析值（schema 默认 → composition base → 用户层）
    base?: JsonValue;
    user?: JsonValue;               // 用户层原始 section；字段在此出现 = 被用户覆盖
    applies: 'live' | 'restart';
    secrets: SettingsSecretView[];  // {path: string[]; set: boolean}
    revision: number;               // 写回时作为 expectedRevision
}
export interface SettingsDescribeValue {
    writable: boolean;
    hasDocument: boolean;
    namespaces: SettingsNamespaceView[];
}
export type SettingsPathOpView = { op:'set'; path:string[]; value:JsonValue } | { op:'unset'; path:string[] };
```

错误码：`settings/conflict`（details `{ns, expected, actual}`，需重读重写）、`settings/rejected`（details `{ns}`）。

### 4.6 凭据

| 端点 | args | 返回 |
|---|---|---|
| `credentials/describe` | `{refs: string[]}` | `Record<string, CredentialInfo>` |
| `credentials/set` | `{ref, value}` | `void` |
| `credentials/unset` | `{ref}` | `void` |

**秘密只单向过线**：没有任何读路径返回秘密值。`refs` 超过 `MAX_DESCRIBE_REFS` 或名字不合法 → 整个调用 `gateway/bad-request`；provider 拒绝 → `credential/rejected`（details `{ref}`，**不含值**）。

### 4.7 LLM 供应商目录

| 端点 | args | 返回 |
|---|---|---|
| `llm/listProviders` | `{}` | `LlmProviderInfo[]` = `{id, name}[]`（**仅活跃路由**） |
| `llm/listConfigurableProviders` | `{}` | `LlmConfigurableProvider[]` = `{provider, displayName, settingsNs, settingsPath, declared?, error?}[]` |
| `llm/discoverModels` | `{settingsNs, request:{provider?, baseURL?, api?, apiKey?}}` | `LlmDiscoveredModel[]` = `{id, name?, contextWindow?, maxTokens?}[]` |

来源：`⟨P⟩\dsh-llm\lib\typert.remote-client.d.ts:11-19` + `⟨P⟩\dsh-llm\lib\types\types.d.ts`。

### 4.8 技能列表

```json
{"...","method":"skills/list","payload":{"args":{"request":{"sessionId":"01J..."}}}}
→ {"ok":true,"value":{"skills":[{"name":"build","description":"…","whenToUse":"…","modelInvocable":true}]}}
```

`SkillEntry`（`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:220-234`）。冷会话也能列，用的是记录下来的 preset 的 standing scope，**不会启动 Agent**。

### 4.9 斜杠命令

```
POST /api/commands/list     {"args":{"agentId":"01J..."}}                     → CommandDescriptor[]
POST /api/commands/execute  {"args":{"agentId":"01J...","line":"/compact","submittedAttachments":[]}} → CommandExecution | undefined
```

`CommandDescriptor` = `{name, description, input?:{hint, attachments?}}`；`value === undefined` 表示**没有匹配任何命令**（不是错误）。
`CommandExecution` = `{commandId, result: {kind:'success', text?, sourceEventSeq?} | {kind:'error', text}}`。

**0.1.2 → 0.1.5 破坏性改名**：第三参数由 `images` 改为 `submittedAttachments`；`commands/list` 描述符里 `input.images` 改为 `input.attachments`。第三方实现用「新名优先、旧名回退」+ 记忆可用名来兼容（`⟨W⟩\src\dsh\apiClient.ts:485-523`）——**这是目前在跨版本客户端里唯一稳妥的做法**。

### 4.10 其他端点速查

| 端点 | args 形状 | 说明 |
|---|---|---|
| `fileReferences/list` | `{agentId, query}` | `@` 文件/目录候选，`{path, kind:'file'\|'directory'}[]` |
| `sessionReferenceResolver/candidates` | `{agentId, query}` | `@` 会话候选，`{sessionId, label, cwd?, createdAt, mention}[]` |
| `session/attachment` | `{request:{sessionId, attachmentId}}` | 读 durable 图片，`{attachment, data: base64}` |
| `session/canOpenWorkspacePath` | `{}` | `boolean` |
| `session/openWorkspacePath` | `{request:{path, action?:'reveal'}}` | `{opened:true}` |
| `workspace/create` | `{request:{path}}` | `{workspace: WorkspaceView, created: boolean}` |
| `workspace/rename` | `{request:{workspaceId, title}}` | `{workspace}` |
| `workspace/delete` | `{request:{workspaceId}}` | `{deleted:true}` |
| `workspace/insertBefore` | `{request:{workspaceId, beforeWorkspaceId?}}` | `{workspaceIds}` |
| `workspace/insertSessionBefore` | `{request:{workspaceId, sessionId, beforeSessionId?}}` | `{workspace}` |
| `workspace/follow` | `{}`（WS 流） | `WorkspaceFollowFrame` |
| `workspaceFiles/list` | `{workspaceFileScopeId, path, ...}` | 目录列表 |
| `workspaceFiles/read`/`readAll`/`stat`/`changes` | 见 §9.2 | 工作区文件读 / 监听 |
| `subagents/list` | `{parentSessionId}` | 子代理目录 |
| `subagents/prompt` | `{request:{...}}` | **0.1.5 起 `delivery` 必填** |
| `subagents/interruptByParent` | `{childSessionId, parentSessionId, mode}` | |
| `goals/create`/`edit`/`pause`/`resume`/`complete`/`clear`/`get` | `{agentId, ref, request?}` | |
| `messageFeedback/list`/`put`/`delete` | `{request:{...}}` | |
| `sessionFeedback/record` | `{request:{...}}` | |
| `pluginInventory/list` | `{}` | 插件清单快照 |
| `directoryPicker/list`/`pick`/`createDirectory` | 位置参数 | 目录选择器 |
| `dynamicCordisRunner/*` | 见 §9.2 | 动态 Cordis 插件（一般客户端不需要） |

### 4.11 原生 GET 路由（不经 RPC 信封）

这几条是**精确的 Fetch 路由**，挂在同一个 `/api` 前缀下，鉴权相同，但**不是** `client-request` 信封：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/file?path=<绝对路径>` | GET/HEAD | 读任意绝对路径文件；`mime-types` 推断类型；超过 `maxImageBytes`（通常 20 MiB）→ 413；响应带 `private, no-store`、`nosniff` 与 sandbox CSP |
| `/api/session.export?...` | GET/HEAD | 会话日志下载（gzip） |
| `/api/present.host` | GET | 交付物的宿主能力查询（JSON） |
| `/api/present.open?action=open\|reveal&sessionId=...&id=...` | POST | 打开/定位交付物 |

证据：`⟨P⟩\dsh-api-session-controller\lib\index.js:2369-2375`（`path: "/api/file"`）、`⟨P⟩\dsh-session-log-export\lib\index.js:463`（`SESSION_LOG_EXPORT_PATH = "/api/session.export"`）、`⟨P⟩\dsh-client-ui-deliverables\lib\index.js:4-6`（`PRESENT_OPEN_PATH = "/api/present.open"`、`PRESENT_HOST_PATH = "/api/present.host"`）。

> 第三方扩展想在 VS Code 里显示 Agent 生成的图片，就用 `/api/file?path=<绝对路径>`。

---

## 5. 审批与交互

**这是整个协议里唯一会"卡住 Agent"的部分。**

### 5.1 唯一交互通道：`$events` 逻辑流

`$events` 是一个普通逻辑流，通过 `/api/remote.mux` 打开：

```json
{"type":"open","streamId":"<uuid>","endpoint":"$events","payload":{"args":{}}}
```

**payload 被严格校验为 `{args:{}}`**——多一个字段就报 `gateway/arguments-invalid`（`⟨P⟩\dsh-api-gateway\lib\index.js:586`）。

开帧必须是 `ready`（精确键集 `{type,clientId,host}`，`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:21-32`）：

```ts
export interface RemoteEventHostInfo { readonly home: string; }
export interface RemoteEventReadyFrame {
    readonly type: 'ready';
    readonly clientId: RemoteEventClientId;
    readonly host: RemoteEventHostInfo;
}
```

```json
{"type":"item","streamId":"<uuid>","value":{"type":"ready","clientId":"b0f1...","host":{"home":"C:\\Users\\Cueio"}}}
```

`clientId` 每次 open 都重新随机生成，**必须记住**（回复审批时要用）。

### 5.2 转发事件全集（19 个，只有 2 个是 waterfall）

唯一权威来源：`⟨P⟩\dsh-api-remotes\lib\types\remote-events.d.ts:12-69` 的 `API_REMOTE_FORWARDED_EVENTS`。

| 事件名 | 模式 |
|---|---|
| `agent-preset/selected` | emit |
| **`approval/request`** | **waterfall** |
| `api-session/activity` | emit |
| `api-session/added` | emit |
| `api-session/error` | emit |
| `api-session/removed` | emit |
| `api-session/status` | emit |
| `commands/change` | emit |
| `credentials/reference-updated` | emit |
| `goal/activation-changed` | emit |
| `cordis/request-run` | emit |
| `cordis/request-run-resolved` | emit |
| `cordis/dynamic-package` | emit |
| `cordis/dynamic-retract` | emit |
| `cordis/inspect-query` | emit |
| `cordis/inspect-query-resolved` | emit |
| `llm/adapters-updated` | emit |
| `settings/document-updated` | emit |
| **`user-questions/request`** | **waterfall** |

`emit` 帧（`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:35-40`）：

```ts
export interface RemoteEventEmitFrame {
    readonly type: 'emit';
    readonly event: string;
    readonly args: readonly unknown[];    // 原始 Cordis 事件参数列表
}
```

常用 emit 事件的确切 `args`（用于会话列表联动）：

| 事件 | args |
|---|---|
| `api-session/added` | `[summary: SessionSummary]` |
| `api-session/removed` | `[sessionId: SessionId]` |
| `api-session/status` | `[sessionId: SessionId, running: boolean]` |
| `api-session/activity` | `[sessionId: SessionId, updatedAt: number]` |
| `api-session/error` | `[sessionId: SessionId, message: string]` |
| `agent-preset/selected` | `[sessionId: SessionId, agentPreset: string]` |

`waterfall` 帧（`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:33-48`）：

```ts
export interface RemoteEventInvocationFrame {
    readonly type: 'waterfall';
    readonly event: string;
    readonly eventId: RemoteEventId;
    readonly agentId: RemoteEventAgentId;
    readonly request: Readonly<Record<string, unknown>>;
}
```

**注意：没有 `rpcId` 字段**（`rpcId` 只存在于 HTTP 信封里）。`agentId` 是不透明 Agent 身份；`request` 已剥离 `agent` 与 `signal`。

`cancel` 帧（`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:49-53`）：

```ts
export interface RemoteEventCancellationFrame { readonly type: 'cancel'; readonly eventId: RemoteEventId; }
```

### 5.3 回复：`POST /api/$events/result`

```json
{"type":"client-request","rpcId":"<uuid>","method":"$events/result","payload":{"args":{
  "clientId":"b0f1...","eventId":"9c8d...",
  "outcome":{"kind":"result","value":"allowed-once"}}}}
→ {"type":"server-response","rpcId":"<uuid>","result":{"ok":true}}
```

`RemoteEventResult`（逐字，`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.d.ts:68-81`）：

```ts
export interface RemoteEventResult {
    readonly clientId: RemoteEventClientId;
    readonly eventId: RemoteEventId;
    readonly outcome: {
        readonly kind: 'next';
    } | {
        readonly kind: 'result';
        readonly value?: unknown;
    } | {
        readonly kind: 'rejected';
        readonly error: RemoteEventRejection;
    };
}
export interface RemoteEventRejection {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly details?: unknown;
}
```

三个 `outcome` 分支的确切语义（`⟨P⟩\dsh-api-gateway\lib\index.js:683-693`）：

| 分支 | Host 侧效果 |
|---|---|
| `{kind:'result', value}` | **resolve** 该 waterfall，`value` 交给等待者 |
| `{kind:'rejected', error}` | **reject（抛异常）** 该 waterfall，error 被重建成 `Error` |
| `{kind:'next'}` | 若**所有**已投递的 client 都回了 `next`，则推进到链上的下一个 Host 监听器 |

**`clientId`/`eventId` 不匹配时静默无操作**（不报错，`⟨P⟩\dsh-api-gateway\lib\index.js:684-686`）——所以回错 id 不会得到任何反馈。

### 5.4 工具审批（`approval/request`）

waterfall 帧：

```json
{"type":"item","streamId":"<uuid>","value":{
  "type":"waterfall","event":"approval/request","eventId":"9c8d...","agentId":"01J...",
  "request":{"toolName":"Bash","callId":"call_abc","reason":"escalate sandbox to danger-full-access: 需要写工作区外的文件"}}}
```

线上 `request` 只有 **`toolName`、`callId?`、`reason?`** 三个字段（**0.1.7-rc.2 起多一个可选的
`displayReason?`**，见下）——`agent` 与 `signal` 被剥离（`⟨P⟩\dsh-api-gateway\lib\types\stream-protocol.js:60-85`）。
**没有 `input`/`arguments`/`parameters`/`options`/`rationale` 字段**；`reason` 就是理由（`⟨P⟩\dsh-user-approval\README.md`：「The request carries no tool arguments」）。

`displayReason`（**0.1.7-rc.2 起**）是 asker 附的本地化展示文案：

```ts
readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
```

**只用于展示、不改写日志**：审计事件里存的仍是英文的 `reason`。官方 `ui-approval` 的读法是
「有它就用它、没有才用 `reason`」（`displayReason === undefined ? reason : resolveText(displayReason)`），
按当前语言沿「完整标识 → 主语言 → `en`」取值。产生了它的两处 asker：沙箱升级
（`Allow this operation with <mode> permissions: <理由>` / `允许本次操作使用 <mode> 权限：<理由>`）
与 Auto 评审拒绝（`Auto review denied this call: <理由>` / `Auto review 拒绝了此调用：<理由>`）。

回答：

```json
{"clientId":"b0f1...","eventId":"9c8d...","outcome":{"kind":"result","value":"allowed-once"}}
{"clientId":"b0f1...","eventId":"9c8d...","outcome":{"kind":"result","value":"rejected"}}
```

`ApprovalOutcome`（`⟨P⟩\dsh-user-approval\lib\types\types.d.ts:22-26`）：

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

- **`allowed-once` 是唯一的授予值**。**没有 `allowed-always` / `allow-always` / 记忆规则 / 授权仓库**（`⟨P⟩\dsh-user-approval\README.md` 明确列为设计限制）。
- 返回非词表字符串会被**归一化为 `unavailable`（拒绝）**（`⟨P⟩\dsh-user-approval\lib\index.js:179`）。
- `cancelled` / `unavailable` 是 Host 侧产出（信号中止 / 无应答者时 fail-closed），不是客户端该发的值。

**策略门控**——什么时候根本不会有 waterfall 帧（`⟨P⟩\dsh-user-approval\lib\index.js:175-192`）：

```js
async decide(req, session) {
    const signal = req.signal;
    if (signal?.aborted) return "cancelled";
    if (this.effectivePolicy(session) === "never") return "rejected";
    const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable")))...
```

→ `approval/policy === 'never'`（对应 `danger-full-access` preset）或信号已中止时，**直接确定性拒绝，不派发 waterfall**，客户端不会收到帧。
另外：`request()` 在**没有打开的轮次**时直接抛异常（不产生帧）。

### 5.5 向用户提问（`user-questions/request`）

waterfall 帧：

```json
{"type":"item","streamId":"<uuid>","value":{
  "type":"waterfall","event":"user-questions/request","eventId":"7a2b...","agentId":"01J...",
  "request":{"questions":[{
    "id":"q1","header":"选择","question":"用哪个方案？","detail":"方案 B 更快但改动大",
    "options":[{"label":"方案 A","description":"稳"},{"label":"方案 B"}],
    "multiSelect":false}]}}}
```

类型（逐字，`⟨P⟩\dsh-user-questions\lib\types\types.d.ts`）：

```ts
export interface AskUserQuestionOption { label: string; description?: string; }
export type AskUserQuestionIntent = { kind: 'plan-review'; approve: string; };
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];
    multiSelect?: boolean;
    intent?: AskUserQuestionIntent;
}
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
}
/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
    id: string;
    selected: string[];      // 选中的 option label
    custom?: string;         // 自由文本 "Other"
}
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[]; }
```

**回答必须一次性回整批**（没有逐题往返）：

```json
{"clientId":"b0f1...","eventId":"7a2b...","outcome":{"kind":"result","value":{
  "answers":[{"id":"q1","selected":["方案 B"]}]}}}
```

语义（`⟨P⟩\dsh-user-questions\README.md:39`）：

- 单选 + 自定义文本 ⇒ `custom` 覆盖，`selected` 为空数组。
- 多选 ⇒ `custom` 作为补充，`selected` 保留。
- 跳过的题 ⇒ `{id, selected: []}`。

参考实现的答案构造（`⟨P⟩\dsh-client-ui-user-questions\lib\client.js:537-549`）：

```js
const answer = { answers: questions.map((item, itemIndex) => {
    const value = values[itemIndex];
    if (value.skipped) return { id: item.id, selected: [] };
    const custom = value.custom.trim();
    return { id: item.id, selected: custom === "" || item.multiSelect === true ? value.selected : [], ...custom === "" ? {} : { custom } };
}) };
```

**取消有两个方向，编码不同**：

1. **Host 撤回**：客户端收到 `{type:'cancel',eventId}` 且本地 `signal` 中止。**此时什么都不要回**。参考实现在此路径上跳过 POST（`⟨P⟩\dsh-api-gateway\lib\types\client\remote-events.js:137-138`）。触发撤回的三种情形（`⟨P⟩\dsh-api-gateway\lib\index.js` 的 `startRemoteEvent` / `receiveRemoteEventResult` / `finishRemoteEvent`）：轮次中止、Agent Context 释放，以及**另一个客户端先答了**（结算 `settleRemoteEvent` → `finishRemoteEvent` 给剩余投递方推 `cancel`）——最后这条是多窗口下「问卷 / 审批该跟着一起收场」的权威信号。
2. **用户主动取消**：客户端发 `rejected`：

```json
{"clientId":"b0f1...","eventId":"7a2b...","outcome":{"kind":"rejected",
 "error":{"name":"UserQuestionError","message":"user cancelled the question","code":"ASK_CANCELLED"}}}
```

`UserQuestionError` 的错误码集合：`EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`ASK_ABORTED`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、以及浏览器实际使用的 `ASK_CANCELLED`（`⟨P⟩\dsh-user-questions\lib\types\index.d.ts:39-42` + `⟨P⟩\dsh-client-ui-user-questions\lib\client.js:58-64`）。

### 5.6 计划模式（plan mode）

**没有计划专用的线上事件、端点或审批。** 计划模式由三件事组成：

**(a) 开关是一条命令**，不是事件：发 `commands/execute`，`line: "/plan off"`。开关状态是会话投影键 `plan`：

```ts
export interface PlanProjection { active: boolean; pending: boolean; }
```

**(b) 模型用 `exit_plan_mode` 工具请求离开**，参数 `{plan: string}`（必须以 `#` 标题开头），返回 `{approved: true}`。

**(c) 确认是「用户提问」，不是「审批」**（`⟨P⟩\dsh-plan-mode\lib\index.js:34-40, 257-294`）：

```js
const EXIT_PLAN_MODE = "exit_plan_mode";
const REVIEW_ID = "plan-review";
const APPROVE_LABEL = "Approve";
const KEEP_PLANNING_LABEL = "Keep planning";
...
const answer = await interaction.ask({
    questions: [{
        id: REVIEW_ID,
        header: "Plan review",
        question: "Approve this plan and leave plan mode?",
        detail: args.plan,
        options: [
            { label: APPROVE_LABEL, description: "Leave plan mode; the plan is carried out from the next step." },
            { label: KEEP_PLANNING_LABEL, description: "Stay in plan mode; feedback goes back to the model." }],
        intent: { kind: "plan-review", approve: APPROVE_LABEL }
    }],
    agent,
    signal: exec.signal
}).catch((cause) => {
    if (cause instanceof UserQuestionError && cause.code === "ASK_CANCELLED") throw new Error("The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.");
    throw cause;
});
...
const reviewItems = answer.answers.filter((entry) => entry.id === REVIEW_ID);
const item = reviewItems.length === 1 ? reviewItems[0] : void 0;
if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== void 0) {
    const feedback = item?.custom ?? "";
    throw new Error(feedback === "" ? "The user chose to keep planning; revise the plan and present it again." : `The user chose to keep planning; their feedback: ${feedback}`);
}
```

**客户端如何确认计划**：识别 `request.questions[0].intent?.kind === 'plan-review'`，用：

```json
{"answers":[{"id":"plan-review","selected":["Approve"]}]}
```

判定规则是**严格的**：必须有且仅有一个选中项，且标签等于 `intent.approve`，且**不能带 `custom`**。任何其他形状（包括 `custom` 文本）都被读作「继续规划」，`custom` 会作为反馈回给模型。
「先聊聊」= 发 `ASK_CANCELLED` 的 `rejected`（不是答案）。

### 5.7 不卡死 Agent 的硬性规则

1. **收到的每一个 `waterfall` 帧都必须回。** Host 会一直持有这条 Cordis waterfall，直到**每一个**收到投递的客户端都回了结果。不认识的用 `{"outcome":{"kind":"next"}}`（委托给链上的下一个监听器）。
2. **断开连接不会释放 pending waterfall。** `removeRemoteEventClient` 只是**丢掉投递**，不 settle 任何东西（`⟨P⟩\dsh-api-gateway\lib\index.js:698-702`）：请求会一直挂着，直到另一个客户端回、或 Host 侧 `AbortSignal` 触发。→ **一个连着却不理的客户端能把 Agent 永久挂住。**
3. **`result` 与 `rejected` 不可互换**：审批的 `rejected` 会**抛进**等待方，`result` 是 resolve。
4. **waterfall 会在连接/重连时重投递**（`⟨P⟩\dsh-api-gateway\lib\index.js:598` 的 `for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`）——同一次请求可能被投递两次，客户端必须**按 `eventId` 幂等**。相反，`emit` 事件**不重放**。
5. **`$events/result` POST 失败会终结整代**（客户端实现会 `abort` 整个 generation），触发重连并重投递。
6. 先答 `ready` 再做别的；保持回 Pong（2 秒一次，2 次不回被 terminate）。

---

## 6. 数据模型

### 6.1 线上事件信封

`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:384-407`（逐字）：

```ts
/** Browser wire surface operation; replacement endpoints are earlier event seqs in surface order. */
export type SessionWireSurfaceOp = 'append' | {
    readonly op: 'replace';
    readonly startSeq: number;
    readonly endSeq: number;
};
export type SessionHistoryRecord = SessionEventEntry;
export interface SessionWireEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: JsonValue;
    readonly ignorable?: true;
    readonly sourceEventSeqs?: JsonValue;
    readonly surfaceOp?: JsonValue;
}
export interface SessionEventEntry { readonly type: 'event'; readonly event: SessionWireEvent; }
```

**客户端校验规则**（`assertSessionWireEvent`，`⟨P⟩\dsh-api-session-controller\lib\client.js:289-308`）：只允许这 7 个键；`seq` 非负安全整数；`time` 安全整数；`data` 必须存在。

**`ignorable` 的语义**（`⟨P⟩\dsh-session\lib\types\types.d.ts:468-478`）：

> 不认识的 `type` 且**没有** `ignorable: true` → 读者**必须拒绝重建会话**，而不是静默丢弃。有 `ignorable: true` 才能安全跳过。

这是**向前兼容的硬要求**：客户端必须维护一份「已知事件类型集合」，遇到未知且非 ignorable 的事件要报错（或至少明确降级），不能当作没看见。

**`surfaceOp` / `sourceEventSeqs`**（`⟨P⟩\dsh-session\lib\types\types.d.ts:407-446`）：

- 只有 4 种「表层事件」可以携带：`system/message`、`user/message`、`assistant/message`、`tool/result`；它们**必须**带 `surfaceOp`。
- `'append'`：追加到尾部（常规路径）。
- `{op:'replace', startSeq, endSeq}`：用本节点替换 `[startSeq, endSeq]` 闭区间内的表层节点；`sourceEventSeqs` 必须**包含每一个被遮蔽的节点**。压缩（compaction）用它。
- **人类对话记录不应该用 surface**：

> *"The model-visible surface deliberately shadows replaced ranges, so it is the wrong source for a human transcript — a landed replacement would erase conversation the user already saw. Append-origin events are that transcript's durable source material; replacement copies stay model-only."*（`⟨P⟩\dsh-session\lib\types\surface.d.ts:28-33`）

→ **渲染历史时只取 `surfaceOp === 'append'` 的表层事件**；这也正是 Host 自己的分页规则。

### 6.2 事件类型全集（核心）

`⟨P⟩\dsh-session\lib\types\types.d.ts:242-404`（逐字）：

```ts
export interface SessionEventMap {
    'turn/start': { turn: number; };
    'turn/end': { turn: number; reason: TurnEndReason; };
    'step/start': { turn: number; step: number; };
    'step/end': { turn: number; step: number; };
    'user/message': UserMessage;                                  // data 就是 {id, role:'user', content, source}
    'system/message': { turn: number; step: number; message: SystemMessage; };
    'assistant/message': {
        turn: number;
        step: number;
        message: AssistantMessage;
        stream: AssistantStreamRecord[];
        usage?: TokenUsage;
        interrupted?: true;
    };
    'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[]; };
    'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string; };
    'tool/result': {
        turn: number;
        step: number;
        message: ToolResultMessage;
        error?: { name: string; code: string };                   // 仅当 tool-result 块 isError:true
        meta?: JsonValue;                                          // 工具私有的展示负载（如 fs 的 diff）
    };
    'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; };
    'request/context': RequestContext;
    'session/end-seed': { inherited?: true };
}
```

`TurnEndReason`（`⟨P⟩\dsh-session\lib\types\types.d.ts:148-201`）：

```ts
export type TurnEndReason =
    | { kind: 'completed' }
    | { kind: 'aborted';   reason: TurnEndCancelCause }   // 'user' | 'parent' | {kind:'hook',reason} | 'disposed' | 'legacy'
    | { kind: 'blocked' }
    | { kind: 'error';     error: LlmFailure }            // {message, code, status?, providerRetryAfterMs?, requestId?}
    | { kind: 'max-tokens' }
    | { kind: 'interrupted' };                            // 崩溃后补写的收尾
```

**没有独立的 `error` 会话事件**——错误一律走 `turn/end.reason.kind === 'error'`、`llm/retry.failure`、`compaction/end.error`。

### 6.3 插件扩展事件（客户端至少要能安全跳过）

| 事件 | data 形状 | 来源 |
|---|---|---|
| `model/selection` | `{provider, model, reasoningEffort?}` | `⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:29-37` |
| `agent/inbox/spliced` | `{target:'next-turn'\|'next-step', start, removedCount?, inserted: UserMessage[], outcome?:'canceled'}` | `⟨P⟩\dsh-agent\lib\types\types.d.ts:73-88` |
| `compaction/start` / `summary` / `end` / `prune` | 见 `⟨P⟩\dsh-compaction\lib\types\types.d.ts:21-98` | |
| `session/title` | `{title, messageSeqs, source}` | `⟨P⟩\dsh-session-title\lib\types\types.d.ts:22-41` |
| `llm/retry` / `llm/retry-started` | `{retryId, turn, step, …}` | `⟨P⟩\dsh-llm-retry\lib\types\types.d.ts:12-41` |
| `command/run` / `command/done` | `{commandId, name, args?, source}` / `{commandId, kind, text?, sourceEventSeq?}` | `⟨P⟩\dsh-commands\lib\types\types.d.ts:88-117` |
| `approval/policy` | `{policy, source?:'delegation'}` | `⟨P⟩\dsh-user-approval\lib\types\index.d.ts:17-31` |
| `approval/asked` / `approval/decided` | `{id, toolName, callId?, reason?}` / `{id, outcome}` | `⟨P⟩\dsh-user-approval\lib\types\types.d.ts:28-52` |
| `sandbox/mode` | `{mode, source?:'delegation'}` | `⟨P⟩\dsh-sandbox-policy\lib\types\session-mode.d.ts:23-36` |
| `permission/preset` | `{preset: string}` | `⟨P⟩\dsh-permission-presets\lib\types\index.d.ts:31-41` |
| `plan/mode` | `{active: boolean}` | `⟨P⟩\dsh-plan-mode\lib\types\index.d.ts:30-39` |
| `todo/write` | `{todos: TodoItem[]}` | `⟨P⟩\dsh-tool-todo\lib\types\types.d.ts:27-32` |
| `goal/change` | `GoalChangeMeta` | `⟨P⟩\dsh-goal\lib\types\domain.d.ts:47-52` |
| `hook/invoked` / `hook/result` | `{turn, point, dialect, matcher?, handlerId}` / `{...}` | `⟨P⟩\dsh-hook-protocol\lib\types\types.d.ts:8-39` |
| `agent-preset/selected` | `{agentPreset: string}` | `⟨P⟩\dsh-agent-presets\lib\types\session.d.ts:18-28` |
| `deliverables/presented` | `{turn, callId, files: PresentedFile[]}` | `⟨P⟩\dsh-tool-present\lib\types\types.d.ts:11-18` |
| `workspace/changes` | `{turn}`（清单**不在**事件里，经 `/api/changes.summary` 另取） | `⟨P⟩\dsh-workspace-changes\lib\types\types.d.ts:99-108` |

权威名称集合在 `⟨P⟩\dsh-session\lib\types\known-event-types.js` 的
`KNOWN_SESSION_EVENT_TYPES`：0.1.5-rc.1 是 56 个，0.1.6-alpha 起新增
`workspace/changes`（提交 `f937f4e23b`，log-only：只宣告「这一轮改了文件」，
清单与逐文件对比留在 Host 内存里按 `workspaceChanges.summary(sessionId, seq)` /
`diff(...)` 提供，Session 释放或 Host 重启后就没有了）。客户端按它渲染轮尾的
**改动文件卡片**（见下文「改动清单路由」）。

**改动清单路由**（`dsh-client-ui-deliverables` 注册在 Connection 的认证围栏内）：

| 路由 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/api/changes.summary` | GET | `sessionId`, `seq` | `{turn, files[], total, added, deleted}`；Host 不再持有该清单时 **404** |
| `/api/changes.diff` | GET | `sessionId`, `seq`, `index` | `WorkspaceFileDiff`（`text` / `binary` / `oversized`）；清单或下标不在时 404 |
| `/api/changes.open` | POST | `sessionId`, `seq`, `index` | 在 Host 桌面上打开该文件；204 |

`files[]` 每一项是 `{path, display, added, deleted, binary?, oversized?}`，Host 已按
`display` 排好序；`total` / `added` / `deleted` 是**含被 Host 上限截掉的文件**在内的
完整合计。认证与其它 `/api/*` 相同（cookie，由 `GET /?token=` 换取）。

> **未确认**：`team/member`、`team/message/delivered`、`team/message/queued`、`team/task` 在 `KNOWN_SESSION_EVENT_TYPES` 里，但**安装树里没有任何 `.d.ts` 声明它们的 data 形状**。推测属于未安装的 experimental agent-team 包。客户端应按 `ignorable` 规则处理。

### 6.4 内容块（ContentBlock）

**规范标签是 `text` / `reasoning` / `image` / `file` / `tool-call` / `tool-result`（带连字符）。**
`⟨P⟩\dsh-llm\lib\types\types.d.ts:38-102`（逐字）：

```ts
export interface TextBlock { type: 'text'; text: string; }
export interface ReasoningBlock { type: 'reasoning'; text: string; }        // 思考，不是 'thinking'
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; }
export interface FileBlock  { type: 'file';  attachment: FileAttachmentRef; }
export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string; }  // arguments 是原始 JSON 字符串
export interface ToolResultBlock { type: 'tool-result'; toolCallId: ToolCallId; content: ContentBlock[]; isError?: boolean; }
export interface ContentBlockMap {
    'text': TextBlock; 'reasoning': ReasoningBlock; 'image': ImageBlock;
    'file': FileBlock; 'tool-call': ToolCallBlock; 'tool-result': ToolResultBlock;
}
export type ContentBlock = ContentBlockMap[keyof ContentBlockMap];
```

> **不要写 `type:'thinking'`、`type:'tool_use'`、`toolUseId`、`type:'tool_result'`（下划线版）——这些在本协议里都不存在。** 思考块是 `reasoning`，工具调用是 `tool-call`，工具结果是 `tool-result`（连字符），工具调用 id 字段名是 `id`（在 `ToolCallBlock` 里）/`toolCallId`（在 `ToolResultBlock` 里）。

### 6.5 消息形状

`⟨P⟩\dsh-llm\lib\types\message.d.ts:119-153`（逐字）：

```ts
export interface Message {
    readonly id: MessageId;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends Message { readonly role: 'user'; }
export interface AssistantMessage extends Message { readonly role: 'assistant'; readonly source: ModelMessageSource; }
export interface ToolResultMessage extends Message { readonly role: 'user'; readonly content: [ToolResultBlock]; readonly source: ToolMessageSource; }
export interface ModelMessageSource extends AssistantProvenance { kind: 'model'; }
export interface AssistantProvenance { provider: string; model: string; replayState?: unknown; }
export interface ToolMessageSource { kind: 'tool'; callId: ToolCallId; }
```

`MessageSource` 的 `kind` 取值：`'user' | 'plugin' | 'model' | 'tool'`（核心），加上插件合并的 `'user-rpc'`（`{kind:'user', rpcId, clientTimeZone?}`，**客户端发送的消息就带这个**）、`'agent-instructions'`、`'goal'`、`'skill-invocation'` 等。
`plugin` 源还带 `form?: 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'`（`ContextFormed`，`⟨P⟩\dsh-llm\lib\types\message.d.ts:42-89`）。

### 6.6 附件引用

`⟨P⟩\dsh-attachment\lib\types\types.d.ts:4-41`（逐字）：

```ts
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface ImageAttachmentRef {
    attachmentId: AttachmentId;
    mediaType: ImageMediaType;
    bytes: number;
    width: number;
    height: number;
    name?: string;
    originalDimensions?: { width: number; height: number };
}
export interface FileAttachmentRef {
    attachmentId: AttachmentId;   // 文件的是 sha256 摘要
    name: string;
    bytes: number;
}
```

`AttachmentIdType` 只是 `AttachmentId` 的别名（`⟨P⟩\dsh-attachment\lib\types\index.d.ts:10`）。取图片字节：`session/attachment`（返回 base64），或直接 `GET /api/file?path=<绝对路径>`。

### 6.7 流式块（StreamChunk）

`⟨P⟩\dsh-llm\lib\types\types.d.ts:351-389`（逐字）：

```ts
export type StreamChunk = {
    type: 'block-start'; index: number; blockType: ContentBlockType;
} | {
    type: 'text-delta'; index: number; text: string;
} | {
    type: 'reasoning-delta'; index: number; text: string;
} | {
    type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string;
} | {
    type: 'block-end'; index: number; block: ContentBlock;
} | {
    type: 'usage'; usage: TokenUsage;
} | {
    type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope;
};
```

`FinishReason` = `{kind:'stop'} | {kind:'tool-calls'} | {kind:'max-tokens'} | {kind:'aborted', failure} | {kind:'error', failure}`。

**实时帧** `SessionAssistantStreamFrame`（逐字，`⟨P⟩\dsh-api-session-controller\lib\types\types.d.ts:441-468`）：

```ts
export type SessionAssistantStreamFrame = {
    readonly type: 'start';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly startedAfterSeq: SessionSeqCursor;
    readonly turn: number;
    readonly step: number;
} | {
    readonly type: 'chunk';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly time: number;
    readonly chunk: JsonValue;            // 反序列化后就是一个 StreamChunk
} | {
    readonly type: 'end';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;               // 已发 chunk 帧的稠密计数
    readonly outcome:
        | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: number }
        | { readonly kind: 'abandoned' };
};
```

开窗基线（`SessionAssistantStreamBaseline` / `SessionAssistantStreamAttempt`，同文件 `:423-439`）：`{revision, activeAttempt?: {attemptId, startedAfterSeq, turn, step, nextIndex, stream: JsonValue[]}}`。

**中途挂上的语义（`[契约]`，2026-09-21 因一次真实缺陷补记）**：为**已经在跑的 attempt** 重开 follow 时，服务端**不会重发 `start` 帧，也不会重发已经发过的增量**——进行中的内容全在开帧的这份基线里：`stream` 是打包过的紧凑记录（`text-chunks` / `reasoning-chunks` / `tool-call-chunks` / 原样 `chunk`，见 `dsh-llm` 的 `AssistantStreamRecord`），`nextIndex` 是**已经发过的增量条数**，其后接续的实时 `chunk` 帧从 `index === nextIndex` 开始（`history.ts` 按 `ordinal > assistantStreamOrdinalCut` 只转发开帧之后的帧）。所以客户端必须自己 `expandAssistantStream(stream)` 取前 `nextIndex` 条重建进行中的块，并从 `activeAttempt` 取 `attemptId` / `turn` / `step`——官方 Web 端走的正是这步（`ClientAssistantStream.replace`）。漏了这步的症状：进行中的节点没有归属（或只剩挂上之后的尾巴），durable 结算时与它**分裂成两条节点**。等价实现见本仓库 `src/dsh/assistantStream.ts` + 适配器的 `replayActiveAttempt`。

**如何把 chunk 折成 UI**（参考实现 `⟨P⟩\dsh-client-ui-chat\lib\client.js` 的 `updateChunk`，逐字摘录）：

```js
switch (chunk.type) {
  case "block-start":
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
      break;
  case "text-delta":
      blocks[chunk.index] = { kind: "text", text: (previous?.kind === "text" ? previous.text : "") + chunk.text };
      break;
  case "reasoning-delta":
      blocks[chunk.index] = { kind: "reasoning", text: (previous?.kind === "reasoning" ? previous.text : "") + chunk.text };
      break;
  case "tool-call-delta": {
      const base = previous?.kind === "tool-call" ? previous : { kind: "tool-call", callId: "", name: "", argsRaw: "" };
      blocks[chunk.index] = { kind: "tool-call", callId: base.callId || String(chunk.id), name: chunk.name ?? base.name, argsRaw: base.argsRaw + chunk.argumentsDelta };
      break;
  }
  case "block-end": blocks[chunk.index] = toAssistantBlock(chunk.block); break;
  case "usage": return { ...state, usage: chunk.usage };
  default: return state;
}
```

**settle 规则**（`⟨P⟩\dsh-api-session-controller\lib\client.js:1482-1496`）：一条 durable `assistant/message` 或 `assistant/attempt` 结算一个活跃 attempt，当且仅当

- `event.seq > attempt.startedAfterSeq`，且
- `event.data.turn === attempt.turn && event.data.step === attempt.step`，且
- 若是 `assistant/message`，还必须 `surfaceOp === 'append'`（替换式的 assistant 消息**永远不结算**活跃 attempt），且
- `end` 帧的 `outcome.eventType` 与真实事件类型一致，`outcome.seq` 命中已暂存的那条。

`outcome.kind === 'abandoned'` ⇒ 丢弃瞬时行，不产生 durable 条目。`revision` / 稠密 `index` / settlement 出现断口 ⇒ 重开 follow。

### 6.8 Token 用量

`⟨P⟩\dsh-llm\lib\types\types.d.ts:128-150`（逐字）：

```ts
export interface TokenUsage {
    inputTokens: number;          // 仅未缓存输入
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;     // 已含在 outputTokens 内
}
```

计数字段**互斥不重叠**：计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`。

出现位置：

- `assistant/message.data.usage`
- `compaction/summary.data.usage`
- 实时 `StreamChunk {type:'usage', usage}`

累计投影 `tokenUsage`（`⟨P⟩\dsh-token-meter\lib\types\projection.d.ts:12-17`）——**注意字段名不同**：

```ts
export interface TokenUsageProjection {
    uncachedInputTokens: number;   // 不是 inputTokens！
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
```

另有 `contextPressure` = `{pressureTokens?, projectedTokens?, contextWindow?}`、`contextBreakdown` = `{systemTokens, toolsTokens, messageTokens}`（启发式估算）、`sessionStats` = `{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}`。
**全协议没有任何价格 / 费用字段。**

### 6.9 seq、轮次与时间

- `seq` 就是日志下标，**连续稠密**（`seq = log.length`，`⟨P⟩\dsh-session\lib\types\index.d.ts:199-200`）。持久化层拒绝不稠密的行和不连续的 seq。
- `seq = -1` 表示「还没有任何事件」（`SessionSeqCursor`）。
- `time` 是 Unix epoch **毫秒**。
- 轮次边界：`turn/start` / `turn/end`（payload `{turn}` / `{turn, reason}`）；步骤边界：`step/start` / `step/end`（`{turn, step}`）。`turn/start` 在该轮 prompt 与所有 step **之前**落盘，所以它的 seq 就是「整轮跳转」的锚点。
- `turnOutline` 投影给出每个已开始轮次的 `{turn, seq, prompt, response}`，是「跳到第 N 轮」的正确入口。

### 6.10 投影（projection）与投影缓存

**投影是什么**：从完整 durable 日志折叠出来的**整体值**快照，按 key 注册。客户端读它比自己重放日志更省事。每个 key 由某个插件用 `declare module '@deepseek-ai/dsh-session-projection/types'` 注册；插件没加载 ⇒ **key 缺失 = 能力缺失**，不是错误。

**客户端从哪读投影**：

1. `session/follow` 开帧的 `snapshot.projections`：`{asOfSeq, values}`（`asOfSeq` 恒等于 `snapshot.cursor`）。
2. `session/list` 每行的 `projections?: {asOfSeq, values}`（可能是缓存的**陈旧提示**）。
3. `session/control` 流的 `{type:'baseline'} ` 帧里 `value.projections: Record<SessionId, SessionProjectionBaseline>`，以及其后的 `{type:'projection', sessionId, key, value, seq}` 增量。

**客户端消费规则**（`⟨P⟩\dsh-api-session-controller\lib\types\client\sessions\projection-store.d.ts:39-48`，逐字）：

> *"a baseline seeds rows at its cut, a push frame updates one row, and in both paths a lower-or-equal seq loses — a replayed frame cannot regress a value, a stale baseline cannot overwrite a newer frame. A key the store has never seen reads `undefined` (capability absence)."*

**全部客户端可见的投影键**（本机安装树里 19 个）：

| key | 值类型 | 用途 |
|---|---|---|
| `title` | `string \| null` | 会话标题（列表行直接显示） |
| `turnOutline` | `{turn, seq, prompt, response}[]` | 轮次大纲 + 跳转锚点 |
| `plan` | `{active: boolean; pending: boolean}` | 计划模式 |
| `permissions` | `{options: PresetOption[]; currentValue: string}` | 权限预设选择器（见 §4.4 的未确认标注） |
| `agentPreset` | `string \| null` | 当前 preset |
| `modelSelection` | `{lastUsed: ModelSelection\|null; next: ModelSelection\|null}` | 模型选择折叠 |
| `tokenUsage` | `TokenUsageProjection` | 累计 token |
| `contextPressure` | `{pressureTokens?, projectedTokens?, contextWindow?}` | 上下文压力 |
| `contextBreakdown` | `{systemTokens, toolsTokens, messageTokens}` | 上下文组成（启发式） |
| `sessionStats` | `{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}` | 统计 |
| `todos` | `TodoItem[] \| null` | 待办列表 |
| `goal` | `GoalProjection \| null` | 目标 |
| `inbox` | `{'next-turn': JsonValue[]; 'next-step': JsonValue[]}` | 待处理收件箱 |
| `schedule` | `ScheduleRecord[]` | 定时提醒 |
| `subagentCatalog` | `SubagentCatalogEntry[]` | 子代理目录 |
| `subagent` | `SubagentIdentityProjection \| null` | 自身子代理身份 |
| `subagentTiming` | `SubagentTimingProjection` | 子代理耗时 |
| `sessionListMetadata` | `{blank: boolean; lastPromptAt: number\|null}` | 冷列表提示 |
| `imageLimits` | `ImageAttachmentLimits` | 图片上传限制（`{maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, maxImageDimension, mediaTypes}`） |

**只存在于 Host、不过线**的键：`turnBoundary`、`llmRetry`、`sandboxMode`、`timeContext`、`tmuxContext` 等。

**投影缓存**（`@deepseek-ai/dsh-session-projection-cache`）是**折叠捷径，不是权威**：

> *"a row is possibly stale (its `seq` says how stale) but never wrong, so every write path is fail-soft ... and a `ver` mismatch discards the row instead of migrating it."*（`⟨P⟩\dsh-session-projection-cache\lib\types\index.d.ts:1-16`）

**客户端不需要直接接触它**——`session/list` 与 `session/follow` 已经在服务端用它加速了。

### 6.11 渲染历史：该用哪个视图

| 需求 | 用什么 |
|---|---|
| 打开一个已有会话 | `session/follow`（拿 `snapshot` 开窗 + 实时增量）。仅当只需要静态历史且不想开流时，用 `session/page` + 先前的 `throughSeq` |
| 往上翻更早的消息 | `session/page`，`beforeSeq = ` 当前最老记录的 seq，`throughSeq` 沿用开帧 cursor |
| 渲染人类对话记录 | 只取 `surfaceOp === 'append'` 的 `user/message` / `assistant/message` / `tool/result` / `system/message`（**不要**用 surface 折叠） |
| 渲染工具卡片 | `tool/call`（`name` + 原始 JSON `arguments`）+ `tool/result`（`message.content` 里的 `tool-result` 块，`isError`）+ 可选 `meta` |
| 渲染思考 | `reasoning` 内容块（durable）或 `reasoning-delta`（实时） |
| 显示上下文占用 / token | 投影 `tokenUsage` / `contextPressure` / `contextBreakdown` |
| 显示标题 | 投影 `title`（不要自己从第一条消息截断） |
| 轮次导航 | 投影 `turnOutline`，`loadThrough(entry.seq)` |

---

## 7. 版本与兼容性

### 7.1 版本事实

| 项 | 值 | 证据 |
|---|---|---|
| CLI 包版本 | `0.1.5-rc.1` | `⟨D⟩\package.json` 的 `"version"`；`dsh --version` 输出 `0.1.5-rc.1` |
| 会话日志格式版本 | `SESSION_FORMAT_VERSION = 3` | `⟨P⟩\dsh-session\lib\types\types.d.ts:54` |
| **协议版本协商** | **不存在** | 没有任何握手 / version 字段；`SessionWireHeader.version` 是**日志格式版本**，不是协议版本 |
| 服务端身份端点 | **不存在**（0.1.2 起移除了 `host.describe`） | `⟨W⟩\src\dsh\apiClient.ts:92-93, 237-253` |

**如何判断服务端版本**：没有直接途径。可行的替代：

1. 读 `dsh` 的 `package.json`（本地安装场景可行）。
2. 能力探测：发端点看是否 404 / `gateway/arguments-invalid`（第三方实现就是这么做的）。
3. 探测旧版：`POST /api/host.describe`（0.1.1- 的点号端点），存活即旧版（`⟨W⟩\src\dsh\apiClient.ts:237-253`）。

### 7.2 已知的破坏性变更点

| 变更 | 从 → 到 | 客户端影响 |
|---|---|---|
| `host.describe` 移除 | 0.1.1- → 0.1.2 | 探测端点改用 `session/list` |
| 点号端点改斜杠命名空间 | 0.1.1- → 0.1.2 | 如 `llm.providers` → `llm/listProviders`，`session.models` → `session/modelCatalog` |
| `/api` 需要签名 cookie | 0.1.1- → 0.1.2 | 必须先 `GET /?token=` 换 cookie |
| 一轮多路复用：`events.mux` 移除 | 0.1.1- → 0.1.2 | 审批/提问改走 `$events` 逻辑流 |
| 历史分页改 `session/page` 且需 `throughSeq` | 0.1.1- → 0.1.2 | |
| `session/follow` 快照 header 的 `seedLength` → `isSeeded` | 0.1.2- → 0.1.5 | |
| `session/page` 不再返回压缩的 `chunks` 记录 | 0.1.2- → 0.1.5 | 历史即原始事件；逐 token 增量**不再持久化**（只有 `assistant/message.stream` 的紧凑形态） |
| `commands/execute` 第三参数 `images` → `submittedAttachments` | 0.1.2- → 0.1.5 | 名字精确校验 ⇒ 必须做双名回退 |
| `commands/list` 描述符 `input.images` → `input.attachments` | 0.1.2- → 0.1.5 | |
| `subagents/prompt` 新增**必填** `delivery` | 0.1.2- → 0.1.5 | |
| `fileUploads/upload` 新增（文件先上传取 `receiptId`） | 0.1.2- → 0.1.5 | |
| 日志格式 v2 → v3：replace 信封 `{op:'replace', start, end}` → `{op:'replace', startSeq, endSeq}` | 存储层 | **只在读旧日志文件时相关；线上永远是 v3 形态** |

来源：`⟨W⟩\src\dsh\apiClient.ts:77-89` 的注释（原作者逐条核对过 0.1.2→0.1.5 差异）+ 本次独立核对。

### 7.3 版本无关的健壮写法

1. **端点探测**：把 `gateway/arguments-invalid` 当作「参数名可能不同」的信号，做候选名回退并**记住**成功的名字（`⟨W⟩\src\dsh\apiClient.ts:485-523` 的做法）。
2. **事件类型白名单**：维护 `KNOWN_SESSION_EVENT_TYPES`，未知且无 `ignorable` 的事件**明确降级**（至少在 VS Code 输出通道里报一次）。
3. **不要依赖行号**，只依赖符号名。
4. **不要硬编码端口 3080**：用户 profile 可能覆盖（用 `cordis.patch.yml` 的 `port`）。

---

## 8. 最小可用客户端流程（要点）

原稿此节是约 170 行的逐行伪代码，压缩为按调用顺序排列的要点；每一步的契约细节以
§5–§7 与 §9.2–§9.4 对应小节为准。

1. **启动与授权**：spawn `dsh web --no-open --port 0`，从 stdout 按正则
   `^dsh web: (http\S+)/\?token=([A-Za-z0-9_-]+)$` 解析 origin 与 token（端口唯一来源，
   不得假设 3080，见 §7.3）；`GET <origin>/?token=`（`redirect:'manual'`，期待 303），
   取 `set-cookie` 首段 `dsh-auth-<h>=<v>` 作为后续全部请求的 cookie；token 失效表现为
   401/403。
2. **HTTP RPC 信封**：每个调用 `POST /api/<method>`，体为
   `{type:'client-request', rpcId, method, payload:{args}}`；校验响应 `rpcId` 一致且
   `result.ok`，失败抛 `result.error.{message, code}`。
3. **WS 多路复用**：连 `<origin 换 ws>/api/remote.mux`（带 cookie 头）；socket 就绪前先把
   open 帧缓冲起来，就绪后补发。必须处理的帧：`item`（按 `streamId` 派发）、`end`
   （移除该流）、`error`（移除该流并重开）；取消流发 `{type:'cancel', streamId}`。
4. **先挂 `$events` 再做任何事**（唯一人机交互入口，必须最先就绪；`payload.args` 必须是
   `{}`，见 §5.1）。必须处理的帧类别：
   - `ready` → 记住 `clientId`（回复时要用）；
   - `cancel` → 把对应审批/问卷收场，**不回 POST**（§5.5）；
   - `waterfall` → **每一帧都必须回**：`approval/request` 弹模态回
     `allowed-once`/`rejected`；`user-questions/request` 逐题收集、**一次性回整批**
     `{answers}`；计划确认认 `intent.kind==='plan-review'`，答案严格为
     `[intent.approve]` 且**不带 `custom`**（§5.6）；未知事件回 `{kind:'next'}`，绝不静默；
   - 用户主动取消提问 → `{kind:'rejected', error:{name:'UserQuestionError',
     code:'ASK_CANCELLED'}}`；
   - 回复走 `POST $events/result`（`clientId` + `eventId` + `outcome`）。
5. **建会话**：`session/create`（`request.cwd` + `agentPreset`）。
6. **开 `session/follow`**（同时拿开窗快照与实时增量；`request.address` 指向会话 +
   `maxMessages` + `assistantStream:true`）：
   - `snapshot` → 重置视图、逐条应用 durable 记录、以 `{asOfSeq, values}` 种下投影
     （高 seq 胜，§6.10）、有 `assistantStream.activeAttempt` 则用开窗基线重建进行中的块
     （先展开紧凑 `stream` 取前 `nextIndex` 条，再接实时增量，§6.7）；
   - `event` → 按 `seq` 去重后应用；未知类型且无 `ignorable` 必须明确降级（§6.1）；
     人类对话记录只认 `surfaceOp === 'append'` 的表层事件（§6.11）；
     `source.kind === 'user-rpc'` 时按 `rpcId` 回收本地乐观回显。
7. **发消息**：`session/prompt`（`requestId` 供乐观回显配对、`mode:'queue'`、`content` 为
   ContentBlock 数组、`clientTimeZone`）；流式渲染走 `assistant-stream` 帧：`start` 起行、
   `chunk` 按 `index` 折块（稠密计数，出现断口 ⇒ 重开 follow）、`end` 的
   `abandoned` 丢弃瞬时行 / `committed` 暂存等 durable 结算（settle 规则见 §6.7）。
8. **打断**：`session/cancel`。
9. **策略操作**：`session/selectModel`（provider/model/reasoningEffort）；
   `commands/execute`（`agentId` + `line` + `submittedAttachments`，0.1.2→0.1.5 参数改名
   需双名回退，§7.2）发 `/permission …`、`/plan off` 这类斜杠命令。

---

## 9. 附录

### 9.1 环境与实测事实（要点）

- `dsh --version`：`0.1.5-rc.1`。顶层命令 `web`（`--profile web` 别名）与 `plugin`；
  顶层选项 `--profile` / `--from-default-profile` / `--patch` / `--dump-config` /
  `--dump-default-config` / `-V/--version`。
- 默认端口 3080，但用户 profile 可用 `cordis.patch.yml` 的 `port` 覆盖 ⇒ 客户端必须从
  启动日志解析端口；`cookieMaxAgeDays` 默认 30，同样可被用户补丁覆盖。
- `dsh web --help` 在受限沙箱里因无法写 `<home>/.dsh/profiles/web/cordis.yml` 报 `EPERM`
  （`prepareProfile` 的 `node:fs` `writeFileSync`）；普通终端可正常输出，选项清单取自
  `⟨P⟩\dsh-web-app\lib\startup.js`。
- 未带 cookie 的 `GET /` 与 `GET /api/session/list`（方法也不对）均 401；
  `GET /favicon.svg` 200（静态资源公开）。
- 官方前端 bundle 为 `assets/index-*.js` + `assets/vendor-*.js`（哈希随版本变化）。
- `$DSH_HOME` 默认 `~/.dsh`，`DSH_HOME` 环境变量可覆盖统一根。

### 9.2 端点位置参数名总表（严格校验用）

来源：各包 `lib/typert.host.js` 的 descriptors。`args` 里**必须恰好**有这些键。

| 端点 | `args` 键（按序） |
|---|---|
| `session/list` | `_request` |
| `session/search` | `request` |
| `session/create` | `request` |
| `session/selectModel` | `request` |
| `session/modelCatalog` | *（无）* |
| `session/rename` | `request` |
| `session/fork` | `request` |
| `session/prompt` | `request` |
| `session/attachment` | `request` |
| `session/updateQueue` | `request` |
| `session/cancel` | `request` |
| `session/page` | `request` |
| `session/follow` | `request`（**stream**） |
| `session/control` | *（无）*（**stream**） |
| `session/canOpenWorkspacePath` | *（无）* |
| `session/openWorkspacePath` | `request` |
| `skills/list` | `request` |
| `fileReferences/list` | `agentId`, `query` |
| `sessionReferenceResolver/candidates` | `agentId`, `query` |
| `commands/execute` | `agentId`, `line`, `submittedAttachments` |
| `commands/list` | `agentId` |
| `agentPresets/list` | *（无）* |
| `agentPresets/select` | `agentId`, `agentPreset` |
| `agentPresets/read` | `agentPreset` |
| `agentPresets/copy` | `from`, `id`, `name?` |
| `agentPresets/deletePreset` | `id` |
| `settings/describe` | *（无）* |
| `settings/update` | `ns`, `patch`, `expectedRevision` |
| `settings/replace` | `ns`, `section`, `expectedRevision` |
| `settings/mutate` | `ns`, `ops`, `expectedRevision` |
| `settings/openSettingsDocument` | *（无）* |
| `settings/canOpenAgentPresetDirectory` | *（无）* |
| `settings/openAgentPresetDirectory` | `agentPreset` |
| `credentials/describe` | `refs` |
| `credentials/set` | `ref`, `value` |
| `credentials/unset` | `ref` |
| `llm/listProviders` | *（无）* |
| `llm/listConfigurableProviders` | *（无）* |
| `llm/discoverModels` | `settingsNs`, `request` |
| `fileUploads/upload` | `agentId`, `request` |
| `goals/create` | `agentId`, `request` |
| `goals/edit` | `agentId`, `ref`, `request` |
| `goals/get`/`pause`/`resume`/`complete`/`clear` | `agentId` (+ `ref`) |
| `subagents/list` | `parentSessionId` |
| `subagents/prompt` | `request` |
| `subagents/interruptByParent` | `childSessionId`, `parentSessionId`, `mode` |
| `workspace/create`/`rename`/`delete`/`insertBefore`/`insertSessionBefore`/`archiveSession` | `request` |
| `workspace/follow` | *（无）*（**stream**） |
| `workspaceFiles/list`/`stat`/`readAll`/`readBytes`/`readRelated` | `workspaceFileScopeId`, `path` (+ …) |
| `workspaceFiles/read` | `workspaceFileScopeId`, `path`, `range` |
| `workspaceFiles/changes` | `workspaceFileScopeId`（**stream**） |
| `directoryPicker/list` | `path` |
| `directoryPicker/pick` | *（无）* |
| `directoryPicker/createDirectory` | `path`, `name` |
| `messageFeedback/list`/`put`/`delete` | `request` |
| `sessionFeedback/record` | `request` |
| `pluginInventory/list` | *（无）* |
| `$events` | *（无，但必须是 `{}`）*（**stream**） |
| `$events/result` | `clientId`, `eventId`, `outcome` |

### 9.3 流端点总表

| `endpoint` | `payload.args` | 元素类型 |
|---|---|---|
| `session/follow` | `{request: SessionFollowRequest}` | `SessionFollowFrame` |
| `session/control` | `{}` | `SessionControlFrame` |
| `workspace/follow` | `{}` | `WorkspaceFollowFrame` |
| `workspaceFiles/changes` | `{workspaceFileScopeId}` | `WorkspaceFileWatchFrame` |
| `$events` | `{}`（**必须空对象**） | `ready` / `emit` / `waterfall` / `cancel` |

### 9.4 错误码速查

| code | 来源 | details |
|---|---|---|
| `gateway/arguments-invalid` | 网关 | 参数名/数量不匹配 |
| `gateway/input-invalid` | 网关 | 字段边界校验失败 |
| `gateway/bad-request` | Connection | 信封非法 |
| `gateway/cancelled` | 网关 | 调用方 signal 中止 |
| `gateway/service-unavailable` / `gateway/method-unavailable` / `gateway/invocation-unavailable` / `gateway/ambiguous-endpoint` / `gateway/definition-unavailable` | 网关 | 派发失败 |
| `gateway/result-invalid` / `gateway/signature-invalid` | 网关 | 结果或签名非法 |
| `session/not-found` | 各层 | `{sessionId}` |
| `session/model-unavailable` | | `{provider, model}` |
| `session/conflict` | | `{sessionId, requestedCwd, existingCwd?}` |
| `session/agent-busy` | | `{reason}` |
| `session/invalid-time-zone` | | `{value}` |
| `session/attachment-invalid` | | `{reason}` |
| `session/queue-item-not-found` | | `{itemId}` |
| `session/steer-unavailable` | | `{itemId}` |
| `session/title-invalid` | | `{sessionId}` |
| `session/fork-unavailable` | | `{sessionId}` |
| `session/workspace-attach-failed` | | `{sessionId, workspaceId}` |
| `agent-preset/not-found` / `invalid` / `read-only` / `locked` | | 见 §4.3 |
| `settings/conflict` | | `{ns, expected, actual}` |
| `settings/rejected` | | `{ns}` |
| `credential/rejected` | | `{ref}` |
| `workspace/invalid-path` / `name-conflict` / `move-invalid` | | |
| `directory-picker/unavailable` / `unreadable` / `exists` / `create-failed` | | |
| `llm/model-discovery-rejected` | | `{settingsNs, baseURL?}` |
| `subagent/not-found` | | `{parentSessionId, childSessionId}` |
| 用户提问 | `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_ABORTED`, `ASK_CANCELLED`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER` | 经 `rejected.error.code` |

所有 `RemoteErrorDetailsMap` 的声明散落在各包 `lib/types/*.d.ts` 的 `declare module '@deepseek-ai/dsh-typert-protocol'` 块里，可 grep `RemoteErrorDetailsMap` 复核。

### 9.5 官方 README（权威文档指针）

与客户端契约有关的权威说明随包分发、与运行产物同版本，都在本机安装树
`node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包名>\README.md` 下：
`dsh-client-connection`（传输与鉴权）、`dsh-api-gateway`（WS 多路复用/网关）、
`dsh-api-session-controller`（会话控制器，最详细的一份）、`dsh-api-remotes`（事件转发
选择）、`dsh-session-persistence-jsonl`（持久化与格式）。排查扩展的连接与鉴权链路先读
`dsh-client-connection`；follow / 投影 / 流式等会话行为以 `dsh-api-session-controller`
为准。

---

## 10. 不确定项汇总

1. **`team/*` 事件的实际 data 形状**：`KNOWN_SESSION_EVENT_TYPES`（`⟨P⟩\dsh-session\lib\types\known-event-types.js:61-64`）收录了 `team/member`、`team/message/delivered`、`team/message/queued`、`team/task`，但安装树里**没有任何 `.d.ts` 声明它们的 payload**（推测属于未随本安装发布的 experimental agent-team 包）。客户端应按 §6.1 的 `ignorable` 规则保守处理：未知类型且无 `ignorable: true` 时明确降级。
2. **`--port 0` 的端口发现**：`WebServer.port` 会返回 OS 分配的实际端口（`⟨P⟩\dsh-host-webserver\lib\types\index.d.ts` 的 `get port()`），`dsh web` 打印的 URL 里也应含该端口——但我**没有实测** `--port 0` 场景下的日志样式（截稿时无法在不干扰用户会话的前提下再起一个服务）。第三方实现目前使用固定端口。**建议**：把「解析日志行」当作唯一端口来源，不要假设任何默认值。
3. **多客户端抢占 waterfall**：协议允许同一 `eventId` 投递给多个客户端（`⟨P⟩\dsh-api-gateway\lib\index.js:673`），先回的生效、其余会收到 `cancel`。扩展**已按这条实现**（`$events` 的 `cancel` 帧 → 把本窗口那张审批 / 问卷卡收场，见 `controller.onEventFrame` 与 `adapter.cancelEvent`）。代码路径逐行确认过：`receiveRemoteEventResult` 先把**答复方**从投递集合里移除、再 `settleRemoteEvent` → `finishRemoteEvent` 给**剩余投递方**推 `{type:'cancel',eventId}`（所以答复方自己不会收到）。仍未实测的只有 `{kind:'next'}` 与 `{kind:'result'}` 混用时的精确竞态。
4. **`dsh web --help` 未能在受限沙箱里执行**：沙箱禁止写 `<home>/.dsh/profiles/web/cordis.yml`，
   `dsh web --help` 在 `prepareProfile` 阶段就以 `EPERM` 退出。选项清单因此**全部取自源码**
   `⟨P⟩\dsh-web-app\lib\startup.js:31-44`，与运行时一致（commander 的选项定义就是该函数），
   但未做命令行实测。普通终端下可自行 `dsh web --help` 复核。

> 已消除的不确定项（初稿曾标注，后经复核确认）：`PermissionSelect.currentValue`（§4.4）、`expectedRevision` 可省略（§4.5）。
