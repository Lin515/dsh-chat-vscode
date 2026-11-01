/**
 * KaTeX CSS / 字体的受控构建插件（只服务 webview 的 `dist/webview.css`）。
 *
 * 官方 `katex.min.css` 每个 `@font-face` 同时列 WOFF2 / WOFF / TTF。本仓库发布
 * 只保留恰好一个 WOFF2：插件在 esbuild 读取 CSS 时改写 `src`，再由 esbuild 的
 * file loader 复制到 `dist/fonts/<name>-<hash>.woff2`；最终 CSS 里的 URL 是相对
 * 输出样式文件的 `./fonts/...`，不留下 node_modules、绝对路径、CDN 或网络字体。
 *
 * 构建结束后再次从**真实产物**核对：20 个 face、每 face 恰好一个 WOFF2 URL、
 * 每个 URL 在 dist 存在、fonts 目录没有 WOFF / TTF 残留。任一条件不满足直接
 * 报构建错误，避免「CSS 构建成功但字体路径错了」被当作可用。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const KATEX_CSS = /[\\/]katex(?:\.min)?\.css$/u;
const FONT_FACE = /@font-face\s*\{[^}]*\}/gu;
const FONT_URL = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/gu;
const FONT_URL_OUTPUT = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/gu;
const FONT_FILE = /^KaTeX_[A-Za-z0-9-]+\.woff2$/u;
const FONT_OUTPUT_URL = /^\.\/fonts\/[A-Za-z0-9_.@-]+\.woff2$/u;

/**
 * 把官方 KaTeX CSS 的每个 @font-face 收敛为单个 WOFF2，并返回字体文件名。
 * 纯函数，供构建插件与临时复现脚本共用。
 */
export function rewriteKatexFontFaces(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("KaTeX CSS 为空");
  }
  let faces = 0;
  const fontFiles = [];
  const css = source.replace(FONT_FACE, (block) => {
    faces += 1;
    const src = /src\s*:\s*([^;}]+)/u.exec(block);
    if (src === null) throw new Error(`KaTeX @font-face #${faces} 缺少 src`);
    const urls = [...src[1].matchAll(FONT_URL)]
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
      .filter((url) => url !== "");
    const woff2 = urls.filter((url) => /\.woff2$/iu.test(url));
    if (woff2.length !== 1) {
      throw new Error(`KaTeX @font-face #${faces} 需要恰好一个 WOFF2，实际 ${urls.length} 个来源`);
    }
    const url = woff2[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(url)) {
      throw new Error(`KaTeX @font-face #${faces} 含非本地字体 URL`);
    }
    const file = basename(url);
    if (!FONT_FILE.test(file)) {
      throw new Error(`KaTeX @font-face #${faces} 字体名不受控：${file}`);
    }
    fontFiles.push(file);
    const rewritten = block.replace(
      /src\s*:\s*[^;}]+/u,
      `src:url("./fonts/${file}") format("woff2")`,
    );
    if (rewritten === block) throw new Error(`KaTeX @font-face #${faces} 改写失败`);
    return rewritten;
  });
  if (faces !== 20) {
    throw new Error(`KaTeX CSS 需要 20 个 @font-face，实际 ${faces} 个`);
  }
  if (new Set(fontFiles).size !== 20) {
    throw new Error("KaTeX CSS 字体文件不唯一");
  }
  if (/\.woff(?!2)\b|\.ttf\b/iu.test(css)) {
    throw new Error("KaTeX CSS 仍含 WOFF / TTF 来源");
  }
  if (/url\(\s*["']?(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(css)) {
    throw new Error("KaTeX CSS 仍含远程 URL");
  }
  return { css, fontFiles };
}

/**
 * 从真实构建产物核对 KaTeX CSS / 字体：20 个 face、每 face 恰好一个 WOFF2、
 * URL 指向 `./fonts/`、文件存在、没有 WOFF / TTF / 远程 URL。
 */
export function validateKatexAssets(cssFile, fontsDir) {
  const css = readFileSync(cssFile, "utf8");
  const faces = [...css.matchAll(FONT_FACE)];
  if (faces.length !== 20) {
    throw new Error(`${cssFile} 需要 20 个 @font-face，实际 ${faces.length} 个`);
  }
  const referenced = [];
  for (const [block] of faces) {
    const urls = [...block.matchAll(FONT_URL_OUTPUT)]
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim());
    if (urls.length !== 1) {
      throw new Error(`${cssFile} 的 @font-face 需要恰好一个字体 URL，实际 ${urls.length} 个`);
    }
    const url = urls[0];
    if (!FONT_OUTPUT_URL.test(url)) {
      throw new Error(`${cssFile} 的字体 URL 不是相对 ./fonts/ 的 WOFF2：${url}`);
    }
    if (/\.woff(?!2)\b|\.ttf\b/iu.test(block)) {
      throw new Error(`${cssFile} 的 @font-face 仍含 WOFF / TTF 来源`);
    }
    const file = resolve(dirname(cssFile), url);
    if (!existsSync(file)) throw new Error(`字体文件不存在：${file}`);
    referenced.push(file);
  }
  if (new Set(referenced).size !== 20) {
    throw new Error(`${cssFile} 引用的字体文件不唯一`);
  }
  const files = readdirSync(fontsDir);
  const woff2 = files.filter((file) => file.endsWith(".woff2"));
  if (woff2.length !== 20) {
    throw new Error(`${fontsDir} 需要 20 个 WOFF2，实际 ${woff2.length} 个`);
  }
  const legacy = files.filter((file) => /\.(?:woff|ttf)$/iu.test(file));
  if (legacy.length > 0) {
    throw new Error(`${fontsDir} 含 WOFF / TTF 残留：${legacy.join(", ")}`);
  }
}

/** esbuild 插件；`cssFile` / `fontsDir` 相对当前工作目录。 */
export function katexAssetsPlugin({
  cssFile = "dist/webview.css",
  fontsDir = "dist/fonts",
} = {}) {
  return {
    name: "katex-assets",
    setup(build) {
      build.onLoad({ filter: KATEX_CSS }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const { css } = rewriteKatexFontFaces(source);
        return { contents: css, loader: "css", resolveDir: dirname(args.path) };
      });
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        validateKatexAssets(cssFile, fontsDir);
      });
    },
  };
}
