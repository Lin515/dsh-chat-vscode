# 固定上游源码见证

本目录保存来源锁需要的 **21 份官方原文字节**（覆盖 22 份 vendor 副本；完整 `recurrence.ts` 与错误摘录共享同一份原文见证），不保存用户日志、不进扩展发布包，也不是业务实现的第二份副本。

- 来源：DeepSeek Harness，固定 tag `dsh-v0.2.2-rc.1`。
- 固定 commit：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，见[上游固定树](<https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db>)。
- 子目录以 tag 命名，内部保留官方仓库相对路径；包括轨迹纯逻辑 7 份、Markdown 解析 / 投影 / 高亮纯逻辑 7 份、KaTeX→React 适配器 `katex.tsx` 1 份，以及 `packages/util/code-language` 的路径语言表 1 份，以及工具终端模型原文 1 份（vendor 只摘录退出状态纯函数），以及时间库原文 4 份（Cron 字段摘录，以及完整 RRULE / instant / recurrence；错误类型摘录与完整 recurrence 共用一份见证）。
- [锁登记](<../../../scripts/vendorSourceLock.json>)逐份登记官方路径、原字节数、原文 SHA-256、规范化摘要及允许适配。
- [来源校验模块](<../../../scripts/vendorSourceLock.ts>)与[正式回归](<../../../scripts/vendorSourceLock.test.ts>)共同读取这些文件；不会依赖本机上游 checkout 或联网获取。

## 允许与拒绝

规范化仅处理 AST 的 import/export 模块说明符，以及注释／排版；`.tsx` 按 TSX（JSX AST）解析，普通字符串、模板字符串、正则中的连续空白与 ASI 换行均保留语义。不使用全局字符串替换或压缩空白。

缺少／新增文件、原文字节变化、宿主字段污染、摘要与登记不符、规范化规则漂移都必须失败。原文、锁与本地 vendor 三方自洽，不等于外部签名认证；更新 tag 与摘要须显式审查，而不是为了通过测试重写锁。

## 离线复现

```powershell
npm run build:scripts
node build/vendor-source-lock.test.mjs
```

标准 `npm test` 已登记该回归，包含集合、原字节和语义变异的负对照（含 TSX 选项 / JSX 属性变异）。更新过程与许可登记见[vendor 索引](<../../../src/vendor/README.md>)；源文件仍按官方许可使用，版权与许可全文见[第三方声明](<../../../THIRD-PARTY-NOTICES.md>)。
