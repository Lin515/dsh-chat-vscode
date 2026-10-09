# test/ — 离线预览与夹具

本目录不进入扩展发布包；用于真实组件的离线界面验收，不是可启动真实模型会话的入口。

- [预览页](<preview.html>)消费正式 webview 产物。轨迹参数 `trajectory=small|long|compaction` 异步载入已授权生成的真实脱敏夹具；`locale=en|zh` 切中英，载入后点击顶栏轨迹按钮。缺载荷或不合格时失败，不退回合成轨迹。
- 默认聊天演示、`empty=1`／`rail=one` 等仍是独立界面材料，不算真实轨迹语料；`trajectory=ptc` 明确无真实样本，不伪造工具调用。
- [预览回归](<../scripts/previewFixture.test.ts>)检查真实载荷接线、失败路径、预览状态和既有语法／重复键启发式；不能把 `Function` 编译成功当成重复键不存在的证明。
- [滚动探针页](<scroll-probe.html>)是单独的离线量测入口；不能替代真实完整载荷的组件与连续 DOM 验收。
- [夹具根索引](<fixtures/README.md>)区分用户会话脱敏材料与固定上游源码见证，两者都可离线消费，不读用户日志。

纯逻辑回归放[脚本目录](<../scripts/README.md>)，新增测试必须进入[构建登记](<../esbuild.scripts.mjs>)才会被标准 `npm test` 执行。完整载荷量测由[正式 benchmark CLI](<../scripts/trajectoryPayloadBenchCli.ts>)生成独立浏览器工件，不改预览页或生产组件。
