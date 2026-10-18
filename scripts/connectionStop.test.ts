/**
 * 离线断言：**连接收场的接线**（每一处落点走的是哪个收场意图）。
 *
 * 收场的**动作与顺序**已经收进 `src/dsh/connectionAttempts.ts`，那些"点了停止停不下来 /
 * 过一会儿又连上了 / 停内部把外部也收掉"的行为由 `connectionAttempts.test.ts` 驱动真的
 * `ChatController` + 假客户端 / 假服务端逐条钉住。这一份只保留**接线**——它回答的是
 * 「控制器这几个落点有没有绕开模块自己拼档位、自己 dispose」：
 *
 * - 控制器里**一个** `this.server.stop(` 都不该有（档位由模块说了算，调用点拼错档
 *   不报任何错，只会在用户那里表现为"点了没反应"）；
 * - 四个落点各走哪个意图方法；
 * - 客户端回调的身份判据走轮次（旧客户端不许写全局状态）；
 * - 两道闸（自动路径 / 本轮可重试）不再由控制器自己存字段。
 *
 * 另一半在管理器侧（`supervisorManager.ts`，行为由 `supervisorPolicy.test.ts` 用真 socket
 * 钉住）：心跳兜底的**顺序**、`release` 那一档同时断与挡、旧入口是薄壳——这几条只在这里
 * 按源码钉，因为它们的判据是"某一句写在谁前面"，行为断言要到"5 秒后心跳跑一轮"那一档
 * 才等价，代价不成比例。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
/** 管理器那一份（心跳兜底顺序与旧入口薄壳在这边）。 */
const managerSource = readFileSync(join(process.cwd(), "src", "dsh", "supervisorManager.ts"), "utf8");

/**
 * 取一个方法的**完整函数体**。
 *
 * 必须锚在**定义行**（行首两空格缩进 + 可选修饰符）：注释里、调用点上的同名标识符
 * 都会命中朴素正则，取到的就不是函数体了。
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

// ---------- 1. 档位只有一个地方拼：控制器不直接调管理器的停止入口 ----------
{
  // 唯一允许的一处是**交给模块的那道窄端口**（`stop: (options) => this.server.stop(options)`）；
  // 其余任何一处都说明档位又回到调用点上拼了
  const direct = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("this.server.stop(") && !line.startsWith("stop: (options) => this.server.stop(options)"));
  check(
    "控制器里没有直接调 `this.server.stop(...)`（档位与顺序归 `connectionAttempts`）",
    direct.length === 0,
    direct.join(" | "),
  );
  for (const retired of ["cancelWaiting", "releaseInternal", "stopAndExit", "detachInternal"]) {
    check(
      `控制器不再直接调旧入口 ${retired}`,
      !source.includes(`this.server.${retired}(`),
      `控制器里还有 this.server.${retired}(…)：收场那几件事又会散回各处`,
    );
  }
}

// ---------- 2. 四个落点各走哪个收场意图 ----------
{
  check(
    "prepareRound 那个位置（换目标 / 重开一轮）走 `retarget()`：作废在途轮 + 中止等待 + 收连接，**不交还占用**",
    /this\.attempts\.retarget\(\)/u.test(bodyOf("beginConnect")),
  );
  check(
    "beginConnect 另外重开两道闸（`reopen()`：显式动作或自动选路都要能拉起）",
    /this\.attempts\.reopen\(\)/u.test(bodyOf("beginConnect")),
  );
  check(
    "reconnectPeer 也走 `retarget()`（窗口重载后 / 心跳换共享后台）",
    /this\.attempts\.retarget\(\)/u.test(bodyOf("reconnectPeer")),
  );
  check(
    "激活期那次自动连接也走 `reopen()` + `retarget()`（选路＝换目标：作废在途轮 + 中止等待 + 收连接，**不交还占用**）",
    /this\.attempts\.reopen\(\)/u.test(bodyOf("chooseAtActivation")) &&
      /this\.attempts\.retarget\(\)/u.test(bodyOf("chooseAtActivation")),
    "本体在 chooseAtActivation；autoConnect 只是那道「一个宿主只做一次」的闸",
  );
  check(
    "autoConnect 只把本体交给 chooseAtActivation，不自己拼收场",
    /this\.chooseAtActivation\(/u.test(bodyOf("autoConnect")) && !/this\.attempts\./u.test(bodyOf("autoConnect")),
    "闸里再动手收场＝重复调用也会作废用户刚发起的那一轮",
  );
  check(
    "stopReconnect（用户点「停止连接」）走 `stopByUser()`",
    /this\.attempts\.stopByUser\(\)/u.test(bodyOf("stopReconnect")),
    "自己拼 `stop({...})` = 档位又回到调用点上，少一样就是「点了停止还在连」",
  );
  check(
    "stopServer 把当前目标交给模块判（`stopInternal(this.target?.kind)`），不自己判目标、不自己拼 flag",
    /return this\.attempts\.stopInternal\(this\.target\?\.kind\)/u.test(bodyOf("stopServer")),
    "外部目标那一档（本窗口连接一个字都不动）归模块，控制器这层只做转发",
  );
  check(
    "ensureConnected 连接中换目标只 `cancelWait()`（马上要接上的可能是同一个后台）",
    /this\.attempts\.cancelWait\(\)/u.test(bodyOf("ensureConnected")),
  );
  check(
    "restart 走 `detach()`（只收本窗口这条连接，不碰轮次与等待）",
    /this\.attempts\.detach\(\)/u.test(bodyOf("restart")),
  );
  check(
    "dispose 走 `attempts.dispose()`（窗口释放 = 作废在途轮 + 收连接）",
    /this\.attempts\.dispose\(\)/u.test(bodyOf("dispose")),
  );
}

// ---------- 3. 客户端回调只代表"当前这个客户端"，判据走轮次 ----------
{
  const body = bodyOf("connectOnce");
  check(
    "状态回调以轮次的身份判据守卫（`round.isCurrent(client)`）",
    /round\.isCurrent\(client\)/u.test(body),
    "少了它：被换掉的客户端仍会把 connection/retryable 改回去",
  );
  check("这一轮作废之后静默让位（`round.stale()`）", /round\.stale\(\)/u.test(body));
  check(
    "用户叫停后放弃这一轮（`round.userStopped()` + `attempts.abandon(round)`）",
    /round\.userStopped\(\)/u.test(body) && /attempts\.abandon\(round\)/u.test(body),
  );
  check(
    "建新客户端前先收掉旧的（`attempts.detach()`，而不是只覆盖字段）",
    /this\.attempts\.detach\(\)/u.test(body),
    "少了它：旧客户端成了没人管的无限重连循环",
  );
  check(
    "接管失败（这一轮已不作数）时立刻放弃（`if (!round.adopt(client)) return;`）",
    /if\s*\(!round\.adopt\(client\)\)\s*return;/u.test(body),
    "少了它：过期轮次会把客户端装进账本、覆盖新轮已经接管的那条",
  );
  check(
    "catch 里先查这一轮还作不作数，再分类失败（`if (round.stale()) return;`）",
    /catch\s*\(error\)\s*\{[\s\S]{0,400}?if\s*\(round\.stale\(\)\)\s*return;[\s\S]{0,200}?classifyConnectFailure/u.test(body),
    "少了它：换目标/叫停之后迟到的 auth 失败仍会把界面拉进错误档、写旧目标的详情",
  );
}

// ---------- 4. 两道闸归模块，控制器不再自己存字段 ----------
{
  check("控制器没有 autoReconnect 字段（自动路径的闸归账本）", !/private autoReconnect/u.test(source));
  check("控制器没有 retryable 字段（本轮结算的闸归账本）", !/private retryable/u.test(source));
  check("控制器不再自己动作废轮次（没有 connectRoundId 字段）", !/private connectRoundId/u.test(source));
  check("控制器不再自己记在途那一轮（没有 connectPromise 字段）", !/private connectPromise/u.test(source));
  const heartbeat = bodyOf("handleHeartbeat");
  check(
    "心跳的两道闸读账本（`attempts.autoReconnect` / `attempts.retryable`）",
    /this\.attempts\.autoReconnect/u.test(heartbeat) && /this\.attempts\.retryable/u.test(heartbeat),
  );
  check(
    "心跳不许为外部目标并发建第二个客户端（已有客户端就交给它自己重连）",
    /this\.client\s*&&\s*this\.target\.kind\s*===\s*"external"/u.test(heartbeat),
    "少了它：client 的 ws 重连与心跳的 ensure 会各建一个客户端",
  );
}

// ---------- 5. 目标不是内部时，**内部那套一个字都不许动界面** ----------
//
// 2026-09-19 立的是「目标为外部」这一档；2026-10-18 桌面端接进来之后，同一个道理对它同样
// 成立（桌面端那一支也不走 supervisor，管理器报的内部状态与我们这条连接无关），所以这条
// 断言覆盖**两个非内部目标**。
{
  const body = bodyOf("onServerStatus");
  check(
    "onServerStatus 在目标为外部 / 桌面端时提前返回（内部那套的退场/失败不许改写界面）",
    /this\.target\?\.kind\s*===\s*"external"\s*\|\|\s*this\.target\?\.kind\s*===\s*"desktop"/u.test(body),
    "少了它：内部守护进程退场/换地址会把界面从'连着外部'拉回按钮态",
  );
}

// ---------- 6. 心跳里「目标不是内部就断开」与「叫停过不许接回」两道兜底的**顺序** ----------
//
// 这不是风格问题，是那次 bug 的**形状本身**：要修的状态恰恰是"目标已经是外部、socket 却
// 还连着"。把兜底写在 `if (this.connection?.connected) return;` **后面**，它就永远不生效
// ——而 typecheck、行为断言、真机探针都不会红。
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

// ---------- 6b. 桌面端目标：端点每次启动都变，比对必须用**刚探到的那一份** ----------
//
// 这是桌面端接入里最容易写错、也最难发现的一处：管理器那份 `status.info` 是本窗口自己
// `ensure()` 时写下的旧值，拿它和手里的客户端比会**永远**"端点没变"，于是安装更新替换宿主
// （端口与凭据一起换）之后，客户端会一直重连一个已经不存在的端口——用户看到的只是
// "一直正在连接…"，没有任何报错。所以：未连接那一档与**已连接那一档**都要重新发现。
{
  const heartbeat = bodyOf("handleHeartbeat");
  check(
    "心跳对桌面端目标重新发现端点（不是拿管理器那份旧 status.info 比）",
    /probeDesktop\(false\)/u.test(heartbeat) && /sameEndpoint\(current\.baseUrl, this\.client\.baseUrl\)/u.test(heartbeat),
    "少了它：宿主被替换（端口变了）之后永远判「端点没变」",
  );
  check(
    "「已连接」那一档也覆盖桌面端（否则替换宿主之后客户端会一直重连死端口）",
    /this\.connection === "connected"[\s\S]{0,600}?this\.target\?\.kind === "desktop"[\s\S]{0,900}?probeDesktop\(false\)/u.test(heartbeat),
    "桌面端的重发现必须排在那条分支里（连上的时候也要能发现宿主换了）",
  );
  check(
    "桌面端可连接时按原目标重建连接（走 reconnectPeer → ensure，重新发现 + 重新签票）",
    /reconnectPeer\(\{ baseUrl: current\.baseUrl, owned: false, ownership: "desktop" \}\)/u.test(heartbeat),
  );
  check(
    "桌面端这一刻连不上就什么都不发起（不自行拉起，也不改重连意图）",
    /current\.kind !== "attached"\) return;/u.test(heartbeat),
  );
}

// ---------- 7. 管理器侧：release 那一档同时"断"与"挡" ----------
{
  const release = bodyOf("releaseInternal", managerSource);
  check(
    "releaseInternal 是薄壳：走新入口的 release 那一档（交还占用）",
    /this\.stop\(\s*\{\s*release:\s*true\s*\}\s*\)/u.test(release),
    "少了它：「停止连接」没走统一入口，停止那几件事又会散回各处",
  );
  const stopEntry = bodyOf("stop", managerSource);
  check(
    "release 那一档同时做两件事：置位 detachedByUser + 收连接（只断不挡 = 5 秒后被接回去）",
    /if\s*\(release\)\s*this\.detachedByUser\s*=\s*true;/u.test(stopEntry) && /detachConnection\s*\(/u.test(stopEntry),
  );
  check(
    "bringUp 清掉 detachedByUser（显式动作必须能重新接上）",
    /this\.detachedByUser = false/u.test(bodyOf("bringUp", managerSource)),
  );
  check(
    "stopAndExit 是薄壳：走新入口的 askSupervisor + cancelWait 那一档",
    /this\.stop\(\s*\{\s*cancelWait:\s*true,\s*askSupervisor:\s*true\s*\}\s*\)/u.test(bodyOf("stopAndExit", managerSource)),
  );
  check(
    "「请守护进程收场」按「手里有没有活连接」决定要不要短暂接入（不是按目标）",
    /connection\?\.connected !== true/u.test(bodyOf("askSupervisorToStop", managerSource)),
    "少了它：交还占用后「停止内部 DSH」会静默空转并谎报没有在运行",
  );
}

// ---------- 8. 控制器不再镜像管理器：连接那组字段读**只读快照** ----------
{
  check("控制器没有 internalRunning 字段（并进了 facts）", !/private internalRunning/u.test(source));
  check("控制器没有 externalReachable 字段（并进了 facts）", !/private externalReachable/u.test(source));
  check(
    "两轴只剩一份观测（private facts: TargetFacts）",
    /private facts: TargetFacts/u.test(source),
    "两个字段各自赋值 = 改了内部忘了外部，按钮态的文案与按钮集就开始各说各话",
  );
  check(
    "connectionPatch 读管理器快照（不再自己拼那 9 个字段）",
    /snapshot: this\.server\.snapshot\(\)/u.test(bodyOf("connectionPatch")),
  );
  check(
    "界面那组字段的判定在一个纯函数里（connectionFieldsOf）",
    /^function connectionFieldsOf\(/mu.test(source),
    "散回组件/方法里就没有单一来源可言了",
  );
  check("外部地址来自快照（snapshot.externalUrl），不再直接问管理器 getter", /externalAddress: snapshot\.externalUrl/u.test(source));
  check(
    "外部两态复用 connectTarget 的 externalStateOf（一份实现，不重写「没配地址」的判据）",
    /externalState: externalStateOf\(facts\)/u.test(source),
  );
  check(
    "控制器读管理器状态只剩快照一条路（不再调 getStatus()）",
    !/this\.server\.getStatus\(/u.test(source),
    "两处读同一份状态 = 两处状态各说各话；`getStatus()` 留给探针与旧调用点",
  );
}

if (failures > 0) {
  console.error(`\n✗ 连接收场的接线（落点各走哪个意图 / 回调身份判据 / 闸归账本）：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 连接收场的接线（档位只在一个地方拼 / 四个落点各走对意图 / 回调身份判据走轮次 / 两道闸归账本 / 心跳兜底顺序 / release 同时断与挡 / 连接字段读快照）全通过",
  );
  assert.ok(true);
}
