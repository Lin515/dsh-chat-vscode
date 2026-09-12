/**
 * 配置文件热重载 → 客户端要重读什么。
 *
 * `dsh web` 的 web profile 是 `patchReload: live`（`dsh-app-boot`：随产品交付的
 * `web` 模板实时重载，其他随附模板只在启动时应用 patch），所以下面这些文件
 * 改了**不重启**进程就生效：
 *
 * | 文件 | 宿主侧机制 | 转发给客户端的帧 |
 * |---|---|---|
 * | `$DSH_HOME/settings.yaml`（或 `.json`） | `dsh-settings-file` chokidar 监视 → `publish` → `settings/document-updated` | `settings/document-updated(ns, revision)` |
 * | `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/profiles/<name>/cordis.patch.yml` | `watchUserPatches` + Cordis HMR 重新组合 | 无专属帧；插件行增删的**后果**经 `commands/change` / `llm/adapters-updated` 出来 |
 * | `$DSH_HOME/.credentials.yaml` | `dsh-credentials-local` chokidar 监视 → `credentials/reference-updated` | `credentials/reference-updated(ref)` |
 * | skill 根目录（`~/.dsh/skills`、`~/.agents/skills`、项目内 skill 目录） | `dsh-skill-filesystem` chokidar 监视 | **没有**（`skills/change` 不在转发白名单里） |
 *
 * 注意 `llm/adapters-updated` **不是**「模型目录变了」的充分信号：它只在提供方
 * 拓扑提交点发（适配器注册/注销、可配置提供方目录增删）。改一个已有模型的
 * `reasoningEfforts`（用户 2026-09-12 报的现场）**只发 settings/document-updated**，
 * 而 `session/modelCatalog` 的内容确实跟着变——所以两个事件都必须重取目录。
 * 官方 `ui-model-selection` 正是对 `settings/document-updated` /
 * `credentials/reference-updated` / `llm/adapters-updated` 三者都
 * `this.catalog.refresh()`。
 *
 * 客户端这一侧只被允许看到转发白名单内的事件
 * （`@deepseek-ai/dsh-api-remotes` 的 `API_REMOTE_FORWARDED_EVENTS`），
 * 以 `$events` 流上的 `{type:'emit', event, args}` 帧到达（网关
 * `dsh-api-gateway` 的 `broadcastRemoteEvent` 就是这一帧）。
 * 官方前端据此让 settings 镜像失效并重读；本扩展此前在
 * `frame.type !== "waterfall"` 处直接 return，这些帧全被丢掉，于是
 * 「外部改了配置，界面纹丝不动」。
 *
 * 这一层刻意与 vscode 无关：只做「帧 → 重读动作」的映射与合并，
 * 冒烟测试（`scripts/configChanges.test.ts`）可以直接验。
 */

/** 重读动作：由控制器实现，这里只负责决定「什么时候调、调几次」。 */
export interface ConfigChangeActions {
  /**
   * 用户设置层变了：设置面板、`ui-conversation.busyEnter`、图片输入能力、
   * 部署默认模型（`agent-default-model`）。
   */
  reloadSettings(): Promise<void>;
  /**
   * 重取模型目录（`session/modelCatalog`）：提供方拓扑变了，或
   * `llm-*` 设置里的模型清单/档位变了（后者不发 `llm/adapters-updated`）。
   */
  reloadModelTopology(): Promise<void>;
  /** 命令 / 技能目录变了；给了 `sessionId` 就只重取那一个会话。 */
  reloadCommandCatalogs(sessionId?: string): Promise<void>;
}

/** 一轮重读要做的事：同一批 emit 帧合并成一轮，避免配置改一次打出一串 RPC。 */
interface Round {
  settings: boolean;
  topology: boolean;
  /** 所有打开域的目录都重取（命令注册表是全局的）。 */
  allCatalogs: boolean;
  /** 只重取这些会话的目录（技能集合随 agent preset 变）。 */
  catalogs: Set<string>;
}

function newRound(): Round {
  return { settings: false, topology: false, allCatalogs: false, catalogs: new Set<string>() };
}

export class ConfigChangeRouter {
  private pending: Round | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly actions: ConfigChangeActions,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * 处理一条转发的 `emit` 帧。
   *
   * @param event - 帧上的 `event` 名。
   * @param args - 帧上的 `args`（网关保证是 JSON 值；缺省为空数组）。
   * @returns 是否认识这个事件。不认识的由调用方忽略（转发白名单里还有
   *   会话目录、审批、cordis 检查等一堆本扩展用别的流覆盖的事件）。
   */
  handle(event: string, args: readonly unknown[] = []): boolean {
    // 先攒在**已有**的那一轮上（在飞时就是排队的那一轮），认识的才落回 pending
    const round = this.pending ?? newRound();
    switch (event) {
      case "settings/document-updated":
      case "credentials/reference-updated":
      case "llm/adapters-updated":
        // 三个事件都**同时**重读设置与模型目录——这是官方 `ui-model-selection`
        // 的口径（它对这三个 `$on` 都调 `catalog.refresh()`），也是用户 2026-09-12
        // 报的现场所要求的：删掉一个模型档位**只发 settings/document-updated**
        // （路由集合没变，不发 llm/adapters-updated，实测见 configReloadProbe），
        // 只重读设置、不重取目录的话，模型选择框里的档位会永远停在旧目录上。
        round.settings = true;
        round.topology = true;
        break;
      case "commands/change":
        round.allCatalogs = true;
        break;
      case "agent-preset/selected": {
        // 官方 `ui-commands` 收到它就 `directory.resetSession(sessionId)`：
        // 预设换了，该会话能用的命令与技能都不一样。
        const sessionId = typeof args[0] === "string" && args[0] ? args[0] : undefined;
        if (sessionId === undefined) round.allCatalogs = true;
        else round.catalogs.add(sessionId);
        break;
      }
      default:
        return false;
    }
    this.pending = round;
    this.drain();
    return true;
  }

  /** 等到彻底空闲（含排队的那一轮）。离线断言用。 */
  async settled(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /**
   * 串行泵：一轮跑完再看有没有新帧。
   *
   * `settings.yaml` 一次保存会命中多个命名空间，帧是**逐条**来的
   * （`settings/document-updated` 每个变更的命名空间一条），所以同一批帧
   * 必须合并——官方 settings 镜像同样是「在飞 + 一次 rerun」，不做并发叠加。
   */
  private drain(): void {
    if (this.running) return; // 在飞的那轮会看到新的 pending
    this.running = (async () => {
      while (this.pending) {
        const round = this.pending;
        this.pending = undefined;
        await this.runRound(round);
      }
    })().finally(() => {
      this.running = undefined;
      // 循环退出到 finally 之间到达的帧：再起一轮，别把它落在 pending 里
      if (this.pending) this.drain();
    });
  }

  private async runRound(round: Round): Promise<void> {
    const catalogs = round.allCatalogs ? "all" : [...round.catalogs].join(",") || "-";
    this.log(
      `[config] 配置热重载：settings=${round.settings} topology=${round.topology} catalogs=${catalogs}`,
    );
    // **顺序**执行，不并发：重读设置时要用到刚重取的模型目录（部署默认模型的
    // 标签与档位都从目录里取，并发会让它读到旧目录）
    if (round.topology) await this.act("模型目录", () => this.actions.reloadModelTopology());
    if (round.settings) await this.act("设置", () => this.actions.reloadSettings());
    if (round.allCatalogs) await this.act("命令目录", () => this.actions.reloadCommandCatalogs());
    for (const sessionId of round.catalogs) {
      await this.act(`命令目录(${sessionId})`, () => this.actions.reloadCommandCatalogs(sessionId));
    }
  }

  /**
   * 跑一个重读动作，失败只记日志。
   *
   * 一个动作失败不该拖垮同一轮里的其余动作，也不该打断 `drain` 的循环
   * （否则一次 RPC 抖动会让后面的配置文件改动再也引发不了重读）。
   */
  private async act(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.log(`[config] ${label}重读失败：${String(error)}`);
    }
  }
}
