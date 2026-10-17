/**
 * 离线断言：`dshChat.autoConnect` 改动**即时生效**，不提示重载窗口，且**不触发连接**
 * （2026-09-19 / 2026-10-18 用户口径）。
 *
 * 此前 `url` / `command` / `autoConnect` 三项改动都触发 `promptServerReload()`（提示重载
 * 窗口）。用户收紧：`autoConnect` 只是"自动路径的许可"，改完不该要求重载——只有
 * `dshChat.url` / `dshChat.command`（决定"连哪个服务器、怎么拉起"，激活期只读一次）
 * 才需要重载窗口。
 *
 * 用户 2026-10-18 再收紧：自动连接一个扩展宿主**只做一次**（扩展启动那一趟，见
 * `docs/design-supervisor.md`「自动连接只做一次」）。所以改开关既不再"马上自动连一次"，
 * 也不收回已建好的连接——它只把许可交给管理器。行为面由
 * `autoConnectOnce.test.ts`（驱真 `ChatController`）覆盖，这里钉的是源码结构。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
const manager = readFileSync(join(process.cwd(), "src", "dsh", "supervisorManager.ts"), "utf8");

/**
 * 取一个方法的**完整函数体**（与 connectionStop.test.ts 同款）。
 */
function bodyOf(name: string, text: string): string {
  const definition = new RegExp(`^  (?:private |public )?(?:async )?${name}\\s*\\(`, "u");
  let offset = 0;
  for (const line of text.split("\n")) {
    if (definition.test(line)) {
      const lineEnd = offset + line.length;
      const open = text.lastIndexOf("{", lineEnd);
      assert.ok(open >= offset, `${name} 的函数体开括号不在定义行`);
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
  throw new Error(`找不到方法 ${name}`);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- 1. 配置监听：`autoConnect` 不再与 url/command 一起触发重载提示 ----------
{
  // 取「url/command 的 if 块 → promptServerReload 调用」这一段，钉住 autoConnect 不在里面
  const start = extension.indexOf('event.affectsConfiguration("dshChat.url")');
  const end = extension.indexOf("void promptServerReload();", start);
  assert.ok(start >= 0 && end > start, "extension.ts 里找不到 url/command 的重载提示块");
  const reloadBlock = extension.slice(start, end + "void promptServerReload();".length);
  check(
    "重载提示的触发条件里只有 url / command，没有 autoConnect",
    !/dshChat\.autoConnect/.test(reloadBlock),
    "autoConnect 也弹「重载窗口」= 用户改开关被要求重载（2026-09-19 口径不该这样）",
  );
  check(
    "url / command 改动仍触发 promptServerReload",
    /event\.affectsConfiguration\("dshChat\.url"\)/.test(reloadBlock) &&
      /event\.affectsConfiguration\("dshChat\.command"\)/.test(reloadBlock) &&
      /void promptServerReload\(\);/.test(reloadBlock),
    "这两项决定连哪个服务器、怎么拉起，激活期只读一次，必须重载窗口生效",
  );
  check(
    "autoConnect 改动改走 applyAutoConnect 即时应用",
    /event\.affectsConfiguration\("dshChat\.autoConnect"\)[\s\S]{0,200}?controller\.applyAutoConnect\(/.test(extension),
    "少了它：autoConnect 改动没有任何生效路径，等于白改",
  );
}

// ---------- 2. ChatController.applyAutoConnect：只更新许可，不触发连接 ----------
//
// 自动连接只在扩展启动时做一趟（`startup()` 那一趟，行为面见 autoConnectOnce.test.ts）。
// 改开关不再是"马上连一次"的落点——那正是"停掉后台之后又被自动拉起来"的另一条来路；
// 改关也不收回已经建好的连接（要立即断开照旧用「停止连接」）。
{
  const body = bodyOf("applyAutoConnect", controller);
  check(
    "更新管理器的自动路径许可（server.setAutoConnect）",
    /this\.server\.setAutoConnect\(value\)/.test(body),
    "少了它：canStart() 还是旧值，省略 start 的 ensure() 按旧许可走",
  );
  check(
    "不发起任何连接（既没有 ensureConnected，也不去调 autoConnect）",
    !/ensureConnected\(/.test(body) && !/this\.autoConnect\(/.test(body),
    "改开关触发连接 = 用户改配置的动作被当成「我要起一套后台」",
  );
  check(
    "不按连接状态分叉（改开关不该看界面停在哪个档）",
    !/this\.connection\s*===/.test(body),
    "改开打断正在跑的会话、或改关把它收掉，都不是这个开关该做的事",
  );
  check(
    "粘性目标也不参与（不重选路）",
    !/this\.target/.test(body),
    "选路只在激活期那一趟发生，改开关不许替他换服务器",
  );
  check(
    "控制器自己不再读 dshChat.autoConnect 配置（许可只在扩展启动时读一次）",
    !/get(?:<[^>]*>)?\(\s*"autoConnect"\s*\)/.test(controller),
    "控制器里再读一次 = 心跳/恢复/补空壳又有了按开关自动拉起的来路",
  );
}

// ---------- 3. SupervisorManager.setAutoConnect：写的就是 canStart 读的那个字段 ----------
{
  const body = bodyOf("setAutoConnect", manager);
  check(
    "setAutoConnect 更新 options.autoConnect",
    /this\.options\.autoConnect\s*=\s*value/.test(body),
    "canStart() 读的是 this.options.autoConnect（默认 true），不写它等于没生效",
  );
  check(
    "canStart 仍读 options.autoConnect",
    /return\s*this\.options\.autoConnect\s*\?\?\s*true/.test(bodyOf("canStart", manager)),
    "两处读的是同一个字段，改动才不会各说各话",
  );
}

// ---------- 4. 用户点按钮永远不受 autoConnect 约束；两个内部按钮同一套逻辑 ----------
//
// 用户 2026-09-19 口径：「`autoConnect` 只是决定 VSCode 启动后是否自动连接，不影响任何用户
// 主动点击按钮的逻辑」；并且「启动内部 DSH」与「连接内部 DSH」是**同一套逻辑**（有就接上、
// 没有就起一套）——界面显示哪个按钮是按两轴探测给的措辞，与后台真实状态会有偏差，语义相同
// 才不会出现「点对了按钮却什么都没发生」。
//
// 这一条在这里钉的是**许可这个值**（某条入口传了 true 还是 false），而不是实现形状：
// 两个内部入口都必须传 true，外部入口必须传 false。行为面另有 autoConnectOnce.test.ts
// （驱真 ChatController）覆盖"显式动作不受开关影响、迟到的自动选路让位"。
{
  check(
    "「启动内部 DSH」允许拉起（mayStart=true）",
    /beginConnect\("internal",\s*true/.test(bodyOf("startInternal", controller)),
    "内部不存在时这个按钮就是主动作",
  );
  check(
    "「连接内部 DSH」同样允许拉起（mayStart=true）",
    /beginConnect\("internal",\s*true/.test(bodyOf("connectInternal", controller)),
    "与「启动内部 DSH」同一套逻辑：显示「连接」时后台也可能还没起",
  );
  check(
    "「连接外部 DSH」不拉起任何东西（mayStart=false）",
    /beginConnect\("external",\s*false/.test(bodyOf("connectExternal", controller)),
    "外部目标从来不由扩展拉起",
  );
  // 显式动作一路把 start 传下去：不许在中途被 autoConnect 改写
  for (const name of ["startInternal", "connectInternal"]) {
    check(
      `「${name === "startInternal" ? "启动" : "连接"}内部 DSH」把 start: true 传给了 ensureConnected`,
      /ensureConnected\(\{\s*start:\s*true/.test(bodyOf(name, controller)),
      "传 false 会被管理器的 startAllowed 挡成 ServerNotRunningError（回按钮态）",
    );
  }
}

console.log(failures === 0 ? "\nautoConnectConfig: 全部通过 ✓" : `\nautoConnectConfig: ${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
