# src/vendor/ — 从上游逐字搬进来的官方纯决策模块

这个目录放的是**上游官方客户端的源码副本**（不是我们写的、也不许手改）。
存在理由只有一个：轨迹这一页有若干「一行显示什么 / 时间线怎么摆 / 搜索怎么匹配」
的**纯决策**，我们从前是照着官方文档与源码**手工等价实现**的——手抄必然漂移
（真踩过：`duration` 模式的轮次边界把原始 Unix 毫秒当域值，每一根边界都被渲染端丢掉）。
搬进来之后这些口径只有一份实现，且那一份是官方原文。

## 来源与版本

| 项 | 值 |
|---|---|
| 来源包 | `@deepseek-ai/dsh-client-ui-trajectory` 与 `@deepseek-ai/dsh-client-ui-primitives`（同属 DeepSeek Harness 官方客户端） |
| 版本 | `0.2.0-rc.2`（上游 tag `dsh-v0.2.0-rc.2`） |
| 上游仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 许可 | MIT（Copyright (c) 2026 DeepSeek）——归属说明见[第三方声明](<../../THIRD-PARTY-NOTICES.md>) |
| 固定 commit | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| 离线来源见证 | [11 份官方原文](<../../test/fixtures/vendor-sources/README.md>) |
| 自动来源锁 | [登记](<../../scripts/vendorSourceLock.json>)、[校验模块](<../../scripts/vendorSourceLock.ts>)、[正式回归](<../../scripts/vendorSourceLock.test.ts>) |

选这个版本是因为它与[DSH 兼容基准](<../../docs/dsh-compat.md>)是同一个版本。
来源锁校验双向文件集合、原文字节与允许适配后的摘要；规范化只处理 AST 模块说明符、注释与排版，保留字符串／模板／正则空白和 ASI 语义。锁与原文自洽不是外部签名认证。

## 子目录

- [ui-trajectory](<ui-trajectory/README.md>) — 预览投影、记录身份、时间线、搜索索引、PTC 代码程序。
- [ui-primitives](<ui-primitives/README.md>) — Markdown 纯文本投影（预览投影的依赖）。

## 硬规则

1. **不要手改**。每个文件头部都写了「本仓库改了哪几处」——只有那些是允许的偏差
   （去掉 `.ts` import 后缀、把上游跨包的类型引用换成本地声明），语义必须逐字相同。
2. 消费方**必须**经[轨迹适配层](<../webview/trajectoryVendor.ts>)与[时间线适配层](<../webview/trajectoryTimeline.ts>)转成官方形状，**不要**在 vendor 文件里加宿主字段或分支。前一轮工具目录只在宿主适配层合成为官方 `previousPromptDetail`，不再扩展官方接口为 `previousPromptTools`。
3. 上游升级时**先 diff 再决定**（见下），不要凭记忆补。

## 升级 DSH 时怎么重新同步

`dsh:watch` / `dsh:check` 只追踪服务端契约包，不监控 UI 语义。现在标准 `npm test` 另有**离线 vendor 来源锁**，旧的「这里只能手工发现漂移」口径不再适用；但它不会自动联网升级。

1. 显式选择新 tag／commit，逐一 diff 官方与本地实现，审查文件头允许适配是否仍成立；不要只更新摘要求绿。
2. 对确需更新的实现整份同步，再重做获准适配；同步对应官方原文字节与[锁登记](<../../scripts/vendorSourceLock.json>)。保留固定 tag／SHA，不用不稳定的 HEAD。
3. 先跑离线来源锁与[适配回归](<../../scripts/trajectoryVendor.test.ts>)，再跑 `npm run typecheck`、`npm test`、`npm run build`、`git diff --check`。
4. 真实日志对拍**另需当次授权**。获准后用显式 `--source <指定文件>`；`missing`、覆盖缺口与错配分列，不能只报「错配 0」。标准测试不读取用户日志，也不默认扫描家目录。
5. 同步本文件、子目录索引与[第三方声明](<../../THIRD-PARTY-NOTICES.md>)。官方入参增字段时在[宿主适配层](<../webview/trajectoryVendor.ts>)补真实填充路径，不污染 vendor 接口。
