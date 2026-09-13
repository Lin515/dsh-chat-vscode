/**
 * 扩展的日志写入器：**在任何生命周期阶段都不得抛异常**。
 *
 * 为什么单独成模块（2026-09-13 用户实测的严重缺陷）：VS Code 关窗 / 重载窗口时，
 * **输出通道会先于扩展停用被关闭**。实测的 exthost.log：
 *
 * ```text
 * 19:59:47.828 [info] Extension host terminating: received terminate message from renderer
 * 19:59:47.848 [error] An error occurred when disposing the subscriptions for extension 'Lin515.dsh-chat':
 * 19:59:47.848 [error] Error: Channel has been closed
 *     at Object.appendLine (...)
 *     at Object.M [as log] (.../Lin515.dsh-chat-0.6.0/dist/extension.js:44:5487)
 *     at Et.release (.../Lin515.dsh-chat-0.6.0/dist/extension.js:43:2091)     ← ServerManager.release()
 * ```
 *
 * `release()` 是「关窗必须带走后台」的唯一落点，而它的第一条语句就是写日志
 * （`[server] 本窗口退出：停止后台 pid=…`）。这一句抛出之后，下面的 `killOwnedServer`
 * 根本执行不到 —— 后台 dsh 就这样被留在磁盘上：租约里的端口被它一直占着，
 * 下一次启动若配置了固定端口（`dshChat.command` 写死 `--port 20000`）就会 `EADDRINUSE`
 * 起不来，用户看到的是「无法连接 dsh 服务」。
 *
 * 所以这里做两件事，缺一不可：
 * 1. **写入失败一律吞掉**（通道关闭是最常见的一种，还会有"通道被用户关掉"等情形）；
 * 2. **失败期间的消息先攒着**，等下次拿到可用通道时补写——排查现场最需要的恰好是
 *    关窗那几秒的日志，丢掉的代价比多留几行高得多。
 *
 * 探针 `scripts/gracefulCloseProbe.ts` 的第 5 步用"每次写入都抛 `Channel has been closed`"
 * 的假通道钉住这条纪律：那种情形下后台**仍然必须**被带走。
 */

/** 只用到 `appendLine` 的通道接口（刻意不依赖 `vscode`，便于离线断言）。 */
export interface OutputChannelLike {
  appendLine(value: string): unknown;
}

/** 关闭期间最多攒多少条：正常关窗只有几条，超过就说明另有问题，不必无限增长。 */
const MAX_PENDING_LINES = 200;

export interface HostLogger {
  /** 写一行（空行会被忽略，与既有行为一致）。**永不抛异常。** */
  (line: string): void;
  /** 测试与诊断用：失败期间攒下的行数。 */
  pendingCount(): number;
}

/**
 * 供日志通道使用的时间戳（`[20:00:36] …`）。
 *
 * 在**调用时**打戳而不是写入时：通道关闭期间消息会先攒着，写入时再打戳会把
 * 「关窗那几秒」的时间全记成补写的那一刻——排查退出路径时时间线正是关键证据。
 */
export function stamp(line: string): string {
  return `[${new Date().toLocaleTimeString()}] ${line}`;
}

/**
 * 造一个日志函数。
 *
 * @param channel 取通道的回调：不得抛异常；返回 `undefined` 表示"现在没有可用通道"。
 *                每次写入都重新取一次，所以通道被重新创建（重载窗口）后会自动接上。
 */
export function createHostLog(channel: () => OutputChannelLike | undefined): HostLogger {
  const pending: string[] = [];

  const log = (line: string): void => {
    if (!line) return;
    pending.push(stamp(line));
    // 只把攒下的补写进**当前**通道；失败的留在队列里等下一个通道
    while (pending.length) {
      let target: OutputChannelLike | undefined;
      try {
        target = channel();
      } catch {
        target = undefined;
      }
      if (!target) {
        if (pending.length > MAX_PENDING_LINES) pending.splice(0, pending.length - MAX_PENDING_LINES);
        return;
      }
      try {
        target.appendLine(pending[0] as string);
      } catch {
        // 通道已关闭 / 被释放：**绝不外抛**（见文件头），这一行留在队列里
        if (pending.length > MAX_PENDING_LINES) pending.splice(0, pending.length - MAX_PENDING_LINES);
        return;
      }
      pending.shift();
    }
  };

  return Object.assign(log, {
    pendingCount: (): number => pending.length,
  });
}
