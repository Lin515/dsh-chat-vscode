import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import { IconClose } from "../icons";
import {
  bindImagePreviewReset,
  closeImagePreview,
  imagePreviewValue,
  openImagePreview,
  panImageView,
  resetImageView,
  subscribeImagePreview,
  zoomImageView,
  type ImagePreviewValue,
  type ImageView,
  type ImageViewGeometry,
} from "../imagePreview";
import { failedImageText, resolveLocalImages } from "../localImages";
import { useTexts } from "../texts";

/**
 * 会话里的图片：用户发出的、模型给的、工具回带的、正文里引用的。
 *
 * 三处合成**一套**呈现，而不是各画一个 `<img>`：缩略图尺寸、点击放大、加载失败
 * 降级这三件待遇必须完全一致（`docs/AGENTS.md` 的「同语义元素待遇一致性」）。
 * 此前用户消息里的图只显示一个文件名芯片，工具行与助手消息各画一遍 `<img>`。
 *
 * `src` 可能是三种东西，组件不区分（浏览器也不该区分）：
 * - `data:` URL——服务端 durable 附件（`session/attachment` 换回来的字节）；
 * - `https:` URL——模型写在 markdown 里的外链（渲染时已加 `no-referrer`）；
 * - `data:` URL——宿主按会话创建目录读回来的本地文件图（见 `dsh/localImages.ts`）。
 */

export interface ImageSource {
  src: string;
  /** 无障碍文本；缺省用调用方给的通用文案。 */
  alt?: string;
  /**
   * 这张图对应的**引用**（磁盘路径 / 正文里的原文）。
   *
   * 只有调用方知道才给：服务端附件与工具回带的图是 `data:` URL，没有路径可缀；
   * 本地文件图（`LocalImageGallery`）给得出来。加载失败时它缀在降级文案后面。
   */
  ref?: string;
  /** 固有宽高：字节到达前按它占位，免得图加载完把消息顶一下。 */
  width?: number;
  height?: number;
}

/** 缩略图图库。空 `src`（字节还没回来）不占位——先闪一个碎图图标更难看。 */
export function ImageGallery({ sources, alt }: { sources: ImageSource[]; alt: string }) {
  const texts = useTexts();
  const [failed, setFailed] = useState<Record<number, true>>({});
  const [loaded, setLoaded] = useState<Record<number, true>>({});
  const shown = sources.filter((source) => source.src);
  if (!shown.length) return null;
  return (
    <div className="row-body-images">
      {shown.map((source, index) =>
        failed[index] ? (
          // 外链被 CSP 拦掉、本地文件被删、字节取不回来……都落到这里。
          // 不显示碎图图标，也不静默：说一句「加载失败」比一个灰框有用；
          // 知道是哪一张（`ref`）就把引用一起说出来。
          <span className="image-failed" key={index} title={source.ref}>
            {failedImageText(texts, source.ref)}
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="image-thumb"
            // 缩略图**一律**单击出原图浮层：放大看是这里最常见的动作，用户消息里的图
            // 也一样。「在编辑器里打开」是**附件芯片**的动作（`../attachmentOpen.ts`），
            // 别把两种入口合成一个——那样用户就只是想把图看大一点，却弹出整个编辑器。
            title={texts.imagePreview}
            onClick={() => openImagePreview(source.src, source.alt ?? alt)}
          >
            <img
              src={source.src}
              alt={source.alt ?? alt}
              loading="lazy"
              decoding="async"
              // 占用位比例只用**在字节到齐之前**：真实尺寸由图片自己给出。
              // 不摘掉的话，元数据与真实比例不一致的图会被 aspect-ratio 拉伸变形
              // （服务端按 mediaType 归一化过格式，宽高却可能不是原始比例）。
              style={
                !loaded[index] && source.width && source.height
                  ? { aspectRatio: `${source.width} / ${source.height}` }
                  : undefined
              }
              onLoad={() => setLoaded((prev) => (prev[index] ? prev : { ...prev, [index]: true }))}
              onError={() => setFailed((prev) => ({ ...prev, [index]: true }))}
            />
          </button>
        ),
      )}
    </div>
  );
}

/**
 * 磁盘上的图片文件 → 图库（文件路径先经宿主读成 data URL）。
 *
 * 用途是**agent 交付图片**的两种表达：`present` 申报的文件、以及本轮 write 出来的
 * 文件。实测（2026-09-18）agent 被要求"发一张图"时做的正是这两件事——下载一张 jpg、
 * 写一张 svg、再 `present` 它们——而界面上此前只有两行文件芯片，一张图都看不到。
 * 正文里显式写 `![](…)` 的那条路由 `Markdown` 的 `hydrateLocalImages` 处理，这里
 * 补的是"没有 markdown 引用"的情形。
 *
 * 解析不出来的（工作目录之外、文件被删、超上限）**不渲染任何东西**：那些路径在同一
 * 条消息的文件芯片里照常有名字，这里再画一句「加载失败」只是噪音。
 */
export function LocalImageGallery({ paths }: { paths: string[] }) {
  const texts = useTexts();
  const [urls, setUrls] = useState<Record<string, string>>({});
  // 路径数组每次渲染都是新的：用拼出来的键做依赖，避免每帧重复请求
  const key = paths.join("\n");
  useEffect(() => {
    if (!paths.length) return;
    let cancelled = false;
    // 缓存命中时同步返回（`resolveLocalImages` 会先查缓存），所以重渲染不会重新读盘
    void resolveLocalImages(paths).then((resolved) => {
      if (!cancelled) setUrls(resolved);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const sources = paths
    .filter((path) => urls[path])
    .map((path) => ({ src: urls[path], alt: path, ref: path }));
  return <ImageGallery alt={texts.messageImageAlt} sources={sources} />;
}

/** 浮层几何 + 基准中心（视口坐标）。图片基准中心就是可用区域中心。 */
interface PreviewGeometry extends ImageViewGeometry {
  centerX: number;
  centerY: number;
}

/**
 * 读浮层与图片的当前几何。
 *
 * 图片的 `offsetWidth/offsetHeight` 是**未受 transform 影响**的布局尺寸，正好是倍率 1
 * 时的尺寸；可用区域要去掉浮层的内边距（`max-width/height: 100%` 的百分比基准就是它）。
 * 每次滚轮 / 拖动都现读，窗口尺寸变化后不需要另记一份缓存。
 */
function previewGeometry(overlay: HTMLElement, image: HTMLImageElement): PreviewGeometry {
  const style = getComputedStyle(overlay);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const viewportWidth = Math.max(0, overlay.clientWidth - paddingLeft - paddingRight);
  const viewportHeight = Math.max(0, overlay.clientHeight - paddingTop - paddingBottom);
  const rect = overlay.getBoundingClientRect();
  return {
    width: image.offsetWidth,
    height: image.offsetHeight,
    viewportWidth,
    viewportHeight,
    centerX: rect.left + paddingLeft + viewportWidth / 2,
    centerY: rect.top + paddingTop + viewportHeight / 2,
  };
}

/**
 * 原图浮层。挂在 App 根部**一次**，任何来源的图片共用它。
 *
 * 操作口径：滚轮以光标为锚点缩放（向上放大、向下缩小），左键按住放大后的图片拖动，
 * 右键菜单的「复原」把倍率与平移一起清零。拖动只在放大后成立——缩到适配视口或更小
 * 时图片本来就整个可见，拖动只会把它从中间挪开。
 *
 * ESC 归**归属链**（见 `../escapeOwner.ts`）：本层在活跃期间按
 * `ESC_LAYER.imagePreview` 登记，关掉即注销。层级低于右键菜单，于是菜单开在原图上时
 * 一次 ESC 只关菜单、下一次才关它，第三次才轮到「停止生成」。
 */
export function ImagePreviewLayer() {
  const texts = useTexts();
  const [value, setValue] = useState<ImagePreviewValue | null>(imagePreviewValue);
  const [view, setView] = useState<ImageView>(resetImageView);
  const [dragging, setDragging] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef(view);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  /** 拖动松手后浏览器仍可能补一个 click：别让它被当成「点了背景」。 */
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setValue(imagePreviewValue());
    return subscribeImagePreview(setValue);
  }, []);

  const commit = useCallback((next: ImageView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const reset = useCallback(() => {
    dragRef.current = null;
    suppressClickRef.current = false;
    setDragging(false);
    commit(resetImageView());
  }, [commit]);

  // 换一张图（或重新打开）都从适配视口开始；layout effect 保证首帧之前就复位，
  // 不会先闪一下上一张的缩放位置
  useLayoutEffect(() => {
    if (value) reset();
    else {
      dragRef.current = null;
      setDragging(false);
    }
  }, [value, reset]);

  // 右键菜单通过这个端口执行「复原」（菜单在页面级接取，拿不到本组件的 state）
  useEffect(() => bindImagePreviewReset(reset), [reset]);

  // ESC 关预览走归属链：层级在原图浮层这一档——右键菜单开着时（层级更高）先关菜单，
  // 下一次 ESC 才轮到它；没有浮层时才会落到「停止生成」
  useEscapeLayer(ESC_LAYER.imagePreview, value !== null, closeImagePreview);

  // 滚轮必须用原生监听 + passive: false：React 的 onWheel 在根节点上是被动监听，
  // 拦不住 webview 的滚动 / 浏览器缩放。缩放锚在光标上，见 `zoomImageView`。
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !value) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const image = imageRef.current;
      if (!image) return;
      const geometry = previewGeometry(overlay, image);
      if (!geometry.viewportWidth || !geometry.viewportHeight) return;
      // 行 / 页模式换算成像素；鼠标滚轮通常是像素模式（deltaMode 0）
      const deltaY =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * geometry.viewportHeight
            : event.deltaY;
      commit(
        zoomImageView(
          viewRef.current,
          { x: event.clientX - geometry.centerX, y: event.clientY - geometry.centerY },
          deltaY,
          geometry,
        ),
      );
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [value, commit]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    suppressClickRef.current = false;
    // 只接管左键、且只接管放大后的图；缩到适配视口或更小时没有可拖的余量
    if (event.button !== 0 || viewRef.current.scale <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const overlay = overlayRef.current;
    const image = imageRef.current;
    if (!overlay || !image) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dx && !dy) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    commit(panImageView(viewRef.current, dx, dy, previewGeometry(overlay, image)));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    // 拖动结束时不要顺手把浮层关掉：这一次 click 是拖动的尾巴，不是「点背景」
    if (drag.moved) suppressClickRef.current = true;
  };

  if (!value) return null;
  return (
    <div
      ref={overlayRef}
      className={`image-preview${view.scale > 1 ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={texts.imagePreview}
      onPointerDown={() => {
        suppressClickRef.current = false;
      }}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        closeImagePreview();
      }}
    >
      {/* 点图本身不该关掉浮层（只有点背景才关）；拖动后的尾巴 click 同样不允许穿透 */}
      <img
        ref={imageRef}
        src={value.src}
        alt={value.alt}
        draggable={false}
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
        onClick={(event) => {
          event.stopPropagation();
          suppressClickRef.current = false;
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      />
      <button
        type="button"
        className="image-preview-close"
        title={texts.imagePreviewClose}
        aria-label={texts.imagePreviewClose}
        onClick={closeImagePreview}
      >
        <IconClose size={16} />
      </button>
    </div>
  );
}
