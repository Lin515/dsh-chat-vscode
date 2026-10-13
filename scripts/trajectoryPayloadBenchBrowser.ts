/**
 * 【脚本定位】工具型 · 零 token · **浏览器整链路工件** —— 真浏览器里的 M06 量测支撑。
 *
 * 它负责四件事（都不读用户日志、不起 DSH、不花 token）：
 *
 * 1. `emitBrowserArtifacts()`：把**已通过资格闸门**（与 Node 量测**同一套**判据）的夹具、
 *    生产样式的**同字节副本**、离线主题桥、自包含页面与 runner 写到目标目录。
 *    所有输入在**第一次写盘之前**全部检查完；任何拒绝 → 零工件。
 * 2. `bundleBrowserRunner()`：用 esbuild API 现场打包 runner —— 入口 import 经 `onResolve`
 *    指回**仓库当前生产源码**；同时用记录型 `onLoad` 在**内存里**给生产组件折入私有打点
 *    （磁盘字节一个都不改），并留下「原字节 / 转换后字节 / 锚点命中数」见证。
 * 3. `serveBrowserArtifacts()`：零依赖静态服务器（只服务目标目录、绑 `127.0.0.1`、
 *    **等 listening 之后再公布真实端口**；绑不上就抛出可判定的失败）。
 * 4. 页面 runner：在真浏览器里量真实收帧字节 / 首次装载 / 同模型对象 refresh / 真实连续滚动，
 *    并把结果写成带 `status` / `success` / `exitCode` 的结构，供父级工具断言。
 *
 * ## 浏览器阶段量了什么（不许与 Node 阶段混读）
 *
 * - **真实**：`{type:"trajectory", json}` 形状的 JSON 字符串帧解析、生产 `TrajectoryView`
 *   的首次装载与 refresh（真实 React commit）、真实账本容器的连续滚动窗口 / 垫行 / 帧间隔、
 *   rAF 帧健康采样。
 * - **组件内部归因**（私有 onLoad 打点，本次已实现）：`view.timeline` / `view.vendorTurns` /
 *   `view.ledgerRows` / `view.allRows` / `view.commitLayoutEffect` / `vendor.searchIndex.update`
 *   ——这些是**组件自己那次调用**的读数。每个锚点必须**恰好命中一次**：缺命中或多命中
 *   直接让 emit 失败（打点没折进去的 bundle 不许被当成「已归因」）。
 * - **对照（control）**：harness 自己发起的生产纯函数调用（`control.harnessInvoked`）**不是**
 *   组件内部那一次；它只用来与 Node 阶段的同函数读数对照，产物里单独标注。
 * - **离线桥**：VS Code 主题变量与 13px 基准由 `vscode-bridge.css` 提供——**不是** VS Code IPC、
 *   也不是宿主注入的真实主题。
 * - **未覆盖**：VS Code webview 宿主 IPC、真实主题与字体度量、行高 / 内存、真实用户夹具
 *   （须先过安全闸门与当次读取授权）。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "esbuild";

import {
  readFixtureFile,
  refusalText,
  qualifyFixturePayload,
  type BenchRefusal,
} from "./trajectoryPayloadBench";

// ───────────────────────── 私有打点：运行时 + 变换 ─────────────────────────

/**
 * 打点运行时：作为 esbuild `banner` 插在**产物最前面**，先于任何被折入的模块求值。
 *
 * 只做计数与计时，不碰业务状态；`globalThis.__M06_PROBE__` 也让被注入的代码不必 import
 * 任何东西（生产源文件里不新增 import）。
 */
export const PROBE_RUNTIME_SOURCE = `globalThis.__M06_PROBE__ = (() => {
  const origin = performance.now();
  const stages = new Map();
  // 搜索索引的**生产调度见证**：schedule → fire 按 nonce / timer id 配对，挂起被复用与取消也各记一笔。
  const searchSchedules = [];
  const searchFires = [];
  const searchCoalesced = [];
  const searchCancelled = [];
  let searchNonce = 0;
  let searchPendingNonce = null;
  const entryOf = (stage) => {
    let value = stages.get(stage);
    if (value === undefined) {
      value = { stage, calls: 0, totalMs: 0, samplesMs: [], firstAtMs: null, lastAtMs: null, value: null, valueAtMs: null };
      stages.set(stage, value);
    }
    return value;
  };
  const record = (stage, ms) => {
    const value = entryOf(stage);
    const at = performance.now() - origin;
    value.calls += 1;
    value.totalMs += ms;
    value.samplesMs.push(ms);
    if (value.firstAtMs === null) value.firstAtMs = at;
    value.lastAtMs = at;
    return at;
  };
  // 只留**可比较的数字见证**：数组（或带 length 的对象）取长度、有限数字原样，其余 null。
  const numeric = (raw) => {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw)) return raw.length;
    if (raw !== null && typeof raw === "object" && Number.isFinite(raw.length)) return raw.length;
    return null;
  };
  const capture = (stage, raw, at) => {
    const normalized = numeric(raw);
    if (normalized === null) return;
    const value = entryOf(stage);
    value.value = normalized;
    value.valueAtMs = at;
  };
  return {
    origin,
    sync(stage, run) {
      const start = performance.now();
      try {
        return run();
      } finally {
        record(stage, performance.now() - start);
      }
    },
    // 与 sync 同一语义，额外把**返回值**归一成数字见证（组件自己那次投影的逻辑行数走这里）。
    syncValue(stage, run) {
      const start = performance.now();
      try {
        const result = run();
        capture(stage, result, record(stage, performance.now() - start));
        return result;
      } catch (error) {
        record(stage, performance.now() - start);
        throw error;
      }
    },
    begin(stage) {
      return { stage, start: performance.now() };
    },
    end(token, value) {
      if (token) {
        const at = record(token.stage, performance.now() - token.start);
        if (value !== undefined) capture(token.stage, value, at);
      }
    },
    mark(stage) {
      record(stage, 0);
    },
    now() {
      return performance.now() - origin;
    },
    // ── 搜索索引的生产调度见证 ──────────────────────────────────────────
    // 调度：记**生产 setTimeout 自己的**调度时刻与请求延迟；node 里同样有 timer id（浏览器是数字句柄）。
    searchScheduled(requestedDelayMs, timerId) {
      searchNonce += 1;
      searchPendingNonce = searchNonce;
      searchSchedules.push({
        nonce: searchNonce,
        requestedDelayMs,
        timerId: timerId === undefined ? null : timerId,
        atMs: performance.now() - origin,
      });
      return searchNonce;
    },
    // 已挂起时批次再来：生产直接 return（不新建 timer），这里同样只记一笔，**不算新调度**。
    searchCoalesced() {
      searchCoalesced.push({ atMs: performance.now() - origin, pendingNonce: searchPendingNonce });
    },
    // 回调真的跑了：按挂起 nonce 配对，同时记下回调看到的 timer id（可与调度 id 对照）。
    searchFired(timerId) {
      searchFires.push({
        nonce: searchPendingNonce,
        timerId: timerId === undefined ? null : timerId,
        atMs: performance.now() - origin,
        // 落地与否由紧随其后的 searchIndex.update(...) 结果补记（默认未落地）。
        landed: false,
      });
      searchPendingNonce = null;
    },
    // 同一个回调里 searchIndex.update(...) 的**真实返回值**：只认 true 才算这次 timer 真落地。
    searchUpdateLanded(landed) {
      if (searchFires.length === 0) return;
      searchFires[searchFires.length - 1].landed = landed === true;
    },
    // 卸载时 clearTimeout：取消的是当前挂起那个，记一笔并清挂起。
    searchCancelled(timerId) {
      searchCancelled.push({
        nonce: searchPendingNonce,
        timerId: timerId === undefined ? null : timerId,
        atMs: performance.now() - origin,
      });
      searchPendingNonce = null;
    },
    searchWitness() {
      const pairs = [];
      for (const schedule of searchSchedules) {
        let fired = null;
        for (const candidate of searchFires) {
          if (candidate.nonce === schedule.nonce) {
            fired = candidate;
            break;
          }
        }
        if (fired === null) continue;
        pairs.push({
          nonce: schedule.nonce,
          requestedDelayMs: schedule.requestedDelayMs,
          timerId: schedule.timerId,
          firedTimerId: fired.timerId,
          timerIdMatched: schedule.timerId === null || fired.timerId === null ? null : schedule.timerId === fired.timerId,
          scheduledAtMs: schedule.atMs,
          firedAtMs: fired.atMs,
          // 这次 timer 的 searchIndex.update(...) 是否真的返回 true（真落地）。
          landed: fired.landed === true,
          // **真实节流延迟**：从生产调度那一刻到回调真的执行，两个时刻都来自生产自己。
          fireDelayMs: fired.atMs - schedule.atMs,
        });
      }
      return {
        schedules: searchSchedules.slice(),
        fires: searchFires.slice(),
        coalesced: searchCoalesced.slice(),
        cancelled: searchCancelled.slice(),
        pairs,
        // 调度了但没有 fire 的（被取消 / 还在挂起）与 fire 了但没落地的，单独给出，不算已执行。
        unpairedSchedules: searchSchedules.length - pairs.length,
        firedWithoutLanding: searchFires.filter((entry) => entry.landed !== true).length,
      };
    },
    snapshot() {
      const out = {};
      for (const [stage, value] of stages) {
        out[stage] = {
          stage,
          calls: value.calls,
          totalMs: value.totalMs,
          samplesMs: value.samplesMs.slice(),
          firstAtMs: value.firstAtMs,
          lastAtMs: value.lastAtMs,
          value: value.value,
          valueAtMs: value.valueAtMs,
        };
      }
      return out;
    },
    reset() {
      stages.clear();
      searchSchedules.length = 0;
      searchFires.length = 0;
      searchCoalesced.length = 0;
      searchCancelled.length = 0;
      searchNonce = 0;
      searchPendingNonce = null;
    },
  };
})();
`;

/**
 * **归因时间窗口与滚动/虚拟窗口判据**（runner 与 Node 侧红/绿对照**共用同一段源码**）。
 *
 * 为什么单独抽出来：同步阶段（timeline / vendorTurns / ledgerRows / allRows / commit layout
 * effect）在 11 份 refresh 样本里每次都会跑，而 vendor 搜索索引的更新是**生产 3 秒节流**的
 * 异步批次——把它塞进同一个「11 次同步样本」窗口要求，等于拿一个异步事实去满足同步判据：
 * 真实浏览器首跑就是这样误报的（`internal-probes` 红、而 `search-throttle` 绿）。
 *
 * 现在的口径：
 * - **同步阶段**：首次装载与 11 份 refresh 样本里都要有调用（保持不变）。
 * - **索引更新**：**单独观察真实 model 的那一次**，判据起点取**生产 `setTimeout` 自己的调度
 *   时刻**（schedule → fire 配对），不是「首载之后」——首载再重也不能把立即回调洗成慢节流，
 *   反过来说 `modelSetAt → fire` 只是诊断（它含首载之后的调度延迟），两种起点不许混用；
 *   refresh 批次被节流合并是**允许**的（不要求 11 次，也不许为了绿去强造 11 次）；
 *   **挂载空账本那一次立即建索引只作旁证，不算真实 model 的索引测量**。
 * - 永不调度 / 调了不 fire / 更新没落地 / 没走节流（含立即回调） / 没 CPU 时间 / 缺 schedule
 *   见证，全判红；`requestedDelayMs` 必须等于生产节流常量（防「悄悄改快」）。
 * - **滚动**：每个 sweep **内部**判真实 `applied` 非递减；跨 sweep 回到 step1 是协议自身的
 *   正常回落，只记诊断（`crossSweepResets`），某 sweep 内倒退必须红。
 * - **虚拟窗口**：`logicalLedgerRows`（`trajectoryLedgerRows` 的组件内返回值）与
 *   `logicalAllRows`（组件 `allRows.length`）同单位；DOM 的 `tr.trajectory-row` 计数
 *   （initial / min / max）与 `logicalAllRows` 比较。窗口真的切片（有垫行、渲染数严格小于
 *   逻辑总量、容器真的能滚）才通过；缺逻辑见证 / 渲染全量 / 无垫行 / 不滚动一律红。
 *   低于虚拟化阈值的短模型**明示 N/A**（只核零垫行 + 全量渲染一致），不当虚拟化性能证明。
 *
 * 阶段名与阈值也由这份源码给出：runner 与测试不许各写一份。
 */
export const PROBE_WINDOW_VERDICT_SOURCE = `var m06ProbeStages = {
  sync: ["view.timeline", "view.vendorTurns", "view.ledgerRows", "view.allRows", "view.commitLayoutEffect"],
  index: "vendor.searchIndex.update",
  // 组件内部投影的**行数见证**阶段名（runner 从这里取，不许再手写一份）。
  ledgerRowsStage: "view.ledgerRows",
  allRowsStage: "view.allRows",
  // 生产节流是 3 秒：真实 timer 至少得等这么久才说明「节流真的生效」，同时给一个上界兜住异常。
  throttleFloorMs: 2500,
  throttleCeilingMs: 15000,
  // 生产 Trajectory.tsx 的 SEARCH_INDEX_THROTTLE_MS：调度的请求延迟必须逐字等于它。
  declaredThrottleMs: 3000,
};
function m06CallCount(probe, stage) {
  var value = probe && probe[stage] ? probe[stage] : null;
  return value && typeof value.calls === "number" ? value.calls : 0;
}
function m06ProbeWindowVerdict(input) {
  var callCount = m06CallCount;
  var missingOnFirstLoad = [];
  var missingAcrossRefresh = [];
  var i;
  for (i = 0; i < m06ProbeStages.sync.length; i += 1) {
    var stage = m06ProbeStages.sync[i];
    if (callCount(input.firstLoadProbe, stage) < 1) missingOnFirstLoad.push(stage);
    var acrossRefresh = 0;
    var samples = input.refreshProbes || [];
    for (var r = 0; r < samples.length; r += 1) acrossRefresh += callCount(samples[r], stage);
    if (acrossRefresh < 1) missingAcrossRefresh.push(stage);
  }
  var search = input.search || {};
  var raw = search.scheduleWitness && typeof search.scheduleWitness === "object" ? search.scheduleWitness : null;
  // **筛选起点**：生产把真实 model 交给组件的那一刻（probe 时钟）。它只决定「哪些生产事件属于
  // 本夹具这一轮」，**不是**判据量——延迟永远是那一对 timer 的 firedAt - scheduledAt。
  var windowStartMs = raw !== null && typeof raw.modelSetAtMs === "number" ? raw.modelSetAtMs : null;
  var witness = raw !== null && raw.witness && typeof raw.witness === "object" ? raw.witness : null;
  var count = function (value) {
    return typeof value === "number" && isFinite(value) ? value : 0;
  };
  var list = function (value) {
    return Array.isArray(value) ? value : [];
  };
  var inWindow = function (entry, field) {
    if (windowStartMs === null || entry === null || typeof entry !== "object") return false;
    var at = typeof entry[field] === "number" ? entry[field] : null;
    return at !== null && at >= windowStartMs;
  };
  // 生产事件按**起点**筛（不是按快照长度切片：切片基线一旦取在调度之后，schedule 会被整段漏掉，
  // 而随后 fire 产生的 pair 还在——真实首跑就是这样报出 schedules=[] / pairs=1 的）。
  var schedules = list(witness && witness.schedules).filter(function (entry) { return inWindow(entry, "atMs"); });
  var fires = list(witness && witness.fires).filter(function (entry) { return inWindow(entry, "atMs"); });
  var pairs = list(witness && witness.pairs).filter(function (entry) { return inWindow(entry, "scheduledAtMs"); });
  var coalesced = list(witness && witness.coalesced).filter(function (entry) { return inWindow(entry, "atMs"); });
  var cancelled = list(witness && witness.cancelled).filter(function (entry) { return inWindow(entry, "atMs"); });
  var pair = pairs.length > 0 ? pairs[0] : null;
  /**
   * **选中那一对的身份绑定**（判据在这里，不认 pair 自带的标签）。
   *
   * pair 是 runtime 按 nonce 折出来的**派生形状**，它自带的 timerId / firedTimerId /
   * timerIdMatched / landed 都只是被核对的对象。这里回原始 schedules / fires 里找**唯一**
   * 同 nonce 的两条事件，并要求：
   * - nonce 是数字、窗口内各有且仅有一条同 nonce 的调度与回调（缺一条或同 nonce 多条 = 身份没绑上）；
   * - 两个 timer id 都在且**逐值相等**（不同 id 必须拒；id 缺失必须拒）；
   * - pair 的 timerId / firedTimerId 与原始两条事件一致，且自带的 timerIdMatched 必须是 true
   *   （**伪 matched=true 不算数**：上一条的 id 相等才是判据）；
   * - pair 的 scheduledAtMs / firedAtMs / requestedDelayMs / landed 与原始两条事件逐项一致
   *   （时间、请求延迟或落地与原始事件矛盾的一律拒）。
   *
   * 窗口外噪音不参与（它们本来就落在 schedules / fires 之外），取消 / 合并也不在这里判
   * （它们没有 fire，走既有分支）。
   */
  var bindingOfNonce = function (nonce) {
    var found = { schedules: [], fires: [] };
    var i;
    if (typeof nonce !== "number") return found;
    for (i = 0; i < schedules.length; i += 1) {
      if (schedules[i] !== null && typeof schedules[i] === "object" && schedules[i].nonce === nonce) found.schedules.push(schedules[i]);
    }
    for (i = 0; i < fires.length; i += 1) {
      if (fires[i] !== null && typeof fires[i] === "object" && fires[i].nonce === nonce) found.fires.push(fires[i]);
    }
    return found;
  };
  var binding = bindingOfNonce(pair === null ? null : pair.nonce);
  var boundSchedule = binding.schedules.length === 1 ? binding.schedules[0] : null;
  var boundFire = binding.fires.length === 1 ? binding.fires[0] : null;
  var scheduledTimerId = boundSchedule === null || boundSchedule.timerId === undefined ? null : boundSchedule.timerId;
  var firedTimerId = boundFire === null || boundFire.timerId === undefined ? null : boundFire.timerId;
  var pairTimerId = pair === null || pair.timerId === undefined ? null : pair.timerId;
  var pairFiredTimerId = pair === null || pair.firedTimerId === undefined ? null : pair.firedTimerId;
  var idsPresent = scheduledTimerId !== null && firedTimerId !== null;
  var idsEqual = idsPresent && scheduledTimerId === firedTimerId;
  var noncePresent = pair !== null && typeof pair.nonce === "number";
  var pairBinding = {
    nonce: noncePresent ? pair.nonce : null,
    noncePresent: noncePresent,
    scheduleHits: binding.schedules.length,
    fireHits: binding.fires.length,
    scheduleTimerId: scheduledTimerId,
    fireTimerId: firedTimerId,
    pairTimerId: pairTimerId,
    pairFiredTimerId: pairFiredTimerId,
    idsPresent: idsPresent,
    idsEqual: idsEqual,
    // pair 自带的标签：只作核对对象，不作判据（伪 true 必须被 id 相等这一条拦住）。
    pairLabelMatched: pair === null || pair.timerIdMatched === undefined ? null : pair.timerIdMatched,
    scheduleAtMatches: boundSchedule !== null && pair !== null && boundSchedule.atMs === pair.scheduledAtMs,
    fireAtMatches: boundFire !== null && pair !== null && boundFire.atMs === pair.firedAtMs,
    requestedDelayMatches: boundSchedule !== null && pair !== null && boundSchedule.requestedDelayMs === pair.requestedDelayMs,
    landedMatches: boundFire !== null && pair !== null && (boundFire.landed === true) === (pair.landed === true),
    landedVerified: boundFire !== null && boundFire.landed === true,
    pairIdsAgree: pairTimerId === scheduledTimerId && pairFiredTimerId === firedTimerId,
  };
  // 身份缺失：没有选中对 / nonce 不是数字 / 窗口内凑不出唯一一条调度 + 回调 / 任一 timer id 缺失。
  var identityMissing = pairBinding.noncePresent !== true || boundSchedule === null || boundFire === null
    || idsPresent !== true;
  // 不同 timer 或伪 matched 标签：id 不相等、pair 自己的 id 与原始事件不一致、或标签不是 true。
  var idMismatch = identityMissing !== true
    && (idsEqual !== true || pairBinding.pairIdsAgree !== true || pairBinding.pairLabelMatched !== true);
  // 矛盾：时间 / 请求延迟 / 落地与原始两条事件对不上（上面两条成立时才看这一条）。
  var pairInconsistent = identityMissing !== true && idMismatch !== true
    && (pairBinding.scheduleAtMatches !== true || pairBinding.fireAtMatches !== true
      || pairBinding.requestedDelayMatches !== true || pairBinding.landedMatches !== true);
  var index = {
    // 空账本挂载那一次**只作旁证**：它不是真实 model 的索引测量。
    mountEmptyCalls: count(search.mountEmptyCalls),
    mountEmptyAtMs: typeof search.mountEmptyAtMs === "number" ? search.mountEmptyAtMs : null,
    // ── 生产调度/回调见证（**判据起点**） ──────────────────────────────
    windowStartMs: windowStartMs,
    // 窗口外的生产事件只作诊断：起点取晚了就会在这里现形（不许拿来当本轮资格）。
    schedulesBeforeWindow: witness === null ? 0 : list(witness.schedules).length - schedules.length,
    scheduleObserved: schedules.length >= 1,
    schedulesAfterModelSet: schedules.length,
    firedAfterModelSet: fires.length,
    pairsAfterModelSet: pairs.length,
    coalescedAfterModelSet: coalesced.length,
    cancelledAfterModelSet: cancelled.length,
    // 调度了没 fire（被取消 / 还在挂起）、fire 了没落地：都不算已执行。
    unpairedSchedules: witness === null ? 0 : list(witness.schedules).length - list(witness.pairs).length,
    firedWithoutLanding: witness === null ? 0 : list(witness.fires).filter(function (entry) { return entry.landed !== true; }).length,
    requestedDelayMs: pair === null ? null : (typeof pair.requestedDelayMs === "number" ? pair.requestedDelayMs : null),
    scheduledAtMs: pair === null ? null : (typeof pair.scheduledAtMs === "number" ? pair.scheduledAtMs : null),
    firedAtMs: pair === null ? null : (typeof pair.firedAtMs === "number" ? pair.firedAtMs : null),
    fireDelayMs: pair === null ? null : (typeof pair.fireDelayMs === "number" ? pair.fireDelayMs : null),
    // 这一对 timer 的 searchIndex.update(...) 是否真的返回 true（fire ≠ 已执行）。
    pairLanded: pair === null ? null : pair.landed === true,
    nonce: pair === null ? null : pair.nonce,
    timerId: pair === null ? null : pair.timerId,
    firedTimerId: pair === null ? null : pair.firedTimerId,
    timerIdMatched: pair === null ? null : pair.timerIdMatched,
    // 被判据选中的那一对原始事件（父级直接读这个，不必自己再筛一遍）。
    selectedPair: pair,
    // 选中那一对与原始 schedule / fire 事件的身份绑定核对（判据不以 pair 的标签为准）。
    pairBinding: pairBinding,
    // ── 诊断（**不作判据起点**）：model set 之后的旧口径延迟与首载耗时 ──
    timerObserved: search.throttledExecuted === true,
    callsAfterModelSet: count(search.callsAfterModelSet),
    delayAfterModelSetMs: typeof search.delayAfterModelSetMs === "number" ? search.delayAfterModelSetMs : null,
    modelSetAtMs: typeof search.modelSetAtMs === "number" ? search.modelSetAtMs : null,
    firstLoadWallMs: typeof search.firstLoadWallMs === "number" ? search.firstLoadWallMs : null,
    cpuMsAfterModelSet: typeof search.cpuMsAfterModelSet === "number" ? search.cpuMsAfterModelSet : null,
    updateCallsTotal: typeof search.updateCallsTotal === "number" ? search.updateCallsTotal : null,
    updatesDuringRefresh: count(search.updatesDuringRefresh),
    refreshBatches: count(search.refreshBatches),
    // 合并是被允许的：refresh 期间只落地一次都算正常节流批次（零次则由随后的落地窗口补齐）。
    mergedBatches: count(search.updatesDuringRefresh) >= 1 && count(search.refreshBatches) > count(search.updatesDuringRefresh),
  };
  var indexFailures = [];
  // 缺 schedule 见证（打点没折进去 / 生产根本没调度）不许装通过。
  if (index.scheduleObserved !== true) indexFailures.push("timer-not-scheduled");
  if (index.firedAfterModelSet < 1) indexFailures.push("timer-not-fired");
  // fire 了但那次 searchIndex.update 没有真落地（返回 false）不算已执行；挂起复用/取消更不算。
  if (index.pairsAfterModelSet < 1 || index.pairLanded !== true) indexFailures.push("no-landed-update");
  if (index.callsAfterModelSet < 1) indexFailures.push("no-update-after-model-set");
  // **起点是生产自己的 schedule**：重 UI 只推迟调度，不会把立即回调洗成慢节流。
  if (index.fireDelayMs === null || index.fireDelayMs < m06ProbeStages.throttleFloorMs) indexFailures.push("update-not-throttled");
  if (index.fireDelayMs !== null && index.fireDelayMs > m06ProbeStages.throttleCeilingMs) indexFailures.push("update-too-late");
  if (index.requestedDelayMs !== m06ProbeStages.declaredThrottleMs) indexFailures.push("requested-delay-mismatch");
  if (!(typeof index.cpuMsAfterModelSet === "number" && index.cpuMsAfterModelSet > 0)) indexFailures.push("no-cpu-time");
  // 身份绑定：不同 timer / 伪 matched 标签 / 身份缺失 / 与原始事件矛盾，各自点名（缺一不成）。
  if (identityMissing) indexFailures.push("timer-identity-missing");
  if (idMismatch) indexFailures.push("timer-id-mismatch");
  if (pairInconsistent) indexFailures.push("timer-pair-inconsistent");
  return {
    pass: missingOnFirstLoad.length === 0 && missingAcrossRefresh.length === 0 && indexFailures.length === 0,
    sync: { missingOnFirstLoad: missingOnFirstLoad, missingAcrossRefresh: missingAcrossRefresh, stages: m06ProbeStages.sync },
    index: index,
    indexFailures: indexFailures,
  };
}
function m06ScrollWindowVerdict(input) {
  input = input || {};
  var warmup = Array.isArray(input.warmup) ? input.warmup : [];
  var samples = Array.isArray(input.samples) ? input.samples : [];
  var maxScroll = typeof input.maxScroll === "number" ? input.maxScroll : 0;
  var logicalLedgerRows = typeof input.logicalLedgerRows === "number" ? input.logicalLedgerRows : null;
  var logicalAllRows = typeof input.logicalAllRows === "number" ? input.logicalAllRows : null;
  var initialRenderedRows = typeof input.initialRenderedRows === "number" ? input.initialRenderedRows : 0;
  var harnessLedgerRows = typeof input.harnessLedgerRows === "number" ? input.harnessLedgerRows : null;
  var virtualizedExpected = input.virtualizedExpected === true;
  var appliedNonzero = 0;
  var maxRenderedRows = 0;
  var minRenderedRows = null;
  var maxPads = 0;
  var withinSweepDecreases = [];
  var crossSweepResets = [];
  var sweepMonotone = { warmup: true, samples: true };
  var phases = [["warmup", warmup], ["samples", samples]];
  for (var p = 0; p < phases.length; p += 1) {
    var phase = phases[p][0];
    var sweeps = phases[p][1];
    for (var s = 0; s < sweeps.length; s += 1) {
      var steps = sweeps[s] && Array.isArray(sweeps[s].steps) ? sweeps[s].steps : [];
      for (var i = 0; i < steps.length; i += 1) {
        var step = steps[i] || {};
        if (typeof step.applied === "number" && step.applied > 0) appliedNonzero += 1;
        if (typeof step.rows === "number") {
          if (step.rows > maxRenderedRows) maxRenderedRows = step.rows;
          if (minRenderedRows === null || step.rows < minRenderedRows) minRenderedRows = step.rows;
        }
        if (typeof step.pads === "number" && step.pads > maxPads) maxPads = step.pads;
        // **逐 sweep 判**：只有同一个 sweep 内部真实 applied 倒退才算红。
        if (i > 0 && typeof step.applied === "number" && typeof steps[i - 1].applied === "number" && step.applied < steps[i - 1].applied) {
          sweepMonotone[phase] = false;
          withinSweepDecreases.push({ phase: phase, sweep: s, step: i, from: steps[i - 1].applied, to: step.applied });
        }
      }
      // 跨 sweep 回到 step1：协议自身的正常回落，**只记诊断**。
      if (s > 0) {
        var previous = sweeps[s - 1] && Array.isArray(sweeps[s - 1].steps) ? sweeps[s - 1].steps : [];
        var last = previous[previous.length - 1];
        var first = steps[0];
        if (last && first && typeof last.applied === "number" && typeof first.applied === "number" && first.applied < last.applied) {
          crossSweepResets.push({ phase: phase, boundary: s, from: last.applied, to: first.applied });
        }
      }
    }
  }
  if (minRenderedRows === null) minRenderedRows = 0;
  var protocolComplete = warmup.length === 2 && samples.length === 11;
  var appliedMonotone = sweepMonotone.warmup === true && sweepMonotone.samples === true;
  var scrollFailures = [];
  if (protocolComplete !== true) scrollFailures.push("scroll-protocol-incomplete");
  if (sweepMonotone.samples !== true) scrollFailures.push("applied-decreased-within-sample-sweep");
  if (sweepMonotone.warmup !== true) scrollFailures.push("applied-decreased-within-warmup-sweep");
  // 真实滚动是**虚拟化**的前提；短模型装不溢出，不要求它也能滚。
  if (virtualizedExpected === true) {
    if (!(maxScroll > 0)) scrollFailures.push("no-scrollable-overflow");
    if (!(appliedNonzero > 0)) scrollFailures.push("no-applied-scroll");
  }
  var logicalWitnessPresent = logicalLedgerRows !== null && logicalAllRows !== null && logicalAllRows > 0;
  var virtualFailures = [];
  if (virtualizedExpected === true) {
    if (logicalWitnessPresent !== true) virtualFailures.push("no-logical-rows-witness");
    if (!(maxScroll > 0)) virtualFailures.push("no-scrollable-overflow");
    if (!(maxPads > 0)) virtualFailures.push("no-virtual-pad");
    if (!(maxRenderedRows > 0)) virtualFailures.push("no-rendered-rows-witness");
    // 同单位比较：DOM 的 tr.trajectory-row 数 vs 组件自己投影的 allRows 数。
    if (logicalWitnessPresent === true && maxRenderedRows >= logicalAllRows) virtualFailures.push("rendered-all-logical-rows");
  } else {
    // 非虚拟（短模型）：只核「零垫行 + 全量渲染」与状态一致，**明示 N/A**，不当性能证明。
    if (logicalWitnessPresent !== true) virtualFailures.push("no-logical-rows-witness");
    if (maxPads !== 0) virtualFailures.push("unexpected-virtual-pad");
    if (logicalWitnessPresent === true && maxRenderedRows !== logicalAllRows) virtualFailures.push("non-virtual-window-sliced");
    if (logicalWitnessPresent === true && initialRenderedRows !== logicalAllRows) virtualFailures.push("initial-window-not-full");
  }
  if (logicalWitnessPresent === true && logicalAllRows < logicalLedgerRows) virtualFailures.push("logical-units-mismatch");
  // harness 调同一条生产纯函数只作交叉校验：与组件内部见证不符时说明见证本身有问题。
  if (logicalWitnessPresent === true && harnessLedgerRows !== null && harnessLedgerRows !== logicalLedgerRows) {
    virtualFailures.push("logical-witness-cross-check-mismatch");
  }
  var virtualPass = virtualizedExpected === true && virtualFailures.length === 0;
  var nonVirtualConsistent = virtualizedExpected !== true && virtualFailures.length === 0;
  return {
    pass: virtualizedExpected === true ? virtualPass : nonVirtualConsistent,
    applicable: virtualizedExpected === true,
    outcome: virtualizedExpected === true
      ? (virtualPass === true ? "virtualized-window-observed" : "virtual-window-rejected")
      : "not-applicable-non-virtual-model",
    scroll: {
      pass: scrollFailures.length === 0,
      failures: scrollFailures,
      maxScroll: maxScroll,
      appliedNonzero: appliedNonzero,
      appliedMonotone: appliedMonotone,
      sweepMonotone: sweepMonotone,
      withinSweepDecreases: withinSweepDecreases,
      crossSweepResets: crossSweepResets,
      warmupSweeps: warmup.length,
      sampleSweeps: samples.length,
    },
    virtual: {
      pass: virtualPass,
      failures: virtualFailures,
      virtualizedExpected: virtualizedExpected,
      logicalLedgerRows: logicalLedgerRows,
      logicalAllRows: logicalAllRows,
      initialRenderedRows: initialRenderedRows,
      minRenderedRows: minRenderedRows,
      maxRenderedRows: maxRenderedRows,
      maxPads: maxPads,
      harnessLedgerRows: harnessLedgerRows,
    },
  };
}
`;

/** 归因窗口判据的结果形状（浏览器里由上面那段源码算出）。 */
export interface ProbeWindowVerdict {
  pass: boolean;
  sync: { missingOnFirstLoad: string[]; missingAcrossRefresh: string[]; stages: string[] };
  index: {
    mountEmptyCalls: number;
    mountEmptyAtMs: number | null;
    /** 筛选起点（probe 时钟）：生产把真实 model 交给组件的那一刻；只决定事件属于哪一轮。 */
    windowStartMs: number | null;
    /** 窗口外的生产调度数（诊断：起点取晚了就会现形）。 */
    schedulesBeforeWindow: number;
    /** 生产 `setTimeout` 的调度见证是否到手（缺了不许通过）。 */
    scheduleObserved: boolean;
    schedulesAfterModelSet: number;
    firedAfterModelSet: number;
    /** 完整配对（schedule + fire）条数；挂起复用/取消不计。 */
    pairsAfterModelSet: number;
    coalescedAfterModelSet: number;
    cancelledAfterModelSet: number;
    /** 调度了没 fire / fire 了没落地（都不算已执行）。 */
    unpairedSchedules: number;
    firedWithoutLanding: number;
    requestedDelayMs: number | null;
    scheduledAtMs: number | null;
    firedAtMs: number | null;
    /** `firedAt - scheduledAt`：真实节流延迟，判据量（起点只用于筛选，不参与算延迟）。 */
    fireDelayMs: number | null;
    /** 该 timer 的 `searchIndex.update(...)` 是否真返回 true（fire ≠ 已执行）。 */
    pairLanded: boolean | null;
    nonce: unknown;
    timerId: unknown;
    firedTimerId: unknown;
    timerIdMatched: boolean | null;
    /** 判据选中的那一对原始生产事件（父级可直接读，不必自己再筛一遍）。 */
    selectedPair: unknown;
    /**
     * 选中那一对与原始 schedule / fire 事件的**身份绑定**核对结果（判据不以 pair 自带的
     * 标签为准：不同 timer id、伪 matched=true、身份缺失、时间/落地矛盾都在这里被拒）。
     */
    pairBinding: {
      /** 选中的 nonce（不是数字时为 null）。 */
      nonce: number | null;
      noncePresent: boolean;
      /** 窗口内同 nonce 的调度 / 回调条数（都必须是 1 才算绑上）。 */
      scheduleHits: number;
      fireHits: number;
      scheduleTimerId: unknown;
      fireTimerId: unknown;
      pairTimerId: unknown;
      pairFiredTimerId: unknown;
      idsPresent: boolean;
      idsEqual: boolean;
      /** pair 自带的 `timerIdMatched`（只作核对对象；伪 true 不构成通过条件）。 */
      pairLabelMatched: boolean | null;
      scheduleAtMatches: boolean;
      fireAtMatches: boolean;
      requestedDelayMatches: boolean;
      landedMatches: boolean;
      /** 原始 fire 事件上的真实落地位（`searchIndex.update(...) === true`）。 */
      landedVerified: boolean;
      /** pair 自带的两个 id 与原始两条事件是否逐个一致。 */
      pairIdsAgree: boolean;
    };
    /** 诊断：旧的「model set 之后」口径与首载耗时，**不作判据起点**。 */
    timerObserved: boolean;
    callsAfterModelSet: number;
    delayAfterModelSetMs: number | null;
    modelSetAtMs: number | null;
    firstLoadWallMs: number | null;
    cpuMsAfterModelSet: number | null;
    updateCallsTotal: number | null;
    updatesDuringRefresh: number;
    refreshBatches: number;
    mergedBatches: boolean;
  };
  indexFailures: string[];
}

/** 滚动 / 虚拟窗口判据的结果形状（同一段源码算出）。 */
export interface ProbeScrollVerdict {
  /** 虚拟窗口那一条的通过与否（非虚拟时看「零垫行 + 全量渲染」是否与状态一致）。 */
  pass: boolean;
  /** 是否适用虚拟化判据（低于阈值的短模型为 false，此时结论是 N/A）。 */
  applicable: boolean;
  outcome: "virtualized-window-observed" | "virtual-window-rejected" | "not-applicable-non-virtual-model";
  scroll: {
    pass: boolean;
    failures: string[];
    maxScroll: number;
    appliedNonzero: number;
    appliedMonotone: boolean;
    sweepMonotone: { warmup: boolean; samples: boolean };
    withinSweepDecreases: { phase: string; sweep: number; step: number; from: number; to: number }[];
    crossSweepResets: { phase: string; boundary: number; from: number; to: number }[];
    warmupSweeps: number;
    sampleSweeps: number;
  };
  virtual: {
    pass: boolean;
    failures: string[];
    virtualizedExpected: boolean;
    logicalLedgerRows: number | null;
    logicalAllRows: number | null;
    initialRenderedRows: number;
    minRenderedRows: number;
    maxRenderedRows: number;
    maxPads: number;
    harnessLedgerRows: number | null;
  };
}

/**
 * 把**同一段源码**编译成 Node 侧可调用的判据函数，供离线回归做红/绿对照。
 *
 * 用 `new Function` 是有意的：判据只存在一份（runner 里嵌的就是这段字符串），
 * 离线测试跑的也是它，不给「测试与浏览器两套逻辑」留下漂移空间。
 */
export function compileProbeWindowVerdict(): (input: unknown) => ProbeWindowVerdict {
  return new Function(`${PROBE_WINDOW_VERDICT_SOURCE}\nreturn m06ProbeWindowVerdict;`)() as (input: unknown) => ProbeWindowVerdict;
}

/** 同一段源码里的滚动 / 虚拟窗口判据（同样只此一份）。 */
export function compileScrollWindowVerdict(): (input: unknown) => ProbeScrollVerdict {
  return new Function(`${PROBE_WINDOW_VERDICT_SOURCE}\nreturn m06ScrollWindowVerdict;`)() as (input: unknown) => ProbeScrollVerdict;
}

/** 一处打点：锚点在文件里必须**恰好出现一次**。 */
export interface InstrumentationPoint {
  /** 稳定 id（就是产物里的阶段名）。 */
  id: string;
  /** 仓库相对路径。 */
  file: string;
  /** 必须唯一命中的字面锚点（换行符按文件的换行风格对齐，见 `instrumentSource`）。 */
  anchor: string;
  /** 替换文本（含 `globalThis.__M06_PROBE__` 调用）。 */
  replacement: string;
}

/**
 * 打点清单：**组件内部**的真实调用点。
 *
 * 每个锚点都取自生产源码的当前字节；命中数必须严格等于 1——这条由 `instrumentSource`
 * 记录、由 `bundleBrowserRunner` 判死。
 */
export const INSTRUMENTATION_POINTS: readonly InstrumentationPoint[] = [
  {
    id: "view.timeline",
    file: "src/webview/components/Trajectory.tsx",
    anchor: "  const timeline = useMemo(() => deriveTrajectoryTimeline(turns, mode), [turns, mode]);",
    replacement:
      '  const timeline = useMemo(() => globalThis.__M06_PROBE__.sync("view.timeline", () => deriveTrajectoryTimeline(turns, mode)), [turns, mode]);',
  },
  {
    id: "view.vendorTurns",
    file: "src/webview/components/Trajectory.tsx",
    anchor: "    () => [vendorTurns(turns, (title) => trajectoryGroupTitle(title, tt))] as const,",
    replacement:
      '    () => [globalThis.__M06_PROBE__.sync("view.vendorTurns", () => vendorTurns(turns, (title) => trajectoryGroupTitle(title, tt)))] as const,',
  },
  {
    id: "view.ledgerRows",
    file: "src/webview/components/Trajectory.tsx",
    anchor: "    () => trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes }),",
    replacement:
      '    () => globalThis.__M06_PROBE__.syncValue("view.ledgerRows", () => trajectoryLedgerRows({ turns, collapsedTurns, collapsedCalls, matchIndexes })),',
  },
  {
    id: "view.allRows.begin",
    file: "src/webview/components/Trajectory.tsx",
    anchor: "  const allRows: LedgerRow[] = ledgerRows.map((row) => ({",
    replacement:
      '  const __m06AllRows = globalThis.__M06_PROBE__.begin("view.allRows");\n  const allRows: LedgerRow[] = ledgerRows.map((row) => ({',
  },
  {
    id: "view.allRows.end",
    file: "src/webview/components/Trajectory.tsx",
    anchor:
      "        : renderRow(row.record as TrajectoryCell, turns[row.section], row.turnStart),\n  }));",
    replacement:
      "        : renderRow(row.record as TrajectoryCell, turns[row.section], row.turnStart),\n  }));\n  globalThis.__M06_PROBE__.end(__m06AllRows, allRows.length);",
  },
  {
    id: "view.commitLayoutEffect",
    file: "src/webview/components/Trajectory.tsx",
    anchor: "    port.followSelected(timeline.spans);",
    // 这个 layout effect **每次渲染都跑**（无依赖数组），所以它就是「这一帧真的 commit 了」
    // 的组件内信号——与 React Profiler 的 onRender 互为独立见证。
    replacement: '    globalThis.__M06_PROBE__.mark("view.commitLayoutEffect");\n    port.followSelected(timeline.spans);',
  },
  {
    id: "vendor.searchIndex.update",
    file: "src/vendor/ui-trajectory/trajectory-search-index.ts",
    anchor: "  update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {\n    if (this.layouts === layouts) return false",
    // 把方法体挪进一个私有方法，公开方法只留一层计时壳——语义逐字不变（短路分支照旧先判）。
    replacement:
      '  update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {\n    return globalThis.__M06_PROBE__.sync("vendor.searchIndex.update", () => this.__m06Update(layouts));\n  }\n\n  private __m06Update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {\n    if (this.layouts === layouts) return false',
  },
  {
    /**
     * **搜索索引的生产调度见证**：不多不少就这一个新增锚点。
     *
     * 锚点覆盖「挂起复用判断 + `setTimeout` 调度 + 回调 + 卸载清理」这一整段；替换保持
     * 调用语义、返回值与清理时序逐字不变，只在生产自己的调度点与回调点各记一笔：
     * - 调度：`requestedDelayMs`（就是 `SEARCH_INDEX_THROTTLE_MS`）与 `scheduledAt`、timer id、nonce；
     * - 回调：`firedAt`，按 nonce（并在能拿到时按 timer id 对照）配对——判据起点因此是
     *   **生产自己调度的那一刻**，而不是 runner 侧「首载之后」的近似起点；回调里
     *   `searchIndex.update(...)` 的**真实返回值**另外补记（`fire` 不算已执行，落地才算）；
     * - 已挂起时批次再来（生产直接 `return`）记 `coalesced`；卸载 `clearTimeout` 记 `cancelled`——
     *   两者都**不算已执行**，不参与配对。
     */
    id: "vendor.searchIndex.schedule",
    file: "src/webview/components/Trajectory.tsx",
    anchor:
      "    if (searchTimer.current !== null) return;\n    searchTimer.current = setTimeout(() => {\n      searchTimer.current = null;\n      if (searchIndex.update(latestSearchLayouts.current)) setSearchRevision((revision) => revision + 1);\n    }, SEARCH_INDEX_THROTTLE_MS);\n  }, [searchIndex, searchLayouts]);\n  useEffect(() => () => {\n    if (searchTimer.current !== null) clearTimeout(searchTimer.current);\n  }, []);",
    replacement:
      '    if (searchTimer.current !== null) {\n      globalThis.__M06_PROBE__.searchCoalesced();\n      return;\n    }\n    var __m06SearchTimer = null;\n    __m06SearchTimer = setTimeout(() => {\n      searchTimer.current = null;\n      globalThis.__M06_PROBE__.searchFired(__m06SearchTimer);\n      var __m06Landed = searchIndex.update(latestSearchLayouts.current);\n      globalThis.__M06_PROBE__.searchUpdateLanded(__m06Landed === true);\n      if (__m06Landed) setSearchRevision((revision) => revision + 1);\n    }, SEARCH_INDEX_THROTTLE_MS);\n    searchTimer.current = __m06SearchTimer;\n    globalThis.__M06_PROBE__.searchScheduled(SEARCH_INDEX_THROTTLE_MS, __m06SearchTimer);\n  }, [searchIndex, searchLayouts]);\n  useEffect(() => () => {\n    if (searchTimer.current !== null) {\n      globalThis.__M06_PROBE__.searchCancelled(searchTimer.current);\n      clearTimeout(searchTimer.current);\n    }\n  }, []);',
  },
];

/** 一次打点的命中数。 */
export interface InstrumentationHit {
  id: string;
  anchorHits: number;
}

/** 一份被折入 bundle 的生产源的字节见证（打点前后各一份）。 */
export interface FoldedSourceWitness {
  file: string;
  /** 真正折进 bundle 的字节数（打过点就是转换后的）。 */
  bytes: number;
  sha256: string;
  instrumented: boolean;
  originalBytes: number;
  originalSha256: string;
  instrumentation: InstrumentationHit[];
}

/**
 * 给一份源码折入打点。**纯函数**（不碰磁盘），因此测试可以直接喂变异过的字节。
 *
 * 换行符按**文件自己的风格**对齐：锚点写成 `\n`，CRLF 文件里也能命中，
 * 且不会把整份文件的换行风格改掉（转换只落在这几处锚点上）。
 *
 * @returns 转换后的文本 + 每个锚点的命中数（调用方负责「必须恰好 1」的判死）。
 */
export function instrumentSource(
  text: string,
  points: readonly InstrumentationPoint[] = INSTRUMENTATION_POINTS,
): { text: string; hits: InstrumentationHit[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const align = (value: string): string => (eol === "\n" ? value.replace(/\r\n/g, "\n") : value.replace(/\r?\n/g, "\r\n"));
  let output = text;
  const hits: InstrumentationHit[] = [];
  for (const point of points) {
    const anchor = align(point.anchor);
    const replacement = align(point.replacement);
    const count = output.split(anchor).length - 1;
    hits.push({ id: point.id, anchorHits: count });
    // 只有**恰好一次**才替换；0 次与多次都不动它，交给调用方判死。
    if (count === 1) output = output.split(anchor).join(replacement);
  }
  return { text: output, hits };
}

// ───────────────────────── 生产样式（同字节载入） ─────────────────────────

/** 浏览器工件必须**逐字节**载入的生产样式（顺序同 `main.tsx` 的 import 顺序）。 */
export const PRODUCTION_STYLE_SOURCES = ["src/webview/styles/tokens.css", "src/webview/styles/app.css"] as const;

/**
 * 离线主题桥：VS Code 默认深色主题里本界面用到的变量 + 13px 基准字号。
 *
 * **它不是 VS Code IPC**：真机上是宿主把主题变量注入 webview 的；离线页没有宿主，
 * 于是这里给一份固定的默认值，让「生产 app.css + 生产 tokens.css + 13px 基准」这一套
 * 能真的生效。基准字号 13px 与 `tokens.css` 的 `--font-size` 默认值一致。
 */
export const VSCODE_BRIDGE_CSS = `/* M06 harness offline bridge: NOT VS Code IPC. Default dark-theme variables + the 13px base. */
:root {
  --vscode-font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-sideBar-background: #1e1e1e;
  --vscode-sideBar-foreground: #e6e6e6;
  --vscode-sideBar-border: #2b2b2b;
  --vscode-panel-background: #1e1e1e;
  --vscode-panel-foreground: #e6e6e6;
  --vscode-panel-border: #2b2b2b;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #e6e6e6;
  --vscode-button-background: #2c5aa0;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #3a6db3;
  --vscode-button-secondaryBackground: #303030;
  --vscode-button-secondaryForeground: #e6e6e6;
  --vscode-button-secondaryHoverBackground: #3a3a3a;
  --vscode-focusBorder: #3a6db3;
  --vscode-commandCenter-inactiveBorder: #555555;
  --vscode-commandCenter-activeBorder: #4d8bf0;
  --vscode-input-background: #2d2d2d;
  --vscode-input-foreground: #e6e6e6;
  --vscode-input-border: #555555;
  --vscode-input-placeholderForeground: #9e9e9e;
  --vscode-textCodeBlock-background: #1e1e1e;
  --vscode-descriptionForeground: #b3b3b3;
  --vscode-list-deemphasizedForeground: #8c8c8c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-textLink-foreground: #5c9ce6;
  --vscode-tab-activeBorderTop: #4d8bf0;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #04395e;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
  --vscode-editor-findMatchBackground: #515c6a;
  --vscode-editor-findMatchHighlightBackground: rgba(234, 92, 0, 0.33);
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-orange: #d18616;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-purple: #b180d7;
  --vscode-charts-pink: #d16d9e;
  --vscode-charts-aqua: #4ec9b0;
  --vscode-charts-apricot: #ffb74d;
  --vscode-charts-lightgreen: #b5cea8;
  --vscode-notebookStatusSuccessIcon-foreground: #89d185;
  --vscode-testing-iconPassed: #73c991;
}
/* harness 自己的布局脚手架（不是产品样式）：把面板高度交给生产 .trajectory-view 的 flex 链。 */
html, body, #root { height: 100%; }
#root { overflow: hidden; }
.m06-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.m06-panel > .trajectory-view { flex: 1 1 auto; min-height: 0; }
`;

// ───────────────────────── 页面 + runner ─────────────────────────

/** 页面外壳：两个挂载点 + 结果区；结果同时写进 `window.__M06__`。 */
export const BROWSER_PAGE_SOURCE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>M06 browser end-to-end harness</title>
<link rel="stylesheet" href="./vscode-bridge.css" />
<link rel="stylesheet" href="./tokens.css" />
<link rel="stylesheet" href="./app.css" />
<style>
  body { margin: 0; }
  #root { height: 70vh; overflow: hidden; border-bottom: 1px solid #888; }
  #result { white-space: pre-wrap; padding: 8px; font: 12px ui-monospace, monospace; }
  h1 { font-size: 14px; margin: 8px; }
</style>
</head>
<body>
<h1>M06 browser end-to-end harness</h1>
<div id="root"></div>
<h1>result</h1>
<div id="result">running…</div>
<script src="./fixture.js"></script>
<script type="module" src="./runner.js"></script>
</body>
</html>
`;

/**
 * 浏览器 runner 的源码（**生成物**，不是正式源码）。
 *
 * 口径全部写进结果对象：哪些是组件内部打点、哪些只是 harness 对照、哪些没量。
 * 依赖缺失（夹具 / 组件 / 容器 / 生产 CSS / 长模型没有真实滚动）一律记 `failed` + 非 0，
 * 不用 `note` 混过去，也**不做任何合成 fallback**。
 */
export const BROWSER_RUNNER_SOURCE = `/**
 * M06 浏览器整链路 runner（由 scripts/trajectoryPayloadBenchBrowser.ts 生成，勿手改）。
 * 产物落点由 --emit-browser 指定；本文件不在正式源码目录里。
 */
import { Profiler, createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TrajectoryView } from "./webview/Trajectory.js";
import { TextsContext, dictionaryFor } from "./webview/texts.js";
import { UiScaleContext } from "./webview/uiScale.js";
import { trajectoryTurnCells } from "./shared/trajectory.js";
import { trajectoryLedgerRows } from "./webview/trajectoryLedgerRows.js";
import { VIRTUALIZATION_THRESHOLD, VIRTUAL_ROW_HEIGHT, trajectoryRowPositions, trajectoryWindowPlan } from "./webview/trajectoryVirtual.js";
import { deriveTrajectoryTimeline } from "./webview/trajectoryTimeline.js";
import { vendorTurns } from "./webview/trajectoryVendor.js";

var SAMPLE_COUNT = 11;
var WARMUP_COUNT = 2;
var SCROLL_STEPS = 12;
${PROBE_WINDOW_VERDICT_SOURCE}
// 同步阶段（每次 refresh 都会跑）与异步索引阶段分开：索引由节流 timer 驱动，见 m06ProbeWindowVerdict。
var PROBE_IDS = m06ProbeStages.sync;
var INDEX_STAGE = m06ProbeStages.index;
// 组件内部投影的**逻辑行数**见证阶段名（同一份判据源码给出，不在 runner 里再写一遍）。
var LEDGER_STAGE = m06ProbeStages.ledgerRowsStage;
var ALL_ROWS_STAGE = m06ProbeStages.allRowsStage;
var out = {
  tool: "m06-browser-harness",
  version: 3,
  // 初始是 running：半途被读到也必须看得出「还没跑完」，不许看起来像结论。
  status: "running",
  success: false,
  exitCode: 3,
  done: false,
  progress: "starting",
  error: null,
  startedAt: null,
  checks: [],
  notes: [],
  commits: [],
  fixtures: [],
  frameHealth: null,
  environment: null,
  coverage: {},
};
window.__M06__ = out;

var probe = globalThis.__M06_PROBE__;
var now = function () { return performance.now(); };
var nextFrame = function () { return new Promise(function (done) { requestAnimationFrame(function () { done(); }); }); };
var sleep = function (ms) { return new Promise(function (done) { setTimeout(done, ms); }); };

function sha256Hex(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (digest) {
    return Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  });
}

function stats(values) {
  var sorted = values.slice().sort(function (left, right) { return left - right; });
  var pick = function (rank) { return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]; };
  if (sorted.length === 0) pick = function () { return 0; };
  return {
    n: sorted.length,
    samples: values.slice(),
    min: pick(0),
    median: pick(Math.floor((sorted.length - 1) / 2)),
    // 与 Node 侧同一份最近秩定义：小样本下它可能等于 max，不代表尾部百分位。
    p95: pick(Math.ceil(0.95 * sorted.length) - 1),
    max: pick(sorted.length - 1),
  };
}

/** 组件内部投影的逻辑行数见证（syncValue / end(token, value) 记下来的那个数字）。 */
function stageValue(snapshot, stage) {
  var entry = snapshot ? snapshot[stage] : null;
  return entry !== undefined && entry !== null && typeof entry.value === "number" ? entry.value : null;
}

function structureOf(model) {
  var cells = 0;
  var groups = 0;
  var kinds = {};
  for (var t = 0; t < model.turns.length; t += 1) {
    groups += model.turns[t].groups.length;
    for (var g = 0; g < model.turns[t].groups.length; g += 1) {
      var groupCells = model.turns[t].groups[g].cells;
      cells += groupCells.length;
      for (var c = 0; c < groupCells.length; c += 1) {
        var kind = groupCells[c].kind;
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
    }
  }
  return { turns: model.turns.length, groups: groups, cells: cells, requests: model.requests.length, kinds: kinds };
}

function check(id, pass, actual) {
  out.checks.push({ id: id, pass: pass === true, actual: actual });
  return pass === true;
}

function probeDelta(before, after) {
  var delta = {};
  for (var i = 0; i < PROBE_IDS.length; i += 1) {
    var id = PROBE_IDS[i];
    var a = after[id] || { calls: 0, totalMs: 0, samplesMs: [] };
    var b = before[id] || { calls: 0, totalMs: 0, samplesMs: [] };
    delta[id] = {
      calls: a.calls - b.calls,
      totalMs: a.totalMs - b.totalMs,
      samplesMs: a.samplesMs.slice(b.samplesMs.length),
    };
  }
  return delta;
}

function waitFor(predicate, timeoutMs, stepMs) {
  var start = now();
  return new Promise(function (done) {
    (function poll() {
      if (predicate()) return done(true);
      if (now() - start > timeoutMs) return done(false);
      setTimeout(poll, stepMs);
    })();
  });
}

function cssChecks() {
  var links = [];
  var nodes = document.querySelectorAll('link[rel="stylesheet"]');
  for (var i = 0; i < nodes.length; i += 1) links.push(nodes[i].getAttribute("href"));
  var sheets = [];
  try {
    for (var s = 0; s < document.styleSheets.length; s += 1) {
      var href = document.styleSheets[s].href;
      sheets.push(href ? href.split("/").pop() : "(inline)");
    }
  } catch (error) {
    sheets.push("(unreadable)");
  }
  var ledger = document.querySelector(".trajectory-ledger");
  var ledgerStyle = ledger === null ? null : getComputedStyle(ledger);
  return {
    links: links,
    sheetsLoaded: sheets,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    uiScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
    ledgerOverflowY: ledgerStyle === null ? null : ledgerStyle.overflowY,
    ledgerOverflowAuto: ledgerStyle !== null && ledgerStyle.overflowY === "auto",
    ledgerBox: ledger === null ? null : { clientHeight: ledger.clientHeight, scrollHeight: ledger.scrollHeight },
  };
}

var nextLabel = "init";
function onRender(id, phase, actualDuration, baseDuration, startTime, commitTime) {
  out.commits.push({
    label: nextLabel,
    phase: phase,
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    commitTimeMs: commitTime,
    atMs: now(),
  });
}
function lastCommit(label) {
  for (var i = out.commits.length - 1; i >= 0; i -= 1) {
    if (out.commits[i].label === label) return out.commits[i];
  }
  return null;
}

var root = null;
var Harness = null;

function mountHarness(key) {
  flushSync(function () {
    root.render(
      createElement(
        "div",
        { className: "m06-panel" },
        createElement(
          Profiler,
          { id: "TrajectoryView", onRender: onRender },
          createElement(
            TextsContext.Provider,
            { value: dictionaryFor("en") },
            createElement(UiScaleContext.Provider, { value: 1 }, createElement(Harness, { key: key })),
          ),
        ),
      ),
    );
  });
}

async function refreshOnce(wire) {
  var clone = JSON.parse(wire);
  var before = probe.snapshot();
  nextLabel = "refresh";
  var start = now();
  flushSync(function () { window.__M06_SET_MODEL__(clone); });
  var wallMs = now() - start;
  await nextFrame();
  return { wallMs: wallMs, probe: probeDelta(before, probe.snapshot()), commit: lastCommit("refresh") };
}

/**
 * 滚动协议：warmup 2 + samples 11，每份 12 步。
 *
 * 判据不在这里手写：原始样本交给与 Node 侧同一段源码的 m06ScrollWindowVerdict——
 * 它逐 sweep 判真实 applied 非递减（跨 sweep 回到 step1 只作诊断），并用**组件自己
 * 投影的**逻辑行数与同一渲染窗口的 DOM tr.trajectory-row 计数做同单位比较。
 *
 * @param virtualizedExpected - 生产组件会不会走窗口化（hasOlder || allRows.length > 阈值）。
 * @param harnessLedgerRows - harness 另调同一条生产纯函数的交叉校验值（不是组件内部测量）。
 */
async function scrollProtocol(virtualizedExpected, harnessLedgerRows) {
  var ledger = document.querySelector(".trajectory-ledger");
  if (ledger === null) return { measured: false, reason: "no .trajectory-ledger element" };
  var maxScroll = Math.max(0, ledger.scrollHeight - ledger.clientHeight);

  var initSnapshot = probe.snapshot();
  var logicalLedgerRows = stageValue(initSnapshot, LEDGER_STAGE);
  var logicalAllRows = stageValue(initSnapshot, ALL_ROWS_STAGE);
  var initialRenderedRows = document.querySelectorAll("tr.trajectory-row").length;
  var sweep = async function () {
    var steps = [];
    var frames = [];
    var previous = await nextFrame().then(function () { return now(); });
    for (var step = 1; step <= SCROLL_STEPS; step += 1) {
      var target = Math.round((maxScroll * step) / SCROLL_STEPS);
      ledger.scrollTop = target;
      var stamp = await nextFrame().then(function () { return now(); });
      frames.push(stamp - previous);
      previous = stamp;
      steps.push({
        target: target,
        applied: ledger.scrollTop,
        rows: document.querySelectorAll("tr.trajectory-row").length,
        pads: document.querySelectorAll("tr.trajectory-virtual-pad").length,
      });
    }
    var total = 0;
    for (var f = 0; f < frames.length; f += 1) total += frames[f];
    return { steps: steps, frames: frames, ms: total };
  };
  var warmup = [];
  for (var w = 0; w < WARMUP_COUNT; w += 1) warmup.push(await sweep());
  var samples = [];
  for (var i = 0; i < SAMPLE_COUNT; i += 1) samples.push(await sweep());
  var sweepMs = samples.map(function (sample) { return sample.ms; });
  var frameIntervals = [];
  for (var k = 0; k < samples.length; k += 1) frameIntervals = frameIntervals.concat(samples[k].frames);
  var verdict = m06ScrollWindowVerdict({
    warmup: warmup,
    samples: samples,
    maxScroll: maxScroll,
    initialRenderedRows: initialRenderedRows,
    logicalLedgerRows: logicalLedgerRows,
    logicalAllRows: logicalAllRows,
    virtualizedExpected: virtualizedExpected,
    harnessLedgerRows: harnessLedgerRows,
  });
  return {
    measured: true,
    maxScroll: maxScroll,
    clientHeight: ledger.clientHeight,
    scrollHeight: ledger.scrollHeight,
    // warmup（2 份）与 samples（11 份）**原值保留**，raw 帧间隔/每步读数都在里面。
    warmup: warmup,
    samples: samples,
    sweepMsStats: stats(sweepMs),
    frameIntervalsStats: stats(frameIntervals),
    // 墙钟与 CPU 不是一回事：帧间隔是 rAF 墙钟（含 vsync / 合成 / 标签页节流），
    // commit 的 actualDurationMs 才是 React 自己的 CPU 时间。
    wallVsCpu: "frameIntervalsStats is rAF wall-clock spacing; commit.actualDurationMs is React CPU time. Never compare them directly.",
    renderedRowsUnit: "tr.trajectory-row count in the DOM window; compared against the component's own allRows.length (logicalAllRows), NOT cellCount",
    initialRenderedRows: initialRenderedRows,
    logicalLedgerRows: logicalLedgerRows,
    logicalAllRows: logicalAllRows,
    // 判据（与 Node 侧同一段源码）：逐 sweep 单调 + 同单位 logical/rendered 比较。
    verdict: verdict,
    appliedNonzero: verdict.scroll.appliedNonzero,
    appliedMonotone: verdict.scroll.appliedMonotone,
    sweepMonotone: verdict.scroll.sweepMonotone,
    withinSweepDecreases: verdict.scroll.withinSweepDecreases,
    // 跨 sweep 回到 step1 是协议自身的正常回落：**只作诊断**，不判红。
    crossSweepResets: verdict.scroll.crossSweepResets,
    maxPads: verdict.virtual.maxPads,
    minRenderedRows: verdict.virtual.minRenderedRows,
    maxRenderedRows: verdict.virtual.maxRenderedRows,
  };
}

async function measureFixture(entry, index, total) {
  var result = {
    index: index,
    name: "unnamed",
    fixtureBytes: entry && entry.bytes,
    fixtureSha256: entry && entry.sha256,
    wireBytes: 0,
    wireSha256: "",
    structure: null,
    status: "failed",
    reason: null,
    search: null,
    firstLoad: null,
    refresh: null,
    scroll: null,
    control: null,
    style: null,
  };
  var provenance = entry && entry.payload && entry.payload.provenance;
  if (provenance && typeof provenance.fixture === "string") result.name = provenance.fixture;
  try {
    if (!entry || !entry.payload || !entry.payload.model) throw new Error("fixture entry has no model");
    var wire = JSON.stringify(entry.payload.model);
    result.wireBytes = new TextEncoder().encode(wire).length;
    result.wireSha256 = await sha256Hex(wire);
    var model = JSON.parse(wire);
    result.structure = structureOf(model);
    if (!Array.isArray(model.turns) || model.turns.length === 0) throw new Error("fixture model has no turns");

    // 重新挂载：先让空模型进来一次（那一刻的索引建立是**立即**发生的），
    // 再装载真实模型——产品的首次立即建索引与之后的 3 秒节流由此可分辨。
    out.progress = "fixture " + (index + 1) + "/" + total + " " + result.name + ": mounting empty ledger";
    root.render(null);
    await nextFrame();
    probe.reset();
    mountHarness("fixture-" + index);
    await nextFrame();
    var afterMount = probe.snapshot();
    // 空账本挂载这一次立即建索引**只作旁证**，不是真实 model 的索引测量。
    var indexAtMount = afterMount[INDEX_STAGE] || { calls: 0, totalMs: 0, firstAtMs: null, lastAtMs: null };
    result.style = cssChecks();

    // 首次装载真实模型（真实收帧解析 → commit）。
    var clone = JSON.parse(wire);
    var beforeFirst = probe.snapshot();
    // **筛选起点**：生产把真实 model 交给组件的那一刻（probe 时钟，必须取在首载 commit 之前——
    // 生产的搜索 effect 就在这次 commit 之后立刻调度 timer）。它只决定「哪些生产事件属于本夹具」，
    // 不参与延迟计算：延迟永远是那一对 timer 的 firedAt - scheduledAt。
    var modelSetAtMs = probe.now();
    nextLabel = "first-load";
    var firstStart = now();
    flushSync(function () { window.__M06_SET_MODEL__(clone); });
    var firstWallMs = now() - firstStart;
    await nextFrame();
    result.firstLoad = {
      wallMs: firstWallMs,
      probe: probeDelta(beforeFirst, probe.snapshot()),
      commit: lastCommit("first-load"),
      note: "wallMs covers render + React commit + layout effects (flushSync); commit.actualDurationMs is React CPU only.",
    };

    // 搜索索引：**单独观察真实 model 那一次生产 timer 的 schedule → fire → update 落地配对**。
    // 判据量是那一对 timer 的 fireDelayMs（生产自己调度 → 自己回调）；modelSetAt 只用来把
    // 本夹具这一轮的生产事件从整个 witness 里**筛出来**（不能用「某次快照之后的长度」切片：
    // 快照若取在首载 rAF 之后，schedule 已被计入基线，列表会整段为空而 pair 还在）。
    out.progress = "fixture " + (index + 1) + "/" + total + " " + result.name + ": waiting for the throttled index update";
    var fired = await waitFor(function () {
      var stage = probe.snapshot()[INDEX_STAGE];
      return stage !== undefined && stage.calls > indexAtMount.calls;
    }, 8000, 25);
    var afterThrottle = probe.snapshot()[INDEX_STAGE] || { calls: indexAtMount.calls, totalMs: indexAtMount.totalMs, lastAtMs: null };
    var witnessAfterSet = probe.searchWitness();
    result.search = {
      mountEmptyCalls: indexAtMount.calls,
      mountEmptyAtMs: indexAtMount.firstAtMs,
      // ── 诊断（**不是判据起点**）：model set 之后的延迟含首载后的调度推迟，与首载耗时并列。──
      modelSetAtMs: modelSetAtMs,
      firstLoadWallMs: firstWallMs,
      delayAfterModelSetMs: afterThrottle.lastAtMs === null ? null : afterThrottle.lastAtMs - modelSetAtMs,
      diagnosticsNote: "modelSetAt/delayAfterModelSetMs and firstLoadWallMs are diagnostics only: the judged delay is the selected pair's firedAt - scheduledAt, never modelSetAt.",
      throttledExecuted: fired,
      callsAfterModelSet: afterThrottle.calls - indexAtMount.calls,
      cpuMsAfterModelSet: afterThrottle.totalMs - indexAtMount.totalMs,
      updateCallsTotal: afterThrottle.calls,
      // ── 生产调度见证：**原始 runtime 输出 + 筛选起点**，由判据自己筛（runner 不另写一套筛选）。──
      scheduleWitness: {
        modelSetAtMs: modelSetAtMs,
        witness: witnessAfterSet,
        note: "raw probe.searchWitness() output. The verdict windows these events by modelSetAtMs (production model set) and judges the pair's firedAt - scheduledAt; fire alone is not execution — the paired searchIndex.update(...) must have returned true. Coalesced (pending timer reused) and cancelled timers are recorded but never counted as executed.",
      },
      note: "The empty-ledger mount builds the index immediately (context only). The real model's update is measured on its own production timer: schedule -> fire -> landed update, with delay + CPU + calls.",
    };

    // refresh：同一份模型内容、**新对象身份**；预热 2 次后采 11 份。
    var refreshWarmup = [];
    for (var warm = 0; warm < WARMUP_COUNT; warm += 1) refreshWarmup.push(await refreshOnce(wire));
    var refreshSamples = [];
    for (var sample = 0; sample < SAMPLE_COUNT; sample += 1) refreshSamples.push(await refreshOnce(wire));
    result.refresh = {
      warmup: refreshWarmup,
      samples: refreshSamples,
      wallMsStats: stats(refreshSamples.map(function (row) { return row.wallMs; })),
      reactActualDurationMsStats: stats(refreshSamples.map(function (row) { return row.commit === null ? 0 : row.commit.actualDurationMs; })),
      probePerSample: refreshSamples.map(function (row) { return row.probe; }),
    };
    // refresh 批次之后那次节流更新是**观察项**（afterRefreshExecuted / updatesDuringRefresh），
    // 不是 checks 里的判据：判据是上面首载那一次生产 timer 的 schedule -> fire -> landed
    // （身份经 pairBinding 核对）。这里等它落地只为如实报告，等不到不改变通过与否。
    // **允许多个 refresh 批次被节流合并成一次更新**：不要求 11 次，也不许为了绿去强造 11 次。
    out.progress = "fixture " + (index + 1) + "/" + total + " " + result.name + ": waiting for the throttled refresh batch";
    var refreshBatches = refreshWarmup.length + refreshSamples.length;
    var beforeRefreshWait = (probe.snapshot()[INDEX_STAGE] || { calls: afterThrottle.calls }).calls;
    var refreshLanded = await waitFor(function () {
      var stage = probe.snapshot()[INDEX_STAGE];
      return stage !== undefined && stage.calls > beforeRefreshWait;
    }, 8000, 25);
    var finalIndex = probe.snapshot()[INDEX_STAGE] || { calls: beforeRefreshWait };
    result.search.refreshBatches = refreshBatches;
    result.search.updatesDuringRefresh = finalIndex.calls - afterThrottle.calls;
    result.search.afterRefreshCalls = finalIndex.calls;
    result.search.afterRefreshExecuted = refreshLanded;
    result.search.finalUpdateCalls = finalIndex.calls;
    result.search.mergeNote = "Production throttling may merge several refresh batches into one update: one landed update (fewer than the batch count) is the expected behaviour and is recorded as mergedBatches.";

    // 对照：harness 自己调生产纯函数（明确**不是**组件内部那一次，只作交叉校验）。
    var controlStart = now();
    var controlRows = trajectoryLedgerRows({ turns: model.turns, collapsedTurns: new Set(), collapsedCalls: new Set(), matchIndexes: null });
    var controlLedgerMs = now() - controlStart;
    var controlTimelineStart = now();
    var controlSpans = deriveTrajectoryTimeline(model.turns, "sequence").spans.length;
    var controlTimelineMs = now() - controlTimelineStart;
    var controlVendorStart = now();
    var controlTurns = vendorTurns(model.turns, function (title) { return String(title && title.kind ? title.kind : ""); });
    var controlVendorMs = now() - controlVendorStart;
    result.control = {
      kind: "harness-invoked-production-pure-functions (NOT the component-internal call)",
      ledgerRows: { rows: controlRows.length, ms: controlLedgerMs },
      timelineSequence: { spans: controlSpans, ms: controlTimelineMs },
      vendorTurns: { turns: controlTurns.length, ms: controlVendorMs },
    };

    // 生产组件的虚拟化触发条件：hasOlder || allRows.length > VIRTUALIZATION_THRESHOLD。
    // 逻辑行数取自**组件自己**的投影见证（view.allRows），不是 harness 的镜象。
    var witnessNow = probe.snapshot();
    var logicalLedgerRows = stageValue(witnessNow, LEDGER_STAGE);
    var logicalAllRows = stageValue(witnessNow, ALL_ROWS_STAGE);
    var virtualizedExpected = (model.hasOlder === true) || (logicalAllRows !== null && logicalAllRows > VIRTUALIZATION_THRESHOLD);

    // 真实滚动（容器就是生产那个 .trajectory-ledger）；判据与 Node 侧同一段源码。
    result.scroll = await scrollProtocol(virtualizedExpected, controlRows.length);

    // ── 该夹具自己的判据 ──────────────────────────────────────────────
    var prefix = "M06.fixture." + result.name + ".";
    var firstProbe = result.firstLoad.probe;
    // 归因窗口判据由**与 Node 侧红/绿对照同一段源码**算出：同步阶段看 11 份 refresh 样本，
    // 索引更新单独观察生产 timer 的 schedule → fire → 落地配对，合并批次是合法结果。
    var probeVerdict = m06ProbeWindowVerdict({
      firstLoadProbe: firstProbe,
      refreshProbes: refreshSamples.map(function (row) { return row.probe; }),
      search: result.search,
    });
    result.probeVerdict = probeVerdict;
    // 判据选中的那一对生产事件回填给父级直接读（**只是拷贝**，筛选仍只由判据源码做一次）。
    result.search.scheduleWitness.selectedPair = probeVerdict.index.selectedPair;
    check(prefix + "internal-probes", probeVerdict.pass === true, probeVerdict);
    // 索引那一份单独再报一次，用的是**同一个 verdict 对象**：两条 check 不可能再各说一套
    // （真实首跑就是 internal-probes 红、search-throttle 绿）。
    check(prefix + "search-throttle", probeVerdict.indexFailures.length === 0, {
      index: probeVerdict.index,
      indexFailures: probeVerdict.indexFailures,
      mergedBatchesAllowed: true,
      judgeStart: "production setTimeout schedule -> fire -> landed searchIndex.update, with the pair's timer identity verified against the raw schedule/fire events (NOT modelSetAt, NOT firstLoad, NOT the pair's own matched label)",
    });

    var scroll = result.scroll;
    if (scroll.measured !== true) {
      check(prefix + "real-scroll", false, scroll);
      check(prefix + "virtual-window", false, scroll);
    } else {
      check(prefix + "real-scroll", scroll.verdict.scroll.pass === true, {
        scrollRequired: virtualizedExpected,
        maxScroll: scroll.maxScroll,
        appliedNonzero: scroll.appliedNonzero,
        appliedMonotone: scroll.appliedMonotone,
        sweepMonotone: scroll.sweepMonotone,
        withinSweepDecreases: scroll.withinSweepDecreases,
        crossSweepResets: scroll.crossSweepResets,
        warmup: scroll.warmup.length,
        samples: scroll.samples.length,
        failures: scroll.verdict.scroll.failures,
        note: "per-sweep applied monotonicity; cross-sweep resets are diagnostics (the protocol restarts at step 1).",
      });
      check(prefix + "virtual-window", scroll.verdict.pass === true, {
        applicable: scroll.verdict.applicable,
        outcome: scroll.verdict.outcome,
        virtualizedExpected: virtualizedExpected,
        logicalLedgerRows: scroll.logicalLedgerRows,
        logicalAllRows: scroll.logicalAllRows,
        initialRenderedRows: scroll.initialRenderedRows,
        minRenderedRows: scroll.minRenderedRows,
        maxRenderedRows: scroll.maxRenderedRows,
        maxPads: scroll.maxPads,
        maxScroll: scroll.maxScroll,
        harnessLedgerRows: controlRows.length,
        renderedRowsUnit: scroll.renderedRowsUnit,
        failures: scroll.verdict.virtual.failures,
        virtualizationProof: scroll.verdict.applicable === true,
        note: scroll.verdict.applicable === true
          ? "Virtual window: real overflow + virtual pads + rendered window strictly below the component's own logical allRows (same unit)."
          : "N/A: this model is below the virtualization threshold and renders every logical row; this check only verifies zero pads + full render consistency and is NOT virtualization performance evidence.",
      });
    }

    result.status = out.checks.filter(function (row) { return row.id.indexOf(prefix) === 0; }).every(function (row) { return row.pass; })
      ? "passed"
      : "failed";
    result.reason = result.status === "passed" ? null : "one or more fixture checks failed";
  } catch (error) {
    result.reason = String(error && error.stack ? error.stack : error);
    result.status = "failed";
    check("M06.fixture." + result.name + ".threw", false, { error: result.reason });
  }
  return result;
}

async function main() {
  out.startedAt = new Date().toISOString();
  out.environment = {
    href: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  };
  out.coverage.measuredHere = [
    "JSON string frame parse (same shape as the host {type:'trajectory', json} frame)",
    "production TrajectoryView first load and same-content refresh, measured through React commits",
    "component-internal probes injected by esbuild onLoad (timeline / vendorTurns / ledgerRows / allRows / commit layout effect / search index update)",
    "component-internal logical row witnesses (trajectoryLedgerRows length + allRows.length) compared in the same unit with the DOM tr.trajectory-row window",
    "production search-index throttle witness: setTimeout schedule -> callback fire -> searchIndex.update returned true, paired by nonce/timer id",
    "real ledger container continuous scrolling: per-sweep applied monotonicity, window plan, pad rows, frame intervals",
    "rAF frame-health sampling",
    "control: production pure functions invoked explicitly by the harness (NOT the component-internal call)",
  ];
  out.coverage.notMeasuredHere = [
    "VS Code webview host IPC",
    "real VS Code theme injection and font metrics",
    "row height / memory",
    "non-fixture real user data beyond the fixtures passed to --emit-browser",
  ];
  out.coverage.offlineBridge = {
    kind: "offline-css-variable-bridge (NOT VS Code IPC)",
    stylesheets: ["./vscode-bridge.css", "./tokens.css", "./app.css"],
    baseFontSizePx: 13,
    note: "tokens.css and app.css are byte-identical copies of the production files; the theme variables and the 13px base come from the harness bridge.",
  };
  out.coverage.measurementBuild = {
    reactDom: "react-dom/profiling (so React Profiler onRender reports real commit durations)",
    note: "The shipped webview uses the non-profiling react-dom build; this substitution is measurement infrastructure, not product behaviour.",
  };

  var fixtures = Array.isArray(window.__FIXTURES__) ? window.__FIXTURES__ : [];
  check("M06-fixture-present", fixtures.length > 0, { count: fixtures.length });
  if (fixtures.length === 0) throw new Error("no fixture payload was emitted");

  root = createRoot(document.getElementById("root"));
  Harness = function (props) {
    var state = useState(undefined);
    window.__M06_SET_MODEL__ = state[1];
    return createElement(TrajectoryView, {
      model: state[0],
      sessionId: "m06-harness",
      locale: "en",
      onLoadEarlier: function () {},
      loadingEarlier: false,
    });
  };

  check("M06-probe-runtime-present", probe !== undefined && typeof probe.snapshot === "function", { present: probe !== undefined });

  for (var index = 0; index < fixtures.length; index += 1) {
    out.progress = "fixture " + (index + 1) + "/" + fixtures.length + ": starting";
    out.fixtures.push(await measureFixture(fixtures[index], index, fixtures.length));
    out.progress = "fixture " + (index + 1) + "/" + fixtures.length + ": status=" + out.fixtures[index].status;
  }

  var style = cssChecks();
  var componentPresent = document.querySelector(".trajectory-view") !== null && document.querySelector(".trajectory-ledger") !== null;
  check("M06-component-mounted", componentPresent, {
    view: document.querySelector(".trajectory-view") !== null,
    ledger: document.querySelector(".trajectory-ledger") !== null,
    rows: document.querySelectorAll("tr.trajectory-row").length,
  });
  check(
    "M06-css-production-bytes-loaded",
    style.sheetsLoaded.indexOf("tokens.css") >= 0 && style.sheetsLoaded.indexOf("app.css") >= 0 && style.links.length >= 3,
    style,
  );
  check(
    "M06-css-production-applied",
    style.ledgerOverflowAuto === true && style.bodyFontSize === "13px",
    { bodyFontSize: style.bodyFontSize, rootFontSize: style.rootFontSize, uiScale: style.uiScale, ledgerOverflowY: style.ledgerOverflowY, ledgerBox: style.ledgerBox },
  );
  check("M06-commit-profiler", out.commits.length > 0, { commits: out.commits.length, phases: out.commits.map(function (row) { return row.phase; }) });
  check(
    "M06-sample-protocol",
    out.fixtures.every(function (fixture) {
      return fixture.refresh !== null
        && fixture.refresh.warmup.length === WARMUP_COUNT
        && fixture.refresh.samples.length === SAMPLE_COUNT
        && fixture.scroll !== null
        && fixture.scroll.measured === true
        && fixture.scroll.warmup.length === WARMUP_COUNT
        && fixture.scroll.samples.length === SAMPLE_COUNT;
    }),
    { samples: SAMPLE_COUNT, warmup: WARMUP_COUNT, p95Definition: "nearest-rank: sorted[ceil(0.95*n)-1]; with n=11 p95 === max", fixtures: out.fixtures.map(function (fixture) { return fixture.name; }) },
  );
  check(
    "M06-all-fixtures-measured",
    out.fixtures.length === fixtures.length && out.fixtures.every(function (fixture) { return fixture.status === "passed"; }),
    { emitted: fixtures.length, measured: out.fixtures.length, statuses: out.fixtures.map(function (fixture) { return fixture.name + ":" + fixture.status; }) },
  );
  check(
    "M06-no-synthetic-fallback",
    out.fixtures.every(function (fixture) { return typeof fixture.wireSha256 === "string" && fixture.wireSha256.length === 64 && fixture.structure !== null && fixture.structure.turns > 0; }),
    { note: "every measured fixture came from window.__FIXTURES__; the runner never synthesises a model" },
  );

  out.status = out.checks.every(function (row) { return row.pass; }) ? "passed" : "failed";
  out.error = out.status === "passed" ? null : out.checks.filter(function (row) { return !row.pass; }).map(function (row) { return row.id; }).join(",");
}

// 帧健康：一段 rAF 空闲采样（标签页被节流时整体偏大，如实记录）。
async function frameHealth() {
  var idle = [];
  var previous = await nextFrame().then(function () { return now(); });
  for (var index = 0; index < 60; index += 1) {
    var stamp = await nextFrame().then(function () { return now(); });
    idle.push(stamp - previous);
    previous = stamp;
  }
  out.frameHealth = stats(idle);
}

function finish() {
  // 半途出错时 status 还停在 running：收尾必须落成一个**结论**，不许留着 running。
  if (out.status === "running") out.status = "failed";
  out.done = true;
  out.success = out.status === "passed";
  out.exitCode = out.success ? 0 : 3;
  out.finishedAt = new Date().toISOString();
  window.__M06_DONE__ = true;
  var node = document.getElementById("result");
  if (node) node.textContent = JSON.stringify(out, null, 2);
}

main()
  .then(frameHealth)
  .then(finish)
  .catch(function (error) {
    out.error = String(error && error.stack ? error.stack : error);
    out.notes.push("runner threw: this run does not count as passed");
    finish();
  });
`;

/** 一份已写出的工件（路径 + 摘要，供见证）。 */
export interface BrowserArtifact {
  file: string;
  bytes: number;
  sha256: string;
}

/** bundle 与它实际折进去的生产源码字节见证。 */
export interface BrowserBundleResult {
  artifact: BrowserArtifact;
  folded: FoldedSourceWitness[];
}

/** emit 的输入选项。 */
export interface EmitBrowserOptions {
  /** 显式钉住 `derive.sha256`（与 Node 量测同一个 `--expect-derive-sha256`）。 */
  expectDeriveSha256?: string;
}

/** emit 失败的规则码（**只带规则名与序号，不带路径**）。 */
export type BrowserEmitErrorCode =
  | "no-fixture"
  | "fixture-unreadable"
  | "duplicate-fixture-path"
  | "not-qualified"
  | "style-missing"
  | "instrumentation-failed";

/** emit 失败：CLI 按 `code` 给固定双语文案并退非 0，**不把本机路径写进输出**。 */
export class BrowserEmitError extends Error {
  readonly code: BrowserEmitErrorCode;
  readonly ordinal?: number;
  readonly refusals: readonly BenchRefusal[];
  readonly detail?: string;
  constructor(code: BrowserEmitErrorCode, options: { ordinal?: number; refusals?: readonly BenchRefusal[]; detail?: string } = {}) {
    super(`browser emit refused: ${code}`);
    this.name = "BrowserEmitError";
    this.code = code;
    if (options.ordinal !== undefined) this.ordinal = options.ordinal;
    this.refusals = options.refusals ?? [];
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

// ───────────────────────── 现场打包（含私有打点） ─────────────────────────

/** 定位仓库根：`package.json` + 两个已知源文件同时存在。 */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "dsh", "trajectory.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo root not found");
}

/** 折入 bundle 的生产模块：入口里的相对说明符 → 仓库当前源码。 */
function productionSpecifiers(repoRoot: string): Map<string, string> {
  return new Map<string, string>([
    ["./webview/Trajectory.js", join(repoRoot, "src/webview/components/Trajectory.tsx")],
    ["./webview/texts.js", join(repoRoot, "src/webview/texts.ts")],
    ["./webview/uiScale.js", join(repoRoot, "src/webview/uiScale.ts")],
    ["./webview/trajectoryLedgerRows.js", join(repoRoot, "src/webview/trajectoryLedgerRows.ts")],
    ["./webview/trajectoryVirtual.js", join(repoRoot, "src/webview/trajectoryVirtual.ts")],
    ["./webview/trajectoryTimeline.js", join(repoRoot, "src/webview/trajectoryTimeline.ts")],
    ["./webview/trajectoryVendor.js", join(repoRoot, "src/webview/trajectoryVendor.ts")],
    ["./shared/trajectory.js", join(repoRoot, "src/shared/trajectory.ts")],
    ["./vendor/search-index.js", join(repoRoot, "src/vendor/ui-trajectory/trajectory-search-index.ts")],
  ]);
}

/**
 * react-dom 的**测量用**桥：把 `react-dom` / `react-dom/client` 指到 profiling 构建，
 * 让 React Profiler 的 `onRender` 真的报 commit 时长。
 *
 * 为什么用一层显式 shim 而不是直接 alias：`react-dom/profiling.js` 是 `module.exports = require(...)`
 * 形态，具名 import 靠 esbuild 的 CJS 词法分析不可靠；显式 `import * as` 再转出最稳。
 */
const REACT_DOM_SHIM_SOURCE = `import * as ReactDOMProfiling from "react-dom/profiling";
export const createRoot = ReactDOMProfiling.createRoot;
export const flushSync = ReactDOMProfiling.flushSync;
export const hydrateRoot = ReactDOMProfiling.hydrateRoot;
export const createPortal = ReactDOMProfiling.createPortal;
export default ReactDOMProfiling;
`;

interface RunnerBundle {
  artifact: BrowserArtifact;
  bytes: Buffer;
  folded: FoldedSourceWitness[];
}

/**
 * 在一个**临时工作目录**里把 runner 打成 bundle（含私有打点）。
 *
 * 放临时目录是为了「拒绝时零工件」：emit 在打包（可能因锚点缺命中失败）成功之后
 * 才往目标目录写第一个字节。
 */
async function buildRunnerBundle(workDir: string, runnerSourceText: string): Promise<RunnerBundle> {
  const repoRoot = findRepoRoot();
  const runnerSource = join(workDir, "runner.src.js");
  writeFileSync(runnerSource, runnerSourceText, "utf8");
  const stubPath = join(workDir, "vscode-stub.js");
  writeFileSync(stubPath, "export default {};\n", "utf8");
  const shimPath = join(workDir, "react-dom-profiling-shim.js");
  writeFileSync(shimPath, REACT_DOM_SHIM_SOURCE, "utf8");

  const require = createRequire(import.meta.url);
  // **必须用异步 `build`**：esbuild 的同步 API 不接受插件，而折入见证与打点正是靠插件做的。
  const esbuild = require("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };

  const specifiers = productionSpecifiers(repoRoot);
  const declared = new Map<string, string>();
  for (const [specifier, absolute] of specifiers) declared.set(resolve(absolute), specifier);
  const pointsByFile = new Map<string, InstrumentationPoint[]>();
  for (const point of INSTRUMENTATION_POINTS) {
    const absolute = resolve(join(repoRoot, point.file));
    const list = pointsByFile.get(absolute) ?? [];
    list.push(point);
    pointsByFile.set(absolute, list);
  }

  const folded = new Map<string, FoldedSourceWitness>();
  const failures: string[] = [];
  const plugin: Plugin = {
    name: "m06-map-production-sources-and-instrument-onload",
    setup(build) {
      build.onResolve({ filter: /^\.\/.*\.js$/ }, (args) => {
        const absolute = specifiers.get(args.path);
        return absolute === undefined ? undefined : { path: absolute };
      });
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath }));
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: shimPath }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: shimPath }));
      build.onLoad({ filter: /\.(ts|tsx)$/ }, (args) => {
        const raw = readFileSync(args.path);
        const absolute = resolve(args.path);
        const specifier = declared.get(absolute);
        const points = pointsByFile.get(absolute) ?? [];
        let contents = raw.toString("utf8");
        let hits: InstrumentationHit[] = [];
        if (points.length > 0) {
          const transformed = instrumentSource(contents, points);
          contents = transformed.text;
          hits = transformed.hits;
          for (const hit of hits) {
            if (hit.anchorHits !== 1) failures.push(`${hit.id}×${hit.anchorHits}`);
          }
        }
        if (specifier !== undefined && !folded.has(specifier)) {
          const transformedBytes = Buffer.from(contents, "utf8");
          folded.set(specifier, {
            file: relative(repoRoot, args.path).replace(/\\/g, "/"),
            bytes: transformedBytes.length,
            sha256: createHash("sha256").update(transformedBytes).digest("hex"),
            instrumented: points.length > 0,
            originalBytes: raw.length,
            originalSha256: createHash("sha256").update(raw).digest("hex"),
            instrumentation: hits,
          });
        }
        return {
          contents,
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };

  const outfile = join(workDir, "runner.js");
  await esbuild.build({
    entryPoints: [runnerSource],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome120",
    logLevel: "silent",
    jsx: "automatic",
    absWorkingDir: repoRoot,
    // 生成物在临时/工件目录里，bare import（react / react-dom）要从仓库的 node_modules 解析。
    nodePaths: [join(repoRoot, "node_modules")],
    // 与生产 webview 同一个 NODE_ENV 口径：量的是 production 分支的 React。
    define: { "process.env.NODE_ENV": "\"production\"" },
    // **必须压缩**：esbuild 在不压缩时会在每个内联模块前写一行 `// <路径>` 注释，
    // 而 runner 的入口/空壳来自一次性临时目录——那行注释会把临时路径写进产物，
    // 于是**同一份源码两次 emit 得到不同的 bundle 摘要**（见证不可复现，还会带出本机路径）。
    // 压缩也顺带更贴近真正发布的 webview（esbuild.mjs 发布档就是 minify）。
    // 打点阶段名都是字符串字面量，属性名不参与压缩改名，归因不受影响。
    minify: true,
    legalComments: "none",
    banner: { js: PROBE_RUNTIME_SOURCE },
    plugins: [plugin],
  });
  if (failures.length > 0) {
    // 缺命中 / 多命中：直接判死（打点没折进去的 bundle 不许被当成「已归因」）。
    throw new BrowserEmitError("instrumentation-failed", { detail: failures.sort().join(",") });
  }
  const bytes = readFileSync(outfile);
  return {
    artifact: { file: outfile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    bytes,
    folded: [...folded.values()].sort((left, right) => (left.file < right.file ? -1 : 1)),
  };
}

/**
 * 现场把 `directory/runner.src.js` 打成 `directory/runner.js`（esbuild API，产物只落该目录）。
 *
 * 打点与折入见证都在 `buildRunnerBundle` 里；这里只是「目录形态」的入口。
 */
export async function bundleBrowserRunner(directory: string): Promise<BrowserBundleResult> {
  const target = resolve(directory);
  const runnerSource = join(target, "runner.src.js");
  if (!existsSync(runnerSource)) throw new Error("runner.src.js missing");
  const bundle = await buildRunnerBundle(target, readFileSync(runnerSource, "utf8"));
  writeFileSync(join(target, "runner.js"), bundle.bytes);
  return { artifact: { file: join(target, "runner.js"), bytes: bundle.artifact.bytes, sha256: bundle.artifact.sha256 }, folded: bundle.folded };
}

// ───────────────────────── 工件写出 ─────────────────────────

/** 一份夹具在 emit 时的登记（**不含绝对路径**）。 */
interface EmittedFixture {
  name: string;
  bytes: number;
  sha256: string;
  payload: unknown;
}

function sha256OfFile(file: string): { bytes: number; sha256: string } {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fixtureNameOf(payload: unknown): string {
  const provenance = payload !== null && typeof payload === "object" ? (payload as { provenance?: unknown }).provenance : undefined;
  const name = provenance !== null && typeof provenance === "object" ? (provenance as { fixture?: unknown }).fixture : undefined;
  return typeof name === "string" && name !== "" ? name : "unnamed";
}

/**
 * 把夹具与页面写到 `directory`。
 *
 * **闸门与 Node 量测同一套**（`qualifyFixturePayload`：完整登记校验 + `payloadReduced === false`
 * + `payloadMeasurementEligible === true` + `truncatedFields` 为空），并支持同一个
 * `--expect-derive-sha256` pin。**所有输入在第一次写盘之前全部检查完**；任何拒绝 → 零工件。
 * 多份夹具**逐份**过闸门并**逐份**写进 `fixture.js`，runner 侧逐份量测。
 *
 * **只写这个目录**：不碰 `test/preview.html`、不碰任何正式源码 / 产物目录。
 */
export async function emitBrowserArtifacts(
  directory: string,
  fixtures: readonly string[],
  options: EmitBrowserOptions = {},
): Promise<string[]> {
  const target = resolve(directory);
  const repoRoot = findRepoRoot();
  if (fixtures.length === 0) throw new BrowserEmitError("no-fixture");

  // ── 1) 输入全部读完、全部过闸门（**写盘之前**） ──────────────────────
  const seen = new Set<string>();
  const entries: EmittedFixture[] = [];
  const refusals: BenchRefusal[] = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    const ordinal = index + 1;
    const absolute = resolve(fixtures[index] as string);
    if (seen.has(absolute)) throw new BrowserEmitError("duplicate-fixture-path", { ordinal });
    seen.add(absolute);
    const read = readFixtureFile(absolute);
    if (read === undefined) throw new BrowserEmitError("fixture-unreadable", { ordinal });
    const qualification = qualifyFixturePayload(
      read.payload,
      options.expectDeriveSha256 === undefined ? {} : { expectDeriveSha256: options.expectDeriveSha256 },
    );
    if (!qualification.eligible) {
      for (const reason of qualification.reasons) refusals.push({ ordinal, reason });
      continue;
    }
    entries.push({ name: fixtureNameOf(read.payload), bytes: read.bytes, sha256: read.sha256, payload: read.payload });
  }
  if (refusals.length > 0) throw new BrowserEmitError("not-qualified", { refusals });

  // ── 2) 生产样式：先确认读得到（也发生在写盘之前） ────────────────────
  const styles: { file: string; source: string; bytes: number; sha256: string }[] = [];
  for (const source of PRODUCTION_STYLE_SOURCES) {
    const absolute = join(repoRoot, source);
    if (!existsSync(absolute)) throw new BrowserEmitError("style-missing", { detail: source.split("/").pop() ?? source });
    const meta = sha256OfFile(absolute);
    styles.push({ file: source.split("/").pop() ?? source, source, bytes: meta.bytes, sha256: meta.sha256 });
  }
  const bridgeBytes = Buffer.from(VSCODE_BRIDGE_CSS, "utf8");

  // ── 3) 打点 + 打包（可能因锚点缺命中失败；此时还没写任何目标文件） ──
  const workDir = mkdtempSync(join(tmpdir(), "m06-browser-emit-"));
  let bundle: RunnerBundle;
  try {
    bundle = await buildRunnerBundle(workDir, BROWSER_RUNNER_SOURCE);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // ── 4) 到这一步才写盘 ──────────────────────────────────────────────
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  const write = (name: string, contents: string): void => {
    const file = join(target, name);
    writeFileSync(file, contents, "utf8");
    written.push(file);
  };
  const copy = (source: string, name: string): void => {
    const file = join(target, name);
    copyFileSync(source, file);
    written.push(file);
  };
  // `fixture.js` 是普通脚本（不是模块）：把载荷直接赋给全局，避免 fetch / CORS 面。
  // 只登记**名字 + 字节 + 摘要**，不把本机路径带进工件。
  write(
    "fixture.js",
    `window.__FIXTURES__ = ${JSON.stringify(entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256, payload: entry.payload })))};\n`,
  );
  write("index.html", BROWSER_PAGE_SOURCE);
  write("runner.src.js", BROWSER_RUNNER_SOURCE);
  write("react-dom-profiling-shim.js", REACT_DOM_SHIM_SOURCE);
  write("README.txt", readmeText());
  for (const style of styles) copy(join(repoRoot, style.source), style.file);
  const bridge = join(target, "vscode-bridge.css");
  writeFileSync(bridge, bridgeBytes);
  written.push(bridge);
  const runnerFile = join(target, "runner.js");
  writeFileSync(runnerFile, bundle.bytes);
  written.push(runnerFile);
  const witness = {
    generatedBy: "scripts/trajectoryPayloadBenchBrowser.ts",
    toolVersion: 2,
    entry: "runner.src.js",
    fixtures: entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })),
    derivePinned: options.expectDeriveSha256 !== undefined,
    expectDeriveSha256: options.expectDeriveSha256 ?? null,
    bundle: { file: "runner.js", bytes: bundle.artifact.bytes, sha256: bundle.artifact.sha256 },
    styles: [
      ...styles.map((style) => ({ ...style, generated: false })),
      {
        file: "vscode-bridge.css",
        source: null,
        generated: true,
        bytes: bridgeBytes.length,
        sha256: createHash("sha256").update(bridgeBytes).digest("hex"),
        note: "offline theme-variable + 13px bridge; NOT VS Code IPC",
      },
    ],
    instrumentation: bundle.folded
      .filter((entry) => entry.instrumented)
      .map((entry) => ({
        file: entry.file,
        originalBytes: entry.originalBytes,
        originalSha256: entry.originalSha256,
        transformedBytes: entry.bytes,
        transformedSha256: entry.sha256,
        hits: entry.instrumentation,
      })),
    foldedProductionSources: bundle.folded,
  };
  write("browser-witness.json", `${JSON.stringify(witness, null, 2)}\n`);
  return written;
}

/** 工件清单（人读说明；跑法与覆盖边界都在这里）。 */
function readmeText(): string {
  return [
    "M06 浏览器整链路工件（由 trajectoryPayloadBenchBrowser 写出；写出本身不运行浏览器）。",
    "",
    "真实测得：JSON 字符串帧解析、生产 TrajectoryView 首次装载与同内容 refresh（真实 React commit）、",
    "          真实账本连续滚动（窗口计划 / 垫行 / 帧间隔）、rAF 帧健康采样。",
    "组件内部归因：esbuild onLoad 在内存里折入私有打点（view.timeline / view.vendorTurns /",
    "          view.ledgerRows / view.allRows / view.commitLayoutEffect / vendor.searchIndex.update）；",
    "          每个锚点必须恰好命中一次，见证在 browser-witness.json 的 instrumentation。",
    "对照不是归因：control.harnessInvoked 由 harness 自己发起，不是组件内部那一次调用。",
    "样式：tokens.css 与 app.css 是**同字节生产副本**；vscode-bridge.css 是**离线桥**（主题变量 + 13px），",
    "      不是 VS Code IPC。",
    "测量用构建：react-dom 走 profiling 构建，好让 React Profiler 真的报 commit 时长（不是产品行为）。",
    "",
    "跑法：",
    "  1) node build/trajectory-payload-bench.mjs --fixture <夹具.json> [--fixture …] --emit-browser <本目录>",
    "     （夹具先过与 Node 量测同一套资格闸门；不过闸门则零工件）",
    "  2) node build/trajectory-payload-bench.mjs --serve-browser <本目录> [--port <n>]",
    "  3) 浏览器打开打印出来的 URL；完成后 window.__M06_DONE__ 为 true，结果在 window.__M06__。",
    "     判据：window.__M06__.status / success / exitCode（0 通过，3 失败）与 checks[]。",
    "",
    "边界：",
    "  - 依赖缺失（夹具 / 组件 / 容器 / 生产 CSS）或长模型没有真实滚动 / 虚拟窗口 → status=failed、exitCode=3；",
    "    没有合成 fallback，也不会只用 note + done=true 混过去。",
    "  - 本工具不生成夹具、不读用户日志。",
  ].join("\n");
}

// ───────────────────────── 静态服务器 ─────────────────────────

/**
 * 服务器路由判定（**纯函数**）：请求路径 → 该服务哪个文件 / 什么状态码。
 *
 * 与 socket 无关，因此「只服务工件目录」这条判据在禁止回环连接的环境里也照样有牙。
 */
export function resolveServedFile(directory: string, requestPath: string): { status: number; file?: string } {
  const target = resolve(directory);
  const raw = requestPath.split("?")[0] ?? "/";
  const name = raw === "/" || raw === "" ? "index.html" : raw.replace(/^\/+/, "");
  const file = resolve(join(target, name));
  const relativeToTarget = relative(target, file);
  /**
   * 目录包含性判据用**精确的上级判定**：只有 `..` 本身或 `..<分隔符>` 开头才算「在外」。
   * 不能写成 `startsWith("..")`——那会把工件目录里名字以两个点开头的合法文件
   * （`..%2Fpackage.json` 这种纯字面名）也判成越界，安全侧固然偏保守，但判据就不精确了。
   */
  const escapes = relativeToTarget === ""
    || relativeToTarget === ".."
    || relativeToTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeToTarget);
  if (escapes) return { status: 403 };
  return existsSync(file) ? { status: 200, file } : { status: 404 };
}

/** 工件目录里各扩展名的 content-type。 */
function contentTypeOf(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** 服务启动失败的规则码（CLI 据此给固定双语文案）。 */
export type BrowserServerErrorCode = "bind-failed" | "never-listening";

/** 服务启动失败：**可判定**的失败，不带系统原文回显。 */
export class BrowserServerError extends Error {
  readonly code: BrowserServerErrorCode;
  readonly detail: string;
  constructor(code: BrowserServerErrorCode, detail: string) {
    super(`browser artifacts server failed: ${code}`);
    this.name = "BrowserServerError";
    this.code = code;
    this.detail = detail;
  }
}

/** 起好的静态服务器：`url` 里的端口就是**实际绑定**的那一个。 */
export interface BrowserServer {
  url: string;
  port: number;
  close: () => void;
}

/**
 * 零依赖静态服务器：**只服务 `directory` 内的文件**、绑 `127.0.0.1`。
 *
 * **异步等到 `listening` 之后**才读 `server.address()`：那之前地址还没有真实端口
 * （`--port 0` 时读出来是 0，用它公布 URL 会把实连打到别的监听者上）。
 * 绑不上（EADDRINUSE / EACCES / …）→ 抛 `BrowserServerError`，不假装起好了。
 *
 * @param directory - 工件目录。
 * @param port - 端口；`0` = 让系统挑一个空闲端口。
 */
export async function serveBrowserArtifacts(directory: string, port: number): Promise<BrowserServer> {
  const target = resolve(directory);
  const require = createRequire(import.meta.url);
  const http = require("node:http") as typeof import("node:http");
  const server = http.createServer((request, response) => {
    const decision = resolveServedFile(target, request.url ?? "/");
    if (decision.status !== 200 || decision.file === undefined) {
      response.writeHead(decision.status).end(decision.status === 403 ? "forbidden" : "not found");
      return;
    }
    try {
      response.writeHead(200, { "content-type": contentTypeOf(decision.file) }).end(readFileSync(decision.file));
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((done, fail) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      fail(new BrowserServerError("bind-failed", error.code ?? "unknown"));
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  }).catch((error: unknown) => {
    server.close();
    throw error;
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    server.close();
    throw new BrowserServerError("never-listening", address === null ? "address-null" : typeof address);
  }
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    port: address.port,
    close: () => server.close(),
  };
}

/** 供 CLI 使用的拒测文案（与量测共用同一条 `refusalText`：同一闸门、同一套话术）。 */
export function browserRefusalText(refusals: readonly BenchRefusal[]): string {
  return refusalText(refusals);
}
