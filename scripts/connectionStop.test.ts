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
 * 第 5 组补的是**同一天用户实测的另一半**：换目标只换了"决策"，没换"手里握着的东西"——
 * 切到外部之后内部那套的状态推送照样改界面（见 `SupervisorManager.detachInternal`，
 * 管理器侧由 `supervisorPolicy.test.ts` 第 7 组用真的 socket 数活连接钉住）。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
/** 管理器那一份（第 6 组用：判断的**顺序**也是要钉的事实）。 */
const managerSource = readFileSync(join(process.cwd(), "src", "dsh", "supervisorManager.ts"), "utf8");

/**
 * 取一个方法的**完整函数体**。
 *
 * 必须锚在**定义行**（行首两空格缩进 + 可选修饰符）：注释里、调用点上的同名标识符
 * 都会命中朴素正则，取到的就不是函数体了（这一条被 `prepareRound` 的字段注释验证过——
 * 注释里就提到了它的名字）。
 */
function bodyOf(name: string, text = source): string {
  const definition = new RegExp(`^  (?:private |public )?(?:async )?${name}\\s*\\(`, "u");
  let offset = 0;
  for (const line of text.split("\n")) {
    if (definition.test(line)) {
      // 函数体的开括号总在**定义行的最后**（签名里可能还有别的 `{`，例如
      // `restart(options: { target?: DshTarget } = {})`），所以取行内最后一个
      const lineEnd = offset + line.length;
      const open = text.lastIndexOf("{", lineEnd);
      assert.ok(open >= offset, `${name} 的函数体开括号不在定义行（改了代码风格就同步改这条断言）`);
      let depth = 0;
      for (let index = open; index < text.length; index += 1) {
        const char = text[index];
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) return text.slice(open, index + 1);
        }
      }
      throw new Error(`${name} 的函数体花括号不配对`);
    }
    offset += line.length + 1;
  }
  throw new Error(`找不到方法 ${name}（改了名字就同步改这条断言）`);
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

// ---------- 5. 目标是外部时，**内部那套一个字都不许动界面**（2026-09-19） ----------
//
// 用户实测：本来是内部那套，切到「连接外部 DSH」之后，内部那套的状态推送照样在改界面
// （被拉回按钮态/错误态），点「停止内部 DSH」还会把外部那条连接一起收掉——看起来就像
// "连的是外部，其实还在跟内部守护进程打交道"。管理器那侧的断开由
// `scripts/supervisorPolicy.test.ts` 第 7 组用真的 socket 数活连接钉住；这里钉控制器这侧
// 的两道闸（它依赖 vscode，离线跑不起实例，只能按"函数体里必须出现什么"）。
{
  const body = bodyOf("onServerStatus");
  check(
    "onServerStatus 在目标为外部时提前返回（内部那套的退场/失败不许改写界面）",
    /if\s*\(this\.target\?\.kind\s*===\s*"external"\)\s*return;/u.test(body),
    "少了它：内部守护进程退场/换地址会把界面从'连着外部'拉回按钮态",
  );

  const stop = bodyOf("stopServer");
  const externalAt = stop.indexOf('this.target?.kind === "external"');
  const prepareAt = stop.indexOf("prepareRound(");
  check(
    "stopServer 认出「当前目标是外部」这一支",
    externalAt >= 0,
    "少了它：停内部 DSH 会连外部那条连接一起 dispose",
  );
  check(
    "stopServer 在外部目标下**先返回**，不 prepareRound（外部连接一个字都不动）",
    externalAt >= 0 && prepareAt >= 0 && externalAt < prepareAt,
    `external@${externalAt} prepareRound@${prepareAt}`,
  );
  check(
    "stopServer 把「请求有没有真的发出去」交回调用方（回执才能如实）",
    /return this\.server\.stopAndExit\(\)/u.test(stop),
  );
}

// ---------- 6. 心跳里那道「目标不是内部就断开」的兜底**必须排在「连接还在」之前** ----------
//
// 这不是风格问题，是这次 bug 的**形状本身**：要修的状态恰恰是"目标已经是外部、socket 却
// 还连着"。把兜底写在 `if (this.connection?.connected) return;` **后面**，它就永远不生效
// ——而 typecheck、行为断言、真机探针都不会红（我这次就是这么写反的，写完当场读出来才改）。
// 管理器的行为断言覆盖的是 `ensure()` 那条主路径，兜底这一道只能这样钉。
{
  const tick = bodyOf("heartbeatTick", managerSource);
  const guardAt = tick.indexOf('this.target !== "internal"');
  const connectedAt = tick.indexOf("this.connection?.connected");
  check(
    "heartbeatTick 里有「目标不是内部就 detach」这道兜底",
    guardAt >= 0 && /detachInternal\s*\(/u.test(tick),
    "少了它：只有换目标那条主路径会断开，别的路径留下的陈旧连接会把 dsh 一直拎住",
  );
  check(
    "这道兜底排在 `this.connection?.connected` 之前（写反 = 兜底永远不生效）",
    guardAt >= 0 && connectedAt >= 0 && guardAt < connectedAt,
    `guard@${guardAt} connected@${connectedAt}`,
  );

  // 「停止连接」那道闸同理：它管的是"要不要**重新连**"，所以也得排在"连接还在"之前
  const detachedAt = tick.indexOf("this.detachedByUser");
  check(
    "「停止连接」之后心跳不许自动接回（detachedByUser 排在 connection.connected 之前）",
    detachedAt >= 0 && connectedAt >= 0 && detachedAt < connectedAt,
    `detached@${detachedAt} connected@${connectedAt}`,
  );
}

// ---------- 7. 用户点「停止连接」= **不再占用内部后台**（2026-09-19 口径） ----------
//
// 用户明确选了"不连就不占用"。管理器那侧的行为由 `supervisorPolicy.test.ts` 第 8 组用真的
// socket 数活连接钉住（含"心跳跑一轮也不许接回来"）；这里钉控制器与标志位这三处接线：
// 少任何一处，"停止连接"就会退化成"只是界面上不连了、后台还被本窗口拎着"。
{
  const release = bodyOf("releaseInternal", managerSource);
  check(
    "releaseInternal 同时做两件事：断开连接 + 置位 detachedByUser（只断不挡 = 5 秒后被接回去）",
    /this\.detachedByUser = true/u.test(release) && /this\.detachInternal\s*\(/u.test(release),
  );
  check(
    "bringUp 清掉 detachedByUser（显式动作必须能重新接上）",
    /this\.detachedByUser = false/u.test(bodyOf("bringUp", managerSource)),
  );

  const stop = bodyOf("stopReconnect");
  check(
    "stopReconnect 交还内部后台的占用（releaseInternal）",
    /this\.server\.releaseInternal\(\)/u.test(stop),
    "少了它：连接一直留着，守护进程永远认为有人用，内部 dsh 不会空闲退场",
  );
  check("stopReconnect 顺带重探两轴（刚交还，结论已经变了）", /refreshFacts\(\)/u.test(stop));

  const probe = bodyOf("probeFacts");
  check(
    "probeFacts 已连上时不再探外部（落实它自己注释里的口径，少一次周期 GET）",
    /this\.connection !== "connected"/u.test(probe),
    "少了它：每 5 秒朝外部地址发一次无意义的请求",
  );

  // 「停止内部 DSH」的判据必须是"手里有没有活连接"，不是"目标是不是内部"：
  // 用户点过「停止连接」之后目标仍是内部（粘性），但连接已经交还了——按目标判就会把
  // "交还后守护进程还在空闲窗口里活着"误当成"没有可停的东西"，一句"没有在运行"骗人。
  check(
    "stopAndExit 按「手里有没有活连接」决定要不要短暂接入（不是按目标）",
    /connection\?\.connected !== true/u.test(bodyOf("stopAndExit", managerSource)),
    "少了它：交还占用后「停止内部 DSH」会静默空转并谎报没有在运行",
  );
}

if (failures > 0) {
  console.error(`\n✗ 连接的收场（停止 / 换目标真的停得下来）：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 连接的收场（停止连接真的停 / 换目标先收旧连接 / 旧客户端不许写状态 / 外部目标不碰内部那套 / 停止连接交还占用）全通过",
  );
  assert.ok(true);
}
