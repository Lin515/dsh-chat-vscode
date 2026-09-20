/**
 * 【探针定位】工具型 · 零模型 token —— 验「cookie 跨重启有效」（起两次 dsh、
 *   不发模型消息）；动认证链后跑，可自由运行。
 *
 * 验证：启动令牌每次重启都会换，但**签名 cookie 跨重启仍然有效**。
 *
 * 依据（逐行读自 dsh-client-connection/lib/index.js）：
 *  - `processLaunchToken()` = `randomBytes(32)`，按进程 owner 记忆 → 每次启动都是新的；
 *  - cookie 的签名密钥走 credentials（`client-connection.browser-session`），
 *    首次创建后持久化 → 跨重启不变；
 *  - `isAuthenticated()` 只校验 cookie 的签名 / authority / 有效期
 *    （`cookieMaxAgeDays` 默认 30 天），与本次进程的启动令牌无关。
 *
 * 做法：同一个固定端口起两次 dsh web，第一次用令牌换 cookie，第二次直接用该 cookie。
 *
 * 运行：npm run build:scripts && node build/cookie-survives-restart.mjs
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../src/dsh/client";

const PORT = 21999;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** dsh web 打印的公告行：`dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`。 */
const ANNOUNCE = /dsh web:\s*(https?:\/\/\S+)/;

async function startServer(tag: string): Promise<{ baseUrl: string; token: string; stop: () => void }> {
  const logFile = join(tmpdir(), `dsh-cookie-probe-${tag}.log`);
  writeFileSync(logFile, "", "utf8");
  const child: ChildProcess = spawn("dsh", ["web", "--port", String(PORT), "--no-open"], {
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    writeFileSync(logFile, output, "utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = () => {
    if (child.pid === undefined) return;
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const match = ANNOUNCE.exec(output);
    if (match) {
      const url = new URL(match[1]);
      const token = url.searchParams.get("token") ?? "";
      url.search = "";
      const baseUrl = url.toString().replace(/\/+$/, "");
      // 等端口真的能连上
      for (let i = 0; i < 40; i++) {
        try {
          await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(1500) });
          return { baseUrl, token, stop };
        } catch {
          await wait(250);
        }
      }
    }
    if (child.exitCode !== null) throw new Error(`dsh web 退出（code=${child.exitCode}）：${readFileSync(logFile, "utf8")}`);
    await wait(300);
  }
  throw new Error(`等待 dsh web 就绪超时：${output}`);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let stopFirst: (() => void) | undefined;
let stopSecond: (() => void) | undefined;

try {
  console.log(`1) 第一次启动（端口 ${PORT}）…`);
  const first = await startServer("1");
  stopFirst = first.stop;
  check("拿到启动令牌", Boolean(first.token), `${first.token.slice(0, 12)}…`);

  const client1 = new DshClient(first.baseUrl, first.token, () => {});
  await client1.authenticate();
  const cookie = client1.sessionCookie;
  await client1.listSessions();
  client1.dispose();
  check("令牌换 cookie 成功", Boolean(cookie), cookie.slice(0, 28) + "…");

  console.log("\n2) 停掉，重启一个（同一端口，authority 不变）…");
  first.stop();
  await wait(2500);

  const second = await startServer("2");
  stopSecond = second.stop;
  check(
    "启动令牌确实变了",
    second.token !== first.token,
    `${first.token.slice(0, 10)}… → ${second.token.slice(0, 10)}…`,
  );

  console.log("\n3) 新进程上先用**旧令牌**（预期失败）…");
  const stale = new DshClient(second.baseUrl, first.token, () => {});
  let staleFailed = false;
  try {
    await stale.authenticate();
    await stale.listSessions();
  } catch {
    staleFailed = true;
  }
  stale.dispose();
  check("旧启动令牌已失效（符合预期）", staleFailed);

  console.log("\n4) 新进程上用**第一次拿到的 cookie**（预期成功）…");
  const reuse = new DshClient(second.baseUrl, undefined, () => {});
  reuse.useSessionCookie(cookie);
  let reused = false;
  try {
    const list = await reuse.listSessions();
    reused = Array.isArray(list.items);
  } catch (error) {
    console.log(`     失败：${error instanceof Error ? error.message : String(error)}`);
  }
  reuse.dispose();
  check("cookie 跨重启仍然有效", reused);

  console.log(failures === 0 ? "\n✓ 结论成立：令牌每次变，cookie 跨重启有效" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  stopFirst?.();
  stopSecond?.();
}
