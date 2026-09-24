import { useEffect, useMemo, useRef, useState } from "react";
import type { JobItemView } from "../../shared/chat";
import { IconChevronDown, IconClose, IconJobs, IconStop } from "../icons";
import { formatClock, formatDuration } from "./primitives";
import { CopyButton } from "./CopyButton";
import { compareJobs, isLiveJob, isObservableJob, isSubagentJob } from "../jobsOrder";
import { autoResetMs, killSettled, phaseLive, pressKill, type KillPhase } from "../jobsKill";
import type { JobObserved } from "../jobObserve";
import { post } from "../bridge";
import { useTexts } from "../texts";

/**
 * 面板要用到的两条界面动作（观察开始 / 观察释放）。
 *
 * 收窄成这两条而不是直接收 `Dispatch<Action>`：面板只管这两件事，别的动作从这里
 * 发不出去（`App.tsx` 传进来的 `dispatch` 本来就接受全部动作，收窄是给自己看的约束）。
 */
type JobOutputAction =
  | { type: "ui/jobObserve"; jobId: string; watchId: number }
  | { type: "ui/jobClose"; jobId: string };

/** 抽屉外壳：历史 / 后台任务两个面板共用（标题栏 + 可滚动内容）。 */function Drawer({
  title,
  icon,
  onClose,
  children,
  bodyRef,
}: {
  title: string;
  icon: JSX.Element;
  onClose: () => void;
  children: React.ReactNode;
  /** 滚动容器的 ref（需要「默认停在最新一条」的面板用）。 */
  bodyRef?: React.RefObject<HTMLDivElement>;
}) {
  const texts = useTexts();
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <span className="drawer-icon">{icon}</span>
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
 *
 * 每行可展开看**实时输出**（官方 `JobListAction` 同口径）：能展开的只有
 * `isObservableJob` 为真的行（live，或已结束但环里还留着输出），展开时向宿主
 * 要一条 `job/follow` 观察流，收起 / 关面板 / 行离开名册时释放。输出累积在
 * `webview/jobObserve.ts`，这里只画。
 */
export function JobsPanel({
  jobs,
  outputs,
  killResult,
  dispatch,
  onClose,
}: {
  jobs: JobItemView[];
  /** 各任务的实时输出累积（键 = 任务 id；没有条目的行 = 还没展开过）。 */
  outputs?: Record<string, JobObserved>;
  /** 最近一条停止请求的结算（宿主 `jobs/killResult` 帧；没有 = 还没停过任何任务）。 */
  killResult?: { jobId: string; ok: boolean };
  /** 只放行本面板要用的两条动作（观察开始 / 观察释放），别的一律发不出去。 */
  dispatch: (action: JobOutputAction) => void;
  onClose: () => void;
}) {
  const texts = useTexts();
  // 两段式停止按钮的状态机：同一时刻只跟踪一枚按钮（官方 killPhase 同款）
  const [killPhase, setKillPhase] = useState<KillPhase>();
  // 展开的那一行（官方 `expandedKey` 也是单个键：同一时刻只看一条输出）
  const [expanded, setExpanded] = useState<string>();
  // 观察代号：每次展开换一个新号，宿主回带的帧只有对上它才被采纳
  // （旧流的残余帧因此进不来，见 `jobObserve.ts`）。用 ref 而不是 state：
  // 它不参与渲染，只做铸造。
  const watchSeq = useRef(0);
  const expandedRef = useRef<string>();
  // 摘要（live 时长）要每秒重算：面板开着且有名册里的 live 行时才跑（官方同款）
  const [now, setNow] = useState(() => Date.now());
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

  /**
   * 收起一行：先告诉宿主释放观察流，再把界面这份累积丢掉。
   *
   * 丢掉是必须的（不是省内存）：宿主收起即取消流，重新展开会从服务端环里最旧的
   * 保留字节重新锚起——留着旧文本会把同一段输出接两遍。
   */
  const closeRow = (jobId: string) => {
    setExpanded(undefined);
    dispatch({ type: "ui/jobClose", jobId });
    post({ type: "unobserveJob", jobId });
  };

  const toggleRow = (job: JobItemView) => {
    if (expanded === job.id) {
      closeRow(job.id);
      return;
    }
    if (expanded !== undefined) closeRow(expanded);
    const watchId = (watchSeq.current += 1);
    setExpanded(job.id);
    // 代号先进状态、再发请求：宿主回带的帧要能立刻对上号（见 `jobObserve.ts`）
    dispatch({ type: "ui/jobObserve", jobId: job.id, watchId });
    post({ type: "observeJob", jobId: job.id, watchId });
  };

  // 展开的那一行没了（任务被属主回收、或整份名册换了会话）：这条观察已经没有意义，
  // 照着收起处理（官方那条「展开行离开列表就折起面板」的 effect 同口径）
  useEffect(() => {
    if (expanded === undefined) return;
    if (jobs.some((job) => job.id === expanded)) return;
    closeRow(expanded);
  }, [jobs, expanded]);

  // 关面板 / 关窗口：把观察流交给宿主收掉，界面这份累积也一起清掉——留着它就是
  // 一段没人会渲染的文本（最多 128K），面板开着时才有意义
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(
    () => () => {
      if (expandedRef.current === undefined) return;
      dispatch({ type: "ui/jobClose", jobId: expandedRef.current });
      post({ type: "unobserveJob", jobId: expandedRef.current });
    },
    [],
  );

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
  const sorted = useMemo(
    () => [...jobs].filter((job) => !isSubagentJob(job)).sort(compareJobs),
    [jobs],
  );
  const liveCount = sorted.filter(isLiveJob).length;
  useEffect(() => {
    if (liveCount === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [liveCount]);

  return (
    <Drawer title={texts.jobs} icon={<IconJobs size={14} />} onClose={onClose}>
      {sorted.length === 0 ? (
        <div className="popover-empty">{texts.jobsEmpty}</div>
      ) : (
        sorted.map((job) => {
          const observable = isObservableJob(job);
          const open = expanded === job.id;
          // 生产者的实时进度优先于终态原因（官方 `jobDetail`）：在跑的行看进度，
          // 收场的行看 `detail`（`progress` 那时服务端自己清空了，不会两个都在）
          const qualifier = job.progress ?? job.detail;
          const output = outputs?.[job.id];
          const head = (
            <>
              <span className={`dot ${JOB_TONE[job.status] ?? ""}`} />
              <span className="job-label" title={job.label}>
                {job.label}
              </span>
              <span className="job-kind">{job.kind}</span>
            </>
          );
          return (
            <div key={job.id} className="job-row">
              <div className="job-head">
                {/* 可观察的行才可点：不能展开的行给普通 span，不做一个点了没反应的按钮 */}
                {observable ? (
                  <button
                    type="button"
                    className="job-row-toggle"
                    aria-expanded={open}
                    aria-label={
                      open ? texts.jobCollapseAria(job.label) : texts.jobExpandAria(job.label)
                    }
                    onClick={() => toggleRow(job)}
                  >
                    {head}
                    <IconChevronDown size={12} className={`job-chevron${open ? " is-open" : ""}`} />
                  </button>
                ) : (
                  <span className="job-row-toggle is-static">{head}</span>
                )}
                <JobStopButton job={job} phase={killPhase} onPress={pressStop} />
              </div>
              <div className="job-meta">
                {label[job.status] ?? (job.status === "unknown" ? texts.jobUnknown : job.status)}
                {" · "}
                {formatClock(job.startedAt)}
                {job.finishedAt
                  ? ` · ${formatDuration(job.finishedAt - job.startedAt)}`
                  : ` · ${formatDuration(now - job.startedAt)}`}
              </div>
              {qualifier ? <div className="job-detail">{qualifier}</div> : null}
              {open ? <JobOutputPanel job={job} output={output} /> : null}
            </div>
          );
        })
      )}
    </Drawer>
  );
}

/**
 * 展开区：提示条 + 命令头（可复制）+ 输出正文。
 *
 * 三段各自的判据都来自同一条累积状态（见 `webview/jobObserve.ts`）：
 * - `gapBefore` → 「较早的输出已丢弃」（**不是**「无输出」：这是「有，但开头没了」）；
 * - `error` → 终态失败（`null` = 宿主没能开流，用概括文案；字符串 = 原样报错）；
 * - 正文为空 → 「无输出」占位（一个真的什么都没打的命令，与「还没收到帧」由
 *   `opened` 分开：锚点没到之前整块不画，免得闪一下假的「无输出」）。
 *
 * 复制按钮复制的是**任务标签**（官方 `copyText={job.label}`），不是输出正文。
 */
function JobOutputPanel({ job, output }: { job: JobItemView; output?: JobObserved }) {
  const texts = useTexts();
  if (!output) return null;
  const body = output.opened || output.error !== undefined;
  if (!body) return null;
  const empty = output.text.trim() === "";
  return (
    <div className="job-panel">
      {output.gapBefore ? <div className="job-notice">{texts.jobOutputGap}</div> : null}
      {output.error !== undefined ? (
        <div className="job-notice is-error">
          {output.error === null ? texts.jobOutputUnavailable : texts.jobOutputError(output.error)}
        </div>
      ) : null}
      <div className="job-panel-head">
        <span className="job-panel-command" title={job.label}>
          {job.label}
        </span>
        <CopyButton text={job.label} />
      </div>
      {empty ? (
        <div className="job-output is-empty">{texts.terminalNoOutput}</div>
      ) : (
        <div className="job-output">{output.text}</div>
      )}
    </div>
  );
}

/**
 * 任务排序（官方 `dsh-client-ui-jobs/lib/client.js` 的 `ordered()` 同口径）：
 * 1. live（`running` / `stopping`）在前，按 `startedAt` **升序**（先开跑的排上面）；
 * 2. settled 在后，按 `finishedAt` **降序**；没有 `finishedAt` 的按开始时间兜底。
 *
 * 实现在 `webview/jobsOrder.ts`（纯函数，`scripts/jobsOrder.test.ts` 直接钉住）。
 */
