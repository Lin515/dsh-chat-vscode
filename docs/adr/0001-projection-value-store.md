# 投影值存储由宿主拥有水位

宿主侧新增一个**投影值存储**（`src/dsh/projectionStore.ts`），一个会话域一份，
`key → {value, seq}`，按官方契约判新旧：**higher seq wins**（同 seq 也算负）、baseline 在它的
截止水位上播种、替换型 baseline 先截断。改造前三个调用点都把线上带的 `seq` / `asOfSeq` 丢掉了，
于是「重放的旧帧不能把新值顶回去」这条契约在扩展里没有落点。

## Consequences

- **形状解析与水位分家**：解析在 `src/dsh/projections.ts` 的读取表（纯函数），
  新旧在 store，效果在控制器（`ProjectionHandlers` 一张映射类型表——少一个键编译不过）。
- **有意偏离**：`session/list` 行携带的投影（历史抽屉的标题）**不走 store**，仍是 last-wins。
  那份数据契约自己就声明它「可能是缓存的陈旧提示」，而扩展刻意不为未打开的会话建域；
  接上 store 意味着替所有会话维护投影行，收益只是抽屉标题不回退。
  看到这条偏离请**不要顺手对齐**——它是有意的。
- 适配器不再直接读 `projections.values.title`（那是绕过水位的第二个读点），
  标题统一走 controller 的效果；`session/title` **事件**那条路不受影响。
