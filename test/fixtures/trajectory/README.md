# 轨迹真实脱敏夹具

这里保存已获当次读取授权、由正式提取 CLI 生成的三份真实停止会话夹具。它们不是手工合成轨迹，也不是原始日志；不会进入扩展发布包。

| 夹具 | 源格式 | durable 事件 | 轮／组／记录／请求 | 模型 JSON 字节 | 夹具文件字节 |
|---|---|---:|---|---:|---:|
| [小会话](<real-small.json>) | v3 | 63 | 3／9／21／6 | 206,721 | 280,131 |
| [长会话](<real-long.json>) | v3 | 5,141 | 20／985／2,047／926 | 13,485,165 | 15,166,299 |
| [压缩会话](<real-compaction.json>) | v4 | 732 | 4／107／297／84 | 3,714,411 | 4,069,664 |

此处 durable 数 = 登记 `sourceEventCounts` 合计 − 一条 `session` 元数据行；带元数据行的合计为 64／5,142／733。

三份均为 `fieldLimit=0`、`payloadReduced=false`、`payloadMeasurementEligible=true`、`truncatedFields={}`。长会话包含 20 条 steering；压缩夹具包含 2 条 compacted 记录／2 次压缩请求。当前完整模型的工具名／内容块名字枚举未观察到 `run_code`；这属于模型与探针观察，登记的 `capabilities` 没有 PTC 计数字段。`subtool` 登记及模型枚举均为零。没有同一步 overflow 的肯定样本，不以合成预览补足这些事实。

## 载荷与变换

每个文件是 `{ provenance, model }`：[模型契约](<../../../src/shared/trajectory.ts>)为 `TrajectoryModel`，登记包含源摘要／字节数／事件计数、脱敏统计、提取器与派生源码摘要、结构／能力表、seq 映射、模型摘要与资格闸门。

保留键、类型、数组长度、顺序与相对时序；自由文本换成低熵伪文，身份换成保唯一性和 `:` 前缀关系的确定性伪名，绝对路径换占位根，时刻统一平移，provider/model 中性化。自由文本保留 **UTF-16 长度与换行位置**，不保证 UTF-8 字节等长；因此上述脱敏模型字节数不能冒充未脱敏运行时帧大小。

## 显式生成与离线校验

读取真实日志必须先取得本次具体范围授权；零 token 不等于可以随意扫描用户目录。

```powershell
npm run build:scripts
node build/trajectory-fixture-build.mjs --source <已授权日志> --name <name> --out test/fixtures/trajectory --limit 0 --repo-root .
node build/trajectory-fixture-verify.mjs --fixture test/fixtures/trajectory/<name>.json --name <name>
```

生成器仅一次读取源字节，摘要、严格解码和派生共用该快照；严格检查完整 canonical zstd 帧、拼接后 fatal UTF-8 与对象 JSONL。脱敏后先扫描整份载荷，再写临时文件、完整读回验证、原子改名。实际折入 CLI 的派生字节由可重新构建的[打包见证](<../../../build/trajectory-fixture-build.witness.json>)登记，不能以磁盘源码声明替代该见证。

生成退出码：`0` 写出并读回通过；`2` 参数／配置／覆盖保护；`3` 读取、解码、派生、深度、不变量或写后校验失败；`4` 秘密规则命中。离线校验为 `0`／`2`／`3`。固定诊断中英双语，不回显来源内容、路径或异常原文。

标准 `npm test` **不读用户日志**；相关测试只读取本目录脱敏夹具或自己创建的受控合成材料。工具链与安全回归见[正式脚本索引](<../../../scripts/tests/trajectory/README.md>)。

## 真实界面预览

```powershell
npm run preview
```

打开[预览页](<../../preview.html>)，选择 `?locale=en&trajectory=small`、`?locale=en&trajectory=long` 或 `?locale=zh&trajectory=compaction`，载入后点击顶栏轨迹按钮。预览来源状态在 `window.__trajectoryFixtureInfo`，不向生产 `State` 或 wire 添加元数据字段。

缺失／不合格载荷必须失败，不回退合成长轨迹；`?trajectory=ptc` 仅说明无真实样本，不伪造 `run_code` 轨迹。默认聊天演示仍是独立合成界面材料，不算轨迹真实语料。

## 边界

- 截断样本 `payloadReduced=true` 不可用于完整载荷测量；零上限只是关闭截断，不豁免秘密、类型或结构检查。
- 离线校验证明登记和模型自洽，不认证来源、版本语义或历史会话完整性；严格生成器认证收到的字节内部完整，不证明历史日志未在完整帧边界丢失过。
- 本轮三份来源绑定还经独立单快照重新派生／脱敏同值检查；这是此次已授权来源的证据，不能推广到其他日志。
- `redaction.rules` 是语言中立稳定 id；`redaction.version` 为正整数不代表校验器认识该版本的全部语义。
