# 固定上游源码见证

本目录保存来源锁需要的 **11 份官方原文字节**，不保存用户日志、不进扩展发布包，也不是业务实现的第二份副本。

- 来源：DeepSeek Harness，固定 tag `dsh-v0.2.0-rc.2`。
- 固定 commit：`639ed015397290b3745d163aafe02ffee4aa3f84`，见[上游固定树](<https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84>)。
- 子目录以 tag 命名，内部保留官方仓库相对路径；包括轨迹纯逻辑 7 份与 Markdown 纯逻辑 4 份。
- [锁登记](<../../../scripts/vendorSourceLock.json>)逐份登记官方路径、原字节数、原文 SHA-256、规范化摘要及允许适配。
- [来源校验模块](<../../../scripts/vendorSourceLock.ts>)与[正式回归](<../../../scripts/vendorSourceLock.test.ts>)共同读取这些文件；不会依赖本机上游 checkout 或联网获取。

## 允许与拒绝

规范化仅处理 AST 的 import/export 模块说明符，以及注释／排版。普通字符串、模板字符串、正则中的连续空白与 ASI 换行均保留语义；不使用全局字符串替换或压缩空白。

缺少／新增文件、原文字节变化、宿主字段污染、摘要与登记不符、规范化规则漂移都必须失败。原文、锁与本地 vendor 三方自洽，不等于外部签名认证；更新 tag 与摘要须显式审查，而不是为了通过测试重写锁。

## 离线复现

```powershell
npm run build:scripts
node build/vendor-source-lock.test.mjs
```

标准 `npm test` 已登记该回归，包含集合、原字节和语义变异的负对照。更新过程与许可登记见[vendor 索引](<../../../src/vendor/README.md>)；源文件仍按官方许可使用，版权与许可全文见[第三方声明](<../../../THIRD-PARTY-NOTICES.md>)。
