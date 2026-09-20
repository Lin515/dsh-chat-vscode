/**
 * 改动文件清单（`workspace/changes`）的**形状校验**。
 *
 * 清单来自 Host 的认证路由 `GET /api/changes.summary?sessionId&seq`，它的形状是
 * `dsh-client-ui-deliverables` 的 `ChangesSummary`（Host 侧把 `cwd` 与快照 id
 * 留下不发，见 `handleChangesSummary`）。服务端给的值一律不可信，所以这里逐字段
 * 验形状，**验不过就整份丢弃**（界面因此不显示卡片，退回「本轮改动」文件行）——
 * 半个卡片比没有卡片更误导。
 *
 * 为什么单独成模块：这是纯函数，可离线断言（`scripts/changesCard.test.ts`），
 * 不必起真实 Host。
 */
import type { ChangedFileView, ChangesSummaryView } from "../shared/chat";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 一条改动文件记录是否合规。
 *
 * `added` / `deleted` 必须是**非负安全整数**：它们是渲染的行数，负值或 `NaN`
 * 会在界面上印出 `+-3` 这种东西；`binary` / `oversized` 只接受 `true` 或缺省
 * （Host 只在这两种情况下带它们，带 `false` 说明对方不是这个协议的实现）。
 */
export function isChangedFile(value: unknown): value is ChangedFileView {
  if (!isRecord(value)) return false;
  const { path, display, added, deleted, binary, oversized } = value;
  return (
    typeof path === "string" &&
    path.length > 0 &&
    typeof display === "string" &&
    display.length > 0 &&
    Number.isSafeInteger(added) &&
    (added as number) >= 0 &&
    Number.isSafeInteger(deleted) &&
    (deleted as number) >= 0 &&
    (binary === undefined || binary === true) &&
    (oversized === undefined || oversized === true)
  );
}

/**
 * 把路由回来的 JSON 解成清单；形状不对（或压根不是对象）返回 `null`。
 *
 * 返回 `null` 的语义与「Host 答 404」一致：**没有可显示的卡片**。调用方不需要
 * 区分「Host 说没有」与「对方发了个看不懂的东西」——两者都只能不显示。
 */
export function decodeChangesSummary(raw: unknown): ChangesSummaryView | null {
  if (!isRecord(raw)) return null;
  const { turn, files, total, added, deleted } = raw;
  if (!Number.isSafeInteger(turn) || (turn as number) < 1) return null;
  if (!Number.isSafeInteger(total) || (total as number) < 0) return null;
  if (!Number.isSafeInteger(added) || (added as number) < 0) return null;
  if (!Number.isSafeInteger(deleted) || (deleted as number) < 0) return null;
  if (!Array.isArray(files) || !files.every(isChangedFile)) return null;
  return {
    turn: turn as number,
    files: files as ChangedFileView[],
    total: total as number,
    added: added as number,
    deleted: deleted as number,
  };
}
