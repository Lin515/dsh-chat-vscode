/**
 * 离线断言：**连接的收场**（停止 / 换目标必须真的停下来）。
 *
 * 为什么单独一条（2026-09-19 用户实测 bug）：连着外部 DSH 时把外部服务关掉，界面会一直
 * 反复自动连接；点「停止连接」停不下来；甚至点了「启动内部 DSH」也停不下来。根因是三处
 * 叠在一起，而它们**都不会让 typecheck 或别的断言变红**，只是"点了没反应"：
 *
 * 1. `DshClient` 自己带**无限重连**（ws 断开后 1s→2s→…→15s 一直重连，每次 close/connect
 *    都回调状态）。「停止连接」从前只把两个布尔量置假 + `cancelWaiting()`，**没有 dispose
 *    客户端** → 它的回调把界面反复拉回"连接中"；
 * 2. 换目标（`beginConnect`）没有收掉上一条连接 → 旧的客户端继续重连旧地址，且它的回调
 *    继续写全局状态（回调里没有"这个 client 还是不是当前的"守卫）；
 * 3. 心跳在"未连接"分支无条件再 `ensureConnected` 一轮 → 外部掉线时**并发建第二个客户端**
 *    （两个客户端各带一套跟随流，互相打断）。
 *
 * 这一组是**源码结构断言**：controller 依赖 `vscode`，离线跑不起实例（没有注入点能换掉
 * 真的 `DshClient`），所以按"函数体里必须出现什么"来钉。改动这些方法时如果删掉了某一句，
 * 这里会直接红——而不是等到用户又发现"停止按钮没用"。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");

/**
 * 取一个方法的**完整函数体**。
 *
 * 必须锚在**定义行**（行首两空格缩进 + 可选修饰符）：注释里、调用点上的同名标识符
 * 都会命中朴素正则，取到的就不是函数体了（这一条被 `prepareRound` 的字段注释验证过——
 * 注释里就提到了它的名字）。
 */
function bodyOf(name: string): string {
  const definition = new RegExp(`^  (?:private |public )?(?:async )?${name}\\s*\\(`, "u");
  let offset = 0;
  for (const line of source.split("\n")) {
    if (definition.test(line)) {
      // 函数体的开括号总在**定义行的最后**（签名里可能还有别的 `{`，例如
      // `restart(options: { target?: DshTarget } = {})`），所以取行内最后一个
      const lineEnd = offset + line.length;
      const open = source.lastIndexOf("{", lineEnd);
      assert.ok(open >= offset, `${name} 的函数体开括号不在定义行（改了代码风格就同步改这条断言）`);
      let depth = 0;
      for (let index = open; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) return source.slice(open, index + 1);
        }
      }
      throw new Error(`${name} 的函数体花括号不配对`);
    }
    offset += line.length + 1;
  }
  throw new Error(`controller.ts 里找不到方法 ${name}（改了名字就同步改这条断言）`);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- 1. prepareRound：换目标/停止共用的收场，三件事一件都不能少 ----------
{
  const body = bodyOf("prepareRound");
  check(
    "prepareRound 作废在途轮（connectRoundId + 1）",
    /connectRoundId\s*\+=\s*1/u.test(body),
    "少了它：换目标后旧轮苏醒照样建 client、写状态",
  );
  check(
    "prepareRound 中止管理器的在途等待（cancelWaiting）",
    /cancelWaiting\s*\(/u.test(body),
    "少了它：那一轮还挂在旧目标**没有时长上限**的等待里",
  );
  check(
    "prepareRound **dispose 客户端**（连带停掉它自己的无限重连）",
    /client\??\.dispose\s*\(/u.test(body),
    "少了它：ws 会一直退避重连，回调把界面反复拉回连接中",
  );
  check("prepareRound 收掉跟随流（teardownStreams）", /teardownStreams\s*\(/u.test(body));
}

// ---------- 2. 三个入口都必须走收场 ----------
for (const [name, why] of [
  ["stopReconnect", "「停止连接」不收客户端 = 停了等于没停"],
  ["beginConnect", "换目标不收旧连接 = 旧客户端继续重连旧地址"],
  ["autoConnect", "激活期这一轮也要先收场（窗口重载后可能挂着上一条连接）"],
] as const) {
  check(`${name} 调用 prepareRound()`, /prepareRound\s*\(/u.test(bodyOf(name)), why);
}

// ---------- 3. 客户端回调只代表"当前这个客户端" ----------
{
  const body = bodyOf("connectOnce");
  check(
    "状态回调以 `this.client !== client` 守卫（旧客户端不许写全局状态）",
    /onDidChangeState\(\(state\)\s*=>\s*\{\s*[\s\S]{0,400}?if\s*\(this\.client\s*!==\s*client\)\s*return;/u.test(body),
    "少了它：被替换掉的客户端仍会把 connection/retryable 改回去",
  );
  check(
    "掉线回调尊重用户叫停（autoReconnect 为假时不复活）",
    /if\s*\(!this\.autoReconnect\)\s*return;/u.test(body),
  );
  check(
    "使用轮次号（roundStale）拦住被顶掉的旧轮收尾",
    /roundStale\s*\(/u.test(body) && /connectRoundId/u.test(body),
  );
  check(
    "建新客户端前先收掉旧的（dispose，而不是只覆盖 this.client）",
    /this\.client\?\.dispose\(\)/u.test(body),
    "少了它：旧客户端成了没人管的无限重连循环",
  );
}

// ---------- 4. 心跳不许为外部目标并发建第二个客户端 ----------
{
  const body = bodyOf("handleHeartbeat");
  check(
    "外部目标且已有客户端时交给它自己重连（不再 ensureConnected）",
    /this\.client\s*&&\s*this\.target\.kind\s*===\s*"external"/u.test(body),
    "少了它：client 的 ws 重连与心跳的 ensure 会各建一个客户端",
  );
}

if (failures > 0) {
  console.error(`\n✗ 连接的收场（停止 / 换目标真的停得下来）：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 连接的收场（停止连接真的停 / 换目标先收旧连接 / 旧客户端不许写状态）全通过");
  assert.ok(true);
}
