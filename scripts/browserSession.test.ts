/**
 * 离线断言：**自铸浏览器会话凭据**（`src/dsh/browserSession.ts`）。
 *
 * 这一组盯的是"票到底对不对"——它没法靠跑一遍来验（那要起一个真 DSH），所以把三件事
 * 逐条钉死：
 *
 * 1. **名字**：`dsh-auth-` + base64url(sha256(authority))，带一个**固定向量**；
 * 2. **票**：三段式、`v1` 前缀、载荷字段与顺序、HMAC 口径、有效期，都用一个固定向量
 *    逐字节对拍（签名覆盖的是序列化后的字节，字段顺序换了就签不过）；
 * 3. **密钥扫描**：按块收窄（别的记录里的 `secret` / `token` 不许误取）、引号、流式形态、
 *    非法密钥。
 *
 * 与官方实现的对齐口径见 `src/dsh/browserSession.ts` 的文件头；这里的固定向量是**独立
 * 算出来的**（不是从被测实现里抄的），所以它能抓住"实现悄悄改了序列化顺序"这类漂移。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createHash, createHmac } from "node:crypto";
import {
  BROWSER_COOKIE_PREFIX,
  DEFAULT_COOKIE_LIFETIME_MS,
  browserCookieName,
  decodeSecret,
  mintBrowserCookie,
  scanBrowserSessionSecret,
  SHORT_COOKIE_LIFETIME_MS,
} from "../src/dsh/browserSession";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** base64url 解码（测试自己实现一份，不复用被测代码）。 */
function b64urlDecode(value: string): string {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64").toString("utf8");
}

/** 拆开一张票：`{version, payload, signature}`。 */
function decodeCookie(value: string): { version: string; payload: Record<string, unknown>; signature: string } {
  const parts = value.split(".");
  assert.strictEqual(parts.length, 3, `票必须是三段：${value}`);
  return { version: parts[0], payload: JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>, signature: parts[2] };
}

/** 一个可用于扫描夹具的合成密钥（43 个 base64url 字符，解码正好 32 字节）。 */
const SECRET = "s".repeat(43);

// ---------- 1. 名字：固定向量 + 前缀 ----------

{
  const authority = "127.0.0.1:5674";
  const expected = BROWSER_COOKIE_PREFIX + Buffer.from(createHash("sha256").update(authority).digest()).toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  check(
    "名字 = dsh-auth- + base64url(sha256(authority))（固定向量）",
    browserCookieName(authority) === expected,
    browserCookieName(authority),
  );
  check(
    "固定向量的字面量对得上（独立算出来的值，防序列化漂移）",
    expected === "dsh-auth-ZmAzPu0XVSbhYpW9Hk-diMhmEBUEqdtLLhKA2yAj19w",
    expected,
  );
  check("名字里不带 base64 的 + / =（能直接当 cookie 名）", /^[A-Za-z0-9_-]+$/u.test(browserCookieName(authority)));
  check("换一个 authority 名字就变（票是绑 host:port 的）", browserCookieName("127.0.0.1:5675") !== browserCookieName(authority));
}

// ---------- 2. 密钥解码 ----------

{
  const decoded = decodeSecret(SECRET);
  check("43 个 base64url 字符 → 32 字节", decoded?.byteLength === 32, String(decoded?.byteLength));
  check("长度不对（31 字节的写法）→ undefined", decodeSecret("s".repeat(42)) === undefined);
  check("带非法字符 → undefined", decodeSecret(`${"s".repeat(42)}+`) === undefined);
  check("带填充 = → undefined（官方也拒）", decodeSecret(`${"s".repeat(42)}=`) === undefined);
  check("空串 → undefined", decodeSecret("") === undefined);
}

// ---------- 3. 票：形状 / 载荷 / 签名 / 有效期 ----------

{
  const issuedAt = 1_700_000_000_000;
  const minted = mintBrowserCookie({ authority: "127.0.0.1:5674", secret: SECRET, issuedAt, lifetimeMs: 86_400_000 });
  assert.ok(minted, "正常输入必须签得出来");
  const decoded = decodeCookie(minted.value);
  check("值以 `v1.` 开头（载荷版本）", decoded.version === "v1" && minted.value.startsWith("v1."), decoded.version);
  check("名字与值是同一份（header = name=value）", minted.header === `${minted.name}=${minted.value}`, minted.header);
  check("expiresAt = issuedAt + lifetimeMs", decoded.payload.expiresAt === issuedAt + 86_400_000, String(decoded.payload.expiresAt));
  check(
    "载荷字段与顺序逐字对齐官方（version / authority / issuedAt / expiresAt）",
    JSON.stringify(Object.keys(decoded.payload)) === '["version","authority","issuedAt","expiresAt"]',
    JSON.stringify(Object.keys(decoded.payload)),
  );
  check("载荷里的 version 是数字 1（不是字符串）", decoded.payload.version === 1);
  check("签名 = HMAC-SHA256(密钥, 载荷段)（独立重算）", (() => {
    const parts = minted.value.split(".");
    // 测试自己把 base64url 密钥解回字节（不复用被测实现的 decodeSecret）
    const key = Buffer.from(`${SECRET.replaceAll("-", "+").replaceAll("_", "/")}=`, "base64");
    assert.strictEqual(key.byteLength, 32, "夹具密钥应当是 32 字节");
    const expected = createHmac("sha256", key).update(parts[1]).digest();
    const b64 = Buffer.from(expected).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    return parts[2] === b64;
  })());
  check("同一份输入两次签出同一张票（无随机量，可复现）", (() => {
    const again = mintBrowserCookie({ authority: "127.0.0.1:5674", secret: SECRET, issuedAt, lifetimeMs: 86_400_000 });
    return again?.value === minted.value;
  })());
  check("authority 在载荷里原样保留（不是归一化后的另一份）", decoded.payload.authority === "127.0.0.1:5674");
}

{
  // 固定向量：把时间与密钥都钉死，逐字节比对（这条能抓住签名口径与序列化顺序的漂移）
  const minted = mintBrowserCookie({
    authority: "127.0.0.1:5674",
    secret: Buffer.from(Array.from({ length: 32 }, () => 7)).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
    issuedAt: 1_700_000_000_000,
    lifetimeMs: 86_400_000,
  });
  check(
    "固定向量逐字节一致",
    minted?.value ===
      "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6NTY3NCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3MDAwODY0MDAwMDB9.z0cX7_K71udfzh5ZwB7fO4J92s2vglKMXcqL_TnyG44",
    minted?.value,
  );
}

{
  check("密钥非法 → 签不出来（而不是签出一张必被拒的票）", mintBrowserCookie({ authority: "a:1", secret: "short", issuedAt: 0, lifetimeMs: 1 }) === undefined);
  check("有效期 <= 0 → undefined", mintBrowserCookie({ authority: "a:1", secret: SECRET, issuedAt: 0, lifetimeMs: 0 }) === undefined);
  check("非安全整数的签发时刻 → undefined", mintBrowserCookie({ authority: "a:1", secret: SECRET, issuedAt: 1.5, lifetimeMs: 1 }) === undefined);
  check("两档有效期都给了常量（30 天 / 1 天）", DEFAULT_COOKIE_LIFETIME_MS === 30 * 86_400_000 && SHORT_COOKIE_LIFETIME_MS === 86_400_000);
}

// ---------- 4. 密钥扫描：块作用域 ----------

/** 凭据文件的真实形态（值全是合成串，不含任何真密钥）。 */
const CREDENTIALS = [
  "version: 1",
  "refs:",
  "  LOCAL_API_KEY: sk-local",
  "records:",
  "  client-connection/browser-session:",
  "    kind: grant",
  "    payload:",
  "      version: 1",
  `      secret: ${SECRET}`,
  "  deepseek-account-platform/default:",
  "    kind: grant",
  "    payload:",
  "      version: 1",
  "      token: not-a-browser-secret",
  "  other-record:",
  "    kind: grant",
  "    payload:",
  `      secret: ${"X".repeat(43)}`,
  "",
].join("\n");

{
  check("从真实形态里取到浏览器会话密钥", scanBrowserSessionSecret(CREDENTIALS) === SECRET, String(scanBrowserSessionSecret(CREDENTIALS)));
  check(
    "别的记录里的 secret 不被误取（块作用域）",
    scanBrowserSessionSecret(CREDENTIALS) !== "X".repeat(43),
  );
  check(
    "记录名之后的同级记录里同名的 secret 不算（块的边界）",
    scanBrowserSessionSecret(["client-connection/browser-session:", "  kind: grant", "other:", `  secret: ${"X".repeat(43)}`].join("\n")) === undefined,
  );
  check("记录不存在 → undefined", scanBrowserSessionSecret(["records:", "  something-else:", "    payload:", `      secret: ${SECRET}`].join("\n")) === undefined);
  check("记录在但密钥长度不对 → undefined", scanBrowserSessionSecret(["client-connection/browser-session:", "  payload:", "    secret: abc"].join("\n")) === undefined);
  check(
    "键带引号也认",
    scanBrowserSessionSecret(['"client-connection/browser-session":', "  payload:", `    secret: "${SECRET}"`].join("\n")) === SECRET,
  );
  check(
    "值是单引号也认",
    scanBrowserSessionSecret(["'client-connection/browser-session':", "  payload:", `    secret: '${SECRET}'`].join("\n")) === SECRET,
  );
  check(
    "流式（同一行 {…}）也认",
    scanBrowserSessionSecret(`client-connection/browser-session: {kind: grant, payload: {version: 1, secret: ${SECRET}}}`) === SECRET,
  );
  check(
    "注释里的记录名不算（不能拿注释当命中）",
    scanBrowserSessionSecret([`# client-connection/browser-session: ${SECRET}`, "records:", "  other: 1"].join("\n")) === undefined,
  );
  check("空文件 → undefined", scanBrowserSessionSecret("") === undefined);
  check(
    "扫描结果能直接用于签票（两段接得上）",
    mintBrowserCookie({ authority: "127.0.0.1:1", secret: scanBrowserSessionSecret(CREDENTIALS) ?? "", issuedAt: 1, lifetimeMs: 1 }) !== undefined,
  );
}

if (failures > 0) {
  console.error(`\n✗ 浏览器会话凭据：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 浏览器会话凭据（名字向量 / 票格式与签名 / 有效期 / 密钥扫描）全通过");
  assert.ok(true);
}
