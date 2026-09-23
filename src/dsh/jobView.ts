/**
 * 后台任务名册（`job/list` 流）的形状解析 —— 纯函数，离线可断言。
 *
 * 抽出来的理由与 `projections.ts` 相同：形状读错在界面上表现为「这个功能没有」，
 * 而不是报错。0.1.7-alpha.1 把 job 从 `session/control` 的帧搬到了
 * `dsh-api-job-controller` 的 `job/list` 流，**两代的帧形状不一样**：
 *
 * - 新（`JobListFrame`）：`{type:'rows', jobs: JobView[]}`，整表替换；
 * - 旧（`SessionControlBaseline.jobs` / `{type:'jobs', jobs}`）：直接就是 `SessionJob[]`。
 *
 * 控制器只在这两个入口调用读取器，判断与兜底都在这里，于是「哪种帧算名册」这件事
 * 有唯一的落点，也钉得住「认不出就不动手」这条纪律。
 */
import type { JobItemView } from "../shared/chat";
import type { JobListFrameWire, JobViewWire } from "./protocol";

/**
 * `job/list` 的一帧 → 名册数组；**认不出返回 `undefined`**。
 *
 * `undefined` 与 `[]` 是两回事：前者是「这帧不是名册」（丢掉，不动现有列表），
 * 后者是「名册是空的」（清空面板）。把未知帧或**坏帧**当空名册用会让面板凭空清空，
 * 而「协议里冒出了新帧类型 / 这一帧没带数组」都不等于「没有后台任务」。
 */
export function jobRowsFromFrame(frame: unknown): unknown[] | undefined {
  const value = frame as JobListFrameWire | null | undefined;
  if (value?.type !== "rows") return undefined;
  return Array.isArray(value.jobs) ? value.jobs : undefined;
}

/**
 * 线格式的一条任务 → 视图模型（`JobView`；旧的 `SessionJob` 同形子集）。
 *
 * - 状态**原样保留**（含服务端将来新增的取值）：以前这里把词表外的状态兜底成
 *   `"completed"`，等于对未知状态给出「已完成」这个肯定结论——正是 AGENTS.md
 *   禁止的「按否定证据下结论」。界面按查表渲染，查不到就原样显示、不猜色调；
 * - `id` 是承重字段（面板的行键、停止按钮的目标）：没有它的整条丢弃，
 *   而不是编一个 id 出来。
 */
export function jobItemsFromWire(jobs: unknown): JobItemView[] {
  const list = Array.isArray(jobs) ? jobs : [];
  const items: JobItemView[] = [];
  for (const job of list) {
    const item = job as JobViewWire | null;
    if (typeof item?.id !== "string" || !item.id) continue;
    items.push({
      id: item.id,
      kind: typeof item.kind === "string" && item.kind ? item.kind : "job",
      label: typeof item.label === "string" && item.label ? item.label : item.id,
      status: typeof item.status === "string" && item.status ? item.status : "unknown",
      detail: typeof item.detail === "string" ? item.detail : undefined,
      startedAt: typeof item.startedAt === "number" ? item.startedAt : Date.now(),
      finishedAt: typeof item.finishedAt === "number" ? item.finishedAt : undefined,
    });
  }
  return items;
}
