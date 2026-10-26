import { useSyncExternalStore } from "react";
import { imageRefLabel, isRemoteImageRef } from "../shared/imageRef";
import { post, subscribe } from "./bridge";
import type { Texts } from "./texts";

/**
 * 正文里**本地图片**引用的解析（webview 侧）。
 *
 * markdown 渲染出来的 `<img src="out/chart.png">` 在 webview 里是死链：它会被
 * 解析成 `vscode-webview://…/out/chart.png`。这里把这类引用交给宿主读成 data URL
 * （宿主侧以执行世界读取与 Host 报告的媒体类型为准，见 `dsh/localImages.ts`），再把
 * DOM 上的 `src` 换掉。
 *
 * 五个必须的约束：
 * - **缓存按范围隔离**：范围是「执行世界连接 + 会话」两张牌一起定的——相对路径的基准
 *   是会话创建目录，而同一会话在另一条连接里也属于另一套执行世界（宿主广播
 *   `images/scope`，会话 id 随 `state` / `patch` 帧同步）；
 * - **读不到的也记一笔**（空串）：否则每次重渲染（流式期间每个 token 都重渲染）
 *   都会把同一个不存在的路径再问一遍宿主；
 * - **失败要有降级**：外链被 CSP 拦、文件被删、超上限，都得说一句「图片加载失败」，
 *   而不是留一个破图图标；**知道是哪一张时把引用缀在后面**（见 `failedImageText`）；
 * - **回帧之前浏览器那次失败不算数**：原始引用必然加载不了，而它失败得比宿主回帧早，
 *   先降级就会把数据 URL 甩在一个已经不在文档里的元素上（见 `hydrateLocalImages`）；
 * - **换范围结算旧请求**：旧请求的 Promise 必须结算（否则调用方的 `.then` 永远悬着），
 *   而且旧闭包、迟到帧都不许写进新范围的缓存。
 */

/** 引用原文 → data URL；空串表示「宿主确认读不了」。 */
const cache = new Map<string, string>();

/** 在途请求：请求号 → 发起时的范围与结算动作。 */
const pending = new Map<number, PendingRequest>();
let nextRequestId = 1;

interface PendingRequest {
  /** 发起时的范围键（见 `scopeKeyOf`）。 */
  readonly scopeKey: string;
  readonly connectionId: string | null;
  readonly sessionId: string;
  /** 本次问到 + 上次命中的表（结算时与回帧合并）。 */
  readonly known: Record<string, string>;
  /** 本次要问的引用（回帧里缺席的记成空串，避免每帧重问）。 */
  readonly missing: string[];
  readonly resolve: (urls: Record<string, string>) => void;
}

/**
 * 当前范围：`connectionId` 由宿主的 `images/scope` 帧决定（`null` = 还没连上执行世界），
 * `sessionId` 是 `state.session.id`（空串 = 还没进任何会话）。
 */
let connectionId: string | null = null;
let sessionId = "";
let scopeVersion = 0;

const scopeListeners = new Set<() => void>();

/** 范围键：`null` 与空串是两件事，用 JSON 数组编码避免分隔串碰撞。 */
function scopeKeyOf(connection: string | null, session: string): string {
  return JSON.stringify([connection, session]);
}

function currentScopeKey(): string {
  return scopeKeyOf(connectionId, sessionId);
}

/**
 * 换范围：清缓存、结算在途请求（空表）、通知订阅者。
 *
 * 结算不是简单丢掉回调——那样 `resolveLocalImages` 的 promise 永远不结算；这里把它们
 * 结算成**空表**（图落到加载失败，重新水合时按新范围重新请求）。旧闭包在结算时**不写
 * 缓存**（见 `isCurrentScope`），迟到帧同理（见 `images/resolved` 的订阅）。
 *
 * 订阅者（`components/Markdown.tsx` 的正文块、`components/Images.tsx` 的图库）靠版本号
 * 重新设置 innerHTML 并水合，所以「已换过的 data URL」与「已经落地的失败占位」都会被
 * 重新读一遍，而不是停在旧范围的结论上。
 */
function applyScope(nextConnectionId: string | null, nextSessionId: string): void {
  if (nextConnectionId === connectionId && nextSessionId === sessionId) return;
  connectionId = nextConnectionId;
  sessionId = nextSessionId;
  cache.clear();
  const inFlight = [...pending.values()];
  pending.clear();
  scopeVersion += 1;
  for (const listener of scopeListeners) listener();
  // 结算旧 Promise：结果一律空表，绝不能让发起时的闭包写进新范围的缓存
  for (const entry of inFlight) entry.resolve({});
}

/**
 * 范围的版本号与订阅（`useSyncExternalStore` 的数据源）。
 *
 * 任何一次范围变化（连接换代、会话切换）都 +1；组件按它重新水合。
 */
export function localImageScopeVersion(): number {
  return scopeVersion;
}

export function subscribeLocalImageScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

/** 当前范围版本：正文块与图库在依赖里带上它，范围一变就重新解析。 */
export function useLocalImageScopeVersion(): number {
  return useSyncExternalStore(subscribeLocalImageScope, localImageScopeVersion, localImageScopeVersion);
}

/**
 * 宿主帧 → 范围。
 *
 * `images/scope` 定连接；`state` / `patch` 在**消费帧的那一刻**同步会话 id——不能等
 * App 的 effect：子组件的 `useLayoutEffect` 先于父 effect 跑，那一刻会话还没登记，
 * 正文里的图就会按上一个范围解析（甚至被当成范围不完整而整批失败）。
 */
subscribe((message) => {
  if (message.type === "images/scope") {
    const next = message.connectionId;
    if (next !== null && typeof next !== "string") return;
    applyScope(next, sessionId);
    return;
  }
  if (message.type === "state") {
    const snapshot = message.state;
    if (typeof snapshot !== "object" || snapshot === null) return;
    applyScope(connectionId, snapshot.session?.id ?? "");
    return;
  }
  if (message.type === "patch") {
    const patch = message.patch;
    if (typeof patch !== "object" || patch === null) return;
    if (!Object.prototype.hasOwnProperty.call(patch, "session")) return;
    applyScope(connectionId, patch.session?.id ?? "");
    return;
  }
  if (message.type !== "images/resolved") return;
  // 逐字段验形状：外部帧不可信，坏的整条丢（在途请求留在表里，只由换范围结算）
  if (!Number.isSafeInteger(message.requestId)) return;
  if (message.connectionId !== null && typeof message.connectionId !== "string") return;
  if (typeof message.sessionId !== "string") return;
  const urls = message.urls;
  if (typeof urls !== "object" || urls === null || Array.isArray(urls)) return;
  if (!Object.values(urls).every((url) => typeof url === "string")) return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  // 迟到帧 / 换过范围：帧里回带的连接与会话必须与发起时完全一致，否则拒收（空表）。
  if (!isCurrentScope(entry)) {
    entry.resolve({});
    return;
  }
  if (message.connectionId !== entry.connectionId || message.sessionId !== entry.sessionId) {
    entry.resolve({});
    return;
  }
  // 只认**这次真的问过**的键：多带的路径不属于本次请求，不许借回帧写进缓存。
  const answered: Record<string, string> = {};
  for (const path of entry.missing) {
    const url = urls[path];
    if (typeof url !== "string") continue;
    if (url) {
      cache.set(path, url);
      answered[path] = url;
    } else {
      // 空串把「读不了」也长记性，避免每帧重问
      cache.set(path, "");
    }
  }
  // 回帧里缺席的同样记成「读不了」，否则每帧都会重问同一个不存在的路径
  for (const path of entry.missing) if (!(path in answered) && !cache.has(path)) cache.set(path, "");
  entry.resolve({ ...entry.known, ...answered });
});

/** 发起请求的那个范围是否仍是当前范围。 */
function isCurrentScope(entry: PendingRequest): boolean {
  return entry.scopeKey === currentScopeKey();
}

/** 范围是否已经齐了：没有执行世界连接或还没进会话时，请求不会有结果。 */
function scopeReady(): boolean {
  return connectionId !== null && sessionId !== "";
}

/** 向宿主换一批本地引用。返回「本次问到 + 上次缓存」的表（读不到、读不了的不在表里）。 */
export function resolveLocalImages(paths: readonly string[]): Promise<Record<string, string>> {
  const known: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths) {
    const hit = cache.get(path);
    if (hit) known[path] = hit;
    else if (hit === undefined) missing.push(path);
  }
  if (!missing.length) return Promise.resolve(known);
  // 范围还没齐（首次 state / 连接帧未到）：不发请求，直接结算成空表。等范围到位，
  // `images/scope` / `state` 帧会让版本号 +1，正文与图库按新范围重新解析。
  if (!scopeReady()) return Promise.resolve({});
  const requestId = nextRequestId++;
  const requestConnection = connectionId;
  const requestSession = sessionId;
  return new Promise((resolve) => {
    pending.set(requestId, {
      scopeKey: scopeKeyOf(requestConnection, requestSession),
      connectionId: requestConnection,
      sessionId: requestSession,
      known,
      missing,
      resolve,
    });
    post({
      type: "resolveImages",
      requestId,
      connectionId: requestConnection,
      sessionId: requestSession,
      paths: [...missing],
    });
  });
}

/**
 * 加载失败的降级文案：**知道是哪一张时把引用缀在后面**。
 *
 * 正文里可能有好几张图，一句「加载失败」分不出是谁；排查时也没法把它和宿主日志
 * 里的路径对上。引用经 `imageRefLabel` 规整（`data:` 与空引用没有可缀的东西，
 * 退回不带路径那一句）。正文（`hydrateLocalImages`）与图库（`components/Images.tsx`）
 * 共用这一份，免得两条路各写一套。
 */
export function failedImageText(texts: Texts, ref: string | undefined): string {
  const label = ref ? imageRefLabel(ref) : undefined;
  return label ? texts.imageLoadFailedAt(label) : texts.imageLoadFailed;
}

/**
 * 把一段注入的 HTML 里的本地图片引用换成 data URL，并给**任何**加载失败的图
 * （本地读不到、外链被 CSP 拦）挂一句降级文案。返回清理函数（调用方在
 * `<img>` 树被替换或组件卸载时调用）。
 *
 * 范围变化时调用方必须重新水合（`hooks` 依赖范围版本，且重设 innerHTML）：
 * 缓存已被清空，这里再跑一遍就是按新连接 / 新会话重新问宿主。等待中的 promise
 * 若在清理后回帧，`cancelled` 会挡住 DOM 写入，不会覆盖新范围的结果。
 *
 * @param root 已渲染的容器（`dangerouslySetInnerHTML` 的那个 div）。
 * @param texts 词典：失败文案取 `imageLoadFailed` / `imageLoadFailedAt`（渲染器不写死）。
 */
export function hydrateLocalImages(root: HTMLElement, texts: Texts): () => void {
  let cancelled = false;
  /**
   * 正在等宿主回帧的图。
   *
   * 浏览器对**原始引用**必然失败：相对路径在 `vscode-webview://` 下拿不到东西
   * （CSP 的 `img-src` 里也没有它），失败事件在毫秒级就到；而宿主那一趟是
   * 「IPC → 读盘 → base64 → 回帧」，几十毫秒。抢在回帧之前把图换成降级文案，
   * 数据 URL 到达时元素已经被换掉（`replaceWith` 之后它不在文档里了），
   * 用户看到的就是「文件明明还在却加载失败」。
   *
   * 所以这期间来的失败**不是结论**——结论只有一个：宿主怎么回答。
   */
  const awaiting = new Set<HTMLImageElement>();
  const onError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && !awaiting.has(target)) markFailed(target, texts);
  };
  // 图片资源的 error **不冒泡**，只能在捕获阶段接（这是唯一能统一兜住
  // 「外链 + 本地图」两种失败的挂法）
  root.addEventListener("error", onError, true);

  const groups = new Map<string, HTMLImageElement[]>();
  const ready = scopeReady();
  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!src || isRemoteImageRef(src)) continue;
    // 原始引用记在元素上：`src` 马上会被换成 data URL，而失败文案要缀的是
    // **用户认得出的那个引用**（一条几兆的 data URL 缀上去毫无意义）。
    image.dataset.imageRef = src;
    const hit = cache.get(src);
    if (hit !== undefined) {
      if (hit) image.setAttribute("src", hit);
      else markFailed(image, texts);
      continue;
    }
    // 范围没齐：先不动它（不发请求、不降级），范围到了会带新版本再水合一次。
    // 但要先记进 `awaiting`：范围未就绪时浏览器对原始引用的那次失败同样不是结论，
    // 否则会先闪一片「图片加载失败」，之后又被新范围的结果替换掉。
    if (!ready) {
      awaiting.add(image);
      continue;
    }
    const list = groups.get(src) ?? [];
    list.push(image);
    groups.set(src, list);
    awaiting.add(image);
  }

  if (groups.size) {
    void resolveLocalImages([...groups.keys()]).then((urls) => {
      if (cancelled) return;
      for (const [src, nodes] of groups) {
        const url = urls[src];
        for (const node of nodes) {
          // 先结清「等回帧」，再落地：`src` 换成 data URL 之后如果还失败（字节坏了），
          // 那次失败才是真的，照旧走 `markFailed`。
          awaiting.delete(node);
          if (url) node.setAttribute("src", url);
          else markFailed(node, texts);
        }
      }
    });
  }

  return () => {
    cancelled = true;
    root.removeEventListener("error", onError, true);
  };
}

/** 把一张加载不了的图换成一句占位文字（比破图图标可读，也不会撑出空白）。 */
function markFailed(image: HTMLImageElement, texts: Texts): void {
  if (image.dataset.imageFailed === "1") return;
  image.dataset.imageFailed = "1";
  // 优先用换 `src` 之前记下的原始引用；外链没换过 `src`，属性本身就是引用
  const ref = image.dataset.imageRef ?? image.getAttribute("src") ?? "";
  const fallback = document.createElement("span");
  fallback.className = "image-failed";
  fallback.textContent = failedImageText(texts, ref);
  // 悬停仍给**原样**的引用（规整过的路径未必能直接拿去打开）
  if (ref) fallback.title = ref;
  image.replaceWith(fallback);
}
