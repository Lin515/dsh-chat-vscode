/**
 * 离线验证 DshClient 的会话 cookie 语义（外部服务器跨重启复用的基础）。
 *
 * 背景（见 scripts/cookieSurvivesRestart.ts 的实测）：
 *  - 启动令牌是 `randomBytes(32)`，每次 `dsh web` 启动都会刷新 → 存它没用；
 *  - cookie 的签名密钥在服务端凭据库里 → cookie 跨重启有效（默认 30 天）。
 *
 * 所以宿主应该存 cookie。这个测试锁定客户端侧的三件事：
 *  1. 带着 cookie 时 `authenticate()` **不做令牌交换**（不该再打 `/?token=`）；
 *  2. `sessionCookie` 只给 `name=value`，不含 `Max-Age/Path/HttpOnly` 等属性；
 *  3. cookie 被服务端拒绝时抛 `DshAuthError`（宿主据此回落到令牌输入）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { DshAuthError, DshClient } from "../src/dsh/client";

/** 记录服务器收到的请求，便于断言「有没有走令牌交换」。 */
interface Hit {
  pathname: string;
  token: string | undefined;
  cookie: string | undefined;
}

interface StubOptions {
  /** 根路径的令牌是否有效（决定换 cookie 是否成功）。 */
  acceptToken?: (token: string | undefined) => boolean;
  /** /api 请求是否接受（真实服务端只看 cookie）。 */
  acceptCookie?: (cookie: string | undefined) => boolean;
  /** 换 cookie 时是否真的下发 Set-Cookie。 */
  issueCookie?: boolean;
}

async function stub(options: StubOptions = {}) {
  const hits: Hit[] = [];
  const acceptToken = options.acceptToken ?? ((token) => token === "good");
  const acceptCookie = options.acceptCookie ?? ((cookie) => Boolean(cookie?.startsWith("dsh-auth-")));
  const issueCookie = options.issueCookie ?? true;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? undefined;
    const cookie = req.headers.cookie as string | undefined;
    hits.push({ pathname: url.pathname, token, cookie });

    // 令牌交换：GET /?token=... → 303 + Set-Cookie
    if (url.pathname === "/") {
      if (!acceptToken(token)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("auth required");
        return;
      }
      const headers: Record<string, string> = { "content-type": "text/plain" };
      if (issueCookie) {
        headers["set-cookie"] =
          "dsh-auth-ABC123=sig.payload.value; Max-Age=2592000; Path=/; Expires=Wed, 01 Jan 2026 00:00:00 GMT; HttpOnly; SameSite=Strict";
      }
      res.writeHead(303, headers);
      res.end();
      return;
    }

    // /api/*：只认 cookie
    if (url.pathname.startsWith("/api/")) {
      if (!acceptCookie(cookie)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("auth required");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "server-response",
            rpcId: sent.rpcId,
            result: { ok: true, value: { items: [] } },
          }),
        );
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------- 1. 令牌交换：cookie 只留 name=value ----------
{
  const s = await stub();
  const client = new DshClient(s.baseUrl, "good", () => {});
  await client.authenticate();
  assert.strictEqual(
    client.sessionCookie,
    "dsh-auth-ABC123=sig.payload.value",
    "只能留 name=value，不能带 Max-Age/Path/HttpOnly（否则放进 Cookie 头会不合规）",
  );
  await client.listSessions();
  client.dispose();
  await s.close();
  console.log("sessionCookie: 令牌交换后只留 name=value ✓");
}

// ---------- 2. 带 cookie 时不做令牌交换 ----------
{
  const s = await stub({ acceptToken: () => false }); // 令牌一律拒绝
  const client = new DshClient(s.baseUrl, undefined, () => {});
  client.useSessionCookie("dsh-auth-ABC123=reused");
  await client.authenticate();
  await client.listSessions();
  client.dispose();

  const exchanged = s.hits.some((hit) => hit.pathname === "/");
  assert.strictEqual(exchanged, false, "已有 cookie 时不该再打 /?token= 做交换");
  const apiHit = s.hits.find((hit) => hit.pathname.startsWith("/api/"));
  assert.strictEqual(apiHit?.cookie, "dsh-auth-ABC123=reused", "/api 请求要带上复用的 cookie");
  await s.close();
  console.log("sessionCookie: 复用 cookie 时跳过令牌交换 ✓");
}

// ---------- 3. cookie 被拒 → DshAuthError（宿主据此回落） ----------
{
  const s = await stub({ acceptCookie: () => false });
  const client = new DshClient(s.baseUrl, undefined, () => {});
  client.useSessionCookie("dsh-auth-ABC123=stale");
  await assert.rejects(() => client.listSessions(), (error: unknown) => error instanceof DshAuthError);
  client.dispose();
  await s.close();
  console.log("sessionCookie: cookie 失效 → DshAuthError ✓");
}

// ---------- 4. 令牌被拒 → DshAuthError ----------
{
  const s = await stub({ acceptToken: () => false });
  const client = new DshClient(s.baseUrl, "bad", () => {});
  await assert.rejects(() => client.authenticate(), (error: unknown) => error instanceof DshAuthError);
  client.dispose();
  await s.close();
  console.log("sessionCookie: 令牌被拒 → DshAuthError ✓");
}

// ---------- 5. 无认证服务器：不带令牌也放行，且不产生 cookie ----------
{
  const s = await stub({ acceptCookie: () => true, issueCookie: false });
  const client = new DshClient(s.baseUrl, undefined, () => {});
  await client.authenticate();
  assert.strictEqual(client.sessionCookie, "", "无认证服务器不该产生 cookie（宿主也就不会存）");
  await client.listSessions();
  client.dispose();
  await s.close();
  console.log("sessionCookie: 无认证服务器不产生 cookie ✓");
}

console.log("\nsessionCookie: all assertions passed");
