/**
 * 连接条的**一个纯函数**：三类状态 + 那行文案 + 按钮集合（用户 2026-09-19 收敛）。
 *
 * 从这里以前，"连接条该长什么样"散在四处：`App.tsx` 的 `ConnectionBar` 自己判
 * `connection` 三档、`statusText` 拼两轴短语、`connectingText` 拼目标与阶段，而宿主侧
 * `controller.ts` 的 `viewConnection` / `connectionPatch` 又各判一遍。四处判同一件事的
 * 代价不是啰嗦，而是**改一处忘三处**：按钮矩阵是用户口径（§9.4，权威），而它在界面里
 * 是"渲染条件"，在宿主里是"字段"，两边都会漂。
 *
 * 现在的纪律：**判定只有这一处**，`App.tsx` 只渲染它的结论（`kind` 决定样式与转圈、
 * `text` 直接落字、`buttons` 按序渲染）。于是这套矩阵可以**离线断言**——不需要 DOM、
 * 不需要 React，给一个 state 与一份词典就能把三类状态 × 每种标志的组合逐条钉住
 * （`scripts/connectView.test.ts`）。
 *
 * 三条不许动的东西（都是用户口径，见 `docs/design-supervisor.md` §8.7 / §9.4）：
 *
 * 1. **连接中只有「停止连接」+「查看日志」**，目标写在文案里（不摆启动/连接按钮）；
 * 2. **「查看日志」恒显**——每一档都可能是"连不上但说不清"；「停止连接」只在正在连接时给；
 * 3. **按钮态（`stopped` / `error`）**：内部在跑 → 「连接内部 DSH」，不在 → 「启动内部 DSH」，
 *    外加恒显的「连接外部 DSH」（没配 `dshChat.url` 时置灰 + 悬停提示）、内部在跑时的
 *    「重启内部 DSH」、需要令牌时的「输入令牌」，最后是恒显的「查看日志」。
 *
 * **本模块不依赖 React**（只吃 `ChatState` 与一份词典）：`resolve` 由调用方注入，
 * 于是"标记怎么翻"仍留在界面那侧（`texts.ts` 的 `resolveText`），这里只管**判定**。
 */
import type { ChatState } from "../shared/chat";

/** 连接条的四种形态：三类状态 + 「整条不渲染」。 */
export type ConnectKind = "hidden" | "connecting" | "stopped" | "error";

/**
 * 连接条上可能出现的按钮（**顺序即渲染顺序**，由 `connectViewOf` 排好）。
 *
 * 给的是**语义 id** 而不是 IPC 报文名：点它发哪条指令是界面侧的事
 * （`App.tsx` 的 `CONNECT_POST`），这里只回答"这一档给哪几个按钮"。
 */
export type ConnectButtonId =
  | "stopReconnect"
  | "startInternal"
  | "connectInternal"
  | "connectExternal"
  | "restartInternal"
  | "enterToken"
  | "showLogs";

export interface ConnectButton {
  id: ConnectButtonId;
  /** 已按当前语言取好的按钮文字。 */
  label: string;
  /** 图标（`null` = 这个按钮没有图标，例如「停止连接」与「查看日志」）。 */
  icon: "key" | "plus" | "refresh" | null;
  /** `primary` = 主按钮（`btn btn-primary`）、`ghost` = 幽灵按钮、`plain` = 普通按钮。 */
  variant: "primary" | "ghost" | "plain";
  /** 置灰（`disabled`）；缺省表示可点。 */
  disabled?: boolean;
  /** 置灰时的悬停说明（挂在按钮外层，`disabled` 的元素收不到 hover）。 */
  tip?: string;
  /** 窄侧栏（迷你模式）下隐藏：`data-mini="hide"`。 */
  miniHide?: boolean;
}

export interface ConnectView {
  kind: ConnectKind;
  /** 条上那行字（已按当前语言解析完；`hidden` 时是空串）。 */
  text: string;
  /** 按序渲染的按钮；`hidden` 时为空。 */
  buttons: ConnectButton[];
}

/**
 * 本模块用到的词典条目（`Texts` 的一个**结构子集**）。
 *
 * 刻意只列用到的那些：一来这里不必依赖 `texts.ts`（那个文件 import 了 React），
 * 二来"连接条用了哪几条文案"在类型上就是一份清单——加一条文案时这里会先报缺键。
 */
export interface ConnectTexts {
  /** 目标未定、地址也没有时的兜底"正在连接…"。 */
  connecting: string;
  startingInternal: string;
  connectingInternal: string;
  connectingExternal: (baseUrl: string) => string;
  statusInternalRunning: string;
  statusInternalNotRunning: string;
  statusExternalReachable: string;
  statusExternalUnreachable: string;
  statusExternalUnconfigured: string;
  statusSeparator: string;
  startInternal: string;
  connectInternal: string;
  connectExternal: string;
  restartInternal: string;
  externalDisabledHint: string;
  enterToken: string;
  stopReconnect: string;
  showLogs: string;
}

/** 连接条那行字：按钮态的**两轴短语**（「内部 DSH：未运行 · 外部 DSH：可达」）。 */
function statusText(state: ChatState, texts: ConnectTexts): string {
  const internal = state.internalRunning === true ? texts.statusInternalRunning : texts.statusInternalNotRunning;
  const external =
    state.externalState === "reachable"
      ? texts.statusExternalReachable
      : state.externalState === "unreachable"
        ? texts.statusExternalUnreachable
        : texts.statusExternalUnconfigured;
  return `${internal}${texts.statusSeparator}${external}`;
}

/**
 * 连接中那行字：写明**目标与阶段**。
 *
 * 有失败详情时（外部地址连不上、与服务器断线）**原因优先**——那才是用户想知道的东西。
 */
function connectingText(state: ChatState, texts: ConnectTexts, detail: string | undefined): string {
  if (detail) return detail;
  if (state.connectTarget === "internal") {
    return state.connectPhase === "starting" ? texts.startingInternal : texts.connectingInternal;
  }
  if (state.connectTarget === "external") {
    return state.externalAddress ? texts.connectingExternal(state.externalAddress) : texts.connecting;
  }
  return `${texts.connecting}${state.serverUrl ? ` ${state.serverUrl}` : ""}`;
}

/**
 * 连接条的全部结论：**三类状态 + 文案 + 按钮集合**（见文件头的口径）。
 *
 * - `ready`（连上了）→ `kind: "hidden"`：整条不渲染（就绪时不该占位置）；
 * - `connecting`（首轮、掉线重试、外部地址的等待）→ 目标 + 阶段写在文案里，
 *   有详情时详情优先；按钮只有「停止连接」+「查看日志」；
 * - `error`（启动类 / 认证类失败，**要用户动作**）与 `stopped`（按钮态：没连也没在试）
 *   → 文案优先给详情、否则给两轴短语；按钮按内部那一轴 + 令牌入口 + 恒显的外部与日志。
 *
 * `resolve` 把宿主发来的 `@key` 标记翻成当前语言（由界面侧注入）；它只作用于
 * `connectionDetail` ——其余文案都直接来自注入的词典。
 */
export function connectViewOf(
  state: ChatState,
  texts: ConnectTexts,
  resolve: (text: string) => string,
): ConnectView {
  if (state.connection === "ready") return { kind: "hidden", text: "", buttons: [] };

  const connecting = state.connection === "connecting";
  const internalRunning = state.internalRunning === true;
  const externalConfigured = state.externalState !== "unconfigured";
  // 详情优先：`error` 或是连接中被判定"连不上"时，原因是用户最需要看的东西
  const detail = state.connectionDetail ? resolve(state.connectionDetail) : undefined;
  const text = connecting ? connectingText(state, texts, detail) : (detail ?? statusText(state, texts));
  // **恒显**的日志入口：每一档都可能是"连不上但说不清"
  const logButton: ConnectButton = {
    id: "showLogs",
    label: texts.showLogs,
    icon: null,
    variant: "ghost",
    miniHide: true,
  };

  if (connecting) {
    // 连接中**唯一**的主动作：停下来由用户说了算（重连没有总超时）。
    // 目标由系统自己选（内部优先、外部备用），所以这里**不摆**启动/连接按钮。
    return {
      kind: "connecting",
      text,
      buttons: [{ id: "stopReconnect", label: texts.stopReconnect, icon: null, variant: "plain" }, logButton],
    };
  }

  const buttons: ConnectButton[] = [];
  // 外部服务器要令牌而自动获取的那份没被接受：给「输入令牌」入口（内部模式没有这一档）
  if (state.needsToken === true) {
    buttons.push({ id: "enterToken", label: texts.enterToken, icon: "key", variant: "plain" });
  }
  // 内部那一轴：在跑 → 「连接内部 DSH」，不在 → 「启动内部 DSH」。
  // 两个按钮**同一套逻辑**（有就接上、没有就起一套，§9.4）：界面显示的是两轴探测的结论，
  // 与后台真实状态必然有偏差，语义相同才不会出现"点对了按钮却什么都没发生"。
  buttons.push(
    internalRunning
      ? { id: "connectInternal", label: texts.connectInternal, icon: "refresh", variant: "primary" }
      : { id: "startInternal", label: texts.startInternal, icon: "plus", variant: "primary" },
  );
  // 恒显：显示与否**不看可达性**（连接失败会写进日志与条上）；只有没配地址时置灰。
  // 提示文字挂在按钮外层（`disabled` 的元素收不到 hover，title 不会显示）
  buttons.push({
    id: "connectExternal",
    label: texts.connectExternal,
    icon: "refresh",
    variant: "plain",
    disabled: !externalConfigured,
    tip: externalConfigured ? undefined : texts.externalDisabledHint,
  });
  // 「重启内部 DSH」只在内部那套在跑时给（外部目标没有"重启"可言）
  if (internalRunning) {
    buttons.push({ id: "restartInternal", label: texts.restartInternal, icon: "refresh", variant: "plain" });
  }
  buttons.push(logButton);
  return { kind: state.connection === "error" ? "error" : "stopped", text, buttons };
}
