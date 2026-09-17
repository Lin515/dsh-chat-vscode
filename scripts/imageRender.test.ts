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
 *    这里只钉「空位不画碎图」这一条）。
 *
 * 以及两条降级口径：
 * - 字节还没回来（`dataUrl` 为空）→ 退回文件名芯片，**不画** `<img>`；
 * - 助手图库的空位（空串）→ 不渲染任何东西。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageView } from "../src/shared/chat";
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

// ---------- 6. 工具结果里的图：**折叠态**就看得见 ----------
//
// `read_image` / 截图这类调用**唯一**的产出就是图。它此前渲染在工具行的展开体里，
// 而展开体默认收起（`Row` 只在 open 时挂 children）——用户 2026-09-18 报的
// 「agent 发来的我看不到」就是这个：图确实渲染了，但要点开那行才出现。
// SSR 渲染的正是**默认收起**态，所以这条断言直接钉住「不展开也看得见」。
{
  const html = quietly(() =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor("zh") },
        createElement(ToolRow, {
          tool: {
            id: "call_img",
            name: "read_image",
            title: "",
            detail: "demo-photo.jpg",
            status: "ok",
            input: '{"file_path":"demo-photo.jpg"}',
            output: "<path>demo-photo.jpg</path>",
            images: [PNG],
          },
        }),
      ),
    ),
  );
  assert.ok(
    html.includes(`<img src="${PNG}"`),
    `工具结果的图必须在**折叠态**就渲染（图库是工具行的兄弟，不是展开体的内容），实际：${html}`,
  );
  assert.ok(html.includes("row-body-images"), "与其它来源共用同一套图库呈现");
  assert.ok(
    !html.includes("io-section"),
    "折叠态不该渲染展开体的 IN/OUT（说明这张图确实被挪出了展开体）",
  );
  console.log("image: 工具结果里的图折叠态可见 ✓");
}

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
