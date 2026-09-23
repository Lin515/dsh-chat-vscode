import { useLayoutEffect, useRef } from "react";
import type { JobItemView, SubagentView } from "../../shared/chat";
import { IconAgents, IconChevronLeft, IconClose, IconJobs } from "../icons";
import { formatClock, formatDuration, Spinner } from "./primitives";
import { compareJobs } from "../jobsOrder";
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

/** 后台任务面板：bash / pwsh / 子代理等，来自 `job/list` 流（旧服务端是 `session/control` 的 jobs 帧）。 */
export function JobsPanel({ jobs, onClose }: { jobs: JobItemView[]; onClose: () => void }) {
  const texts = useTexts();
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
  const sorted = [...jobs].sort(compareJobs);

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
