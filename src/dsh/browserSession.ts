/**
 * 自铸 DSH 的**浏览器会话凭据**（官方 `BrowserAuth` 的 v1 cookie）。
 *
 * 用途只有一个：接**桌面端内置的那个服务**。桌面端不从命令行启动，它的启动令牌
 * （`randomBytes(32)` 按进程生成、只经 IPC 交给 Electron 主进程）拿不到，能自证的
 * 只有 `$DSH_HOME/.credentials.yaml` 里那把**跨重启不变**的签名密钥——谁有密钥谁就能
 * 签出一张服务端认的票（验签是无状态的，见 `docs/design-desktop.md`）。
 *
 * 这里**只做纯计算**：名字推导、票构造、凭据文本扫描。读文件、发请求、启动进程
 * 都在 `desktopAttach.ts`。密钥是**私钥级**的东西，调用方拿到后只在发现流程里短活持有，
 * 不进日志、不进界面、不进错误详情。
 *
 * 与官方实现逐字对齐（`packages/client/connection/src/browser-auth.ts`）：
 * - 名字：`dsh-auth-` + base64url(sha256(authority))，`authority` 是 `URL.host` 那一形
 *   （小写主机名 + 端口，IPv6 带方括号）；
 * - 值：`v1.` + base64url(JSON{version, authority, issuedAt, expiresAt}) + `.` +
 *   base64url(HMAC-SHA256(密钥, 前一段))；JSON 的**字段顺序**就是这里写的顺序（签名
 *   覆盖的是序列化后的那串字节，顺序换了签名即失效）；
 * - 密钥：`records` 下 `client-connection/browser-session` 记录的 `payload.secret`，
 *   32 字节的 base64url。
 *
 * **有效期**：服务端要求 `expiresAt - issuedAt` 不超过它自己的 `cookieMaxAgeDays`
 * （配置项，默认 30 天，schema 下限 1 天）。这个值不在凭据文件里，扩展不猜它：
 * 先用默认的 30 天签，被拒再重读密钥、改用 1 天重签一次（见 `desktopAttach.ts`）。
 * 这也是**不走长效票**的原因——端口每次启动都变，票是"这一次连接"的凭据。
 */
import { createHash, createHmac } from "node:crypto";

/** cookie 名前缀（官方 `COOKIE_PREFIX`）。 */
export const BROWSER_COOKIE_PREFIX = "dsh-auth-";

/** 载荷版本（官方 `COOKIE_PAYLOAD_VERSION`）。 */
export const COOKIE_PAYLOAD_VERSION = 1;

/** 密钥记录里的版本（官方 `STORED_SECRET_VERSION`）。 */
export const STORED_SECRET_VERSION = 1;

/** 密钥字节数（官方 `SECRET_BYTES`）。 */
export const SECRET_BYTES = 32;

/**
 * 凭据文件里那条记录的键（官方 `credentialKey('client-connection', 'browser-session')`）。
 *
 * 它写在 `records` 下，冒号前带斜杠，所以 YAML 里**不带引号**也不会被拆成嵌套键。
 */
export const BROWSER_SESSION_RECORD_KEY = "client-connection/browser-session";

/** 32 字节 base64url 的形态：43 个字符、无填充。 */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 一整天（服务端有效期按天算，这里也按天算）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 首次尝试的有效期：官方默认 30 天。 */
export const DEFAULT_COOKIE_LIFETIME_MS = 30 * DAY_MS;

/**
 * 被拒后重试的有效期：1 天（配置项的下限就是 1 天，所以它一定不超）。
 *
 * 用它而不是别的值时，"服务端把 `cookieMaxAgeDays` 调小了"这唯一的失败原因能自愈。
 */
export const SHORT_COOKIE_LIFETIME_MS = DAY_MS;

/** base64url（无填充）——与官方 `encodeBase64Url` 同一口径。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** 票的名字：`dsh-auth-` + base64url(sha256(authority))。 */
export function browserCookieName(authority: string): string {
  return BROWSER_COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}

/** 密钥文本 → 32 字节；不是 32 字节的 base64url 时返回 undefined。 */
export function decodeSecret(secret: string): Buffer | undefined {
  if (!SECRET_PATTERN.test(secret)) return undefined;
  const decoded = Buffer.from(secret.replaceAll("-", "+").replaceAll("_", "/") + "=", "base64");
  return decoded.byteLength === SECRET_BYTES ? decoded : undefined;
}

export interface MintedBrowserCookie {
  name: string;
  /** `v1.<载荷>.<签名>`。 */
  value: string;
  /** 可直接放进 `Cookie` 头的 `name=value`。 */
  header: string;
  expiresAt: number;
}

export interface MintCookieInput {
  authority: string;
  /** `payload.secret` 的原文（base64url）。 */
  secret: string;
  issuedAt: number;
  lifetimeMs: number;
}

/**
 * 签一张 v1 浏览器会话票。密钥或有效期不可用时返回 undefined（调用方按"读不到凭据"处置）。
 *
 * 载荷字段顺序即 `JSON.stringify` 的顺序，**不能改**：签名覆盖的是序列化后的那串字节。
 */
export function mintBrowserCookie(input: MintCookieInput): MintedBrowserCookie | undefined {
  const secret = decodeSecret(input.secret);
  if (!secret) return undefined;
  if (!Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs <= 0) {
    return undefined;
  }
  const expiresAt = input.issuedAt + input.lifetimeMs;
  if (!Number.isSafeInteger(expiresAt)) return undefined;
  const name = browserCookieName(input.authority);
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority: input.authority,
    issuedAt: input.issuedAt,
    expiresAt,
  };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = encodeBase64Url(createHmac("sha256", secret).update(body).digest());
  const value = `v${COOKIE_PAYLOAD_VERSION}.${body}.${signature}`;
  return { name, value, header: `${name}=${value}`, expiresAt };
}

/**
 * 从 `$DSH_HOME/.credentials.yaml` 的**原文**里取出浏览器会话密钥（拿不到返回 undefined）。
 *
 * 为什么自己扫而不是引 YAML 依赖：扩展是零运行时依赖的（`AGENTS.md`），而这一个字段
 * 的结构是稳定的——`records` 下一层是记录名，记录体里 `payload` 下才是 `secret`。
 * 扫描**按块收窄**（记录名那一行的缩进界定块的边界），于是别的记录里同名的 `secret`
 * 或 `token` 字段不会被误取（凭据文件里 `deepseek-account-platform/default` 就有 `token`）。
 *
 * 只认两种形态：块式（默认写法）与内联流式（同一行里带 `{}`）。
 */
export function scanBrowserSessionSecret(text: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = matchRecordKey(line);
    if (key === undefined) continue;
    // 记录体与记录名同一行（流式）：只在这一行里找
    if (key.rest.trimStart().startsWith("{")) return secretInFlow(key.rest);
    const flow = secretInFlow(key.rest);
    if (flow !== undefined) return flow;
    // 块式：缩进**大于**记录名那一行，直到遇到缩进回到同级或更浅
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const body = lines[inner];
      if (body.trim() === "" || body.trimStart().startsWith("#")) continue;
      const indent = indentOf(body);
      if (indent <= key.indent) break;
      const found = matchSecret(body);
      if (found !== undefined) return found;
    }
    return undefined; // 这条记录里没有密钥，不必再找别的记录
  }
  return undefined;
}

/** 这一行是不是那条记录名；是就给出缩进与冒号之后的原文。 */
function matchRecordKey(line: string): { indent: number; rest: string } | undefined {
  const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^:\s][^:]*?))\s*:(.*)$/u.exec(line);
  if (!match) return undefined;
  const key = match[2] ?? match[3] ?? match[4] ?? "";
  if (key.trim() !== BROWSER_SESSION_RECORD_KEY) return undefined;
  return { indent: match[1].length, rest: match[5] ?? "" };
}

/** `payload` 层里的 `secret:`（引号可有可无，单双都认）。 */
function matchSecret(line: string): string | undefined {
  const match = /^\s*secret\s*:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/u.exec(line);
  if (!match) return undefined;
  return SECRET_PATTERN.test(match[1]) ? match[1] : undefined;
}

/** 流式形态（`{kind: grant, payload: {version: 1, secret: abc}}`）里的 `secret`。 */
function secretInFlow(text: string): string | undefined {
  const match = /[{,]\s*"?secret"?\s*:\s*"?([A-Za-z0-9_-]+)"?/u.exec(text);
  if (!match) return undefined;
  return SECRET_PATTERN.test(match[1]) ? match[1] : undefined;
}

/** 行首空白宽度（缩进判据只用相对大小，制表符算一个字符）。 */
function indentOf(line: string): number {
  return /^(\s*)/u.exec(line)?.[1].length ?? 0;
}
