import { useState } from "react";
import type { AgentPresetsView, WorkspaceView } from "../../shared/chat";
import { post } from "../bridge";
import { dirKey, workspaceDirView, type WorkspaceDirView } from "../composerDir";
import { shortDirectoryLabels } from "../directoryLabel";
import { IconAgentPreset, IconCheck, IconChevronDown, IconFolder } from "../icons";
import { splitPath } from "../pathDisplay";
import { presetDisplayText } from "../presetDisplay";
import { useTexts } from "../texts";
import { Popover } from "./primitives";

/**
 * 空态页（新会话的初始页面）上的两行元信息：**这个会话落在哪个目录**、
 * **它用哪套 agent 组装**。
 *
 * 为什么住在这里而不是输入区工具栏：两者都只在「会话还没开始」时有意义——
 * agent 预设只有空白会话能换（服务端在有过轮次后回 `agent-preset/locked`），
 * 工作目录更是会话一建好就固定了。一个大部分时间只能显示不能用的控件，
 * 该放在它还有用的那页上（官方 agent-preset chip 的同一句理由）。
 *
 * 工作目录行在空会话页才可改：打开着文件夹时把工作区根目录作为预设列出，
 * 并允许（宿主没禁用时）选一个工作区外目录；没有根目录列表的老宿主仍走原来的
 * 系统目录选择器。已有对话不会再渲染这里，标题栏那枚目录只是静态说明——目录是
 * 创建时定下的事实，扩展没有可用的接口改它。
 *
 * `workspace` / `agentPresets` 的可见性判据都在宿主侧定死（`ChatState` 的字段注释）：
 * 拿不到就整个不渲染，而不是渲染一个空壳。这里只做渲染与本地的展开态。
 */
export function EmptyMeta({
  workspace,
  agentPresets,
  agentPreset,
}: {
  /** 新会话的工作目录；拿不到（旧宿主）就不显示这一行。 */
  workspace?: WorkspaceView;
  /** 部署提供的预设目录；空表 / 服务端未开放选择时整个下拉框不出现。 */
  agentPresets?: AgentPresetsView;
  /** 当前会话生效的预设 id；不知道是哪个时同样不渲染（官方 chip 同口径）。 */
  agentPreset?: string;
}) {
  return (
    <div className="empty-meta">
      <WorkspaceChip workspace={workspace} />
      <AgentPresetChip catalog={agentPresets} current={agentPreset} />
    </div>
  );
}

/**
 * 目录文字：拆成「目录前缀 + 末段」，末段不参与收缩。
 *
 * 与正文里路径类节点的口径同一套（`pathDisplay.splitPath` + `.row-detail-dir`）：
 * 窄侧栏里先被裁掉的应该是前面的目录层级，而不是用户真正在看的那个目录名。
 * 不认识（不是路径）时原样一段。
 */
function PathText({ path }: { path: string }) {
  const parts = splitPath(path);
  if (!parts) return <span className="meta-name">{path}</span>;
  return (
    <>
      {parts.dir ? <span className="meta-dir">{parts.dir}</span> : null}
      <span className="meta-name">{parts.name}</span>
    </>
  );
}

/**
 * 工作目录那一行。
 *
 * - **打开着文件夹**：胶囊可点，菜单列出全部根目录（当前那个打勾）与「选择其他
 *   文件夹…」（`canPickOther` 明确为 false 时不显示）；点根目录发 `switchRoot`，
 *   点其他文件夹发 `pickOtherRoot`；
 * - **可改**（没打开文件夹、选过或没选过）：沿用空态页原来的系统目录选择器
 *   （`pickWorkspace`），没选过时显示「未选择工作区」；
 * - **老宿主 / 跟随 VS Code**：静态文字，悬停说明它跟着 VS Code。
 *
 * 判据由宿主下发（`WorkspaceView.roots` / `locked` / `canPickOther`）而不是界面
 * 自己问「有没有打开文件夹」—— webview 读不到 VS Code 的工作区状态。
 */
function WorkspaceChip({ workspace }: { workspace?: WorkspaceView }) {
  const texts = useTexts();
  const view = workspaceDirView(workspace);
  const [open, setOpen] = useState(false);
  if (!view) return null;
  const chosen = view.path;
  const body = (
    <>
      <IconFolder size={13} />
      <span className="meta-label">
        {chosen ? <PathText path={chosen} /> : <span className="meta-name">{texts.workspaceNone}</span>}
      </span>
    </>
  );

  if (view.mode === "locked") {
    // 静态行也要能读到**完整路径**：窄侧栏里上面那段目录前缀是被裁掉的
    return (
      <span className="meta-chip is-static" title={`${view.path}\n${texts.workspaceLocked}`}>
        {body}
      </span>
    );
  }

  if (view.mode === "disabled") {
    // 宿主明确禁用外部目录：仍显示当前值，但不给任何选择入口（系统选择器也是外部目录）
    return (
      <span className="meta-chip is-static" title={texts.workspacePickDisabled}>
        {body}
      </span>
    );
  }

  if (view.mode === "pick") {
    // 悬停说明点下去会发生什么；没选过时说「选择工作目录」，选过时说「更改工作目录」。
    // 没选过时不把 title 拼成「（空行）+ 提示」，所以两条分开写。
    const title = chosen ? `${chosen}\n${texts.workspaceChange}` : texts.workspaceChoose;
    return (
      <button className="meta-chip" title={title} onClick={() => post({ type: "pickWorkspace" })}>
        {body}
        <IconChevronDown size={9} />
      </button>
    );
  }

  return (
    <>
      <button
        className="meta-chip"
        title={chosen ? `${chosen}\n${texts.dirSwitchRoot}` : texts.dirSwitchRoot}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {body}
        <IconChevronDown size={9} />
      </button>
      {/* 向下展开、并相对**这一块**居中：与 agent 预设菜单同一套落位（`.empty-meta`
          是定位祖先）；窄侧栏里菜单不会按触发按钮的对齐方向被裁掉一边。 */}
      <Popover open={open} onClose={() => setOpen(false)} align="center" drop="down">
        <WorkspaceMenu view={view} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/**
 * 工作目录菜单：当前值先说清，再列可选项。
 *
 * 根目录用去重短名（`shortDirectoryLabels`），完整路径挂在 `title` 上；当前目录
 * 是工作区外目录时，在根目录上方单独列一条已选中行——用户点过「选择其他文件夹…」
 * 之后要能看出现在落在哪，而不是一列根目录里一个都没勾。
 */
export function WorkspaceMenu({ view, onClose }: { view: WorkspaceDirView; onClose: () => void }) {
  const texts = useTexts();
  const labels = shortDirectoryLabels(view.roots);
  const choose = (path: string) => {
    onClose();
    if (dirKey(path) === dirKey(view.path)) return;
    post({ type: "switchRoot", path });
  };
  return (
    <>
      <div className="popover-section">{texts.dirSwitchRoot}</div>
      {view.currentInRoots ? null : (
        <div className="popover-item is-selected" title={view.path}>
          <span className="popover-item-icon">
            <IconCheck size={14} />
          </span>
          <span className="popover-item-main">{view.name}</span>
          <span className="popover-item-sub">{view.path}</span>
        </div>
      )}
      {view.roots.map((root) => {
        const current = dirKey(root.path) === dirKey(view.path);
        return (
          <button
            key={root.path}
            className={`popover-item${current ? " is-selected" : ""}`}
            title={root.path}
            onClick={() => choose(root.path)}
          >
            <span className="popover-item-icon">
              {current ? <IconCheck size={14} /> : <IconFolder size={14} />}
            </span>
            <span className="popover-item-main">{labels.get(dirKey(root.path)) ?? root.name}</span>
            <span className="popover-item-sub">{root.path}</span>
          </button>
        );
      })}
      {view.canPickOther ? (
        <button
          className="popover-item"
          onClick={() => {
            onClose();
            post({ type: "pickOtherRoot" });
          }}
        >
          <span className="popover-item-icon">
            <IconFolder size={14} />
          </span>
          <span className="popover-item-main">{texts.dirOtherFolder}</span>
        </button>
      ) : null}
    </>
  );
}

/**
 * agent 预设下拉框。
 *
 * 渲染条件**一条不许少**：这条链路允许选择预设（`selectable`——老服务端看 roster 的
 * `modeSelectionEnabled`，新服务端看宿主的偏好，合成一处见 `dsh/projections.ts`）、
 * 目录非空、且知道当前生效的是哪一个。少任何一条都整个不出现——一个点开只有
 * 「当前这一个」或点不动的控件比没有更糟。
 *
 * 菜单里是**卡片**（名字 + 最多三行描述 + 选中对勾），不是输入区那种单行候选：
 * 描述是选择的依据，挤成一行省略号等于没有（用户 2026-09-22 口径，与官方菜单一致）。
 *
 * 选择只影响**当前这个空白会话**：新会话从配置项（`dshChat.agentPreset`，没配就是
 * 服务端的默认预设）重新开始，与官方 chip 的「暂存值用掉就忘」同一口径。
 */
function AgentPresetChip({
  catalog,
  current,
}: {
  catalog?: AgentPresetsView;
  current?: string;
}) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  if (!catalog || !catalog.selectable || catalog.options.length === 0 || !current) return null;
  const chosen = catalog.options.find((option) => option.id === current);
  // 目录里没有这一条（预设被删了、或服务端换了实现）时退回 id：它是唯一还认得出的身份
  const label = chosen ? presetDisplayText(chosen, texts).name : current;
  return (
    <>
      <button
        className="meta-chip"
        title={texts.agentPresetSeat}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconAgentPreset size={13} />
        <span className="meta-label">{label}</span>
        <IconChevronDown size={9} />
      </button>
      {/* 向下展开、并相对**这一块**居中：这枚胶囊在页面中间，而菜单比它宽得多——
          按触发按钮左/右对齐在窄侧栏里必然裁掉一边（`.empty-meta` 是定位祖先）。 */}
      <Popover open={open} onClose={() => setOpen(false)} align="center" drop="down">
        <div className="popover-section">{texts.agentPresetLabel}</div>
        {catalog.options.map((option) => {
          // 展示名与描述只有这一份折叠（随产品交付的走词典、用户写的用原文）
          const text = presetDisplayText(option, texts);
          const selected = option.id === current;
          return (
            <button
              key={option.id}
              className={`preset-card${selected ? " is-selected" : ""}`}
              // 简述在界面上最多三行，悬停要能读到全文（`.preset-card-desc` 的 clamp）
              title={text.description}
              onClick={() => {
                setOpen(false);
                if (!selected) post({ type: "setAgentPreset", id: option.id });
              }}
            >
              <span className="preset-card-head">
                <span className="preset-card-name">{text.name}</span>
                {selected ? (
                  <span className="preset-card-check">
                    <IconCheck size={13} />
                  </span>
                ) : null}
              </span>
              <span className="preset-card-desc">
                {text.description ?? texts.agentPresetNoDescription}
              </span>
            </button>
          );
        })}
      </Popover>
    </>
  );
}
