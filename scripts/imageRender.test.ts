/**
 * 会话里**图片**的渲染断言（服务端渲染，无浏览器）。
 *
 * 为什么要有这一层：图片这条链路的失效方式全是「静默」的——用户发了一张图，
 * 界面上只有一个文件名芯片；模型回一张图，什么都不显示。源码正则能证明「代码里
 * 有这么一行」，但证明不了「用户真能看见一张图」。这里把消息真渲染一遍，
 * 断言落在产出的 HTML 上。
 *
 * 覆盖三处来源（都是同一条 `ImageGallery`）：
 * 1. **用户发出的图**（durable 附件 → `session/attachment` → data URL）；
 * 2. **助手消息里的 image 块**（`images` 段）；
 * 3. **工具结果里的图**（`tool.images`，由 `toolView.test.ts` 覆盖数据侧，
 *    这里钉「折叠态一个 `<img>` 都不渲染、展开态才渲染」这一条，2026-09-21 口径）。
 *
 * 以及两条降级口径：
 * - 字节还没回来（`dataUrl` 为空）→ 退回文件名芯片，**不画** `<img>`；
 * - 助手图库的空位（空串）→ 不渲染任何东西。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageView, ToolCallView } from "../src/shared/chat";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

// `bridge.ts` 在模块求值期就挂了 `window.addEventListener`（webview 里那是真实存在的
// 宿主）。无头环境里补一个最小 window，免得 import 阶段就炸——补在 import 之前。
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { Message } = await import("../src/webview/components/Message");
const { ToolRow } = await import("../src/webview/components/Rows");

/** 渲染一条消息的 HTML。 */
const render = (message: MessageView, locale: "zh" | "en" = "zh"): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor(locale) },
      createElement(Message, { message }),
    ),
  );

/**
 * SSR 下 `useLayoutEffect` 会打一条「does nothing on the server」的警告。
 *
 * 本文件渲染的是真组件（用户气泡里就有一个 useLayoutEffect，用来量高度），
 * 这条警告是**预期**的、与断言无关；不静音的话 `npm test` 的输出会被它淹掉。
 */
function quietly<T>(run: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const userMessage = (attachments: MessageView["attachments"]): MessageView => ({
  id: "u:1",
  role: "user",
  ts: Date.now(),
  text: "",
  segments: [],
  attachments,
});

// ---------- 1. 用户发出的图片：真画一张图（而不是文件名芯片） ----------
{
  const html = quietly(() =>
    render(
      userMessage([
        {
          id: "m0",
          kind: "image",
          name: "classroom_black_00001_.png",
          attachmentId: "sha256:034860c",
          mediaType: "image/jpeg",
          width: 1024,
          height: 1024,
          dataUrl: JPEG,
        },
      ]),
    ),
  );
  assert.ok(html.includes(`<img src="${JPEG}"`), `用户图片必须渲染成 <img>，实际：${html}`);
  assert.ok(html.includes('class="image-thumb"'), "缩略图要包在可点开的按钮里（原图预览入口）");
  assert.ok(
    html.includes('alt="classroom_black_00001_.png"'),
    "无障碍文本用附件名（比「消息里的图片」有信息量）",
  );
  assert.ok(
    !html.includes("chip-name"),
    "已经是真图了就不该再画一个文件名芯片（同一份附件画两遍）",
  );
  console.log("image: 用户发出的图片渲染为缩略图 ✓");
}

// ---------- 2. 字节还没到 / 取不到：退回文件名芯片，不画碎图 ----------
{
  const html = quietly(() =>
    render(
      userMessage([
        { id: "m0", kind: "image", name: "pending.png", attachmentId: "sha256:x", mediaType: "image/png" },
      ]),
    ),
  );
  assert.ok(!html.includes("<img"), `没有字节时不能画 <img>（会是一个碎图图标），实际：${html}`);
  assert.ok(html.includes("pending.png"), "退回文件名芯片：用户至少知道发出去的是什么");
  console.log("image: 字节未到时退回文件名芯片 ✓");
}

// ---------- 3. 文件附件仍是芯片（图片化不能把文件也带上） ----------
{
  const html = quietly(() =>
    render(userMessage([{ id: "m0", kind: "file", name: "merge-plan.pdf", bytes: 284417 }])),
  );
  assert.ok(html.includes("merge-plan.pdf"), "文件附件显示文件名");
  assert.ok(!html.includes("<img"), "文件附件不该被画成图片");
  console.log("image: 文件附件仍是芯片 ✓");
}

// ---------- 4. 助手消息里的图片块：`images` 段渲染成图库 ----------
{
  const message: MessageView = {
    id: "a:1",
    role: "assistant",
    ts: Date.now(),
    segments: [{ kind: "images", id: "img1", images: [PNG] }],
  };
  const html = quietly(() => render(message));
  assert.ok(html.includes(`<img src="${PNG}"`), `助手图片块必须渲染，实际：${html}`);
  assert.ok(html.includes("row-body-images"), "与工具行图库共用同一套呈现");
  console.log("image: 助手消息里的图片块渲染为图库 ✓");
}

// ---------- 5. 图库里的空位不画（占位帧不该闪碎图） ----------
{
  const message: MessageView = {
    id: "a:2",
    role: "assistant",
    ts: Date.now(),
    segments: [{ kind: "images", id: "img1", images: ["", ""] }],
  };
  const html = quietly(() => render(message));
  assert.ok(!html.includes("<img"), `空位（字节未到）不该渲染 <img>，实际：${html}`);
  assert.ok(!html.includes("row-body-images"), "全是空位时整块图库都不该出现");
  console.log("image: 图库空位不渲染 ✓");
}

// ---------- 6. 工具结果里的图：**折叠态不渲染，展开才渲染** ----------
//
// 用户 2026-09-21 口径：结果里的图（`read_image` / 截图这类调用的产出）跟着展开态走。
// 这条**取代** 2026-09-18 的「图渲染在行下方、折叠态就看得见」——当时是「agent 发来的图
// 看不到」，现在要的正是折叠态不渲染（图多的时候收起的一片图占地方、也要解码）。
// 所以这里两个态都渲染一遍，把双向都钉住：
// - 收起（`open: undefined`，行收到的默认态）→ 连 `<img>` 都不许有；
// - 展开（`open: true`）→ 图库要出现在展开体里。
{
  const tool: ToolCallView = {
    id: "call_img",
    name: "read_image",
    title: "",
    detail: "demo-photo.jpg",
    status: "ok",
    input: '{"file_path":"demo-photo.jpg"}',
    output: "<path>demo-photo.jpg</path>",
    images: [PNG],
  };
  const renderTool = (open: boolean | undefined): string =>
    quietly(() =>
      renderToStaticMarkup(
        createElement(
          TextsContext.Provider,
          { value: dictionaryFor("zh") },
          createElement(ToolRow, {
            // 展开态平时由 `Message` 持有（见 src/webview/nodeOpen.ts）；
            // 这里单独渲染一行，给一份指定的端口。
            node: { open, openedWhileActive: false, setOpen: () => undefined },
            tool,
          }),
        ),
      ),
    );

  const closed = renderTool(undefined);
  assert.ok(
    !closed.includes("<img") && !closed.includes("row-body-images"),
    `折叠态不许渲染图片（这条口径要的就是它），实际：${closed}`,
  );
  assert.ok(closed.includes("demo-photo.jpg"), "折叠态至少要有这行的标题（读的是哪个文件）");

  const opened = renderTool(true);
  assert.ok(opened.includes(`<img src="${PNG}"`), `展开态必须画这张图，实际：${opened}`);
  assert.ok(opened.includes("row-body-images"), "与其它来源共用同一套图库呈现");
  assert.ok(
    opened.indexOf("row-body-images") > opened.indexOf("</button>"),
    "图库要在行头**之下**的展开体里，而不是行头里面",
  );
  console.log("image: 工具结果里的图折叠态不渲染、展开才渲染 ✓");
}

// ---------- 6b. 只有图的调用仍可展开（否则图永远看不见） ----------
//
// `Row` 的展开由 `hasBody` 把关：图片不算进去的话，「只有图、没有别的正文」的调用
// 会变成一行点不开的节点——图渲染得出、但用户永远打不开，是最难发现的那种失效。
// 这里对源码下断言（SSR 渲染不到点击行为）。
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /\(tool\.images\?\.length \?\? 0\) > 0 \|\|/.test(rows),
    "图片必须算进 hasBody：只有图的调用也要点得开",
  );
}
console.log("image: 只有图的调用可展开 ✓");

// ---------- 7. 两语文案都在（加载失败 / 原图预览） ----------
{
  const zh = dictionaryFor("zh");
  const en = dictionaryFor("en");
  for (const [name, texts] of [["zh", zh], ["en", en]] as const) {
    assert.ok(texts.imagePreview.trim(), `${name}: 缺 imagePreview`);
    assert.ok(texts.imagePreviewClose.trim(), `${name}: 缺 imagePreviewClose`);
    assert.ok(texts.imageLoadFailed.trim(), `${name}: 缺 imageLoadFailed`);
  }
  assert.notStrictEqual(zh.imageLoadFailed, en.imageLoadFailed, "中英文案不能是同一串");
  console.log("image: 图片相关文案中英齐备 ✓");
}

console.log("\nimage-render: all assertions passed");
