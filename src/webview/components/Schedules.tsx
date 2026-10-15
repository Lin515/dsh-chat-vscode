import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState, ScheduleItemView } from "../../shared/chat";
import {
  deviceZone,
  formatScheduleStamp,
  formatZoneLabel,
  orderSchedules,
  relativeText,
  scheduleChangeFromDraft,
  scheduleDraft,
  scheduleDraftDiffers,
  scheduleFrequency,
  storedZoneOf,
  unitText,
  zoneChoices,
  type CronField,
  type ScheduleRepeat,
  type ScheduleTexts,
  type ScheduleTimingDraft,
} from "../../shared/schedule";
import { post } from "../bridge";
import { autoResetMs, killSettled, pressKill, type KillPhase } from "../jobsKill";
import { IconChevronDown, IconTrash } from "../icons";
import { useLocale, useTexts, type Texts } from "../texts";
import type { ScheduleHistoryState } from "../state";

/**
 * 后台任务抽屉里的**自动化任务**分区（DSH `schedule`）。
 *
 * 服务端那边一个任务就是一条持久记录（规则 + 原始会话绑定 + 状态 + 最近一次投递），
 * 这里的每一行都按官方同名界面命名：**一律用存下来的 `title`**，不从句指令推名字
 * （旧记录才有「从指令首行兜底」那种做法，本扩展不消费那种记录）。
 *
 * 三种视图状态各自独立，不许合并成一句「没有任务」：
 * - 清单：`loading` / `ready`（可能是空表）/ `unsupported`（服务端没这组端点）/ `error`；
 * - 详情：规则（可编辑）与执行记录（按需分页读取）分开；
 * - 变更结算：保存 / 删除各有一条来自宿主的结算帧（`schedules/result`）。
 *
 * 面板是**按会话**的：清单由宿主读全局目录后按 `sessionId` 过滤（见 controller 的
 * `loadSchedules`），所以切会话时这份数据整份换掉，不需要在这里做任何缓存失效。
 */

/** 面板要向界面状态机发的动作（收窄，别的发不出去）。 */
export type ScheduleAction = { type: "ui/scheduleHistoryRequest"; id: string; reset?: boolean };

/** 执行记录的读取状态（`AppState.scheduleHistory` 的一条）。 */
type HistoryEntry = ScheduleHistoryState;

export function SchedulesSection({
  sessionId,
  schedules,
  status,
  history,
  result,
  dispatch,
}: {
  /** 当前窗口绑定的会话：它变了就要重新读一次本会话的清单。 */
  sessionId?: string;
  schedules: ScheduleItemView[];
  status: ChatState["schedulesStatus"];
  history?: Record<string, HistoryEntry>;
  result?: { op: "update" | "delete"; id: string; ok: boolean; code?: string };
  dispatch: (action: ScheduleAction) => void;
}) {
  const texts = useTexts();
  // 展开的那一行（同一时刻只看一条详情，与后台任务的输出区同口径）
  const [expanded, setExpanded] = useState<string>();
  // 相对时间与「过期在前」的排序都要一个当前时刻：面板开着时每 30 秒重算一次
  // （比后台任务的 1 秒慢：这里最细的单位是秒级的「还有多久」，没有逐秒变化的东西）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (schedules.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [schedules.length]);
  // 打开面板 / 换会话：读一次清单。宿主只在**读过**的会话上重建（见 controller），
  // 所以这一下不会变成每次切会话的固定开销之外的东西。
  useEffect(() => {
    post({ type: "listSchedules" });
  }, [sessionId]);
  // 展开的那一行离开了名册（被删掉、或别的客户端删了）→ 收起，别留一段没有主人
  // 的详情在屏上
  useEffect(() => {
    if (expanded !== undefined && !schedules.some((item) => item.id === expanded)) setExpanded(undefined);
  }, [schedules, expanded]);

  const sorted = useMemo(() => orderSchedules(schedules, now), [schedules, now]);

  return (
    <div className="panel-section">
      <div className="panel-section-title">{texts.scheduleSection}</div>
      {sorted.length > 0 ? (
        sorted.map((item) => (
          <ScheduleRow
            key={item.id}
            item={item}
            now={now}
            open={expanded === item.id}
            history={history?.[item.id]}
            result={result}
            dispatch={dispatch}
            onToggle={() => setExpanded(expanded === item.id ? undefined : item.id)}
          />
        ))
      ) : (
        <ScheduleListNotice status={status} texts={texts} />
      )}
    </div>
  );
}

/**
 * 清单为空时的那一段说明。
 *
 * `undefined`（还没问过）与 `loading` 都按「正在读取」显示：两者都还没到能给结论的
 * 时候，显示空态就是替一次还没落定的读取下结论。
 */
function ScheduleListNotice({ status, texts }: { status: ChatState["schedulesStatus"]; texts: Texts }) {
  if (status === "unsupported") return <div className="job-notice">{texts.scheduleUnsupported}</div>;
  if (status === "error") return <div className="job-notice is-error">{texts.scheduleLoadFailed}</div>;
  if (status === undefined || status === "loading") {
    return <div className="popover-empty">{texts.scheduleLoading}</div>;
  }
  return (
    <div className="popover-empty">
      {texts.scheduleEmpty}
      <div className="job-notice">{texts.scheduleEmptyHint}</div>
    </div>
  );
}

/**
 * 一行自动化任务：装订行主体、删除按钮、规则编辑与执行记录。
 *
 * 本地草稿活在**行组件**里（不是面板）：行离开名册时草稿跟着消失，不会留下一份
 * 指向已经不存在的任务的未保存修改。
 */
function ScheduleRow({
  item,
  now,
  open,
  history,
  result,
  dispatch,
  onToggle,
}: {
  item: ScheduleItemView;
  now: number;
  open: boolean;
  history?: HistoryEntry;
  result?: { op: "update" | "delete"; id: string; ok: boolean; code?: string };
  dispatch: (action: ScheduleAction) => void;
  onToggle: () => void;
}) {
  const texts = useTexts();
  const locale = useLocale();
  const [draft, setDraft] = useState<ScheduleTimingDraft>(() => scheduleDraft(item));
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "failed">("idle");
  const [saveError, setSaveError] = useState<string>();
  const [deletePhase, setDeletePhase] = useState<KillPhase>();
  const [deleteError, setDeleteError] = useState<string>();

  // 服务端刷新（保存成功读回、别的窗口改了、到点投递推进了目标）后，**没有未保存
  // 修改**的草稿跟着换成新值；有未保存修改时保留草稿——用服务端值覆盖用户正在写的
  // 东西是丢数据（官方同口径）。
  const ruleKey = [
    item.kind,
    item.scheduledAt,
    item.everySeconds ?? "",
    item.time ?? "",
    item.timeZone ?? "",
    (item.weekdays ?? []).join(","),
    item.expression ?? "",
  ].join("|");
  useEffect(() => {
    setDraft((previous) => (scheduleDraftDiffers(previous, item) ? previous : scheduleDraft(item)));
  }, [ruleKey]);

  // 展开详情时按需读一次执行记录（只读一次；失败与成功都算落定，别在这里循环）
  useEffect(() => {
    if (!open) return;
    // `code`（任务不存在 / 游标失效）**不算落定**：那种情形下重新展开应当再读一次第一页
    // ——游标失效后本地那份记录接不下去，重读是最省事的出路（文案也让用户「重新打开记录」，
    // 这一条就是让那句话真的成立）。
    const settled =
      (history?.loaded === true && history?.code === undefined) ||
      history?.error !== undefined ||
      history?.hostUnavailable === true;
    if (history !== undefined && (history.loading || settled)) return;
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true });
    post({ type: "scheduleHistory", id: item.id });
  }, [open, history, item.id]);

  /**
   * 又投递过一次 → 重读最新一页。
   *
   * 官方同一口径（「最新一条的 messageId 变了就刷新最新一页」）：服务端的
   * `schedule/changed` 会让清单刷新，但**执行记录是按需读的**——不跟着重读，展开着的
   * 详情就会少掉刚发生的那一次。`deliveredAt` 是这里能拿到的、与 messageId 等价的
   * 「又投递过一次」信号。
   */
  const deliveredAt = item.lastDelivery?.deliveredAt;
  const seenDelivery = useRef<string | undefined>(deliveredAt);
  useEffect(() => {
    if (seenDelivery.current === deliveredAt) return;
    seenDelivery.current = deliveredAt;
    if (!open || history === undefined) return;
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true });
    post({ type: "scheduleHistory", id: item.id });
  }, [deliveredAt, open, item.id]);

  // 变更结算：更新与删除共用一条帧，按 `op` 分派
  useEffect(() => {
    if (!result || result.id !== item.id) return;
    if (result.op === "update") {
      setSavePhase(result.ok ? "idle" : "failed");
      setSaveError(result.ok ? undefined : changeErrorText(result.code, texts));
      return;
    }
    setDeletePhase(killSettled({ key: item.id, state: "pending" }, item.id, result.ok));
    setDeleteError(result.ok ? undefined : deleteErrorText(result.code, texts));
  }, [result]);

  // armed / failed 到点自动复位；pending 要等结算帧收场（与停止按钮同一台状态机）
  useEffect(() => {
    const ms = deletePhase ? autoResetMs(deletePhase.state) : undefined;
    if (ms === undefined) return;
    const timer = setTimeout(() => setDeletePhase(undefined), ms);
    return () => clearTimeout(timer);
  }, [deletePhase]);

  const active = item.status === "active";
  const statusText =
    item.status === "active"
      ? texts.scheduleActive
      : item.status === "inactive"
        ? texts.scheduleInactive
        : item.status === "unknown"
          ? texts.scheduleUnknownStatus
          : item.status;
  const zone = deviceZone();
  const frequency = scheduleFrequency(item, texts, { system: zone, locale });
  const relative = relativeText(item.scheduledAt, now, texts);
  const stamp = formatScheduleStamp(item.scheduledAt, locale, storedZoneOf(item));
  const dirty = scheduleDraftDiffers(draft, item);

  const pressDelete = () => {
    const next = pressKill(deletePhase, item.id);
    setDeletePhase(next);
    setDeleteError(undefined);
    if (next.state !== "pending") return;
    post({ type: "deleteSchedule", id: item.id });
  };

  const patch = (values: Partial<ScheduleTimingDraft>) => {
    setDraft((previous) => ({ ...previous, ...values }));
    setSaveError(undefined);
    setSavePhase("idle");
  };

  const save = () => {
    const built = scheduleChangeFromDraft(draft);
    if ("error" in built) {
      setSavePhase("failed");
      setSaveError(draftErrorText(built.error, built.field, texts));
      return;
    }
    setSavePhase("saving");
    setSaveError(undefined);
    post({ type: "updateSchedule", id: item.id, change: built.change });
  };

  return (
    <div className="job-row">
      <div className="job-head">
        <button
          type="button"
          className="job-row-toggle"
          aria-expanded={open}
          aria-label={open ? texts.scheduleCollapseAria(item.title) : texts.scheduleExpandAria(item.title)}
          onClick={onToggle}
        >
          {/* 状态点：启用中用「有活动含义」的绿点，已结束用中性灰点（不猜色调） */}
          <span className={`dot ${active ? "dot-ok" : "dot-muted"}`} />
          <span className="job-label" title={item.title}>
            {item.title}
          </span>
          <span className="job-kind">{statusText}</span>
          <IconChevronDown size={12} className={`job-chevron${open ? " is-open" : ""}`} />
        </button>
        <button
          type="button"
          className={`job-stop${deletePhase?.state === "armed" ? " is-armed" : ""}${
            deletePhase?.state === "failed" ? " is-failed" : ""
          }`}
          data-kill-state={deletePhase?.state ?? "idle"}
          disabled={deletePhase?.state === "pending"}
          title={
            deletePhase?.state === "armed"
              ? texts.scheduleDeleteConfirm
              : deletePhase?.state === "failed"
                ? texts.scheduleDeleteFailed
                : texts.scheduleDeleteTitle(item.title)
          }
          aria-label={texts.scheduleDeleteTitle(item.title)}
          onClick={pressDelete}
        >
          <IconTrash size={10} />
          {deletePhase?.state === "armed" ? (
            <span className="job-stop-label">{texts.scheduleDeleteConfirmAction}</span>
          ) : null}
        </button>
      </div>
      <div className="job-meta">
        {frequency ? `${frequency} · ` : ""}
        {active ? `${texts.scheduleNextRun} ` : `${texts.scheduleLastTarget} `}
        {stamp}
        {relative ? `（${relative}）` : ""}
      </div>
      {deletePhase?.state === "failed" && deleteError ? (
        <div className="job-notice is-error">{deleteError}</div>
      ) : null}
      {deletePhase?.state === "pending" ? <div className="job-notice">{texts.scheduleDeleting}</div> : null}
      {open ? (
        <div className="job-panel">
          <div className="schedule-card-title">{texts.schedulePromptLabel}</div>
          <div className="job-detail schedule-prompt">{item.prompt}</div>
          <ScheduleTimingCard
            item={item}
            draft={draft}
            active={active}
            editable={item.editable !== false}
            dirty={dirty}
            saving={savePhase === "saving"}
            error={saveError}
            texts={texts}
            onPatch={patch}
            onSave={save}
            onCancel={() => {
              setDraft(scheduleDraft(item));
              setSaveError(undefined);
              setSavePhase("idle");
            }}
          />
          <ScheduleRecords item={item} entry={history} dispatch={dispatch} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 运行时间卡片（规则编辑）。
 *
 * 三件事按官方口径定：
 * - **已结束的任务只读**（服务端会以 `schedule_ended` 拒绝修改）；
 * - 提交的是**完整的新规则**（`change` 带齐该种类的所有字段），服务端按它重锚目标；
 * - `after` 与 `at` 共用「一次」这一档：相对延迟这个选择器**不能**用于修改
 *   （契约里 `change` 就没有 `after` 这一支），编辑时它展示的是已提交的那个时刻。
 */
function ScheduleTimingCard({
  item,
  draft,
  active,
  editable,
  dirty,
  saving,
  error,
  texts,
  onPatch,
  onSave,
  onCancel,
}: {
  item: ScheduleItemView;
  draft: ScheduleTimingDraft;
  active: boolean;
  /** 规则能不能当编辑基准（`false` = 读不出完整规则，只读）。 */
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  error?: string;
  texts: Texts;
  onPatch: (values: Partial<ScheduleTimingDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const zone = deviceZone();
  const locale = useLocale();
  const zones = useMemo(() => zoneChoices(draft.timeZone, zone), [draft.timeZone, zone]);
  const disabled = !active || !editable || saving;
  const cronError = draft.repeat === "cron" ? cronFieldOf(draft.expression) : undefined;

  return (
    <div className="schedule-card">
      <div className="schedule-card-title">{texts.scheduleRuleLabel}</div>
      <div className="schedule-field">
        <label htmlFor={`schedule-repeat-${item.id}`}>{texts.scheduleRepeatLabel}</label>
        <select
          id={`schedule-repeat-${item.id}`}
          value={draft.repeat}
          disabled={disabled}
          onChange={(event) => onPatch({ repeat: event.target.value as ScheduleRepeat })}
        >
          <option value="once">{texts.scheduleRepeatOnce}</option>
          <option value="every">{texts.scheduleRepeatEvery}</option>
          <option value="daily">{texts.scheduleRepeatDaily}</option>
          <option value="weekly">{texts.scheduleRepeatWeekly}</option>
          <option value="cron">{texts.scheduleRepeatCron}</option>
        </select>
      </div>

      {draft.repeat === "once" ? (
        <>
          <div className="schedule-field">
            <label htmlFor={`schedule-date-${item.id}`}>{texts.scheduleFieldDate}</label>
            <input
              id={`schedule-date-${item.id}`}
              type="date"
              value={draft.date}
              disabled={disabled}
              onChange={(event) => onPatch({ date: event.target.value })}
            />
          </div>
          <div className="schedule-field">
            <label htmlFor={`schedule-time-${item.id}`}>{texts.scheduleFieldTime}</label>
            <input
              id={`schedule-time-${item.id}`}
              type="time"
              step="1"
              value={draft.time.slice(0, 8)}
              disabled={disabled}
              onChange={(event) => onPatch({ time: event.target.value })}
            />
          </div>
        </>
      ) : null}

      {draft.repeat === "every" ? (
        <>
          <div className="schedule-field">
            <label htmlFor={`schedule-amount-${item.id}`}>{texts.scheduleFieldAmount}</label>
            <input
              id={`schedule-amount-${item.id}`}
              type="number"
              min={1}
              value={draft.amount}
              disabled={disabled}
              onChange={(event) => onPatch({ amount: event.target.value })}
            />
          </div>
          <div className="schedule-field">
            <label htmlFor={`schedule-unit-${item.id}`}>{texts.scheduleFieldUnit}</label>
            <select
              id={`schedule-unit-${item.id}`}
              value={draft.unit}
              disabled={disabled}
              onChange={(event) => onPatch({ unit: event.target.value as ScheduleTimingDraft["unit"] })}
            >
              <option value="second">{unitText("second", texts, 1)}</option>
              <option value="minute">{unitText("minute", texts, 1)}</option>
              <option value="hour">{unitText("hour", texts, 1)}</option>
            </select>
          </div>
        </>
      ) : null}

      {draft.repeat === "daily" || draft.repeat === "weekly" ? (
        <div className="schedule-field">
          <label htmlFor={`schedule-clock-${item.id}`}>{texts.scheduleFieldTime}</label>
          <input
            id={`schedule-clock-${item.id}`}
            type="time"
            step="1"
            value={draft.time.slice(0, 8)}
            disabled={disabled}
            onChange={(event) => onPatch({ time: event.target.value })}
          />
        </div>
      ) : null}

      {draft.repeat === "weekly" ? (
        <div className="schedule-field is-stacked">
          <span className="schedule-field-label">{texts.scheduleFieldWeekdays}</span>
          <div className="schedule-days">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const on = draft.weekdays.includes(day);
              const name = weekdayName(day, texts);
              return (
                <button
                  key={day}
                  type="button"
                  className={`schedule-day${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  disabled={disabled}
                  title={name}
                  onClick={() =>
                    onPatch({
                      weekdays: on ? draft.weekdays.filter((value) => value !== day) : [...draft.weekdays, day].sort((a, b) => a - b),
                    })
                  }
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {draft.repeat === "cron" ? (
        <div className="schedule-field">
          <label htmlFor={`schedule-cron-${item.id}`}>{texts.scheduleFieldExpression}</label>
          <input
            id={`schedule-cron-${item.id}`}
            type="text"
            className="schedule-cron-input"
            value={draft.expression}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onPatch({ expression: event.target.value })}
          />
        </div>
      ) : null}

      {draft.repeat === "once" || draft.repeat === "daily" || draft.repeat === "weekly" || draft.repeat === "cron" ? (
        <div className="schedule-field">
          <label htmlFor={`schedule-zone-${item.id}`}>{texts.scheduleFieldZone}</label>
          <select
            id={`schedule-zone-${item.id}`}
            value={draft.timeZone}
            disabled={disabled}
            onChange={(event) => onPatch({ timeZone: event.target.value })}
          >
            {zones.map((name) => {
              const label = formatZoneLabel(name, locale);
              return (
                <option key={name} value={name}>
                  {name === zone ? texts.scheduleZoneSystem(label) : label}
                </option>
              );
            })}
          </select>
        </div>
      ) : null}

      {cronError !== undefined ? (
        <div className="job-notice is-error">{texts.scheduleCronInvalid(cronFieldText(cronError, texts))}</div>
      ) : null}
      {!editable ? <div className="job-notice">{texts.scheduleRuleUnreadable}</div> : null}
      {!active ? <div className="job-notice">{texts.scheduleInactiveReadonly}</div> : null}
      {dirty && active && editable ? (
        <div className="schedule-actions">
          <span className="schedule-unsaved">{texts.scheduleUnsaved}</span>
          <span className="spacer" />
          <button type="button" className="schedule-btn" disabled={saving} onClick={onCancel}>
            {texts.scheduleCancel}
          </button>
          <button
            type="button"
            className="schedule-btn is-primary"
            disabled={saving || cronError !== undefined}
            onClick={onSave}
          >
            {saving ? texts.scheduleSaving : texts.scheduleSave}
          </button>
        </div>
      ) : null}
      {error ? <div className="job-notice is-error">{error}</div> : null}
      <div className="job-meta">{item.id}</div>
    </div>
  );
}

/** 执行记录区：按需读取、分页续取，三种「没有记录」分开显示。 */
function ScheduleRecords({
  item,
  entry,
  dispatch,
}: {
  item: ScheduleItemView;
  entry?: HistoryEntry;
  dispatch: (action: ScheduleAction) => void;
}) {
  const texts = useTexts();
  const locale = useLocale();
  const zone = storedZoneOf(item);
  const loadOlder = () => {
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id });
    post({ type: "scheduleHistory", id: item.id, ...(entry?.nextBefore ? { before: entry.nextBefore } : {}) });
  };
  const reload = () => {
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true });
    post({ type: "scheduleHistory", id: item.id });
  };

  return (
    <div className="schedule-records">
      <div className="schedule-card-title">{texts.scheduleRecords}</div>
      {entry === undefined || (!entry.loaded && entry.loading) ? (
        <div className="job-notice">{texts.scheduleRecordsLoading}</div>
      ) : null}
      {entry?.hostUnavailable ? <div className="job-notice">{texts.scheduleRecordsOffline}</div> : null}
      {entry?.code === "schedule_not_found" ? (
        <div className="job-notice">{texts.scheduleRecordsMissing}</div>
      ) : null}
      {entry?.code === "delivery_cursor_not_found" ? (
        <div className="job-notice is-error">{texts.scheduleRecordsCursorLost}</div>
      ) : null}
      {entry?.error !== undefined ? (
        <div className="job-notice is-error">
          {texts.scheduleRecordsFailed(entry.error)}
          <button type="button" className="schedule-link" onClick={reload}>
            {texts.scheduleRecordsRetry}
          </button>
        </div>
      ) : null}
      {entry?.loaded && entry.records.length === 0 && entry.code === undefined ? (
        <div className="job-notice">{texts.scheduleRecordsEmpty}</div>
      ) : null}
      {entry?.records.length ? (
        <div className="schedule-record-list">
          {entry.records.map((record, index) => (
            <div className="schedule-record" key={`${record.scheduledAt}-${index}`}>
              <span className="schedule-record-time">
                {formatScheduleStamp(record.scheduledAt, locale, zone)}
              </span>
              <span
                className="schedule-record-prompt"
                title={texts.scheduleRecordTitle(
                  formatScheduleStamp(record.scheduledAt, locale, zone),
                  formatScheduleStamp(record.deliveredAt, locale, zone),
                )}
              >
                {record.prompt === undefined || record.prompt === ""
                  ? texts.scheduleRecordNoPrompt
                  : record.prompt}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {entry?.loaded && entry.nextBefore ? (
        <button type="button" className="schedule-link" disabled={entry.loading} onClick={loadOlder}>
          {texts.scheduleRecordsMore}
        </button>
      ) : null}
      {/* 「更早的可能没有」与「确实被裁掉过」分开：只有后者才配说明保留口径 */}
      {entry?.pruned && entry.retention ? (
        <div className="job-notice">{texts.scheduleRecordsPruned(entry.retention.days, entry.retention.records)}</div>
      ) : entry?.unavailable ? (
        <div className="job-notice">{texts.scheduleRecordsUnavailable}</div>
      ) : null}
    </div>
  );
}

/** 草稿自身的校验失败（提交前的本地判定，与 `schedule/update` 的错误码同名）。 */
function draftErrorText(
  error: "invalid_rule" | "frequency_too_high" | "invalid_time_zone",
  field: CronField | undefined,
  texts: Texts,
): string {
  if (error === "frequency_too_high") return texts.scheduleErrInterval;
  if (error === "invalid_time_zone") return texts.scheduleErrZone;
  return field === undefined ? texts.scheduleErrInvalid : texts.scheduleCronInvalid(cronFieldText(field, texts));
}

/** 服务端拒绝更新时的稳定错误码 → 文案（`undefined` = 请求根本没发出去）。 */
function changeErrorText(code: string | undefined, texts: Texts): string {
  switch (code) {
    case "schedule_conflict":
      return texts.scheduleErrConflict;
    case "schedule_ended":
      return texts.scheduleErrEnded;
    case "schedule_not_found":
      return texts.scheduleErrNotFound;
    case "subagent_session":
      return texts.scheduleErrSubagent;
    case "invalid_time_zone":
      return texts.scheduleErrZone;
    case "not_future":
      return texts.scheduleErrNotFuture;
    case "frequency_too_high":
      return texts.scheduleErrInterval;
    case "internal_error":
      return texts.scheduleErrInternal;
    case undefined:
      return texts.scheduleErrOffline;
    default:
      return texts.scheduleErrInvalid;
  }
}

/** 删除失败：任务本来就不在，与别的失败分开说（前者重试也没有意义）。 */
function deleteErrorText(code: string | undefined, texts: Texts): string {
  if (code === "schedule_not_found") return texts.scheduleErrNotFound;
  if (code === undefined) return texts.scheduleErrOffline;
  return texts.scheduleDeleteFailed;
}

/** cron 表达式的坏字段（本地校验，与服务端同一套方言）。 */
function cronFieldOf(expression: string): CronField | undefined {
  const built = scheduleChangeFromDraft({
    repeat: "cron",
    date: "",
    time: "",
    timeZone: deviceZone(),
    amount: "60",
    unit: "second",
    weekdays: [1],
    expression,
  });
  return "error" in built ? built.field : undefined;
}

function cronFieldText(field: CronField, texts: Texts): string {
  switch (field) {
    case "minute":
      return texts.scheduleCronFieldMinute;
    case "hour":
      return texts.scheduleCronFieldHour;
    case "dayOfMonth":
      return texts.scheduleCronFieldDayOfMonth;
    case "month":
      return texts.scheduleCronFieldMonth;
    case "dayOfWeek":
      return texts.scheduleCronFieldDayOfWeek;
  }
}

function weekdayName(day: number, texts: ScheduleTexts): string {
  const names = [
    texts.scheduleWeekday1,
    texts.scheduleWeekday2,
    texts.scheduleWeekday3,
    texts.scheduleWeekday4,
    texts.scheduleWeekday5,
    texts.scheduleWeekday6,
    texts.scheduleWeekday7,
  ];
  return names[day - 1] ?? String(day);
}
