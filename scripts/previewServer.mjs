// 仅供 UI 预览：把工作区当静态目录伺服，让 Playwright 能加载 test/preview.html
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, ""));
    if (!path.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(8777, "127.0.0.1", () => console.log("preview server on http://127.0.0.1:8777"));
