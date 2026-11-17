import { post } from "../bridge";
import { dirKey, type ComposerDirView } from "../composerDir";
import { IconCheck, IconFolder } from "../icons";
import { useTexts } from "../texts";

/**
 * 输入栏的**工作目录胶囊**：图标 + 目录名，悬停是完整路径，点开 `DirMenu`。
 *
 * 样式沿用权限胶囊的 `.pill-mode`（同一排的同类入口），目录名带省略号、不换行——英文 / 长目录名
 * 都不撑破工具栏（宽度由 `toolbarFit` 实测，见 `dir:full` 档）。
 */
export function DirPill({
  view,
  onMouseDown,
  onClick,
}: {
  view: ComposerDirView;
  onMouseDown: () => void;
  onClick: () => void;
}) {
  const texts = useTexts();
  return (
    <button
      className="pill-mode pill-dir"
      title={`${texts.dirTitle}\n${view.path}`}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <IconFolder size={13} />
      <span className="pill-mode-label">{view.name}</span>
    </button>
  );
}

/**
 * 工作目录弹层：先说清**现在在哪**（创建目录 / 执行目录），再按会话状态给「怎么改」。
 *
 * - 空会话 + 打开着文件夹：列出工作区的根目录，点一个就切；最后一行「选择其他文件夹…」打开系统
 *   文件夹选择器，可以选工作区之外的目录（直接生效，不弹确认）；
 * - 空会话 + 没打开文件夹：走空态页同一条系统目录选择器；
 * - 已有对话：只读。会话的目录是创建时定下的事实，扩展没有可用的接口改它，所以只说明、不给入口。
 */
export function DirMenu({ view, onClose }: { view: ComposerDirView; onClose: () => void }) {
  const texts = useTexts();
  const currentKey = dirKey(view.path);

  const rows = (
    <>
      <div className="popover-section">{texts.dirTitle}</div>
      {view.switched && view.created ? (
        <>
          <div className="dir-row">
            <span className="dir-row-label">{texts.dirExecution}</span>
            <span className="dir-row-path" title={view.path}>
              {view.path}
            </span>
          </div>
          <div className="dir-row">
            <span className="dir-row-label">{texts.dirCreated}</span>
            <span className="dir-row-path" title={view.created}>
              {view.created}
            </span>
          </div>
        </>
      ) : (
        <div className="dir-row">
          <span className="dir-row-path" title={view.path}>
            {view.path}
          </span>
        </div>
      )}
    </>
  );

  return (
    <>
      {rows}
      {view.mode === "none" ? <div className="dir-hint">{texts.workspaceLocked}</div> : null}
      {view.mode === "started" ? <div className="dir-hint">{texts.dirStartedHint}</div> : null}
      {view.mode === "pick-folder" ? (
        <>
          <div className="popover-sep" />
          <button
            className="popover-item"
            onClick={() => {
              post({ type: "pickWorkspace" });
              onClose();
            }}
          >
            <span className="popover-item-icon">
              <IconFolder size={14} />
            </span>
            <span className="popover-item-main">{texts.dirPickFolder}</span>
          </button>
        </>
      ) : null}
      {view.mode === "switch-root" ? (
        <>
          <div className="popover-sep" />
          <div className="popover-section">{texts.dirSwitchRoot}</div>
          {/* 当前目录不在工作区的根目录里：它就是用户「选择其他文件夹…」选的，作为已选中的一行列在最前 */}
          {view.roots.some((root) => dirKey(root) === currentKey) ? null : (
            <div className="popover-item is-selected" title={view.path}>
              <span className="popover-item-icon">
                <IconCheck size={14} />
              </span>
              <span className="popover-item-main">{view.path}</span>
            </div>
          )}
          {view.roots.map((root) => {
            const current = dirKey(root) === currentKey;
            return (
              <button
                key={root}
                className={`popover-item${current ? " is-selected" : ""}`}
                title={root}
                onClick={() => {
                  if (current) return;
                  post({ type: "switchRoot", path: root });
                  onClose();
                }}
              >
                <span className="popover-item-icon">{current ? <IconCheck size={14} /> : <IconFolder size={14} />}</span>
                <span className="popover-item-main">{root}</span>
              </button>
            );
          })}
          <button
            className="popover-item"
            onClick={() => {
              post({ type: "pickOtherRoot" });
              onClose();
            }}
          >
            <span className="popover-item-icon">
              <IconFolder size={14} />
            </span>
            <span className="popover-item-main">{texts.dirOtherFolder}</span>
          </button>
        </>
      ) : null}
    </>
  );
}
