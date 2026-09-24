/**
 * 后台任务停止按钮的两段式状态机（纯函数，便于离线断言）。
 *
 * 口径照官方 `dsh-client-ui-jobs/lib/client.js` 的 `pressKill` 与配套 effects：
 * 一条 `running` 的行挂一枚停止按钮，**点两下才真的发**——第一下进入
 * `armed`（按钮亮出「确认停止」，几秒不确认就自己退回去），第二下进入
 * `pending`（禁用）并发请求。请求没被受理时进 `failed`（亮一小段
 * 「停止失败」后复位）；被受理时**停在 `pending`**，等名册帧把行推成
 * `stopping` / `killed`（不再 `running`）才整个收场。
 *
 * 抽成纯函数的理由与 `jobsOrder.ts` 相同：这套状态流转错了，轻则「点一下就停」
 * （误触），重则按钮永远卡在「请求中」（没有别的信号能解）。
 */
import type { JobItemView } from "../shared/chat";

/** 停止按钮的瞬时状态：`armed` 待确认、`pending` 请求中、`failed` 上次请求没受理。 */
export type KillPhaseState = "armed" | "pending" | "failed";

export interface KillPhase {
  /** 目标任务的 id（面板里同一时刻只跟踪一枚按钮）。 */
  key: string;
  state: KillPhaseState;
}

/** `armed` 等确认的时长（官方 `KILL_ARM_MS`）。 */
export const KILL_ARM_MS = 3_000;
/** `failed` 提示的停留时长（官方 `KILL_FAILED_MS`）。 */
export const KILL_FAILED_MS = 4_000;

/** 一次按压 → 下一个状态：对同一行**第二次**按压（且还在 `armed`）才发请求。 */
export function pressKill(phase: KillPhase | undefined, key: string): KillPhase {
  if (phase?.key !== key || phase.state !== "armed") return { key, state: "armed" };
  return { key, state: "pending" };
}

/**
 * 需要自动复位的档位与各自的停留时长：`armed` 超时当作没点过、`failed` 亮完即复位；
 * `pending` **不复位**——受理的请求要等名册把行推离 `running` 才收场（见 `phaseLive`）。
 */
export function autoResetMs(state: KillPhaseState): number | undefined {
  if (state === "armed") return KILL_ARM_MS;
  if (state === "failed") return KILL_FAILED_MS;
  return undefined;
}

/**
 * 宿主的结算帧（`jobs/killResult`）落到当前状态上：
 * 只有「这一行的 `pending`」会消费它——没受理进 `failed`；受理了**维持** `pending`，
 * 行的收场交给名册。别的行 / 别的档位的结算一概与当前状态无关。
 */
export function killSettled(
  phase: KillPhase | undefined,
  jobId: string,
  ok: boolean,
): KillPhase | undefined {
  if (!phase || phase.key !== jobId || phase.state !== "pending") return phase;
  return ok ? phase : { key: phase.key, state: "failed" };
}

/**
 * 名册更新时的存续判定：目标行**不再 `running`**（已推成 `stopping` / `killed`，
 * 或整行没了）→ 状态作废；行还在跑 → 原样保留。官方对应那条 rows effect
 * （「killPhase 指的行不再是 running 就清掉」），是 `pending` 唯一的成功收场路径。
 */
export function phaseLive(
  phase: KillPhase | undefined,
  jobs: readonly JobItemView[],
): KillPhase | undefined {
  if (!phase) return undefined;
  const job = jobs.find((item) => item.id === phase.key);
  return job?.status === "running" ? phase : undefined;
}
