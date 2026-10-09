# scripts/tests/ — 分层测试目录

本目录只放**按被测对象分组**的断言与它们共用的测试基础设施（`npm test` 跑的是
`build/*.test.mjs`，条目登记在 `esbuild.scripts.mjs` 的 `entries` 里；忘记登记就会静默不跑）。

本目录**没有**自己的测试文件，全部内容按子目录组织：

- `trajectory/` — S02 轨迹预览夹具工具链（脱敏库、提取 CLI、离线校验 CLI）的离线回归与
  受控观察器。作用、运行方式与边界见 [trajectory/README.md](<trajectory/README.md>)。

放这里的口径：断言与它共用的观察器/夹具辅助文件放**同一个子目录**，便于「改动只影响这一组」；
与某个被测模块同名的顶层断言（`scripts/*.test.ts`）仍留在 `scripts/` 下，不往这里搬。
