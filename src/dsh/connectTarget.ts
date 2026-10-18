/**
 * 「这次连内部 DSH、外部 DSH 还是桌面端内置服务」的**选路**（纯函数，可离线断言）。
 *
 * 用户 2026-09-18 口径（取代旧的"`dshChat.url` 非空 = 外部模式、内部配置全失效"），
 * 2026-10-19 补上内部那一轴的存在性判据：
 *
 * - **内部那一轴要配了启动命令才存在**（`dshChat.command` 留空 = 没有内部 DSH）：
 *   不选它、不探测它、也**不拿它兜底**——用户可以把"只想用桌面端"配成一条显式选择；
 * - **内部优先**：内部后台（守护进程）已经在跑，就连内部；
 * - **外部是备用**：内部不在、而外部地址配了且**此刻确实有应答**，就连外部；
 * - **桌面端也是"已在跑的服务"**（用户 2026-10-18 口径）：内部不在、外部不算数，而配置了
 *   `dshChat.desktopExecutable` 且那套服务**真的可连接**（发现与鉴权都通过）→ 接它。
 *   桌面端的服务随应用启动即跑、与登录无关，扩展连的是同一个服务进程，所以能继续桌面端
 *   正开着的会话（见 `docs/design-desktop.md`）；
 * - **都没有**：拉起一套内部后台；内部那一轴不存在而配了桌面端 → 拉起桌面端；
 *   两者都不存在 → **没有可选项**（`undefined`，界面落按钮态，绝不拿空命令去 spawn）。
 *
 * 判据里只有"外部可达"与"桌面端可连接"需要真实探测（见 `SupervisorManager.probeExternal`
 * 与 `probeDesktop`）：配了地址/路径不等于那个服务活着，而"备用"只有在能用的时候才算数。
 *
 * **选路只发生一次**（激活期自动路径，或用户点按钮）：目标是**粘性**的，
 * 自动重试永远重试同一个目标，不会因为"另一个后来起来了"就换——换目标意味着换服务器、
 * 换会话列表、丢掉正在跑的轮次（用户 2026-09-18 定）。
 *
 * 之所以把它做成纯函数而不是塞进控制器：这套判定是本次改动里唯一"有分支组合"的逻辑
 * （内部在/不在 × 外部配了/没配 × 可达/不可达 × 桌面端配了/没配 × 可连接/不可连接），
 * 放这里才能用断言把各种组合钉住。
 */
export type DshTarget = "internal" | "external" | "desktop";

export interface TargetFacts {
  /** 内部后台（守护进程）进程活着——判据见 `RunningSnapshot.supervisorAlive`。 */
  internalRunning: boolean;
  /**
   * 内部那一轴存不存在：配了启动命令（`dshChat.command` 非空）才算存在。
   *
   * **留空 = 没有内部 DSH**（用户 2026-10-19 口径）：不启动、不连接、不选路、界面不给
   * 那两颗按钮——与桌面端那一轴（`desktopExecutable` 留空即整条关闭）同一副样子。
   * 不同的内部 DSH 是按各自的命令行辨认的，没配命令的窗口没有属于它的那一套。
   *
   * 因此它同时管住三件事：**未配时 `internalRunning` 一律按假处理**（探测层已短路，
   * 见 `SupervisorManager.probeRunning`）、选路不许选内部、选路也不能在"没有别的可选"
   * 时兜底去启动内部。
   */
  internalConfigured: boolean;
  /** 配了外部地址（`dshChat.url` 非空）。 */
  externalConfigured: boolean;
  /** 那个外部地址此刻有应答（只在 `externalConfigured` 为真时有意义）。 */
  externalReachable: boolean;
  /** 配了桌面端可执行文件（`dshChat.desktopExecutable` 非空）。 */
  desktopConfigured: boolean;
  /**
   * 桌面端**进程**在跑（认人成功）。
   *
   * 只给界面用（按钮文案的二分：未在跑 → 「启动 DSH 桌面端」，在跑 → 「连接 DSH 桌面端」）。
   * 选路**不看它**——"进程在"不等于"能连上"（见 `desktopAttachable`）。
   */
  desktopRunning: boolean;
  /**
   * 桌面端服务**此刻可连接**（发现 + 鉴权都通过）。
   *
   * 这才是选路的判据：它蕴含"进程在跑"，还额外证明了本机签名密钥能签出服务端认的票
   * （前提是同源——两边解析到同一个 DSH 主目录，否则密钥不同、票会被拒）。
   */
  desktopAttachable: boolean;
}

export interface TargetPlan {
  target: DshTarget;
  /** 本次是否允许"目标不存在就拉起一套"（只有"都没有"那两支为真）。 */
  start: boolean;
}

/**
 * 自动路径的选路（`dshChat.autoConnect` 开着时，激活期调一次）。
 *
 * 前**三**支都是"接入已经在跑的服务"（`start: false`）：内部 → 外部 → 桌面端。
 * 后两支才是启动：内部优先（它是扩展自己拉起的、不弹 GUI），内部不可用才交给桌面端。
 *
 * **没配启动命令时内部那一轴不存在**（用户 2026-10-19 口径）：既不选它，也不拿它兜底
 * ——所以这条轴未配时，最后那一档不是"启动内部"，而是 `undefined`（"没有任何可选项"），
 * 由调用方落到按钮态并在日志里说明。**绝不能返回"启动内部"**：那会拿空命令去 spawn。
 */
export function chooseTarget(facts: TargetFacts): TargetPlan | undefined {
  if (facts.internalConfigured && facts.internalRunning) return { target: "internal", start: false };
  if (facts.externalConfigured && facts.externalReachable) return { target: "external", start: false };
  if (facts.desktopConfigured && facts.desktopAttachable) return { target: "desktop", start: false };
  if (!facts.internalConfigured && facts.desktopConfigured) return { target: "desktop", start: true };
  // 内部那一轴不存在又没有桌面端可用：**没有可选项**（不是"启动内部"）
  if (!facts.internalConfigured) return undefined;
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
  // 三态：**没配**（整条轴关闭）与"配了但没在跑"必须在日志里分得开——用户报的就是
  // "我都没配，它怎么起来了"，日志里得能一眼看出是"未配置"还是"未运行"。
  const internal = !facts.internalConfigured
    ? "内部=未配置"
    : facts.internalRunning
      ? "内部=运行中"
      : "内部=未运行";
  const external =
    externalStateOf(facts) === "unconfigured"
      ? "外部=未配置"
      : externalStateOf(facts) === "reachable"
        ? "外部=可达"
        : "外部=不可达";
  const parts = [internal, external];
  // 桌面端那一轴只在**配了**的时候写出来：没配的用户不该在日志里多读半句
  if (facts.desktopConfigured) {
    const desktop = facts.desktopAttachable ? "可连接" : facts.desktopRunning ? "在跑但不可连接" : "未运行";
    parts.push(`桌面端=${desktop}`);
  }
  return parts.join("，");
}
