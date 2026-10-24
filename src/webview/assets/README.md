# src/webview/assets/ — 随界面打包的图片资源

被 CSS `url()` 或 TSX 导入引用，由 esbuild 的 `dataurl` 载入器内联进 `dist/webview.css` / `dist/webview.js`，不单独作为文件随包分发。上层见[界面导航](<../README.md>)。

- [running-whale@2x.png](<running-whale@2x.png>) — 官方运行态鲸鱼尾 APNG（28×28、60 帧、50ms/帧、3s 无限循环），灰度 + alpha。只作遮罩用，颜色由使用方的 `currentColor` 决定。
