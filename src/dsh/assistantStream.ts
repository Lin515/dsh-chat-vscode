import type { StreamChunk } from "./protocol";

/**
 * 跟随开帧里那条**紧凑记录流**的展开（官方 `expandAssistantStream` 的等价实现）。
 *
 * 为什么要它：服务端为「已经在跑的 attempt」重开 follow 时**不会重发 `start` 帧与
 * 逐条增量**，进行中的内容全在开帧的 `assistantStream.activeAttempt` 里——一份打包过的
 * 记录（`text-chunks` / `reasoning-chunks` / `tool-call-chunks` / 原样 `chunk`）
 * 加一个 `nextIndex`（已发过的增量条数）。要把中途挂上时那个正在长的节点重建回原样，
 * 就得先把它展开回原始的 timed chunk 序列（官方 Web 端走的也是这一步：
 * `ClientAssistantStream.replace` → `expandAssistantStream`）。
 *
 * 服务端给的值不可信：形状不合的记录**跳过**，坏掉的间隔按 0 计——少画一段好过
 * 让整份基线失效（内核加新记录类型时这条尤其要紧）。
 */
export interface TimedStreamChunk {
  time: number;
  chunk: StreamChunk;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 有限数才算数：时间戳来自服务端，坏值会把整条流的时间轴带偏（TTFT / 解码窗口）。 */
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** 认得出是个 chunk 就行（具体类型由消费处的 switch 兜）。 */
const isChunk = (value: unknown): value is StreamChunk =>
  isRecord(value) && typeof value.type === "string";

/**
 * 这个 chunk 是不是「首 token」的候选：`text-delta` / `reasoning-delta` 帧。
 *
 * **判据与实时流一致**（见 `adapter.applyAssistantStream` 的 `stepFirstTokenAt`）：
 * 只看帧类型，**不看文本是不是空**。空文本帧在真实日志里确实存在（只带推理签名、
 * 一个字的思考正文都没有），实时侧照样把它算作首个 token 的时刻。
 *
 * 与 `trajectory.ts` 的 `streamFirstTokenTime()` **刻意不同**：那一套按官方口径跳过
 * 空片段，用于轨迹账本展示；这里的用途是**复原轮尾速度与 TTFT**，必须与实时侧
 * 折出同一个毫秒数，否则重载前后同一个数字会差几毫秒。
 */
function isFirstTokenChunk(chunk: StreamChunk): boolean {
  return chunk.type === "text-delta" || chunk.type === "reasoning-delta";
}

/**
 * 展开成 timed chunk 序列（顺序与原始增量边界逐一对应）。
 *
 * @param stream - 开帧基线里的 `activeAttempt.stream`（形状不可信，逐条校验）。
 * @returns 展开后的增量；认不出的记录被跳过，不会抛。
 */
export function expandAssistantStream(stream: unknown): TimedStreamChunk[] {
  if (!Array.isArray(stream)) return [];
  const chunks: TimedStreamChunk[] = [];
  for (const raw of stream) {
    if (!isRecord(raw)) continue;
    if (raw.type === "chunk") {
      const time = finite(raw.time);
      if (time === undefined || !isChunk(raw.chunk)) continue;
      chunks.push({ time, chunk: raw.chunk });
      continue;
    }
    const type = raw.type;
    if (type !== "text-chunks" && type !== "reasoning-chunks" && type !== "tool-call-chunks") {
      continue;
    }
    const time0 = finite(raw.time0);
    const index = finite(raw.index);
    if (time0 === undefined || index === undefined) continue;
    const gaps = Array.isArray(raw.dt) ? raw.dt : [];
    const members = type === "tool-call-chunks" ? raw.args : raw.texts;
    if (!Array.isArray(members)) continue;
    // 工具名是可选的（官方 `name?: ToolCallId` 的存在性也参与打包判等，这里只照抄）
    const name = type === "tool-call-chunks" && typeof raw.name === "string" ? raw.name : undefined;
    const id = type === "tool-call-chunks" ? raw.id : undefined;
    if (type === "tool-call-chunks" && typeof id !== "string") continue;

    let time = time0;
    for (let position = 0; position < members.length; position += 1) {
      // 第 0 个成员的时刻就是 `time0`；其后每个成员的时刻是前一个加上它前面的间隔
      // （`dt[i]` = 第 i 个成员到第 i+1 个成员的间隔，官方 `expandAssistantStream` 同义）
      if (position > 0) time += finite(gaps[position - 1]) ?? 0;
      const member = members[position];
      if (typeof member !== "string") continue;
      if (type === "text-chunks") {
        chunks.push({ time, chunk: { type: "text-delta", index, text: member } });
      } else if (type === "reasoning-chunks") {
        chunks.push({ time, chunk: { type: "reasoning-delta", index, text: member } });
      } else {
        chunks.push({
          time,
          chunk: {
            type: "tool-call-delta",
            index,
            id: id as string,
            ...(name === undefined ? {} : { name }),
            argumentsDelta: member,
          },
        });
      }
    }
  }
  return chunks;
}

/**
 * 一份 `data.stream` 里首个 token 的时刻（**复原轮尾速度与 TTFT 用**）。
 *
 * 口径与实时流逐字一致：第一个 `text-delta` / `reasoning-delta` 帧的时刻，
 * 空文本也算（见 `isFirstTokenChunk`）。取不到就是 `undefined`。
 *
 * 为什么要它：轮尾的速度与 TTFT 原本只在**实时 chunk 帧**上累加，那份累加器在
 * 扩展内存里，重载窗口后就没了——于是同一个会话重载前有速度、重载后只剩用时。
 * 而 durable 的 `assistant/message` 自带 `data.stream`，里面的时刻是**无损**的
 * （服务端打包时按 `previous + gap === next` 校验才合并，见 DSH 的
 * `AssistantStreamAccumulator.push`），所以能从它把同一个数算回来。
 *
 * @param stream - `assistant/message` 的 `data.stream`（形状不可信，逐条校验）。
 */
export function assistantStreamFirstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined;
  for (const raw of stream) {
    if (!isRecord(raw)) continue;
    if (raw.type === "chunk") {
      // 裸 chunk 记录自带时刻；类型不合就跳过（与展开逻辑同一套校验）
      const time = finite(raw.time);
      if (time !== undefined && isChunk(raw.chunk) && isFirstTokenChunk(raw.chunk)) return time;
      continue;
    }
    // 打包 run：首个成员的时刻就是 `time0`，不必累加 `dt`。
    // 第一个成员即使是空片段也算——实时侧看到的就是这一帧（见 `isFirstTokenChunk`）。
    // 成员为空数组时这一条流里没有 token 帧，不能拿 `time0` 冒充。
    if (raw.type === "text-chunks" || raw.type === "reasoning-chunks") {
      const time0 = finite(raw.time0);
      const members = raw.texts;
      if (time0 !== undefined && Array.isArray(members) && members.length > 0) return time0;
    }
  }
  return undefined;
}

