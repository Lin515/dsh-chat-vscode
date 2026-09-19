/**
 * 「这次连内部 DSH 还是连外部 DSH」的**选路**（纯函数，可离线断言）。
 *
 * 用户 2026-09-18 口径（取代旧的"`dshChat.url` 非空 = 外部模式、内部配置全失效"）：
 *
 * - **内部优先**：内部后台（守护进程）已经在跑，就连内部；
 * - **外部是备用**：内部不在、而外部地址配了且**此刻确实有应答**，就连外部；
 * - **都没有**：拉起一套内部后台（连内部）。
 *
 * 三条判据里只有"外部可达"需要一次真实探测（见 `SupervisorManager.probeExternal`）：
 * 配了地址不等于那个服务器活着，而"备用"只有在能用的时候才算数。
 *
 * **选路只发生一次**（激活期自动路径，或用户点按钮）：目标是**粘性**的，
 * 自动重试永远重试同一个目标，不会因为"另一个后来起来了"就换——换目标意味着换服务器、
 * 换会话列表、丢掉正在跑的轮次（用户 2026-09-18 定）。
 *
 * 之所以把它做成纯函数而不是塞进控制器：这套判定是本次改动里唯一"有分支组合"的逻辑
 * （内部在/不在 × 外部配了/没配 × 可达/不可达），放这里才能用断言把六种组合钉住。
 */
export type DshTarget = "internal" | "external";

export interface TargetFacts {
  /** 内部后台（守护进程）进程活着——判据见 `RunningSnapshot.supervisorAlive`。 */
  internalRunning: boolean;
  /** 配了外部地址（`dshChat.url` 非空）。 */
  externalConfigured: boolean;
  /** 那个外部地址此刻有应答（只在 `externalConfigured` 为真时有意义）。 */
  externalReachable: boolean;
}

export interface TargetPlan {
  target: DshTarget;
  /** 本次是否允许"内部不存在就拉起一套"（只有"都没有"那一支为真）。 */
  start: boolean;
}

/** 自动路径的选路（`dshChat.autoConnect` 开着时，激活期调一次）。 */
export function chooseTarget(facts: TargetFacts): TargetPlan {
  if (facts.internalRunning) return { target: "internal", start: false };
  if (facts.externalConfigured && facts.externalReachable) return { target: "external", start: false };
  return { target: "internal", start: true };
}

/** 外部轴的界面状态（连接条上那句"外部 DSH：…"）。 */
export type ExternalState = "unconfigured" | "reachable" | "unreachable";

export function externalStateOf(facts: TargetFacts): ExternalState {
  if (!facts.externalConfigured) return "unconfigured";
  return facts.externalReachable ? "reachable" : "unreachable";
}

/** 日志里那半句人类可读的探测结论（诊断用，不面向界面）。 */
export function describeFacts(facts: TargetFacts): string {
  const internal = facts.internalRunning ? "内部=运行中" : "内部=未运行";
  const external =
    externalStateOf(facts) === "unconfigured"
      ? "外部=未配置"
      : externalStateOf(facts) === "reachable"
        ? "外部=可达"
        : "外部=不可达";
  return `${internal}，${external}`;
}
