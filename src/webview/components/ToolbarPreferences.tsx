import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import type {
  ToolbarOptionId,
  ToolbarPreference,
  ToolbarPreferenceAction,
} from "../../shared/toolbarPreference";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import { IconChevronDown, IconClose } from "../icons";
import { useTexts } from "../texts";

interface ToolbarPreferencesProps {
  preference: ToolbarPreference;
  onChange: (action: ToolbarPreferenceAction) => void;
  onClose: () => void;
}

type RowAction = "up" | "down" | "hide" | "enable";
interface RowFocus {
  id: ToolbarOptionId;
  action: RowAction;
}

/** 只呈现宿主的权威顺序；上/下移动的是保留优先级，不是工具栏上的位置。 */
export function ToolbarPreferences({ preference, onChange, onClose }: ToolbarPreferencesProps) {
  const texts = useTexts();
  const titleId = useId();
  const introId = useId();
  const enabledId = useId();
  const hiddenId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rowFocus = useRef<RowFocus | null>(null);

  useEscapeLayer(ESC_LAYER.modal, true, onClose);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // showModal 自带背景隔离和 Tab 作用域；close 将焦点交还给打开前的控件。
    dialog.showModal();
    closeRef.current?.focus();
    return () => dialog.close();
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = rowFocus.current;
    if (!dialog || !previous) return;
    const focused = dialog.ownerDocument.activeElement;
    if (focused && focused !== dialog && dialog.contains(focused) && !focused.matches(":disabled")) return;

    // 宿主回帧后 React 可能移动或重建这一行；进另一组则改聚焦反向操作。
    // 同组移动到首/尾时原方向禁用，保留同一行并聚焦可用的另一个操作。
    const fallback: Record<RowAction, RowAction> = { up: "down", down: "up", hide: "enable", enable: "hide" };
    const row = dialog.querySelector(`[data-toolbar-option="${previous.id}"]`);
    const button = (action: RowAction) => row?.querySelector<HTMLButtonElement>(`[data-action="${action}"]:enabled`);
    (button(previous.action) ?? button(fallback[previous.action]) ?? button("hide") ?? button("enable") ?? closeRef.current)?.focus();
  }, [preference]);

  const labels: Record<ToolbarOptionId, string> = {
    "effort:full": texts.toolbarPreferencesEffort,
    "attach:full": texts.toolbarPreferencesAttach,
    "tps:full": texts.toolbarPreferencesSpeed,
    "permission:label": texts.toolbarPreferencesPermission,
    "preset:full": texts.toolbarPreferencesPreset,
    "context:text": texts.toolbarPreferencesContext,
    "model:provider": texts.toolbarPreferencesProvider,
    "cache:full": texts.ctxDetailCached,
    "tokens:full": texts.toolbarTokensLabel,
  };

  function actionButton(id: ToolbarOptionId, action: RowAction, label: string, content: ReactNode, disabled = false) {
    const move = action === "up" || action === "down";
    return (
      <button
        type="button"
        className={move ? "toolbar-preferences-button is-icon" : "toolbar-preferences-button"}
        data-action={action}
        disabled={disabled}
        aria-label={label}
        title={label}
        onFocus={() => { rowFocus.current = { id, action }; }}
        onClick={() => {
          rowFocus.current = { id, action };
          onChange(move ? { type: "move", id, direction: action } : { type: action, id });
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="toolbar-preferences"
      aria-labelledby={titleId}
      aria-describedby={introId}
      onFocusCapture={() => { rowFocus.current = null; }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header className="toolbar-preferences-header">
        <h2 id={titleId}>{texts.toolbarPreferencesTitle}</h2>
        <button
          ref={closeRef}
          type="button"
          className="toolbar-preferences-button is-icon"
          onClick={onClose}
          aria-label={texts.close}
          title={texts.close}
        >
          <IconClose />
        </button>
      </header>
      <div className="toolbar-preferences-body">
        <p id={introId}>{texts.toolbarPreferencesIntro}</p>
        <section aria-labelledby={enabledId}>
          <h3 id={enabledId}>{texts.toolbarPreferencesEnabled}</h3>
          {preference.enabled.length > 0 ? (
            <ol className="toolbar-preferences-list">
              {preference.enabled.map((id, index) => (
                <li key={id} data-toolbar-option={id}>
                  <div className="toolbar-preferences-row">
                    <span>{labels[id]}</span>
                    <div className="toolbar-preferences-actions">
                      {actionButton(
                        id, "up", texts.toolbarPreferencesMoveUp(labels[id]),
                        <IconChevronDown className="toolbar-preferences-up" />, index === 0,
                      )}
                      {actionButton(
                        id, "down", texts.toolbarPreferencesMoveDown(labels[id]),
                        <IconChevronDown />, index === preference.enabled.length - 1,
                      )}
                      {actionButton(id, "hide", texts.toolbarPreferencesHideItem(labels[id]), texts.toolbarPreferencesHide)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p>{texts.toolbarPreferencesNoneEnabled}</p>}
        </section>
        <section aria-labelledby={hiddenId}>
          <h3 id={hiddenId}>{texts.toolbarPreferencesHidden}</h3>
          {preference.hidden.length > 0 ? (
            <ul className="toolbar-preferences-list">
              {preference.hidden.map((id) => (
                <li key={id} data-toolbar-option={id}>
                  <div className="toolbar-preferences-row">
                    <span>{labels[id]}</span>
                    {actionButton(id, "enable", texts.toolbarPreferencesEnableItem(labels[id]), texts.toolbarPreferencesEnable)}
                  </div>
                </li>
              ))}
            </ul>
          ) : <p>{texts.toolbarPreferencesNoneHidden}</p>}
        </section>
      </div>
      <footer className="toolbar-preferences-footer">
        <button
          type="button"
          className="toolbar-preferences-button"
          onClick={() => onChange({ type: "reset" })}
        >
          {texts.toolbarPreferencesReset}
        </button>
      </footer>
    </dialog>
  );
}
