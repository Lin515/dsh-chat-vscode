/**
 * 轨迹检查器里「自动换行」开关的持久化与初始值口径。
 *
 * 官方那份是 `@deepseek-ai/dsh-client-store` 的 `createSnapshotStore(false, {persist:
 * {name: 'dsh.trajectory.jsonStringWrapping'}})`（`ui-trajectory/src/client/string-wrapping-store.ts`），
 * 我们把它按同一套语义落成 `localStorage`——与「时长」开关
 * （`Trajectory.tsx` 的 `DURATION_PREFERENCE_KEY`）同样是**跨会话共享的浏览器级偏好**，
 * 只是这里的宿主是 webview 的 origin。
 *
 * 两条口径照抄官方（`JsonTree.tsx` / `ProgramInput`）：
 * 1. 偏好是**展开/渲染时采样一次的默认值**，不是持续同步的全局状态——同一时刻两个
 *    已渲染的段落可以各是各的（官方每个 `ProgramInput` 各自 `useState(initialWrapped)`，
 *    拖动开关时只把新值写回默认）；
 * 2. **只有用户拨开关才写**：渲染本身不落盘，否则打开一次轨迹页就会把用户的偏好
 *    改成当前默认值。
 */

/** 偏好的落盘键（与官方 store 名一致：`dsh.trajectory.` 前缀 + 驼峰项名）。 */
const WRAP_PREFERENCE_KEY = "dsh.trajectory.jsonStringWrapping";

/**
 * 开关拨到下一档（纯决策：`next = !value`，拨完还要把它写成新默认）。
 *
 * 抽成纯函数是因为这条判据值得离线钉住，而组件里的 `useState` 更新函数在无 DOM
 * 的测试环境里跑不起来（见 `scripts/trajectoryPre.test.ts`）。
 */
export function toggleWrap(value: boolean): boolean {
  return !value;
}

/**
 * 读全局默认：**默认不换行**——官方 JSON 树打底是 `white-space: pre`
 * （`ui-primitives/src/JsonTree.module.css` 的 `.stringRaw`），只有 `[data-wrap='true']`
 * 才切 `pre-wrap` + `break-all`。我们的 `.trajectory-pre` 需要横向滚动来看清参数 /
 * Schema 的缩进结构，所以「不换行」才是与官方一致的默认。
 *
 * 存储不可用（隐私模式 / 被禁用）或没存过都回落到 `false`。
 */
export function readWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(WRAP_PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写全局默认（写失败就算了，偏好不是功能）。 */
export function writeWrapPreference(wrapped: boolean): void {
  try {
    window.localStorage.setItem(WRAP_PREFERENCE_KEY, wrapped ? "1" : "0");
  } catch {
    // 同上
  }
}
