import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JobItemView, SubagentView } from "../../shared/chat";
import { IconAgents, IconChevronLeft, IconClose, IconJobs, IconStop } from "../icons";
import { formatClock, formatDuration, Spinner } from "./primitives";
import { compareJobs, isSubagentJob } from "../jobsOrder";
import { autoResetMs, killSettled, phaseLive, pressKill, type KillPhase } from "../jobsKill";
import { post } from "../bridge";
import { useTexts } from "../texts";
import { Message } from "./Message";

/** 抽屉外壳：四个面板共用（标题栏 + 可滚动内容）。 */
function Drawer({
  title,
  icon,
  onClose,
  children,
  onBack,
  bodyRef,
}: {
  title: string;
  icon: JSX.Element;
  onClose: () => void;
  children: React.ReactNode;
  onBack?: () => void;
  /** 滚动容器的 ref（子代理记录要能**默认停在最新一条**，见下方面板）。 */
  bodyRef?: React.RefObject<HTMLDivElement>;
}) {
  const texts = useTexts();
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          {onBack ? (
            <button className="icon-btn" title={texts.back} onClick={onBack}>
              <IconChevronLeft size={14} />
            </button>
          ) : (
            <span className="drawer-icon">{icon}</span>
          )}
          <span>{title}</span>
          <span className="spacer" />
          <button className="icon-btn" title={texts.close} onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="drawer-body" ref={bodyRef}>
          {children}
        </div>
      </div>
    </>
  );
}

/**
 * 子代理一行左侧那个状态点的色调。
 *
 * `inactive` = **已完成**（绿灯）：这条子代理已经领过任务、现在不在跑。目录里
 * 一条子代理要么是 one-shot（带着 prompt 建出来的），要么是 continuable
 * （`startContinuable` 的返回值注释写着「initial prompt 被接受后」），所以
 * 「列出来了 + 不在跑」= 跑完了。用户 2026-09-19 的口径就是这条。
 */
function subagentTone(activity: SubagentView["activity"]): string {
  return activity === "running" ? "dot-running" : "dot-ok";
}

/** 子代理面板：列出当前会话的子代理，点进去看它的对话记录。 */
export function SubagentsPanel({
  entries,
  onClose,
  onOpen,
}: {
  entries: SubagentView[];
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const texts = useTexts();
  return (
    <Drawer title={texts.subagents} icon={<IconAgents size={14} />} onClose={onClose}>
      {entries.length === 0 ? (
        <div className="popover-empty">{texts.subagentsEmpty}</div>
      ) : (
        entries.map((entry) => (
          <button key={entry.id} className="session-item" onClick={() => onOpen(entry.id)}>
            <span className="session-item-title">{entry.label}</span>
            <span className="session-item-sub">
              {entry.activity ? (
                <>
                  {/* 状态点**独享一格**（格内水平垂直居中）并自带左外边距：
                      以前它紧跟在标题末尾（行的 gap 只有 2px），窄侧栏下看着像贴在
                      标题上（用户 2026-09-19 报「太靠左、被标题盖住一点」）。 */}
                  <span className="session-item-state">
                    <span className={`dot ${subagentTone(entry.activity)}`} />
                  </span>
                  {entry.activity === "running" ? texts.jobRunning : texts.subagentCompleted}
                </>
              ) : (
                // `activity` 只有 RPC 列表行才有（投影没有这个字段，见 `SubagentView`
                // 的注释）——不知道就**不画状态点**，更不能把"不知道"画成「已完成」。
                // 这时改显示**生命周期模式**（那个字段恒有），也是一条有用的信息。
                <span className="session-item-mode">
                  {entry.mode === "one-shot" ? texts.subagentOneShot : texts.subagentContinuable}
                </span>
              )}
            </span>
          </button>
        ))
      )}
    </Drawer>
  );
}

/**
 * 单个子代理的对话记录（**只读**查看，没有输入区）。
 *
 * 打开时**默认停在最新一条**（用户 2026-09-19 口径）：这是一份「它最后做了什么」
 * 的记录，抽屉一开就落在开头等于让用户先滚一段。内容到达后再落一次底——
 * 快照是攒完一次性下发的，中间那次空渲染不该让滚动位置留在顶上。
 */
export function SubagentTranscriptPanel({
  id,
  label,
  messages,
  loading,
  onClose,
  onBack,
}: {
  /** 子代理的会话 id：滚动落位的身份（换一个子代理就该重新落底）。 */
  id: string;
  /** 抽屉标题：目录里的名字（找不到目录行时由调用方退回 id）。 */
  label: string;
  messages: import("../../shared/chat").MessageView[];
  loading: boolean;
  onClose: () => void;
  onBack: () => void;
}) {
  const texts = useTexts();
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [id, messages]);
  return (
    <Drawer title={label} icon={<IconAgents size={14} />} onClose={onClose} onBack={onBack} bodyRef={body}>
      {messages.length === 0 ? (
        loading ? (
          <div className="drawer-loading">
            <Spinner size={11} /> {texts.subagentLoading}
          </div>
        ) : (
          <div className="popover-empty">{texts.subagentTranscriptEmpty}</div>
        )
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) => (
            // `readOnly`：这份记录属于另一个会话——问卷 / 审批卡只画内容，
            // 不给任何能发出去的控件（用户 2026-09-19 口径「仅可查看不可发送消息」）
            <Message key={message.id} message={message} readOnly />
          ))}
        </div>
      )}
    </Drawer>
  );
}

/**
 * 状态色调：与官方 `dotState` 逐条对齐（`dsh-client-ui-jobs/lib/client.js`：
 * `running→ongoing, stopping→warning, completed→done, killed→warning, failed→error`）。
 *
 * `stopping` 以前画成 `dot-running`（按了停止的任务看起来还在正常运行），
 * `killed` 干脆没有点（一条已被取消的任务连状态点都不显示）——两种都会让用户
 * 得到与事实相反的结论。`.dot-stopped` 本身就是 warning 色，直接用既有类。
 *
 * 未知状态不猜色调（见 `applyJobs`：状态原样保留，不再折成 completed）。
 */
const JOB_TONE: Record<string, string> = {
  running: "dot-running",
  stopping: "dot-stopped",
  completed: "dot-ok",
  killed: "dot-stopped",
  failed: "dot-error",
};

/**
 * 一行后台任务的停止按钮（两段式，官方 `dsh-client-ui-jobs` 同口径）。
 *
 * **只在 `running` 行渲染**：`stopping` 表示停止请求已经在路上（按钮消失本身就是
 * 「受理了」的反馈）；已收场的行没有可停的东西。第一下进入 `armed`（亮出「确认停止」、
 * 几秒不确认自己退回），第二下才发请求——误触保护照官方。状态流转全部在
 * `webview/jobsKill.ts`（纯函数），这里只渲染与转发按压。
 */
function JobStopButton({
  job,
  phase,
  onPress,
}: {
  job: JobItemView;
  /** 面板当前跟踪的停止状态（只跟踪一枚按钮；别的行的状态与本行无关）。 */
  phase: KillPhase | undefined;
  onPress: (job: JobItemView) => void;
}) {
  const texts = useTexts();
  if (job.status !== "running") return null;
  const state = phase?.key === job.id ? phase.state : "idle";
  const title =
    state === "armed"
      ? texts.jobStopConfirm
      : state === "failed"
        ? texts.jobStopFailed
        : texts.jobStopTitle(job.label);
  return (
    <button
      type="button"
      className={`job-stop${state === "armed" ? " is-armed" : ""}${state === "failed" ? " is-failed" : ""}`}
      data-kill-state={state}
      disabled={state === "pending"}
      title={title}
      aria-label={title}
      onClick={() => onPress(job)}
    >
      <IconStop size={10} />
      {/* armed 档亮出文字（官方 `kill.confirmAction`）；其余档只有图标，宽度不横跳 */}
      {state === "armed" ? <span className="job-stop-label">{texts.jobStopConfirmAction}</span> : null}
    </button>
  );
}

/**
 * 后台任务面板：bash / pwsh 等真实后台任务，来自 `job/list` 流（旧服务端是
 * `session/control` 的 jobs 帧）。**子代理（`kind: 'subagent'`）不进面板**
 * （用户 2026-09-24 口径——它有自己的面板），但名册数据里仍保留那一行：
 * 它是子代理按钮的活性来源之一（见 `activity.ts` 的 `subagentsBusy`）。
 */
export function JobsPanel({
  jobs,
  killResult,
  onClose,
}: {
  jobs: JobItemView[];
  /** 最近一条停止请求的结算（宿主 `jobs/killResult` 帧；没有 = 还没停过任何任务）。 */
  killResult?: { jobId: string; ok: boolean };
  onClose: () => void;
}) {
  const texts = useTexts();
  // 两段式停止按钮的状态机：同一时刻只跟踪一枚按钮（官方 killPhase 同款）
  const [killPhase, setKillPhase] = useState<KillPhase>();
  // armed / failed 档到点自动复位；pending 不复位——它要等名册把行推离 running
  useEffect(() => {
    const ms = killPhase ? autoResetMs(killPhase.state) : undefined;
    if (ms === undefined) return;
    const timer = setTimeout(() => setKillPhase(undefined), ms);
    return () => clearTimeout(timer);
  }, [killPhase]);
  // 名册更新：目标行不再 running（已推成 stopping / killed，或整行没了）→ 状态收场。
  // 这是「已受理」的 pending 唯一的成功收场路径（官方 rows effect 同口径）。
  useEffect(() => {
    setKillPhase((prev) => phaseLive(prev, jobs));
  }, [jobs]);
  // 宿主的结算帧：没受理 → failed；受理了维持 pending（同上，等名册收场）。
  // 每次 jobKill 都是新对象，连着两次失败也会各推进一次。
  useEffect(() => {
    if (!killResult) return;
    setKillPhase((prev) => killSettled(prev, killResult.jobId, killResult.ok));
  }, [killResult]);

  const pressStop = (job: JobItemView) => {
    const next = pressKill(killPhase, job.id);
    setKillPhase(next);
    // 返回 pending = 这是对同一行的第二下确认：真的发请求
    if (next.state === "pending") post({ type: "killJob", jobId: job.id });
  };

  const label: Record<string, string> = {
    running: texts.jobRunning,
    stopping: texts.jobStopping,
    completed: texts.jobCompleted,
    killed: texts.jobKilled,
    failed: texts.jobFailed,
  };
  // 排序照官方 `ordered()`：**在跑的（含正在停止）排在最前**、按开始时间升序，
  // 已结束的按结束时间降序。以前一律按开始时间倒序，于是一个跑了十分钟的后台任务
  // 会被刚结束的任务挤到列表下面，看起来像"不见了"。
  // 子代理行先滤掉（它有自己的面板）；空态判据吃的是**过滤后**的名单——
  // 名册里只剩子代理在跑时，面板该显示的是「没有后台任务」，不是空白。
  const sorted = [...jobs].filter((job) => !isSubagentJob(job)).sort(compareJobs);

  return (
    <Drawer title={texts.jobs} icon={<IconJobs size={14} />} onClose={onClose}>
      {sorted.length === 0 ? (
        <div className="popover-empty">{texts.jobsEmpty}</div>
      ) : (
        sorted.map((job) => (
          <div key={job.id} className="job-row">
            <div className="job-head">
              <span className={`dot ${JOB_TONE[job.status] ?? ""}`} />
              <span className="job-label" title={job.label}>
                {job.label}
              </span>
              <span className="job-kind">{job.kind}</span>
              <JobStopButton job={job} phase={killPhase} onPress={pressStop} />
            </div>
            <div className="job-meta">
              {label[job.status] ?? (job.status === "unknown" ? texts.jobUnknown : job.status)}
              {" · "}
              {formatClock(job.startedAt)}
              {job.finishedAt
                ? ` · ${formatDuration(job.finishedAt - job.startedAt)}`
                : ` · ${formatDuration(Date.now() - job.startedAt)}`}
            </div>
            {job.detail ? <div className="job-detail">{job.detail}</div> : null}
          </div>
        ))
      )}
    </Drawer>
  );
}

/**
 * 任务排序（官方 `dsh-client-ui-jobs/lib/client.js` 的 `ordered()` 同口径）：
 * 1. live（`running` / `stopping`）在前，按 `startedAt` **升序**（先开跑的排上面）；
 * 2. settled 在后，按 `finishedAt` **降序**；没有 `finishedAt` 的按开始时间兜底。
 *
 * 实现在 `webview/jobsOrder.ts`（纯函数，`scripts/jobsOrder.test.ts` 直接钉住）。
 */
