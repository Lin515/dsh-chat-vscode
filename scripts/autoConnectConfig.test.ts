/**
 * 离线断言：`dshChat.autoConnect` 改动**即时生效**，不提示重载窗口（2026-09-19 用户口径）。
 *
 * 此前 `url` / `command` / `autoConnect` 三项改动都触发 `promptServerReload()`（提示重载
 * 窗口）。用户收紧：`autoConnect` 只是"自动路径的许可"，改完不该要求重载——只有
 * `dshChat.url` / `dshChat.command`（决定"连哪个服务器、怎么拉起"，激活期只读一次）
 * 才需要重载窗口。
 *
 * 这一组是**源码结构断言**（controller 依赖 `vscode`，离线起不了实例），与
 * `connectionStop.test.ts` 同一套写法。改动这些方法时如果丢了某一句，这里会直接红。
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

// ---------- 2. ChatController.applyAutoConnect：三件事一件都不能少 ----------
{
  const body = bodyOf("applyAutoConnect", controller);
  check(
    "先更新管理器的自动路径许可（server.setAutoConnect）",
    /this\.server\.setAutoConnect\(value\)/.test(body),
    "少了它：canStart() 还是旧值，心跳/自动路径按旧许可走",
  );
  check(
    "改关（!value）只更新许可，不打断现有连接",
    /if\s*\(!value\)\s*\{[\s\S]{0,200}?return;/.test(body),
    "改关不该动任何连接——用户想立即断开照旧用「停止连接」",
  );
  check(
    "改开只在「按钮态」才考虑自动选路",
    /this\.connection\s*===\s*"stopped"\s*\|\|\s*this\.connection\s*===\s*"error"/.test(body),
    "正在连接/已连接时改开不该打断正在跑的会话",
  );
  check(
    "按钮态下还要求「从没定过目标」才自动选路",
    /!this\.target/.test(body),
    "用户点过按钮（有粘性目标）时改开不该替他重选路",
  );
  check(
    "改开 → 按钮态且无目标时走 autoConnect(true)",
    /void\s*this\.autoConnect\(true\)/.test(body),
    "这是「改完开关马上生效」的落点",
  );
  check(
    "applyAutoConnect 不直接 ensureConnected（选路逻辑复用在 autoConnect 里）",
    !/ensureConnected\(/.test(body),
    "直接 ensure 会绕过选路，目标可能不是按两轴探测选出来的",
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
// 这一条只能是源码级断言：`ChatController` 还没有能被测试调用的接缝（`scripts/` 里没有文件
// import 它，见 docs/audit-summary.md 第五批的背景）。所以这里钉的是**许可这个值**，
// 而不是某个函数的实现形状：两个内部入口都必须传 true，外部入口必须传 false。
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
