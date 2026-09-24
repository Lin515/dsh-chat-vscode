/**
 * 后台任务的线格式读取 —— 纯函数，离线可断言。
 *
 * 抽出来的理由与 `projections.ts` 相同：形状读错在界面上表现为「这个功能没有」，
 * 而不是报错。0.1.7-alpha.1 把 job 从 `session/control` 的帧搬到了
 * `dsh-api-job-controller` 的 `job` 命名空间，**两代的帧形状不一样**：
 *
 * - 新（`JobListFrame`）：`{type:'rows', jobs: JobView[]}`，整表替换；
 * - 旧（`SessionControlBaseline.jobs` / `{type:'jobs', jobs}`）：直接就是 `SessionJob[]`。
 *
 * 同一个 `job` 命名空间下还有**单任务的保留输出**（`job/follow`）：`opened` 锚点、
 * 合并过的 `output` 批次、收场后的 `status`。两条流的形状读取都在这里——它们是
 * 同一份 `JobView` 契约的两个投影面，读法（哪些字段缺了就不动手）也该在一处。
 *
 * 控制器只在这些入口调用读取器，判断与兜底都在这里，于是「哪种帧算数」这件事
 * 有唯一的落点，也钉得住「认不出就不动手」这条纪律。
 */
import type { JobItemView } from "../shared/chat";
import type {
  JobChunkWire,
  JobFollowOpenedWire,
  JobFollowOutputWire,
  JobListFrameWire,
  JobViewWire,
} from "./protocol";

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
 * 输出环坐标（`JobView.output`）：**两个数都在才算**。
 *
 * 它们是一对（`total` 与 `earliest` 同时由注册表给出），缺任何一个都不是
 * 「输出是空的」而是「这一帧没按契约带坐标」——那种情况下宁可不可展开，
 * 也不编一个 0 出来（编出来会让一个真写过输出的行看起来没有输出）。
 */
function jobOutputFromWire(value: unknown): { total: number; earliest: number } | undefined {
  const raw = value as { total?: unknown; earliest?: unknown } | null | undefined;
  if (raw === null || typeof raw !== "object") return undefined;
  if (typeof raw.total !== "number" || typeof raw.earliest !== "number") return undefined;
  return { total: raw.total, earliest: raw.earliest };
}

/**
 * 线格式的一条任务 → 视图模型（`JobView`；旧的 `SessionJob` 同形子集）。
 *
 * - 状态**原样保留**（含服务端将来新增的取值）：以前这里把词表外的状态兜底成
 *   `"completed"`，等于对未知状态给出「已完成」这个肯定结论——正是 AGENTS.md
 *   禁止的「按否定证据下结论」。界面按查表渲染，查不到就原样显示、不猜色调；
 * - `id` 是承重字段（面板的行键、停止按钮与观察流的目标）：没有它的整条丢弃，
 *   而不是编一个 id 出来；
 * - `output` 读不出坐标时留 `undefined`（面板因此不给展开入口，见 `JobItemView`）。
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
      progress: typeof item.progress === "string" && item.progress ? item.progress : undefined,
      output: jobOutputFromWire(item.output),
      detail: typeof item.detail === "string" ? item.detail : undefined,
      startedAt: typeof item.startedAt === "number" ? item.startedAt : Date.now(),
      finishedAt: typeof item.finishedAt === "number" ? item.finishedAt : undefined,
    });
  }
  return items;
}

/**
 * `job/follow` 的一帧 → 宿主内部用的规范形状；**认不出返回 `undefined`**。
 *
 * 宿主只把这三件事交给界面：开了（还欠不欠字节）、来了一段输出、终态。
 * 于是这里把服务端的帧折成：
 *
 * - `opened`：`from`（第一条输出帧的起点）与 `earliest`（环里最旧的保留字节）。
 *   两者缺一即整帧丢掉——半个锚点算不出「开头是不是已经被淘汰」，而猜出来的
 *   gap 提示会把一段完整输出说成残缺；
 * - `output`：`chunks` 的正文拼成一整段（频道是模型消费面的事，观察流不区分），
 *   并把 `frame.lossy` 与任一 `chunk.gapBefore` **折算成一个 `gapBefore`**：
 *   界面只关心「这段之前是不是丢过字节」，两处标记的来由对用户是同一件事；
 * - `status`：终态。名册行自己会变成收场态，这一帧在宿主侧只用来收尾（流随即
 *   正常结束），所以不带负载。
 */
export type JobFollowFrameView =
  | { kind: "opened"; from: number; earliest: number }
  | { kind: "output"; text: string; next: number; gapBefore: boolean }
  | { kind: "status" };

export function jobFollowFrameFromWire(value: unknown): JobFollowFrameView | undefined {
  const frame = value as (JobFollowOpenedWire & JobFollowOutputWire) | null | undefined;
  if (frame === null || typeof frame !== "object") return undefined;
  if (frame.type === "opened") {
    const from = frame.from;
    const earliest = jobOutputFromWire(frame.job?.output)?.earliest;
    if (typeof from !== "number" || typeof earliest !== "number") return undefined;
    return { kind: "opened", from, earliest };
  }
  if (frame.type === "output") {
    if (!Array.isArray(frame.chunks) || typeof frame.next !== "number") return undefined;
    const chunks = frame.chunks as (JobChunkWire | null)[];
    let text = "";
    let gapBefore = frame.lossy === true;
    for (const chunk of chunks) {
      if (typeof chunk?.text === "string") text += chunk.text;
      if (chunk?.gapBefore === true) gapBefore = true;
    }
    return { kind: "output", text, next: frame.next, gapBefore };
  }
  if (frame.type === "status") return { kind: "status" };
  return undefined;
}
