# scripts/tests/trajectory/ — S02 夹具工具链的离线回归

测的是 [`scripts/trajectoryFixture.ts`](../../trajectoryFixture.ts)（纯脱敏 / 扫描 / 不变量 /
登记校验）、[`scripts/trajectoryFixtureBuild.ts`](../../trajectoryFixtureBuild.ts)（提取 CLI）与
[`scripts/trajectoryFixtureVerify.ts`](../../trajectoryFixtureVerify.ts)（离线校验 CLI）。

全部**离线、零 token**：材料是本进程用 `zlib.zstdCompressSync` 造出来的**受控合成**日志或载荷，
写在 `mkdtemp` 临时目录里。**不读用户会话日志、不起 dsh、不发模型消息、不跑 smoke / 探针 / e2e。**

## 文件

### `fixture.test.ts`

脱敏库的纯函数与结构不变量断言（合成输入，不落盘）：

- 等长 / 换行位置 / 低熵 / 确定性的伪文；自由文本里的秘密被替换（含注入确认）；
- **秘密规则正向矩阵**（13 条各一份受控样本，且按**解码后的 `path`** 检查不含注入原文）、
  键名回显的定向检查、摘要白名单「精确位置 + 合法格式」双条件；
- **结构化 JSON**：深层完整脱敏（键与类型保留、值替换）、容器截断与逐字段登记、解析失败退回伪文；
- **真实字段契约形态**：整份模型的类型骨架与源模型逐项一致，枚举 / 标识位逐字保留；
- **完整登记校验**：自洽载荷零问题，模型哈希 / structure / capabilities / seq 映射 / 截断闸门 /
  资格互反 / 缺成员 / 未知成员 / 非法声明源 / 秘密命中 / 不变量清单逐条命中，
  并显式断言「**伪造来源摘要仍通过**」（自洽 ≠ 来源真实）；
- **`--limit 0` 语义**：唯一谓词 `limitApplies`、零上限不做长度比较、正上限仍报超限；
- **原型键安全**：`__proto__` / `constructor` 作为自有键活下来、不改原型；
- **静态闸门**：`scripts/trajectoryFixture.ts` 只允许一条**类型**导入（零 Node 运行时依赖）；
- **安全预期**：8 个成员位置各注入一个受控秘密未知键（未知成员照旧报出、问题码与定位
  **不回显原始键名**）+ 超深载荷给固定码 `provenance.depth-exceeded` 且不抛异常。

### `fixtureBuild.test.ts`

提取 CLI 的行为断言。**被测对象是 `build/trajectory-fixture-build.mjs`** —— `npm test` 先跑
`build:scripts`（先清 `build/*.mjs` 再打包），所以它必然是当前源码打出来的；测试**不接受**任何
CLI 路径覆盖环境变量，并用四条判据钉住「不是 alias / 旧产物」：路径固定、
`provenance.derive.sha256` 等于磁盘当前 `src/dsh/trajectory.ts`、与进程内当前源管线**逐字对拍**、
以及构建时记录型 `onLoad` 写下的 `build/trajectory-fixture-build.witness.json`（折入字节 = 当前源）。

覆盖：缺配置 / 坏参数 / 源不存在 / 源是目录 / 覆盖保护（含 `--accept-new-source` 的放宽边界）/
秘密形态 `--name` 入口即拒 / 失败与成功分支都不回显 `--name` / 声明源缺失·是目录·bundle 冒充 /
来源字节快照单读（TOCTOU）/ **写盘·替换·读回故障注入**（先证注入命中再判固定出口）/
深层 JSON 与超限结构化字段 / 深度超限固定安全失败 / 不可信事件 `type` 的准确计数 /
**5 条当前 derive 判别序列**（首 token 的 raw 与 packed 读法、显式它步不借用、晚 attempt 同值回填、
steering 落点）/ **超深既有夹具走覆盖保护固定出口**（退出 2、无异常栈、无本机路径）/
**用户日志读取闸门**（替身日志根必须被拒、正常合成材料照旧可读）/ `--limit 0` 端到端。

### `fixtureVerify.test.ts`

离线校验 CLI 的行为断言：文案表两套齐全（中文含 CJK、英文不含 CJK）、用法与未知参数
（不回显参数原文）、**显式开关缺值按用法错误退出 2**（`--fixture <文件> --name` 这种末尾缺值
不得把 `name` 静默变成「没给」而跳过核对）、输入不可读 / 坏 JSON / 目录、`--name` 核对、
**生成器写出的夹具必须通过校验**（跨 CLI 同一套判据）、载荷被改命中 `model-sha256-mismatch`、
**校验是只读的**、超深载荷报 `provenance.depth-exceeded` 且回显里没有异常栈或本机路径，
以及成功输出必须带**三条边界声明**（自洽 ≠ 来源真实 / 不代表 `redaction.version` 语义兼容 /
不代表帧完整性）。

### `fixtureWriteTrace.cjs`

受控子进程的**观察器 + 故障注入器 + 用户日志读取闸门**（`--require` 预加载，测试基础设施）。
只记布尔与计数：`loaded` / `sensitiveWriteAttempt` / `sensitiveWriteCompleted` /
`guardedRead(+Count)` / `swapApplied` / `mkdirFailureHit` / `writeFailureHit` / `renameFailureHit` /
`readBackTamperHit` / `userLogReadAttempt` / `userLogReadRefused`。

- 读取闸门：目标路径落在 `DSH_FIXTURE_USER_LOG_ROOT`（默认 `<home>/.dsh`）之内即**记命中并拒绝**，
  经 `syncBuiltinESMExports()` 同步到 ESM 具名导入（被测 CLI 是 ESM，少了这层会静默失效）。
  包含性判据是**精确的上级判定**：只有 `..` 本身或 `..<分隔符>` 开头才算「在外」，
  于是同名前缀的兄弟目录（`<root>-sibling`）不误判，而名字以两个点开头但**位于根内**的子目录
  （`<root>/..contained/…`）照旧被拒。
- 注入的 `*Hit=true` **由被测 CLI 自己的调用置位**，所以它本身就是「补丁在 ESM 路径上生效」的证据。

## 与真实夹具的关系

这些断言只用合成材料，**不证明**任何真实日志可用、也不证明来源真实（摘要可被伪造）。
真实小 / 长 / v4 压缩夹具的生成需要单独批准读取范围，见
[`test/fixtures/trajectory/README.md`](../../../test/fixtures/trajectory/README.md)。
