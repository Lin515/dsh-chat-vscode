import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatState, ScheduleItemView, SessionSummaryView } from "../../shared/chat";
import {
  deviceZone,
  formatScheduleStamp,
  orderSchedules,
  relativeText,
  scheduleChangeFromDraft,
  scheduleCreateDraft,
  scheduleCreateRequestOf,
  scheduleForSession,
  scheduleFrequency,
  scheduleIsActive,
  scheduleNextRunAt,
  schedulePatchOf,
  scheduleStatusOf,
  scheduleTargetError,
  scheduleTargetSessionId,
  storedZoneOf,
  type ScheduleEditorDraft,
  type ScheduleTexts,
} from "../../shared/schedule";
import { post } from "../bridge";
import { autoResetMs, killSettled, pressKill, type KillPhase } from "../jobsKill";
import { IconChevronDown, IconPause, IconPlay, IconPlus, IconTrash } from "../icons";
import { useLocale, useTexts, type Texts } from "../texts";
import type { ScheduleHistoryState, AppState } from "../state";
import { scheduleNextOpId, scheduleResultSettles, type SchedulePendingOp } from "../scheduleOps";
import { scheduleRowControls } from "../scheduleControls";
import {
  scheduleEditorReducer,
  scheduleEditorState,
  scheduleEditorStateConflict,
  scheduleEditorStateDirty,
} from "../scheduleEditorState";
import { ScheduleEditor, scheduleTimingCronError } from "./ScheduleEditor";

/**
 * 后台任务抽屉里的**自动化任务**分区（DSH `schedule`）。
 *
 * 数据只有一条来源：宿主读一次零形参的 `schedule/catalog`，把**整份目录**落到会话
 * 字段里。这里再按 `involvedSessionIds` / 投递落点分出「本会话」这一档（`scheduleForSession`）
 * ——「全部任务」直接用整份目录，于是全局视图与全局操作都不会被当前会话过滤拦住，
 * 也不必维护第二份互相打脸的清单。
 *
 * 三种视图状态各自独立，不许合并成一句「没有任务」：
 * - 清单：`loading` / `ready`（可能是空表）/ `unsupported`（服务端没这组端点）/ `error`；
 * - 详情：名称 / 指令 / 目标 / 运行时间（可编辑）与执行记录（按需分页读取）分开；
 * - 变更结算：每次请求都等一条来自宿主的 `schedules/result` 帧，且只认**自己这一次**
 *   操作标识（见 `scheduleOps.ts`）。
 *
 * 服务端代际决定入口：旧代（`legacy`）只保留查看、改时间与删除；创建 / 立即运行 /
 * 暂停恢复 / 目标编辑都是新代才有的能力，旧代一律不暴露。
 */

/** 面板要向界面状态机发的动作（收窄，别的发不出去）。 */
export type ScheduleAction = {
  type: "ui/scheduleHistoryRequest";
  id: string;
  reset?: boolean;
  opId?: number;
};

/** 执行记录的读取状态（`AppState.scheduleHistory` 的一条）。 */
type HistoryEntry = ScheduleHistoryState;

/** 视图范围：本会话（派生过滤）或全部任务（整份目录）。 */
type ScheduleScopeView = "session" | "all";
/** 状态筛选。 */
type ScheduleStatusFilter = "all" | "active" | "paused" | "ended";

export function SchedulesSection({
  sessionId,
  sessions,
  schedules,
  status,
  capability,
  archivedSessionIds,
  newSessionIntervalSeconds,
  limits,
  history,
  result,
  dispatch,
}: {
  /** 当前窗口绑定的会话：它变了就重读一次目录，并把本地展开 / 表单收起来。 */
  sessionId?: string;
  /** 会话列表（目标的会话候选与创建目录候选都来自这里的真实值）。 */
  sessions: readonly SessionSummaryView[];
  /** 整份全局目录（不再只是本会话的子集）。 */
  schedules: ScheduleItemView[];
  status: ChatState["schedulesStatus"];
  capability: ChatState["schedulesCapability"];
  /** 宿主归档列表里的会话 id：目标会话已归档时「立即运行」不可用（肯定证据）。 */
  archivedSessionIds?: readonly string[];
  newSessionIntervalSeconds?: number;
  limits?: AppState["scheduleLimits"];
  history?: Record<string, HistoryEntry>;
  result?: AppState["scheduleResult"];
  dispatch: (action: ScheduleAction) => void;
}) {
  const texts = useTexts();
  const [scopeView, setScopeView] = useState<ScheduleScopeView>("session");
  const [statusFilter, setStatusFilter] = useState<ScheduleStatusFilter>("all");
  // 展开的那一行（同一时刻只看一条详情，与后台任务的输出区同口径）
  const [expanded, setExpanded] = useState<string>();
  const [creating, setCreating] = useState(false);
  // 相对时间与「过期在前」的排序都要一个当前时刻：面板开着时每 30 秒重算一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (schedules.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [schedules.length]);

  // 打开面板 / 换会话：读一次目录。宿主只在**读过**的会话上重建（见 controller），
  // 所以这一下不会变成每次切会话的固定开销之外的东西。
  useEffect(() => {
    post({ type: "listSchedules" });
  }, [sessionId]);

  // 换会话：本地展开的行与未提交的新建表单都属于上一个会话的上下文，收起来。
  useEffect(() => {
    setExpanded(undefined);
    setCreating(false);
  }, [sessionId]);

  // 展开的那一行离开了目录（被删掉、或别的客户端删了）→ 收起
  useEffect(() => {
    if (expanded !== undefined && !schedules.some((item) => item.id === expanded)) setExpanded(undefined);
  }, [schedules, expanded]);

  // 投递间隔到点要**准时**让「立即运行」变得可用：30 秒的周期会晚最多半分钟，
  // 所以额外在 floor 结束那一刻叫醒一次。
  const floorWake = schedules.reduce((earliest, item) => {
    const at = item.deliveryFloorEndsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(item.deliveryFloorEndsAt);
    return at > now && at < earliest ? at : earliest;
  }, Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(floorWake)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, floorWake - Date.now()));
    return () => clearTimeout(timer);
  }, [floorWake]);

  const scoped = useMemo(
    () => (scopeView === "all" ? schedules : scheduleForSession(schedules, sessionId)),
    [scopeView, schedules, sessionId],
  );
  const filtered = useMemo(
    () =>
      scoped.filter((item) => {
        if (statusFilter === "all") return true;
        const status = scheduleStatusOf(item);
        if (statusFilter === "paused") return status === "paused";
        if (statusFilter === "ended") return status === "ended";
        return status === "active";
      }),
    [scoped, statusFilter],
  );
  const sorted = useMemo(() => orderSchedules(filtered, now), [filtered, now]);
  // 旧代（或整组端点缺席）不暴露创建入口；`unknown` 允许试一次——真 404 会被宿主
  // 记成旧代，随后入口消失。
  const canCreate = capability !== "legacy" && status !== "unsupported";
  // 归档证据只认宿主的归档列表：目标会话不在活跃列表里不等于归档（可能只是别的目录）。
  const archived = useMemo(() => new Set(archivedSessionIds ?? []), [archivedSessionIds]);

  return (
    <div className="panel-section schedule-section">
      <div className="panel-section-title">{texts.scheduleSection}</div>
      <div className="schedule-toolbar">
        <div className="schedule-tabs" role="group" aria-label={texts.scheduleSection}>
          <button
            type="button"
            className={`schedule-tab${scopeView === "session" ? " is-on" : ""}`}
            aria-pressed={scopeView === "session"}
            onClick={() => setScopeView("session")}
          >
            {texts.scheduleViewSession}
          </button>
          <button
            type="button"
            className={`schedule-tab${scopeView === "all" ? " is-on" : ""}`}
            aria-pressed={scopeView === "all"}
            onClick={() => setScopeView("all")}
          >
            {texts.scheduleViewAll}
          </button>
        </div>
        {canCreate && !creating ? (
          <button type="button" className="schedule-btn is-primary" onClick={() => setCreating(true)}>
            <IconPlus size={11} />
            {texts.scheduleNew}
          </button>
        ) : null}
      </div>

      {capability === "legacy" ? <div className="job-notice">{texts.scheduleCapabilityLegacy}</div> : null}
      {capability === "unknown" ? <div className="job-notice">{texts.scheduleCapabilityUnknown}</div> : null}

      <div className="schedule-filters" role="group" aria-label={texts.scheduleSection}>
        {(["all", "active", "paused", "ended"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`schedule-chip${statusFilter === value ? " is-on" : ""}`}
            aria-pressed={statusFilter === value}
            onClick={() => setStatusFilter(value)}
          >
            {value === "all"
              ? texts.scheduleFilterAll
              : value === "active"
                ? texts.scheduleFilterActive
                : value === "paused"
                  ? texts.scheduleFilterPaused
                  : texts.scheduleFilterEnded}
          </button>
        ))}
      </div>

      {creating ? (
        <ScheduleCreateCard
          key={`create:${sessionId ?? ""}`}
          sessionId={sessionId}
          sessions={sessions}
          newSessionIntervalSeconds={newSessionIntervalSeconds}
          limits={limits}
          result={result}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {sorted.length > 0 ? (
        sorted.map((item) => {
          // 官方 `targetArchived = task.target.kind !== 'new' && linkedState === 'archived'`：
          // `new` 目标每次新建会话，没有会被归档的固定落点。
          const targetSessionId = scheduleTargetSessionId(item);
          const targetArchived =
            item.target?.kind !== "new" &&
            targetSessionId !== undefined &&
            archived.has(targetSessionId);
          return (
            <ScheduleRow
              key={`${sessionId ?? ""}:${item.id}`}
              item={item}
              now={now}
              open={expanded === item.id}
              modern={capability === "modern"}
              capabilityKnown={capability === "modern" || capability === "legacy"}
              catalogStatus={status}
              targetArchived={targetArchived}
              newSessionIntervalSeconds={newSessionIntervalSeconds}
              limits={limits}
              sessionId={sessionId}
              sessions={sessions}
              history={history?.[item.id]}
              result={result}
              dispatch={dispatch}
              onToggle={() => setExpanded(expanded === item.id ? undefined : item.id)}
            />
          );
        })
      ) : (
        <ScheduleListNotice
          status={status}
          scopeView={scopeView}
          filtered={scoped.length > 0 && sorted.length === 0}
          hasAny={schedules.length > 0}
          texts={texts}
        />
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
function ScheduleListNotice({
  status,
  scopeView,
  filtered,
  hasAny,
  texts,
}: {
  status: ChatState["schedulesStatus"];
  scopeView: ScheduleScopeView;
  /** 这一档里有任务，但当前筛选把它们全滤掉了。 */
  filtered: boolean;
  /** 全局目录本身不为空（用来区分「本会话没有」与「一条都没有」）。 */
  hasAny: boolean;
  texts: Texts;
}) {
  if (status === "unsupported") return <div className="job-notice">{texts.scheduleUnsupported}</div>;
  if (status === "error") return <div className="job-notice is-error">{texts.scheduleLoadFailed}</div>;
  if (status === undefined || status === "loading") {
    return <div className="popover-empty">{texts.scheduleLoading}</div>;
  }
  if (filtered) return <div className="popover-empty">{texts.scheduleEmptyFilter}</div>;
  if (scopeView === "session" && hasAny) {
    return (
      <div className="popover-empty">
        {texts.scheduleEmpty}
        <div className="job-notice">{texts.scheduleEmptyHint}</div>
      </div>
    );
  }
  return (
    <div className="popover-empty">
      {texts.scheduleEmptyAll}
      <div className="job-notice">{texts.scheduleEmptyAllHint}</div>
    </div>
  );
}

/** 新建任务卡：字段与编辑共用一套，提交走 `schedule/create`。 */
function ScheduleCreateCard({
  sessionId,
  sessions,
  newSessionIntervalSeconds,
  limits,
  result,
  onClose,
}: {
  sessionId?: string;
  sessions: readonly SessionSummaryView[];
  newSessionIntervalSeconds?: number;
  limits?: AppState["scheduleLimits"];
  result?: AppState["scheduleResult"];
  onClose: () => void;
}) {
  const texts = useTexts();
  const [draft, setDraft] = useState<ScheduleEditorDraft>(() =>
    scheduleCreateDraft({ target: "new_once", sessionId: sessionId ?? "" }),
  );
  const [pending, setPending] = useState<SchedulePendingOp>();
  const [failure, setFailure] = useState<string>();
  const [created, setCreated] = useState(false);

  // 目标为「每次新建会话」时读一次间隔说明（零形参只读；旧代没有这个端点）。
  useEffect(() => {
    if (draft.target !== "new") return;
    if (limits?.newSessionIntervalSeconds !== undefined || limits?.unsupported === true) return;
    post({ type: "scheduleLimits" });
  }, [draft.target, limits?.newSessionIntervalSeconds, limits?.unsupported]);

  useEffect(() => {
    if (result === undefined || !scheduleResultSettles(pending, result)) return;
    setPending(undefined);
    if (result.op === "create" && result.ok) {
      setCreated(true);
      return;
    }
    setFailure(changeErrorText(result.code, texts));
  }, [result]);

  const cronError = scheduleTimingCronError(draft.timing);
  const missingTarget = scheduleTargetError(draft) !== undefined;
  const submit = () => {
    const built = scheduleCreateRequestOf(draft);
    if ("error" in built) {
      setFailure(draftErrorText(built.error, texts));
      return;
    }
    const opId = scheduleNextOpId();
    setPending({ op: "create", opId });
    setFailure(undefined);
    post({ type: "createSchedule", request: built.request, opId });
  };

  const saving = pending !== undefined;
  const interval = newSessionIntervalSeconds ?? limits?.newSessionIntervalSeconds;

  return (
    <div className="schedule-card is-create">
      <div className="schedule-card-title">{texts.scheduleCreateTitle}</div>
      {created ? <div className="job-notice">{texts.scheduleCreated}</div> : null}
      <ScheduleEditor
        idPrefix="schedule-create"
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          setFailure(undefined);
        }}
        disabled={saving}
        basicDisabled={false}
        allowRrule
        sessions={sessions}
        currentSessionId={sessionId}
        storedTargetSessionId={undefined}
        texts={texts}
      />
      {draft.target === "new" ? (
        <NewSessionIntervalNotice interval={interval} limits={limits} texts={texts} />
      ) : null}
      {failure ? <div className="job-notice is-error">{failure}</div> : null}
      <div className="schedule-actions">
        {/* 新建表单本来就是空的：这里不放「有未保存的修改」——那句话对一张空表单是噪音 */}
        <span className="schedule-unsaved" />
        <span className="spacer" />
        <button type="button" className="schedule-btn" disabled={saving} onClick={onClose}>
          {texts.scheduleCancel}
        </button>
        <button
          type="button"
          className="schedule-btn is-primary"
          disabled={saving || created || cronError !== undefined || missingTarget || !draft.title.trim() || !draft.prompt.trim()}
          onClick={submit}
        >
          {saving ? texts.scheduleCreating : texts.scheduleCreate}
        </button>
      </div>
    </div>
  );
}

/**
 * 一行任务：摘要、运行 / 暂停恢复 / 删除动作、编辑表单与执行记录。
 *
 * 本地草稿活在**行组件**里（不是面板）：行离开名册时草稿跟着消失。草稿与编辑
 * 基线的推进规则在 `webview/scheduleEditorState.ts` 的状态机里（纯函数，离线可断言）：
 * 「有没有改」「提交什么」都相对基线；没有本地修改时跟着权威目录走；保存成功后
 * 两者一起换成权威值。后台刷新只改别的字段时，不会凭空制造一次未保存修改。
 */
export function ScheduleRow({
  item,
  now,
  open,
  modern,
  capabilityKnown,
  catalogStatus,
  targetArchived,
  newSessionIntervalSeconds,
  limits,
  sessionId,
  sessions,
  history,
  result,
  dispatch,
  onToggle,
}: {
  item: ScheduleItemView;
  now: number;
  open: boolean;
  /** 服务端支持新代管理端点（创建 / 运行 / 暂停 / 目标编辑）。 */
  modern: boolean;
  /** 代际已经判明（不是 `unknown`）。 */
  capabilityKnown: boolean;
  /** 目录读取状态：读取中 / 失败时变更按钮没有可靠基准。 */
  catalogStatus: ChatState["schedulesStatus"];
  /** 目标会话已归档（肯定证据；`new` 目标不参与）。 */
  targetArchived: boolean;
  /** 宿主读到的「每次新建会话」最小投递间隔（秒）。 */
  newSessionIntervalSeconds?: number;
  /** 按需读取投递限制的状态（旧代没有该端点）。 */
  limits?: AppState["scheduleLimits"];
  sessionId?: string;
  sessions: readonly SessionSummaryView[];
  history?: HistoryEntry;
  result?: AppState["scheduleResult"];
  dispatch: (action: ScheduleAction) => void;
  onToggle: () => void;
}) {
  const texts = useTexts();
  const locale = useLocale();
  const [editor, dispatchEditor] = useReducer(scheduleEditorReducer, item, scheduleEditorState);
  const { draft, base } = editor;
  const [pending, setPending] = useState<SchedulePendingOp>();
  const [failure, setFailure] = useState<string>();
  const [runConfirm, setRunConfirm] = useState(false);
  const [deletePhase, setDeletePhase] = useState<KillPhase>();
  const [deleteError, setDeleteError] = useState<string>();
  // 结算帧按引用相等识别；它带来的 `item` 由下面这个 ref 取**最新一次渲染**的值
  // （结算帧在权威目录刷新之后才到，见 controller 的变更路由）。
  const itemRef = useRef(item);
  itemRef.current = item;

  // 服务端刷新（保存成功读回、别的窗口改了、到点投递推进了目标）后，状态机决定：
  // 没有本地修改 → 草稿与基线一起跟上；有未保存修改 → 两者都保留。
  useEffect(() => {
    dispatchEditor({ type: "catalog", item });
  }, [item]);

  // 目标切到「每次新建会话」时才读一次间隔说明（零形参只读；旧代没有这个端点，
  // 明确缺席时宿主回 `unsupported`，界面不显示这一行）。`new_once` 不受这条间隔
  // 约束，因此也不显示。
  useEffect(() => {
    if (!open || draft.target !== "new") return;
    if (limits?.newSessionIntervalSeconds !== undefined || limits?.unsupported === true) return;
    post({ type: "scheduleLimits" });
  }, [open, draft.target, limits?.newSessionIntervalSeconds, limits?.unsupported]);

  // 展开详情时按需读一次执行记录（只读一次；失败与成功都算落定，别在这里循环）
  useEffect(() => {
    if (!open) return;
    // `code`（任务不存在 / 游标失效）**不算落定**：那种情形下重新展开应当再读一次第一页
    const settled =
      (history?.loaded === true && history?.code === undefined) ||
      history?.error !== undefined ||
      history?.hostUnavailable === true;
    if (history !== undefined && (history.loading || settled)) return;
    const opId = scheduleNextOpId();
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true, opId });
    post({ type: "scheduleHistory", id: item.id, opId });
  }, [open, history, item.id]);

  /** 又投递过一次 → 重读最新一页（记录按需读；不跟着刷新就会少掉刚发生的那次）。 */
  const deliveredAt = item.lastDelivery?.deliveredAt;
  const seenDelivery = useRef<string | undefined>(deliveredAt);
  useEffect(() => {
    if (seenDelivery.current === deliveredAt) return;
    seenDelivery.current = deliveredAt;
    if (!open || history === undefined) return;
    const opId = scheduleNextOpId();
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true, opId });
    post({ type: "scheduleHistory", id: item.id, opId });
  }, [deliveredAt, open, item.id]);

  // 结算：只认**自己这次**操作（opId 由宿主回显），迟到帧不许结算新界面
  useEffect(() => {
    if (result === undefined || !scheduleResultSettles(pending, result)) return;
    setPending(undefined);
    if (result.op === "delete") {
      setDeletePhase(killSettled({ key: item.id, state: "pending" }, item.id, result.ok));
      setDeleteError(result.ok ? undefined : deleteErrorText(result.code, texts));
      return;
    }
    if (result.ok) {
      setFailure(undefined);
      setRunConfirm(false);
      // 保存成功：宿主已经重读过权威目录再发这一帧，草稿与基线一起换成那条新值。
      // 只清失败提示不推进基线，会让下一次目录刷新把刚保存的这版误判成冲突。
      if (result.op === "update") dispatchEditor({ type: "saved", item: itemRef.current });
      return;
    }
    setFailure(
      result.op === "run" ? runErrorText(result.code, texts) : changeErrorText(result.code, texts),
    );
  }, [result]);

  // armed / failed 到点自动复位；pending 要等结算帧收场（与停止按钮同一台状态机）
  useEffect(() => {
    const ms = deletePhase ? autoResetMs(deletePhase.state) : undefined;
    if (ms === undefined) return;
    const timer = setTimeout(() => setDeletePhase(undefined), ms);
    return () => clearTimeout(timer);
  }, [deletePhase]);

  const active = scheduleIsActive(item);
  const ended = scheduleStatusOf(item) === "ended";
  const statusText =
    item.status === "active"
      ? texts.scheduleActive
      : item.status === "paused"
        ? texts.schedulePaused
        : item.status === "inactive" || item.status === "ended"
          ? texts.scheduleInactive
          : item.status === "unknown"
            ? texts.scheduleUnknownStatus
            : item.status;
  const zone = deviceZone();
  const frequency = scheduleFrequency(item, texts, { system: zone, locale });
  const nextRunAt = scheduleNextRunAt(item);
  const relative = relativeText(nextRunAt, now, texts);
  const stamp = formatScheduleStamp(nextRunAt, locale, storedZoneOf(item));
  const canEditDetails = modern && item.api === "edit";
  const dirty = scheduleEditorStateDirty(editor);
  const stale = canEditDetails && scheduleEditorStateConflict(editor, item);
  const floorAt = item.deliveryFloorEndsAt === undefined ? undefined : Date.parse(item.deliveryFloorEndsAt);
  const floorActive = floorAt !== undefined && floorAt > now;
  const floorNotice = floorActive
    ? texts.scheduleDeliveryFloor(formatScheduleStamp(new Date(floorAt).toISOString(), locale))
    : undefined;
  const executionActive = item.executionActive === true;
  const cronError = scheduleTimingCronError(draft.timing);
  const missingTarget = scheduleTargetError(draft) !== undefined;
  const controls = scheduleRowControls({
    catalogStatus,
    capabilityKnown,
    editable: canEditDetails,
    pending: pending !== undefined,
    deleting: deletePhase?.state === "pending",
    dirty,
    invalid: cronError !== undefined || missingTarget || !draft.title.trim() || !draft.prompt.trim(),
    executionActive,
    floorActive,
    targetArchived,
    ended,
  });

  const pressDelete = () => {
    if (!controls.canDelete) return;
    const next = pressKill(deletePhase, item.id);
    setDeletePhase(next);
    setDeleteError(undefined);
    if (next.state !== "pending") return;
    const opId = scheduleNextOpId();
    setPending({ op: "delete", opId, id: item.id });
    post({
      type: "deleteSchedule",
      id: item.id,
      ...(item.api === "edit" ? { expectedUpdatedAt: base.updatedAt ?? null } : {}),
      opId,
    });
  };

  const save = () => {
    if (!controls.canSave) return;
    if (item.api === "edit") {
      // 只提交**相对编辑基线**改过的字段：用最新目录当比较对象，会把别人刚改的
      // 字段当成自己的修改再提交回去（一次静默覆盖）。
      const built = schedulePatchOf(draft, base);
      if ("error" in built) {
        setFailure(draftErrorText(built.error, texts));
        return;
      }
      const opId = scheduleNextOpId();
      setPending({ op: "update", opId, id: item.id });
      setFailure(undefined);
      post({
        type: "editSchedule",
        id: item.id,
        patch: built.patch,
        expectedUpdatedAt: base.updatedAt ?? null,
        opId,
      });
      return;
    }
    // 旧代：只有运行时间编辑这一条路（`schedule/update` 的比较并交换）
    const built = scheduleChangeFromDraft(draft.timing);
    if ("error" in built) {
      setFailure(draftErrorText(built.error, texts));
      return;
    }
    const opId = scheduleNextOpId();
    setPending({ op: "update", opId, id: item.id });
    setFailure(undefined);
    post({ type: "updateSchedule", id: item.id, change: built.change, opId });
  };

  const setActive = (next: boolean) => {
    if (item.api !== "edit" || !controls.canPause) return;
    const opId = scheduleNextOpId();
    setPending({ op: "active", opId, id: item.id });
    setFailure(undefined);
    post({
      type: "setScheduleActive",
      id: item.id,
      active: next,
      expectedUpdatedAt: base.updatedAt ?? null,
      opId,
    });
  };

  const run = () => {
    if (controls.runHeld) return;
    const opId = scheduleNextOpId();
    setPending({ op: "run", opId, id: item.id });
    setFailure(undefined);
    setRunConfirm(false);
    post({ type: "runSchedule", id: item.id, opId });
  };

  return (
    <div className={`job-row schedule-row${open ? " is-open" : ""}`} data-status={scheduleStatusOf(item)}>
      <div className="job-head">
        <button
          type="button"
          className="job-row-toggle"
          aria-expanded={open}
          aria-label={open ? texts.scheduleCollapseAria(item.title) : texts.scheduleExpandAria(item.title)}
          onClick={onToggle}
        >
          {/* 状态点：启用中用「有活动含义」的绿点，其余用中性灰点（不猜色调） */}
          <span className={`dot ${active ? "dot-ok" : "dot-muted"}`} />
          <span className="job-label" title={item.title}>
            {item.title}
          </span>
          <span className="schedule-status">{statusText}</span>
          <IconChevronDown size={12} className={`job-chevron${open ? " is-open" : ""}`} />
        </button>
      </div>
      <div className="schedule-meta">
        {frequency ? <span className="schedule-frequency">{frequency}</span> : null}
        <span>
          {active || item.status === "paused" ? `${texts.scheduleNextRun} ` : `${texts.scheduleLastTarget} `}
          {stamp}
          {relative ? <span className="schedule-relative"> · {relative}</span> : null}
        </span>
      </div>
      <div className="schedule-row-actions" aria-busy={controls.busy}>
        {modern ? (
          <button
            type="button"
            className="schedule-btn is-run"
            disabled={controls.runHeld}
            title={
              controls.runHeld
                ? runHeldReason({ dirty, executionActive, floorNotice, targetArchived, authoritative: controls.authoritative }, texts)
                : undefined
            }
            aria-label={texts.scheduleRunAria(item.title)}
            onClick={() => setRunConfirm(true)}
          >
            <IconPlay size={12} />
            {pending?.op === "run" ? texts.scheduleRunning : texts.scheduleRunNow}
          </button>
        ) : null}
        {controls.pauseVisible ? (
          <button
            type="button"
            className="schedule-btn"
            disabled={!controls.canPause}
            title={active ? texts.schedulePauseAria(item.title) : texts.scheduleResumeAria(item.title)}
            aria-label={active ? texts.schedulePauseAria(item.title) : texts.scheduleResumeAria(item.title)}
            onClick={() => setActive(!active)}
          >
            {active ? <IconPause size={12} /> : <IconPlay size={12} />}
            {active ? texts.schedulePause : texts.scheduleResume}
          </button>
        ) : null}
        <button
          type="button"
          className={`schedule-btn is-danger${deletePhase?.state === "armed" ? " is-armed" : ""}${
            deletePhase?.state === "failed" ? " is-failed" : ""
          }`}
          data-kill-state={deletePhase?.state ?? "idle"}
          disabled={!controls.canDelete}
          title={
            deletePhase?.state === "armed"
              ? texts.scheduleDeleteConfirm
              : deletePhase?.state === "failed"
                ? texts.scheduleDeleteFailed
                : texts.scheduleDeleteTitle(item.title)
          }
          aria-label={deletePhase?.state === "armed" ? texts.scheduleDeleteConfirmAction : texts.scheduleDeleteTitle(item.title)}
          onClick={pressDelete}
        >
          <IconTrash size={12} />
          {deletePhase?.state === "armed"
            ? texts.scheduleDeleteConfirmAction
            : deletePhase?.state === "pending"
              ? texts.scheduleDeleting
              : deletePhase?.state === "failed"
                ? texts.scheduleDeleteFailed
                : texts.scheduleDelete}
        </button>
      </div>
      {modern && runConfirm ? (
        <div className="schedule-confirm" role="group" aria-label={texts.scheduleRunConfirmTitle}>
          <div className="schedule-card-title">{texts.scheduleRunConfirmTitle}</div>
          <div className="job-notice">{texts.scheduleRunConfirmNote}</div>
          <div className="schedule-confirm-actions">
            <button type="button" className="schedule-btn" disabled={controls.busy} onClick={() => setRunConfirm(false)}>
              {texts.scheduleCancel}
            </button>
            <button type="button" className="schedule-btn is-primary" disabled={controls.runHeld} onClick={run}>
              {texts.scheduleRunConfirmAction}
            </button>
          </div>
        </div>
      ) : null}
      {deletePhase?.state === "failed" && deleteError ? (
        <div className="job-notice is-error">{deleteError}</div>
      ) : null}
      {failure ? <div className="job-notice is-error" role="alert">{failure}</div> : null}
      {open ? (
        <div className="job-panel">
          {executionActive ? <div className="job-notice">{texts.scheduleExecutionActive}</div> : null}
          {floorNotice ? <div className="job-notice">{floorNotice}</div> : null}
          {stale ? (
            <div className="job-notice is-error">
              {texts.scheduleConflictNotice}
              <button
                type="button"
                className="schedule-link"
                onClick={() => {
                  dispatchEditor({ type: "reapply", item });
                  setFailure(undefined);
                }}
              >
                {texts.scheduleReapply}
              </button>
            </div>
          ) : null}
          {targetArchived ? <div className="job-notice">{texts.scheduleErrTargetArchived}</div> : null}
          <ScheduleEditor
            idPrefix={`schedule-edit-${item.id}`}
            draft={draft}
            onChange={(next) => {
              dispatchEditor({ type: "edit", draft: next });
              setFailure(undefined);
            }}
            disabled={controls.fieldsDisabled || item.editable === false}
            basicDisabled={controls.basicDisabled}
            allowRrule={item.api === "edit"}
            sessions={sessions}
            currentSessionId={sessionId}
            storedTargetSessionId={scheduleTargetSessionId(item)}
            texts={texts}
          />
          {/* 只有「每次新建会话」受投递间隔约束：`new_once` 首次投递之后复用同一
              会话，不受它限制；加载中不先下结论。 */}
          {draft.target === "new" ? (
            <NewSessionIntervalNotice
              interval={newSessionIntervalSeconds ?? limits?.newSessionIntervalSeconds}
              limits={limits}
              texts={texts}
            />
          ) : null}
          {!capabilityKnown ? <div className="job-notice">{texts.scheduleCapabilityUnknown}</div> : null}
          {item.editable === false ? <div className="job-notice">{texts.scheduleRuleUnreadable}</div> : null}
          {!canEditDetails && item.api !== "edit" && capabilityKnown ? (
            <div className="job-notice">{texts.scheduleCapabilityLegacy}</div>
          ) : null}
          {dirty && !stale ? (
            <div className="schedule-actions">
              <span className="schedule-unsaved">{texts.scheduleUnsaved}</span>
              <span className="spacer" />
              <button
                type="button"
                className="schedule-btn"
                disabled={controls.busy}
                onClick={() => {
                  dispatchEditor({ type: "discard", item });
                  setFailure(undefined);
                }}
              >
                {texts.scheduleCancel}
              </button>
              <button
                type="button"
                className="schedule-btn is-primary"
                disabled={!controls.canSave}
                onClick={save}
              >
                {pending?.op === "update" ? texts.scheduleSaving : texts.scheduleSave}
              </button>
            </div>
          ) : null}
          <ScheduleRecords item={item} entry={history} dispatch={dispatch} />
        </div>
      ) : null}
    </div>
  );
}

/** 「立即运行」此刻不可用的原因（按钮的悬停说明；空串表示可用）。 */
function runHeldReason(
  state: {
    dirty: boolean;
    executionActive: boolean;
    floorNotice?: string;
    targetArchived: boolean;
    authoritative: boolean;
  },
  texts: Texts,
): string | undefined {
  if (state.dirty) return texts.scheduleUnsaved;
  if (state.executionActive) return texts.scheduleExecutionActive;
  if (state.targetArchived) return texts.scheduleErrTargetArchived;
  if (state.floorNotice !== undefined) return state.floorNotice;
  if (!state.authoritative) return texts.scheduleCapabilityUnknown;
  return undefined;
}

/** 秒数 → 「1 分钟」「2 小时」这类可读间隔（复用规则编辑的单位词）。 */
function formatInterval(seconds: number, texts: Texts): string {
  const scheduleTexts = texts as unknown as ScheduleTexts;
  if (seconds % 3_600 === 0) {
    const value = seconds / 3_600;
    return `${value} ${scheduleTexts.scheduleUnitHour(value)}`;
  }
  if (seconds % 60 === 0) {
    const value = seconds / 60;
    return `${value} ${scheduleTexts.scheduleUnitMin(value)}`;
  }
  return `${seconds} ${scheduleTexts.scheduleUnitSec(seconds)}`;
}

/**
 * 投递间隔说明（目标为「每次新建会话」时）。
 *
 * 三种状态分开：读到了 → 说具体间隔；这次没读到 → 说读取失败（创建不受影响）；
 * 旧代没有这个端点 → 什么也别说（不是失败）。还在读的时候也不显示——此时下结论
 * 等于替一次没落定的读取编一个答案。
 */
function NewSessionIntervalNotice({
  interval,
  limits,
  texts,
}: {
  interval: number | undefined;
  limits?: AppState["scheduleLimits"];
  texts: Texts;
}) {
  if (limits?.unsupported === true) return null;
  if (interval !== undefined) {
    return <div className="job-notice">{texts.scheduleNewSessionInterval(formatInterval(interval, texts))}</div>;
  }
  if (limits?.error !== undefined) {
    return <div className="job-notice">{texts.scheduleNewSessionIntervalUnknown}</div>;
  }
  return null;
}
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
    const opId = scheduleNextOpId();
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, opId });
    post({ type: "scheduleHistory", id: item.id, ...(entry?.nextBefore ? { before: entry.nextBefore } : {}), opId });
  };
  const reload = () => {
    const opId = scheduleNextOpId();
    dispatch({ type: "ui/scheduleHistoryRequest", id: item.id, reset: true, opId });
    post({ type: "scheduleHistory", id: item.id, opId });
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
              <span className="schedule-record-time">{formatScheduleStamp(record.scheduledAt, locale, zone)}</span>
              <span
                className="schedule-record-prompt"
                title={texts.scheduleRecordTitle(
                  formatScheduleStamp(record.scheduledAt, locale, zone),
                  formatScheduleStamp(record.deliveredAt, locale, zone),
                )}
              >
                {record.prompt === undefined || record.prompt === "" ? texts.scheduleRecordNoPrompt : record.prompt}
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

/** 本地草稿校验失败（提交前的判定，与 `schedule/update` / `schedule/edit` 的错误码同名）。 */
function draftErrorText(
  error: "invalid_rule" | "frequency_too_high" | "invalid_time_zone" | "invalid_prompt" | "invalid_target",
  texts: Texts,
): string {
  if (error === "frequency_too_high") return texts.scheduleErrInterval;
  if (error === "invalid_time_zone") return texts.scheduleErrZone;
  if (error === "invalid_prompt") return texts.scheduleErrInvalidPrompt;
  if (error === "invalid_target") return texts.scheduleErrInvalidTarget;
  return texts.scheduleErrInvalid;
}

/** 服务端拒绝变更时的稳定错误码 → 文案（`undefined` = 请求根本没发出去）。 */
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
    case "invalid_prompt":
    case "invalid_title":
      return texts.scheduleErrInvalidPrompt;
    case "invalid_target":
      return texts.scheduleErrInvalidTarget;
    case "target_archived":
    case "schedule/target-archived":
      return texts.scheduleErrTargetArchived;
    case "unsupported":
      return texts.scheduleErrUnsupported;
    case "stale":
      return texts.scheduleErrStale;
    case "internal_error":
      return texts.scheduleErrInternal;
    case "invalid_rule":
    case "invalid_selector":
      return texts.scheduleErrInvalid;
    case undefined:
      return texts.scheduleErrOffline;
    default:
      return texts.scheduleErrInvalid;
  }
}

/** 立即运行的拒绝文案（「还有一次执行在进行」是**正常的等待**，不是故障）。 */
function runErrorText(code: string | undefined, texts: Texts): string {
  if (code === "schedule_execution_pending") return texts.scheduleRunPending;
  if (code === "schedule_not_found") return texts.scheduleErrNotFound;
  return changeErrorText(code, texts);
}

/** 删除失败：任务本来就不在，与别的失败分开说（前者重试也没有意义）。 */
function deleteErrorText(code: string | undefined, texts: Texts): string {
  if (code === "schedule_not_found") return texts.scheduleErrNotFound;
  if (code === "schedule_conflict") return texts.scheduleErrConflict;
  if (code === undefined) return texts.scheduleErrOffline;
  return texts.scheduleDeleteFailed;
}
