/**
 * 一条后台任务实时输出的**累积口径** —— 纯函数，离线可断言。
 *
 * 对应官方客户端 `dsh-api-job-controller/lib/client.js` 的 `ClientJobsModel`
 * （`observeOpened` / `observeOutput` / `observeFailed`）逐条对齐，只把「续传游标」
 * 从界面挪到宿主：断开重连由宿主用上一帧的 `next` 重开流，界面只管把收到的字节
 * 接在后面——所以这里的 `opened` **不清空已有文本**（重连后的锚点帧会接着来）。
 *
 * 三条纪律：
 *
 * 1. **只认自己这一轮**：观察代号（`watchId`）由界面铸造、宿主原样回带。收起再点开
 *    会换一个新号，旧流还在路上的残余帧因为对不上号被丢掉——否则那几帧会被接在
 *    新一轮的开头（同一段输出前后错位，看起来像任务打了两遍）。
 * 2. **没有条目就不新建**：帧永远不该让界面上冒出一个没人展开的条目（那是内存泄漏，
 *    也是「关掉面板后还有东西在长」的来源）。
 * 3. **截断要留痕**：累积文本超过 {@link JOB_RENDER_TAIL_LIMIT} 时从头截掉，并把
 *    `gapBefore` 置起——截断和「服务端淘汰了开头」对读者是同一件事：**前面的没了**。
 *    截断点落在代理对中间时往后挪一位，不切出半个字符（代理对切开在界面上就是乱码方块）。
 */
import type { HostToWebview } from "../shared/ipc";

/** 一条观察在界面里最多留多少 UTF-16 code unit（官方 `RENDER_TAIL_LIMIT`）。 */
export const JOB_RENDER_TAIL_LIMIT = 128 * 1024;

/** 界面侧的一条观察状态。 */
export interface JobObserved {
  /** 界面铸造的观察代号（宿主回带的帧只有对上它才被采纳）。 */
  watchId: number;
  /**
   * 锚点帧（`jobs/opened`）到了没有。
   *
   * 它只用来决定**画不画展开体**：点开到第一帧回来之间是一个往返回合，那段时间
   * 画一个空输出框就是一闪而过的「无输出」假信号（官方同样只在锚点到达后才渲染面板）。
   */
  opened: boolean;
  /** 已累积的输出尾部（上限见 {@link JOB_RENDER_TAIL_LIMIT}）。 */
  text: string;
  /**
   * `text` 之前丢过字节（服务端淘汰了环头、续传有洞、或命中上面的截断上限）。
   *
   * 与 `text === ""` 是两件事：空文本 + `gapBefore` 表示「有输出，但能看到的那部分
   * 之前已经没了」——界面据此给提示，而不是显示成「无输出」。
   */
  gapBefore: boolean;
  /**
   * 终态失败。
   *
   * - 缺席 = 没失败；
   * - `null` = 宿主**没能开流**（没连接 / 没有绑定会话），界面用一句概括文案；
   * - 字符串 = 服务端 / 传输层的原样报错，界面套模板显示、不翻译。
   */
  error?: string | null;
}

type OpenedFrame = Extract<HostToWebview, { type: "jobs/opened" }>;
type OutputFrame = Extract<HostToWebview, { type: "jobs/output" }>;
type FailedFrame = Extract<HostToWebview, { type: "jobs/observeFailed" }>;

/** 点开一行：造一个空条目（等锚点帧来决定画什么）。 */
export function jobObserveStart(watchId: number): JobObserved {
  return { watchId, opened: false, text: "", gapBefore: false };
}

/**
 * 锚点帧：定下这一轮的起点，并判「要看的开头是不是已经被淘汰」。
 *
 * 两种情形都算丢过前面：锚点偏移落在环里最旧字节**之前**（`from < earliest`），
 * 或者第一次观察就直接锚在非零偏移上（`from > 0` 且手上还没有文本 = 环头早在
 * 打开之前就被淘汰了）。
 */
export function applyObservedOpened(
  prev: JobObserved | undefined,
  frame: OpenedFrame,
): JobObserved | undefined {
  if (!prev || prev.watchId !== frame.watchId) return undefined;
  const freshPastHead = prev.text === "" && frame.from > 0;
  return {
    ...prev,
    opened: true,
    gapBefore: prev.gapBefore || frame.from < frame.earliest || freshPastHead,
  };
}

/** 一段输出：接在尾部，超限从头截断（见模块注释第 3 条）。 */
export function applyObservedOutput(
  prev: JobObserved | undefined,
  frame: OutputFrame,
): JobObserved | undefined {
  if (!prev || prev.watchId !== frame.watchId) return undefined;
  let text = prev.text + frame.text;
  let gapBefore = prev.gapBefore || frame.gapBefore;
  if (text.length > JOB_RENDER_TAIL_LIMIT) {
    let cut = text.length - JOB_RENDER_TAIL_LIMIT;
    // 截断点落在低位代理上：往后挪一位，别把一对切开
    const unit = text.charCodeAt(cut);
    if (unit >= 0xdc00 && unit <= 0xdfff) cut += 1;
    text = text.slice(cut);
    gapBefore = true;
  }
  return { ...prev, text, gapBefore };
}

/** 终态失败：文本留着（已经看到的部分不该因为流断了就消失），只记下失败。 */
export function applyObservedFailed(
  prev: JobObserved | undefined,
  frame: FailedFrame,
): JobObserved | undefined {
  if (!prev || prev.watchId !== frame.watchId) return undefined;
  return { ...prev, error: frame.detail ?? null };
}
