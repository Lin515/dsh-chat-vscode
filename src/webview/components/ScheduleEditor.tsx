/**
 * 自动化任务的编辑表单：名称、指令、投递目标与运行时间。
 *
 * 创建与编辑共用同一份表单（官方 `TaskEditorFields` 同口径）：两边的差别只在
 * **怎么提交**（`schedule/create` 与 `schedule/edit` 的 patch），字段本身与校验完全一样。
 *
 * 这里只画字段，不放保存 / 取消按钮：按钮属于外层（行内详情或新建卡），因为它要
 * 绑定「这次操作的 opId 与等待态」。规则编辑的字段集合与旧版一致（一次 / 固定间隔 /
 * 每天 / 每周 / cron / RRULE），新增的只有名称、指令与投递目标。
 */
import { useMemo } from "react";
import type { SessionSummaryView } from "../../shared/chat";
import {
  deviceZone,
  formatZoneLabel,
  scheduleChangeFromDraft,
  unitText,
  zoneChoices,
  type CronField,
  type ScheduleEditorDraft,
  type ScheduleRepeat,
  type ScheduleTargetDraft,
  type ScheduleTimingDraft,
} from "../../shared/schedule";
import { useLocale, type Texts } from "../texts";

/** 运行时间草稿里 cron 表达式坏在哪一段（本地判定，与服务端同一套方言）。 */
export function scheduleTimingCronError(timing: ScheduleTimingDraft): CronField | undefined {
  if (timing.repeat !== "cron") return undefined;
  const built = scheduleChangeFromDraft(timing);
  return "error" in built ? built.field : undefined;
}

/** cron 根因字段 → 界面字段名。 */
export function cronFieldText(field: CronField, texts: Texts): string {
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

/** 星期几的显示名（1 = 周一）。 */
export function weekdayName(day: number, texts: Texts): string {
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

/**
 * 编辑器要显示的可选投递目录（来自会话列表的真实 cwd，去重后给）。
 *
 * 这是本扩展能拿到的**替代来源**：官方 `projectChoices` 用注册的 Workspace 列表
 * （还带默认 Workspace），本仓库的 webview 没有那份注册表，只能列「已经出现过会话的
 * 目录」。因此一个已注册但还没有会话的 Workspace 选不到——已知缺口，见
 * `docs/design-schedules.md` 的「界面结构」一节。
 */
export function scheduleDirectoryChoices(sessions: readonly SessionSummaryView[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const choices: { value: string; label: string }[] = [];
  for (const session of sessions) {
    const cwd = session.cwd;
    if (cwd === undefined || cwd === "" || seen.has(cwd)) continue;
    seen.add(cwd);
    choices.push({ value: cwd, label: cwd });
  }
  return choices;
}

/**
 * 目标会话候选：当前会话 + 任务原有的目标会话（编辑时）+ 会话列表里的其它会话。
 *
 * 空壳会话（`blank`）与有内容的会话一样可选：官方 `useTaskDetail` 的候选就是全部
 * `sessions.ids`，投递到空壳由服务端受理；按「有没有内容」筛掉目标，只会在界面上
 * 凭空少一个用户看得到的会话。
 */
export function scheduleTargetSessionChoices(
  sessions: readonly SessionSummaryView[],
  currentSessionId: string | undefined,
  storedSessionId: string | undefined,
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const choices: { value: string; label: string }[] = [];
  const push = (id: string | undefined, title: string | undefined): void => {
    if (id === undefined || id === "" || seen.has(id)) return;
    seen.add(id);
    choices.push({ value: id, label: title === undefined || title === "" ? id : title });
  };
  const byId = new Map(sessions.map((session) => [session.id, session.title] as const));
  push(currentSessionId, byId.get(currentSessionId ?? ""));
  push(storedSessionId, byId.get(storedSessionId ?? ""));
  for (const session of sessions) {
    if (session.id === currentSessionId || session.id === storedSessionId) continue;
    push(session.id, session.title);
  }
  return choices;
}

/**
 * 创建 / 编辑共用的字段组。
 *
 * `allowRrule`：新代目录才支持 RRULE 原文这一档（旧代的时间编辑没有它）；
 * `region` 为 `"create"` 时目标会话默认落在当前会话，编辑时沿用任务已存的落点。
 */
export function ScheduleEditor({
  idPrefix,
  draft,
  onChange,
  disabled,
  basicDisabled,
  allowRrule,
  sessions,
  currentSessionId,
  storedTargetSessionId,
  texts,
}: {
  idPrefix: string;
  draft: ScheduleEditorDraft;
  onChange: (draft: ScheduleEditorDraft) => void;
  /** 运行时间字段是否只读（保存中 / 规则读不出基准）。 */
  disabled: boolean;
  /** 名称 / 指令 / 投递目标是否只读（旧代目录只有时间编辑这一条路）。 */
  basicDisabled: boolean;
  allowRrule: boolean;
  sessions: readonly SessionSummaryView[];
  currentSessionId: string | undefined;
  storedTargetSessionId: string | undefined;
  texts: Texts;
}) {
  const locale = useLocale();
  const zone = deviceZone();
  const timing = draft.timing;
  const zones = useMemo(() => zoneChoices(timing.timeZone, zone), [timing.timeZone, zone]);
  const cronError = scheduleTimingCronError(timing);
  const sessionChoices = useMemo(
    () => scheduleTargetSessionChoices(sessions, currentSessionId, storedTargetSessionId),
    [sessions, currentSessionId, storedTargetSessionId],
  );
  const directories = useMemo(() => scheduleDirectoryChoices(sessions), [sessions]);
  const change = (values: Partial<ScheduleEditorDraft>): void => {
    if (basicDisabled) return;
    onChange({ ...draft, ...values });
  };
  const patchTiming = (values: Partial<ScheduleTimingDraft>): void =>
    onChange({ ...draft, timing: { ...draft.timing, ...values } });
  const targetLabel = (kind: ScheduleTargetDraft): string =>
    kind === "session"
      ? texts.scheduleTargetSession
      : kind === "new_once"
        ? texts.scheduleTargetNewOnce
        : texts.scheduleTargetNew;

  return (
    <div className="schedule-editor">
      <div className="schedule-field">
        <label htmlFor={`${idPrefix}-title`}>{texts.scheduleFieldTitle}</label>
        <input
          id={`${idPrefix}-title`}
          type="text"
          maxLength={120}
          required
          value={draft.title}
          placeholder={texts.scheduleFieldTitlePlaceholder}
          disabled={disabled || basicDisabled}
          onChange={(event) => change({ title: event.target.value })}
        />
      </div>
      <div className="schedule-field is-stacked">
        <label htmlFor={`${idPrefix}-prompt`}>{texts.scheduleFieldPrompt}</label>
        <textarea
          id={`${idPrefix}-prompt`}
          rows={4}
          required
          value={draft.prompt}
          placeholder={texts.scheduleFieldPromptPlaceholder}
          disabled={disabled || basicDisabled}
          style={{ width: "100%", minWidth: 0, boxSizing: "border-box", resize: "vertical" }}
          onChange={(event) => change({ prompt: event.target.value })}
        />
      </div>

      <div className="schedule-field">
        <label htmlFor={`${idPrefix}-target`}>{texts.scheduleFieldTarget}</label>
        <select
          id={`${idPrefix}-target`}
          value={draft.target}
          disabled={disabled || basicDisabled}
          onChange={(event) => {
            const target = event.target.value as ScheduleTargetDraft;
            change({
              target,
              sessionId:
                target === "session"
                  ? draft.sessionId === ""
                    ? (storedTargetSessionId ?? currentSessionId ?? "")
                    : draft.sessionId
                  : draft.sessionId,
              cwd: target === "session" ? "" : draft.cwd,
            });
          }}
        >
          <option value="session">{targetLabel("session")}</option>
          <option value="new_once">{targetLabel("new_once")}</option>
          <option value="new">{targetLabel("new")}</option>
        </select>
      </div>

      {draft.target === "session" ? (
        <div className="schedule-field">
          <label htmlFor={`${idPrefix}-session`}>{texts.scheduleFieldSession}</label>
          <select
            id={`${idPrefix}-session`}
            value={draft.sessionId}
            disabled={disabled || basicDisabled}
            onChange={(event) => change({ sessionId: event.target.value })}
          >
            {/* 没有选中任何会话时给一个占位项：`<select>` 的 value 匹配不到选项会显示
                第一项，看似选好了其实提交的是空 id（本地会以 invalid_target 拒绝）。 */}
            {draft.sessionId === "" ? <option value="">{texts.scheduleChooseSession}</option> : null}
            {sessionChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {/* 已存的目标会话不在当前列表里（归档 / 别的目录）：原样保留为一项，
                否则下拉框会显示别的会话，而草稿里仍是这个 id。 */}
            {draft.sessionId !== "" && !sessionChoices.some((choice) => choice.value === draft.sessionId) ? (
              <option value={draft.sessionId}>{draft.sessionId}</option>
            ) : null}
          </select>
          {draft.sessionId === "" ? (
            <div className="job-notice is-error">{texts.scheduleErrInvalidTarget}</div>
          ) : null}
        </div>
      ) : (
        <div className="schedule-field">
          <label htmlFor={`${idPrefix}-cwd`}>{texts.scheduleFieldCwd}</label>
          <select
            id={`${idPrefix}-cwd`}
            value={draft.cwd}
            disabled={disabled || basicDisabled}
            onChange={(event) => change({ cwd: event.target.value })}
          >
            <option value="">{texts.scheduleCwdDefault}</option>
            {directories.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {draft.cwd !== "" && !directories.some((choice) => choice.value === draft.cwd) ? (
              <option value={draft.cwd}>{draft.cwd}</option>
            ) : null}
          </select>
        </div>
      )}

      <div className="schedule-card">
        <div className="schedule-card-title">{texts.scheduleRuleLabel}</div>
        <div className="schedule-field">
          <label htmlFor={`${idPrefix}-repeat`}>{texts.scheduleRepeatLabel}</label>
          <select
            id={`${idPrefix}-repeat`}
            value={timing.repeat}
            disabled={disabled}
            onChange={(event) => patchTiming({ repeat: event.target.value as ScheduleRepeat })}
          >
            <option value="once">{texts.scheduleRepeatOnce}</option>
            <option value="every">{texts.scheduleRepeatEvery}</option>
            <option value="daily">{texts.scheduleRepeatDaily}</option>
            <option value="weekly">{texts.scheduleRepeatWeekly}</option>
            <option value="cron">{texts.scheduleRepeatCron}</option>
            {allowRrule ? <option value="rrule">{texts.scheduleRepeatRrule}</option> : null}
          </select>
        </div>

        {timing.repeat === "once" ? (
          <>
            <div className="schedule-field">
              <label htmlFor={`${idPrefix}-date`}>{texts.scheduleFieldDate}</label>
              <input
                id={`${idPrefix}-date`}
                type="date"
                value={timing.date}
                disabled={disabled}
                onChange={(event) => patchTiming({ date: event.target.value })}
              />
            </div>
            <div className="schedule-field">
              <label htmlFor={`${idPrefix}-time`}>{texts.scheduleFieldTime}</label>
              <input
                id={`${idPrefix}-time`}
                type="time"
                step="1"
                value={timing.time.slice(0, 8)}
                disabled={disabled}
                onChange={(event) => patchTiming({ time: event.target.value })}
              />
            </div>
          </>
        ) : null}

        {timing.repeat === "every" ? (
          <>
            <div className="schedule-field">
              <label htmlFor={`${idPrefix}-amount`}>{texts.scheduleFieldAmount}</label>
              <input
                id={`${idPrefix}-amount`}
                type="number"
                min={1}
                value={timing.amount}
                disabled={disabled}
                onChange={(event) => patchTiming({ amount: event.target.value })}
              />
            </div>
            <div className="schedule-field">
              <label htmlFor={`${idPrefix}-unit`}>{texts.scheduleFieldUnit}</label>
              <select
                id={`${idPrefix}-unit`}
                value={timing.unit}
                disabled={disabled}
                onChange={(event) => patchTiming({ unit: event.target.value as ScheduleTimingDraft["unit"] })}
              >
                <option value="second">{unitText("second", texts, 1)}</option>
                <option value="minute">{unitText("minute", texts, 1)}</option>
                <option value="hour">{unitText("hour", texts, 1)}</option>
              </select>
            </div>
          </>
        ) : null}

        {timing.repeat === "daily" || timing.repeat === "weekly" ? (
          <div className="schedule-field">
            <label htmlFor={`${idPrefix}-clock`}>{texts.scheduleFieldTime}</label>
            <input
              id={`${idPrefix}-clock`}
              type="time"
              step="1"
              value={timing.time.slice(0, 8)}
              disabled={disabled}
              onChange={(event) => patchTiming({ time: event.target.value })}
            />
          </div>
        ) : null}

        {timing.repeat === "weekly" ? (
          <div className="schedule-field is-stacked">
            <span className="schedule-field-label">{texts.scheduleFieldWeekdays}</span>
            <div className="schedule-days">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                const on = timing.weekdays.includes(day);
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
                      patchTiming({
                        weekdays: on
                          ? timing.weekdays.filter((value) => value !== day)
                          : [...timing.weekdays, day].sort((a, b) => a - b),
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

        {timing.repeat === "rrule" ? (
          <div className="schedule-field is-stacked">
            <label htmlFor={`${idPrefix}-rrule`}>{texts.scheduleFieldRrule}</label>
            <textarea
              id={`${idPrefix}-rrule`}
              rows={3}
              value={timing.rrule ?? ""}
              style={{ width: "100%", minWidth: 0, boxSizing: "border-box", resize: "vertical" }}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => patchTiming({ rrule: event.target.value })}
            />
          </div>
        ) : null}

        {timing.repeat === "cron" ? (
          <div className="schedule-field">
            <label htmlFor={`${idPrefix}-cron`}>{texts.scheduleFieldExpression}</label>
            <input
              id={`${idPrefix}-cron`}
              type="text"
              className="schedule-cron-input"
              value={timing.expression}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => patchTiming({ expression: event.target.value })}
            />
          </div>
        ) : null}

        {timing.repeat === "rrule" ? null : (
          <div className="schedule-field">
            <label htmlFor={`${idPrefix}-zone`}>{texts.scheduleFieldZone}</label>
            <select
              id={`${idPrefix}-zone`}
              value={timing.timeZone}
              disabled={disabled}
              onChange={(event) => patchTiming({ timeZone: event.target.value })}
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
        )}

        {cronError !== undefined ? (
          <div className="job-notice is-error">{texts.scheduleCronInvalid(cronFieldText(cronError, texts))}</div>
        ) : null}
      </div>
    </div>
  );
}
