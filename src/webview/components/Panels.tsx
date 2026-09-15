import type { JobItemView, SubagentView } from "../../shared/chat";
import { IconAgents, IconChevronLeft, IconClose, IconJobs } from "../icons";
import { formatClock, formatDuration } from "./primitives";
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
}: {
  title: string;
  icon: JSX.Element;
  onClose: () => void;
  children: React.ReactNode;
  onBack?: () => void;
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
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
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
              <span className={`dot ${entry.activity === "running" ? "dot-running" : ""}`} />
              {entry.activity === "running" ? texts.jobRunning : texts.subagentInactive}
            </span>
          </button>
        ))
      )}
    </Drawer>
  );
}

/** 单个子代理的对话记录（只读查看）。 */
export function SubagentTranscriptPanel({
  id,
  messages,
  onClose,
  onBack,
}: {
  id: string;
  messages: import("../../shared/chat").MessageView[];
  onClose: () => void;
  onBack: () => void;
}) {
  const texts = useTexts();
  return (
    <Drawer title={id} icon={<IconAgents size={14} />} onClose={onClose} onBack={onBack}>
      {messages.length === 0 ? (
        <div className="popover-empty">{texts.subagentsEmpty}</div>
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
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

/** 后台任务面板：bash / pwsh / 子代理等，来自 session/control 的 jobs 帧。 */
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
