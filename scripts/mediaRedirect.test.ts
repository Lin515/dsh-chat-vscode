/**
 * 离线断言：`DshClient.getBytes` 跟得上 Host 的**版本化媒体跳转**，且不把 cookie
 * 带去别的 origin。
 *
 * 为什么要有这一条（2026-10-29）：DSH 的 `/api/file` 在缺 `v=<版本>` 时回一条
 * 相对 302，指向同一份字节的版本化 URL（响应因此可长期缓存）。本客户端原先用
 * `redirect: "error"`，于是正文里每一张本地图都以「fetch failed」告终——文件明明
 * 在、`workspaceFiles.stat` 也读得到，界面却显示「图片加载失败」。
 *
 * 钉三件事实：同源 302 会跟到字节、跨源 302 被拒且对方一个请求都收不到、同源但
 * 跳出 `/api/` 的 302 同样被拒。对端用本机 HTTP 服务（行为是事实判据，不靠假的
 * fetch 实现）；两个回环端口天然是两个 origin。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DshClient, DshApiError } from "../src/dsh/client";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Served {
  readonly url: string;
  readonly cookie: string | undefined;
}

interface Peer {
  readonly base: string;
  readonly seen: Served[];
  close(): Promise<void>;
}

/** 一个回环 HTTP 对端：记下每次请求（URL 与 cookie），再交给用例自己回。 */
async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Peer> {
  const seen: Served[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", cookie: req.headers.cookie });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 一条「缺 v 就 302 到带 v 的同一路径」的媒体路由。 */
function versionedMedia(res: ServerResponse, req: IncomingMessage): void {
  const url = new URL(req.url ?? "/", "http://peer");
  if (url.searchParams.get("v") === "v7") {
    res.writeHead(200, { "content-type": "image/png; charset=binary" });
    res.end(Buffer.from([9, 8, 7]));
    return;
  }
  const query = new URLSearchParams({ path: url.searchParams.get("path") ?? "", v: "v7" });
  res.writeHead(302, { location: `${url.pathname}?${query.toString()}` });
  res.end();
}

// ---------- 1. 同源版本跳转 ----------
const origin = await peer((req, res) => versionedMedia(res, req));
const client = new DshClient(origin.base, undefined, () => undefined);
client.useSessionCookie("dsh-auth-test=1");
const bytes = await client.getBytes("/api/file?path=%2Fw%2Fp.png");

check("同源 302 跟到带版本 URL 后拿到字节", bytes?.bytes.byteLength === 3, `实际 ${bytes?.bytes.byteLength ?? "（无）"} 字节`);
check("媒体类型去掉参数", bytes?.mediaType === "image/png", bytes?.mediaType ?? "（无）");
check(
  "第一跳原样、第二跳带 v=v7（Host 的版本化约定）",
  origin.seen.length === 2 &&
    origin.seen[0]?.url.startsWith("/api/file?path=") &&
    !origin.seen[0]?.url.includes("v=") &&
    origin.seen[1]?.url.includes("v=v7"),
  origin.seen.map((entry) => entry.url).join(" → "),
);
check(
  "cookie 只在同一个 origin 内出现（两跳都带、没被丢掉）",
  origin.seen.every((entry) => entry.cookie === "dsh-auth-test=1"),
  origin.seen.map((entry) => entry.cookie ?? "（无）").join(" → "),
);
await origin.close();

// ---------- 2. 跨源跳转：拒绝，且对方收不到请求 ----------
const other = await peer((_req, res) => {
  res.writeHead(200, { "content-type": "image/png" });
  res.end(Buffer.from([1]));
});
const redirector = await peer((_req, res) => {
  res.writeHead(302, { location: `${other.base}/api/file?path=%2Fw%2Fp.png&v=v7` });
  res.end();
});
const leakClient = new DshClient(redirector.base, undefined, () => undefined);
leakClient.useSessionCookie("dsh-auth-test=1");
await assert.rejects(
  () => leakClient.getBytes("/api/file?path=%2Fw%2Fp.png"),
  (error: unknown) => error instanceof DshApiError,
  "跨源跳转必须整份拒绝",
);
check(
  "跨源跳转没有把请求（连同 cookie）带给对方 origin",
  other.seen.length === 0,
  `对方收到 ${other.seen.length} 次：${other.seen.map((entry) => entry.url).join("、") || "（无）"}`,
);
await other.close();
await redirector.close();

// ---------- 3. 同源但跳出 /api/：同样拒绝 ----------
const sneaky = await peer((_req, res) => {
  res.writeHead(302, { location: "/outside/file?path=x" });
  res.end();
});
const sneakyClient = new DshClient(sneaky.base, undefined, () => undefined);
await assert.rejects(
  () => sneakyClient.getBytes("/api/file?path=%2Fw%2Fp.png"),
  (error: unknown) => error instanceof DshApiError && /outside .*api\//u.test(error.message),
  "跳出部署前缀的跳转必须拒绝",
);
check("被拒的跳转目标没有被请求", sneaky.seen.length === 1, `实际 ${sneaky.seen.length} 次请求`);
await sneaky.close();

if (failures > 0) {
  console.error(`\n✗ 媒体跳转：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 媒体跳转（同源跟一次 / 跨源与出前缀拒绝 / cookie 不出 origin）全通过");
}
