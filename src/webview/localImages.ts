import { isRemoteImageRef } from "../shared/imageRef";
import { post, subscribe } from "./bridge";

/**
 * 正文里**本地图片**引用的解析（webview 侧）。
 *
 * markdown 渲染出来的 `<img src="out/chart.png">` 在 webview 里是死链：它会被
 * 解析成 `vscode-webview://…/out/chart.png`。这里把这类引用交给宿主读成 data URL
 * （宿主侧的白名单与上限见 `dsh/localImages.ts`），再把 DOM 上的 `src` 换掉。
 *
 * 三个必须的约束：
 * - **缓存按会话隔离**：相对路径的基准是会话工作目录，切了会话之后
 *   `out/chart.png` 是另一个文件，沿用旧结果就会张冠李戴（`setLocalImageScope`）；
 * - **读不到的也记一笔**（空串）：否则每次重渲染（流式期间每个 token 都重渲染）
 *   都会把同一个不存在的路径再问一遍宿主；
 * - **失败要有降级**：外链被 CSP 拦、文件被删、超上限，都得说一句「图片加载失败」，
 *   而不是留一个破图图标。
 */

/** 引用原文 → data URL；空串表示「宿主确认读不了」。 */
const cache = new Map<string, string>();
const pending = new Map<number, { scope: string; resolve: (urls: Record<string, string>) => void }>();
let nextRequestId = 1;

/** 当前会话标识（`state.session.id`）。空串 = 还没进任何会话。 */
let scope = "";

/**
 * 会话变了：缓存清空、在途请求作废。
 *
 * 在途请求不是简单丢掉回调——那样 `resolveLocalImages` 的 promise 永远不结算，
 * 调用方的 `.then` 就成了悬空引用；这里把它们**结算成空表**（图落到加载失败，
 * 下一帧按新会话重新请求）。
 *
 * **`"" → id` 这一跳不算「切换」**：界面挂载时子组件的 `useLayoutEffect`
 * （正文里扫图片的那一步）先于 App 的 effect 跑，那一刻 `scope` 还是空的——
 * 把这一批请求当「切了会话」作废掉，正文里的图会**全部**落到「加载失败」
 * （预览页实测踩到）。从空到有只是「会话身份确定了」，不是换了会话。
 */
export function setLocalImageScope(next: string): void {
  if (next === scope) return;
  const previous = scope;
  scope = next;
  cache.clear();
  if (!previous) return;
  const inFlight = [...pending.values()];
  pending.clear();
  for (const entry of inFlight) entry.resolve({});
}

subscribe((message) => {
  if (message.type !== "images/resolved") return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  // 期间切过会话：结果是按另一个工作目录解析的，丢掉（见 setLocalImageScope）。
  // 请求发出时身份还没确定（空 scope）的那批照样接受——那时浏览器里的图正是
  // 当前会话的图，丢掉就白请求了。
  entry.resolve(isCurrentSession(entry.scope) ? message.urls : {});
});

/** 结果是否仍属于当前会话：请求时没有身份（空）也算，见 `setLocalImageScope`。 */
function isCurrentSession(requestScope: string): boolean {
  return !requestScope || requestScope === scope;
}

/** 向宿主换一批本地引用。返回「本次问到 + 上次缓存」的表（读不到的不在表里）。 */
export function resolveLocalImages(paths: readonly string[]): Promise<Record<string, string>> {
  const known: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths) {
    const hit = cache.get(path);
    if (hit) known[path] = hit;
    else if (hit === undefined) missing.push(path);
  }
  if (!missing.length) return Promise.resolve(known);
  const requestId = nextRequestId++;
  const requestScope = scope;
  return new Promise((resolve) => {
    pending.set(requestId, {
      scope: requestScope,
      resolve: (urls) => {
        for (const [path, url] of Object.entries(urls)) cache.set(path, url);
        // 空串把「读不了」也长记性，避免每帧重问
        for (const path of missing) if (!(path in urls)) cache.set(path, "");
        resolve({ ...known, ...urls });
      },
    });
    post({ type: "resolveImages", requestId, paths: [...missing] });
  });
}

/**
 * 把一段注入的 HTML 里的本地图片引用换成 data URL，并给**任何**加载失败的图
 * （本地读不到、外链被 CSP 拦）挂一句降级文案。返回清理函数（调用方在
 * `<img>` 树被替换或组件卸载时调用）。
 *
 * @param root 已渲染的容器（`dangerouslySetInnerHTML` 的那个 div）。
 * @param failedText 加载失败的降级文案（走词典，渲染器不写死）。
 */
export function hydrateLocalImages(root: HTMLElement, failedText: string): () => void {
  let cancelled = false;
  const onError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement) markFailed(target, failedText);
  };
  // 图片资源的 error **不冒泡**，只能在捕获阶段接（这是唯一能统一兜住
  // 「外链 + 本地图」两种失败的挂法）
  root.addEventListener("error", onError, true);

  const groups = new Map<string, HTMLImageElement[]>();
  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!src || isRemoteImageRef(src)) continue;
    const hit = cache.get(src);
    if (hit !== undefined) {
      if (hit) image.setAttribute("src", hit);
      else markFailed(image, failedText);
      continue;
    }
    const list = groups.get(src) ?? [];
    list.push(image);
    groups.set(src, list);
  }

  if (groups.size) {
    void resolveLocalImages([...groups.keys()]).then((urls) => {
      if (cancelled) return;
      for (const [src, nodes] of groups) {
        const url = urls[src];
        for (const node of nodes) {
          if (url) node.setAttribute("src", url);
          else markFailed(node, failedText);
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
function markFailed(image: HTMLImageElement, failedText: string): void {
  if (image.dataset.imageFailed === "1") return;
  image.dataset.imageFailed = "1";
  const fallback = document.createElement("span");
  fallback.className = "image-failed";
  fallback.textContent = failedText;
  // 悬停能看到**是哪一张**（正文里可能有好几张，一句「加载失败」分不出是谁，
  // 排查时也没法把它和宿主日志里的路径对上）
  const src = image.getAttribute("src");
  if (src) fallback.title = src;
  image.replaceWith(fallback);
}
