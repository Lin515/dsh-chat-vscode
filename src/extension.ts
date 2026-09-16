import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ChatController } from "./dsh/controller";
import { resolveForVsCode } from "./dsh/hostText";
import { selectionLines } from "./dsh/selection";
import { createHostLog } from "./dsh/hostLog";
import { IDLE_SEC_DEFAULT } from "./dsh/supervisorProtocol";
import { SupervisorManager, groupForConfig } from "./dsh/supervisorManager";
import { createDefaultSupervisorLauncher } from "./dsh/supervisorRunner";
import {
  clearStaleDocumentLocks,
} from "./dsh/processRegistry";

let output: vscode.OutputChannel | undefined;

/**
 * 启动命令的兜底默认值——**与 `package.json` 里 `dshChat.command` 的 default 必须一致**。
 *
 * 为什么要有这个常量：设置在用户没写过时也会返回 schema 的 default，所以这里只在
 * 「用户把命令清成空串」时才生效；但它出现在**两个**地方（激活期构造 ServerManager、
 * 配置变更后重连），写两份字符串迟早漂移。
 *
 * 命令**原样执行，扩展不追加任何参数**：`--port 0`（系统分配端口）与 `--no-open`
 * （不弹系统浏览器）都是这条默认值的一部分，用户可以整条改掉。
 */
const DEFAULT_COMMAND = "dsh web --port 0 --no-open";

/**
 * 这台机器上"共享同一个后台"的分组键：**由有效服务器配置算出来**。
 *
 * 为什么需要它：VS Code 的设置是有作用域的（默认 / 工作区 / 工作区文件夹），所以
 * **不同窗口的 `dshChat.url` / `dshChat.command` 可能不同**——例如 A、B 两个工作区
 * 各自写了"用内部 dsh"，而全局用户设置是"用外部 URL"，其余窗口就该走外部。
 * 若所有窗口共用一份会合信息，配置不同的窗口会互相抢后台（配置外部的那位会无视
 * 自己那份配置，去接入别人起的内部后台）。
 *
 * 所以按**有效配置**分组：有效配置相同的窗口（包括"来源不同但有效值相同"）共用一个后台；
 * 不同的各管各的。`url` 非空时只按 url 分组——那时 `command` 与超时本来就不生效。
 *
 * **算法只有一份**（`groupForConfig`）：探针也要算同一个键，两处漂移就会变成
 * "两个窗口互相看不见对方的后台、各起一个"。
 */
function leaseGroupKey(config: () => vscode.WorkspaceConfiguration): string {
  const url = (config().get<string>("url") ?? "").trim().replace(/\/+$/, "");
  const command = config().get<string>("command") || DEFAULT_COMMAND;
  return groupForConfig(url, command);
}

function outputChannel(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("DSH Chat");
  return output;
}

/**
 * 日志写入器：**永不抛异常**（见 `dsh/hostLog.ts` 的文件头——2026-09-13 那个
 * 「关窗后后台还在、下次启动连不上」的缺陷就是这一句抛异常导致的）。
 *
 * 通道取用是懒的：关窗期通道已被 VS Code 关闭时，消息先攒着，不往外抛。
 */
const log = createHostLog(() => outputChannel());

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("dshChat");

  // 有效配置算出"分组"：有效配置相同的窗口共用一套 supervisor（见 `leaseGroupKey`）。
  const group = leaseGroupKey(config);

  // 拉起 supervisor 的真实实现：用 VS Code 自带的 Node 跑 `dist/supervisor.js`
  // （见 `dsh/runtimeResolve.ts`——不要求用户装 Node，也不用 PATH 上的 node）
  const launcher = createDefaultSupervisorLauncher({
    extensionPath: context.extensionPath,
    appRoot: vscode.env.appRoot,
    log,
  });

  const server = new SupervisorManager({
    group,
    url: config().get<string>("url") ?? "",
    command: config().get<string>("command") || DEFAULT_COMMAND,
    idleSec: config().get<number>("supervisorIdleSec") ?? IDLE_SEC_DEFAULT,
    // `autoStart` 关掉时，扩展**不许**自己拉起后台（只在后台已在跑时自动接上）；
    // 用户显式动作（发消息 / 点「启动服务器」）不受它约束，见 supervisorManager 文件头
    autoStart: config().get<boolean>("autoStart") ?? true,
    workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    launcher,
    log,
  });

  const controller = new ChatController(
    server,
    log,
    // 全局存储：跨工作区共享（本地已删除的会话 id）
    context.globalState,
    // 工作区存储：VS Code 自己那份**按工作区分文件**的缓存，用来记「这个文件夹
    // 上次开着哪几个对话窗口、各自是哪个会话」（见 dsh/windowState.ts）。
    // 它落在 VS Code 的 workspaceStorage 下，不往项目目录里写任何文件。
    context.workspaceState,
    context.secrets,
  );
  // 两个侧栏视图容器各挂一个带标识的实例：日志里能区分视图来自主侧栏还是辅助侧栏
  const provider = new ChatViewProvider(context, controller, "primary", log);
  const secondaryProvider = new ChatViewProvider(context, controller, "secondary", log);

  // 编辑区面板的恢复必须**同步**注册：重开工作区时面板恢复可能就是扩展被激活的
  // 原因，晚一步注册这次恢复就接不到了（见 ChatViewProvider.registerPanelSerializer）。
  // 挂在主侧栏那个实例上，与 openPanel 的创建方保持一致（面板只有这一处宿主）
  provider.registerPanelSerializer();

  // 第一部分：把服务、控制器、视图与全部命令挂到 context.subscriptions（释放即随扩展一起走）
  registerContributions(context, { controller, provider, secondaryProvider, server, config });

  // 辅助侧栏容器（secondarySidebar 贡献点）只在 VS Code ≥ 1.106 存在。
  // 活动栏容器用 `when: !dshChat.supportsSecondarySidebar` 与它互斥，
  // 所以这个标记必须按真实版本设置：写死 true 会让旧版本两个容器都不显示。
  void vscode.commands.executeCommand(
    "setContext",
    "dshChat.supportsSecondarySidebar",
    supportsSecondarySidebar(),
  );

  // 第二部分：启动期收尾——清残留进程、自动连接、按需打开面板
  startup(config, controller);
}

/** 激活期需要交给命令注册使用的对象。 */
interface Contributions {
  controller: ChatController;
  provider: ChatViewProvider;
  secondaryProvider: ChatViewProvider;
  server: SupervisorManager;
  /** 每次调用都重读 `dshChat.*`（配置变更监听要用最新值，不能用激活期快照）。 */
  config: () => vscode.WorkspaceConfiguration;
}

/**
 * 注册视图提供者、命令与配置/状态监听。
 * 全部一次性 push 进 context.subscriptions，deactivate 时统一释放。
 */
function registerContributions(context: vscode.ExtensionContext, host: Contributions): void {
  const { controller, provider, secondaryProvider, server } = host;

  context.subscriptions.push(
    output ?? vscode.window.createOutputChannel("DSH Chat"),
    controller,
    provider,
    // 必须注册 server 本身：deactivate 时 dispose 会**关掉本窗口与 supervisor 的长连接**
    // （不再杀任何进程——dsh 的生死由 supervisor 按"还有几个窗口连着"自己裁决）
    server,
    server.onDidChangeStatus((status) => controller.onServerStatus(status)),

    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, secondaryProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    secondaryProvider,

    // 「新建对话」建在**最近活动的窗口**上：那个窗口的会话换成新的（其他窗口不动）
    vscode.commands.registerCommand("dshChat.newSession", () => controller.newSession(controller.activeViewId())),
    vscode.commands.registerCommand("dshChat.history", async () => {
      await controller.openHistory();
      controller.revealActiveView();
    }),
    // 「在编辑器中打开」：webview 按钮会把点击来源窗口的会话带过来；
    // 命令面板直接执行（没有来源窗口）时用最近活动窗口的会话；都没有就空态
    vscode.commands.registerCommand(
      "dshChat.openInEditor",
      (sessionId?: string) => {
        log(`[cmd] openInEditor session=${sessionId ?? "（无来源窗口，取活动窗口）"}`);
        return provider.openPanel(sessionId ?? controller.activeSessionId()).panel;
      },
    ),
    // 编辑器标题栏（`editor/title` 贡献点）那颗「打开 DSH 窗口」按钮的落点：
    // 与上面那条**刻意不同**——它固定开在**用户当前所在的编辑器分组**里
    // （`ViewColumn.Active`，不是旁边新开一个分组），并且直接起一个**新会话**
    // （用户 2026-09-15 口径：在编辑窗口右上角点一下，本分组里多一个 DSH 新会话
    // 标签页并跳过去）。新会话是用户显式动作，允许拉起后台（见 supervisorManager
    // 的口径），`newSession` 内部就是按 `{ start: true }` 连的。
    vscode.commands.registerCommand("dshChat.newSessionInGroup", async () => {
      const { viewId } = provider.openPanel(undefined, vscode.ViewColumn.Active, true);
      log(`[cmd] newSessionInGroup viewId=${viewId}`);
      await controller.newSession(viewId);
    }),
    // 「停止生成」停最近活动窗口正在跑的这一轮（后台继续）
    vscode.commands.registerCommand("dshChat.stop", () => controller.stopActive()),
    // 「启动服务器」：**用户显式要求**，允许在后台不存在时拉起一套
    // （关掉 `dshChat.autoStart` 时，这就是界面上那个「启动服务器」按钮的落点）
    vscode.commands.registerCommand("dshChat.startServer", () => controller.startServer()),
    vscode.commands.registerCommand("dshChat.restartServer", () => controller.restart()),
    // 「停止服务器」：请 supervisor 把 dsh 一起收场并退出（**扩展自己不 taskkill**）
    vscode.commands.registerCommand("dshChat.stopServer", async () => {
      await server.stopAndExit();
      await vscode.window.showInformationMessage(
        vscode.l10n.t("Stopped the DSH server and its supervisor process."),
      );
    }),
    // 外部服务器（dshChat.url）要求授权时，令牌从这里输入
    vscode.commands.registerCommand("dshChat.setToken", () => controller.setToken()),
    vscode.commands.registerCommand("dshChat.showLogs", () => {
      outputChannel().show(true);
    }),
    vscode.commands.registerCommand("dshChat.showDiagnostics", async () => {
      const status = server.getStatus();
      const shared = server.sharedSummary();
      const state = server.peekState();
      const message = [
        vscode.l10n.t("Server state: {0}", status.state),
        status.info ? vscode.l10n.t("Address: {0}", status.info.baseUrl) : undefined,
        // 「是不是本扩展启动的」**只在外部模式下才是否**：内部后台一律由本扩展拉起，
        // 区别只在于"是不是**这个窗口**拉起的"。原来写成 yes / no(用 url) 会误导用户
        // （用户 2026-09-13 报：连到别的窗口拉起的那个时，它明明也是本扩展启动的）。
        status.info
          ? status.info.ownership === "external"
            ? vscode.l10n.t("Started by this extension: {0}", vscode.l10n.t("no (external dshChat.url)"))
            : vscode.l10n.t(
                "Started by this extension: {0}",
                status.info.owned
                  ? vscode.l10n.t("yes, by this window")
                  : vscode.l10n.t("yes, by another window (shared)"),
              )
          : undefined,
        shared
          ? vscode.l10n.t(
              "Shared with other VS Code windows: {0}",
              shared.ownership === "self"
                ? vscode.l10n.t("this window started the supervisor, {0} window(s) in total", shared.hostCount)
                : shared.ownership === "peer"
                  ? vscode.l10n.t("using the supervisor of another window, {0} window(s) in total", shared.hostCount)
                  : vscode.l10n.t("no (external dshChat.url)"),
            )
          : undefined,
        status.detail ? vscode.l10n.t("Detail: {0}", resolveForVsCode(status.detail)) : undefined,
        // 只列**当前后台自己的**进程：守护进程 + 它持有的 dsh。
        // （曾经这里会"扫描并报残留进程"，但那个判定依赖命令行匹配、分不清"在用"与"没人管"，
        //   准确度不够——不准确的判定不如不要，用户 2026-09-13 定。）
        state
          ? vscode.l10n.t(
              "Server processes: supervisor {0}{1}",
              state.supervisorPid,
              state.serverPid === undefined ? "" : `, dsh ${state.serverPid}`,
            )
          : undefined,
        vscode.l10n.t("Supervisor directory: {0}", server.rendezvousDirectory),
        vscode.l10n.t("Supervisor log: {0}", server.logPath),
        vscode.l10n.t("Extension log: the “DSH Chat” output channel"),
      ]
        .filter(Boolean)
        .join("\n");
      await vscode.window.showInformationMessage(message, { modal: true });
    }),

    // 编辑器与资源管理器右键入口。
    //
    // 「添加选区」与「添加文件」**合并成一条命令**（用户 2026-09-14 口径）：同一个
    // 快捷键 `alt+shift+2` 与同一个右键项，行为按「当前有没有选中」自己分派——
    // 有选中就加选区，没有就加整个文件。
    //
    // **三者一律走 `@` 引用**（用户 2026-09-14 口径：「不论是目录、文件、文件某行，
    // 均以 @ 引用形式而不是附件形式添加」）：插入的是 `@路径` / `@路径#L12-L40` /
    // `@目录/` 这样的**正文 token**，由模型自己用 `read` / `list` 去读；
    // 附件（上传、图片）只从回形针与拖放那条通道走。
    //
    // **坑（用户 2026-09-14 实测报的）**：VS Code 给 `editor/context` 的命令也会把
    // **当前文档的 uri** 当作第一个参数传进来，和 `explorer/context` 一模一样。所以
    // 「有 uri 就当资源管理器点击」会把编辑器里选中的代码当成「添加整个文件」——
    // 右键菜单于是永远加整文件。判据必须是「这个 uri 是不是当前编辑器打开的那份」：
    // 是 → 编辑器入口（按选区分派）；不是 → 资源管理器点中的那个文件。
    //
    // 残留的歧义：在资源管理器里右键**正好是当前编辑器打开的那份文件**、且编辑器里
    // 有选区时，按选区处理。那种情形下「加选中的这段」也是合理读法，不必再加一个
    // 命令 id 去区分。
    //
    // 命令标题**不能**随选中状态变化：菜单项标题来自 `package.json` 的
    // `contributes.commands`，运行期没有任何 API 能改（菜单贡献项本身也不支持逐项
    // `title` 覆盖，见 microsoft/vscode#34048）。所以统一命名为
    // 「添加文件(或选区)到对话」，把两种语义都写在名字里。
    vscode.commands.registerCommand("dshChat.addToChat", (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const fromEditor =
        uri !== undefined && editor !== undefined && uri.toString() === editor.document.uri.toString();

      // 资源管理器点中的文件（且不是编辑器里正开着的那份）→ 加这个文件的 `@` 引用
      if (uri && !fromEditor) {
        if (uri.scheme !== "file") return;
        void controller.addFileContext(uri.fsPath);
        controller.revealActiveView();
        return;
      }

      // 编辑器入口（或有选中时的命令面板/快捷键）：有选中加**带行号的选区引用**
      if (editor && !editor.selection.isEmpty) {
        const name = vscode.workspace.asRelativePath(editor.document.uri);
        controller.addSelection(name, selectionLines(editor.selection));
        // 焦点回到**加引用的那个窗口**（可能是侧栏，也可能是编辑区面板）：
        // 写死 `dshChat.view.focus` 会把开在编辑区的对话硬拽回侧栏
        controller.revealActiveView();
        return;
      }
      // 没有选区（或选区为空）→ 添加整个文件的 `@` 引用
      const target = editor?.document.uri;
      if (!target || target.scheme !== "file") return;
      void controller.addFileContext(target.fsPath);
      controller.revealActiveView();
    }),
    // 目录单独入口：Windows/Linux 的文件对话框不能同时选文件和目录
    // （见 controller.pickFiles 的注释），所以目录走独立命令。
    // 右键文件夹时 uri 直接给到，不再弹对话框。
    vscode.commands.registerCommand("dshChat.addFolder", async (uri?: vscode.Uri) => {
      if (uri) await controller.addFileContext(uri.fsPath);
      else await controller.addFolder();
      controller.revealActiveView();
    }),

    // 界面相关配置（diff 排版 / 语言 / 字号 / 问卷题数）改了即时生效，
    // 不必重载窗口。它们都是纯显示层：重载会丢掉滚动位置与展开状态，代价不成比例。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dshChat.diffLayout")) controller.refreshDiffLayout();
      if (
        event.affectsConfiguration("dshChat.language") ||
        event.affectsConfiguration("dshChat.fontSize") ||
        event.affectsConfiguration("dshChat.questionBatch")
      ) {
        controller.refreshAppearance();
      }
      // 服务器两件套（`dshChat.url` / `dshChat.command`）改了要**真正换一个后台**：
      // 配置项只在启动时读一次，不重连的话用户改了 `dshChat.url`（或启动命令）
      // 却仍连着旧服务器。
      // **服务器配置不再就地热切换**（用户口径 2026-09-14：太复杂，改成重载窗口生效）。
      // 原地切需要"断干净 + 按新配置接上 + 换分组 + 别把别人的后台带走"一整套时序，
      // 收益却只是省一次窗口重载——不值得。这里的提示是**唯一**的生效入口，
      // 配置项说明里也写明了「改完需要重载窗口」。
      if (
        event.affectsConfiguration("dshChat.url") ||
        event.affectsConfiguration("dshChat.command")
      ) {
        void promptServerReload();
      }
    }),
  );
}

/** 服务器配置改了：提示重载窗口（这是唯一生效方式）。 */
async function promptServerReload(): Promise<void> {
  const picked = await vscode.window.showInformationMessage(
    vscode.l10n.t("Server settings changed. Reload the window to apply them."),
    vscode.l10n.t("Reload Window"),
  );
  if (picked) void vscode.commands.executeCommand("workbench.action.reloadWindow");
}

/** 启动期收尾：清理上次未正常关闭的残留服务器、按配置自动连接。 */
function startup(
  config: () => vscode.WorkspaceConfiguration,
  controller: ChatController,
): void {
  // 启动初期的残留处置：
  //
  // **supervisor 的会合文件与进程都不在这里动**。新形态下"没人用"由 supervisor 自己
  // 按连接数裁决（默认空闲 10 秒就收场），扩展启动时**没有**任何需要"清理残留"的动作
  // —— 旧实现那套"清失效心跳 / 回收遗留租约"是在替多方协商擦屁股，现在没有协商了。
  //
  // 唯一保留的是**崩溃遗留的 writer 锁**清理，而且必须在起 dsh 之前：
  // `dsh web` 的 boot 会去锁 `.credentials.yaml`，等 30 秒拿不到就把整个进程带走
  // （用户实测的 `atomic-write: timed out waiting for the writer lock`）。
  // 库本身刻意不回收孤儿锁，所以这一步是扩展的责任。
  const autoStart = config().get<boolean>("autoStart") ?? true;
  void clearStaleDocumentLocks(log)
    .then((result) => {
      if (result.cleared.length) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Cleared the file lock left behind by the last abnormal exit (otherwise the dsh server would fail to start while waiting for it).",
          ),
        );
      }
      if (result.held.length) {
        log(`[lock] ${result.held.join("、")} 仍有持有者，未清理`);
      }
    })
    .catch((error: unknown) => {
      log(`[lock] 残留锁检测失败：${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      // 自动连接的决策全在控制器里（用户 2026-09-14 口径）：
      // - `autoStart` 开着：没有就起一套、有就复用（原行为）；
      // - 关着：**先判断后台在不在跑**——在跑（守护进程 + dsh）才自动重连，
      //   不在就只切到"已停止"，界面显示「启动服务器」，扩展绝不自己拉起一套。
      void controller.autoConnect(autoStart);
    });
}

/** VS Code ≥ 1.106 才有辅助侧栏（secondarySidebar 视图容器贡献点）。 */
function supportsSecondarySidebar(): boolean {
  const [major, minor] = vscode.version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 1 || (major === 1 && minor >= 106);
}

export function deactivate(): void {
  // 全部资源（含 ServerManager.dispose → stop() 杀服务器进程树）随
  // context.subscriptions 在 deactivate 时释放，这里无需额外动作
}
