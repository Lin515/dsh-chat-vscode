/**
 * 【探针定位】勘察型 · 零模型 token —— 钉「settings/credentials 外部编辑以转发帧
 *   到达客户端」这条链路证据，结论固化在 configChanges 的处理；只在重开配置热重载
 *   问题时跑（自管临时 DSH_HOME，不发模型消息）。
 *
 * 配置文件热重载的端到端证据。
 *
 *   node build/config-reload-probe.mjs
 *
 * 用**独立的临时 `DSH_HOME`** 起一个真实的 `dsh web`（完全不碰用户的 `~/.dsh`），
 * 然后直接改磁盘上的配置文件，断言它们真的以转发帧到达客户端：
 *
 *   1. 设置文档的外部编辑 → `$events` 收到
 *      `{type:'emit', event:'settings/document-updated', args:[ns, revision]}`
 *      （宿主侧链路：watcher → 重解析 profile 层 → 设置服务 describe 比对 → publish
 *      → bumpRevision → emitDocumentUpdated → dsh-api-remotes 转发 → 网关广播）；
 *   2. `.credentials.yaml` 的外部编辑 → `credentials/reference-updated`；
 *   3. 改模型的思考档位：服务端 `session/modelCatalog` 确实跟着变，且这一步
 *      **只发 settings/document-updated**（不发 `llm/adapters-updated`）——
 *      用户 2026-09-12 报的「删了一档，模型选择框里的档位不变」的根因；
 *   4. 把这些**真实帧**喂给 `ConfigChangeRouter`，它确实触发了重读动作，
 *      其中「只删档的那批帧」也必须触发模型目录重取。
 *
 * 第 3、4 条是关键：1、2 只证明帧在路上，3 证明服务端事实变了，4 证明本扩展
 * 会因它重读界面状态。
 *
 * **设置文档在哪**（0.2.0 世代）：`ConfigEditor.documentPath` 就是当前 profile 的
 * `profiles/<name>/cordis.patch.yml`，**不是** `$DSH_HOME/settings.yaml`——后者在
 * 新版 home 里根本不存在（老机器上只剩一个迁移产物 `settings.yaml.imported`）。
 * 该 patch 是**顶层 YAML 数组**（`- id: <插件条目 id>` + `config:`），而模板里带一个
 * 空数组 `[]`：**追加前必须剔掉那个 `[]`**，否则同一文档出现两条根节点，服务端
 * `parse overlay` 直接抛错、什么都收不到（本探针旧版写错文件 + 没剔 `[]`，两条
 * 都踩过；排查结论见本文件末尾的注释与 `docs/dsh-server-api.md`）。
 *
 * 为什么用临时 home：热重载的配置是**用户级**的，探针必须能改文件而不能碰
 * 用户的设置与凭据。临时 home 里 dsh 会按随附模板自动初始化 `web` profile
 * （`loadProfile` 找不到 profile 目录时用 `PROFILE_TEMPLATES` 建一个），
 * bundle 从安装锚点解析，不需要装依赖。
 */
// 必须排在最前：supervisor 会合目录指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// DSH_HOME 由本文件自管（下文要预放配置文件并保持空凭据），这里只隔离会合目录。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[config-reload] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../src/dsh/client";
import { ConfigChangeRouter, type ConfigChangeActions } from "../src/dsh/configChanges";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const home = mkdtempSync(join(tmpdir(), "dsh-chat-config-probe-"));
process.env.DSH_HOME = home;

const credentialsFile = join(home, ".credentials.yaml");
// 只在**起进程之前**放好凭据文档：watcher 直接盯住已存在的文件，少一个
// 「文件晚于 watcher 出现」的可变因素。设置文档**不能**在这里放——它的位置是
// profile 目录下的 `cordis.patch.yml`，而 profile 目录由 dsh 首次启动时创建，
// 所以那一步放在 `ensure()` 之后（见 writeSettingsPatch）。
writeFileSync(credentialsFile, "version: 1\nrefs: {}\n", "utf8");

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new SupervisorManager({ url: "", command: "dsh web --port 0 --no-open", log });
let client: DshClient | undefined;
const failures: string[] = [];

/** `$events` 上收到的全部 emit 帧。 */
const emits: { event: string; args: unknown[] }[] = [];
let eventsReady = false;

/** 把真实帧喂给路由器，记录它决定重读什么。 */
const reloads: string[] = [];
const actions: ConfigChangeActions = {
  reloadSettings: async () => void reloads.push("settings"),
  reloadModelTopology: async () => void reloads.push("topology"),
  reloadCommandCatalogs: async (sessionId) => void reloads.push(`catalogs:${sessionId ?? "all"}`),
};
const router = new ConfigChangeRouter(actions, log);

function check(ok: boolean, label: string, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

function framesOf(event: string): { event: string; args: unknown[] }[] {
  return emits.filter((frame) => frame.event === event);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`  ! 等待超时：${what}`);
  return false;
}

try {
  console.log(`临时 DSH_HOME：${home}\n`);
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  client.openEvents({
    onItem: (value) => {
      const frame = value as { type?: string; event?: string; args?: unknown[] };
      if (frame?.type === "ready") {
        eventsReady = true;
        return;
      }
      if (frame?.type !== "emit" || typeof frame.event !== "string") return;
      emits.push({ event: frame.event, args: Array.isArray(frame.args) ? frame.args : [] });
      router.handle(frame.event, frame.args ?? []);
    },
  });

  if (!(await waitFor(() => eventsReady, "$events ready", 20_000))) {
    throw new Error("$events 流没有就绪——后面的断言无从谈起");
  }

  const described = await client.settingsDescribe();
  const namespaces = (described.namespaces ?? []).map((item) => item.ns);
  console.log(`命名空间 ${namespaces.length} 个：${namespaces.join(", ")}\n`);

  // ---------- 1. 设置文档（当前 profile 的 patch 层）的外部编辑 ----------
  //
  // 字段用 `ui-conversation.busyEnter`（DSH Chat 真读的字段，取值 queue/steer）。
  // **翻转**现有值而不是写死一个：写同样的值不会让 describe 的 raw 变化，
  // 也就不会发帧——那会变成「探针自己把断言跑成假绿」。临时 home 里没有这个
  // 命名空间时退到第一个能安全写布尔值的。
  const patchFile = writeSettingsPatch(home);
  console.log(`1) 直接改 ${patchFile}`);
  const currentBehavior = settingsLeaf(described.namespaces ?? [], "ui-conversation", "busyEnter");
  const target =
    namespaces.includes("ui-conversation")
      ? {
          ns: "ui-conversation",
          config: { busyEnter: currentBehavior === "steer" ? "queue" : "steer" } as Record<string, unknown>,
        }
      : pickBooleanTarget(described.namespaces ?? []);
  console.log(`   目标：${target ? target.ns : "（找不到可安全改写的命名空间）"}`);
  if (target) {
    const before = framesOf("settings/document-updated").length;
    writeSettingsPatch(home, target.ns, target.config);
    const arrived = await waitFor(
      () => framesOf("settings/document-updated").length > before,
      "settings/document-updated 帧",
    );
    const frame = framesOf("settings/document-updated").at(-1);
    // 与服务端事实对一次账：帧说改了就够，但还要证明**服务端真的读到了**新值
    // （只发帧而值没变，界面上就是「点了没反应」）。
    const after = await client.settingsDescribe();
    const landed = settingsLeaf(after.namespaces ?? [], target.ns, Object.keys(target.config)[0] ?? "");
    check(
      arrived && frame?.args[0] === target.ns && typeof frame?.args[1] === "number",
      "设置文档外部编辑 → settings/document-updated(ns, revision)",
      `收到：${JSON.stringify(frame ?? null)}`,
    );
    check(
      landed !== undefined && String(landed) === String(Object.values(target.config)[0]),
      "服务端读到的就是新值（不只是发了帧）",
      `describe 里的值：${JSON.stringify(landed)}`,
    );
  } else {
    check(false, "设置文档热重载", "本机 web profile 里没有可安全改写的命名空间");
  }

  // ---------- 2. .credentials.yaml 的外部编辑 ----------
  //
  // 保留已有内容（服务端可能已写进自己的记录），只往 `refs:` 下插一行。
  console.log(`\n2) 直接改 ${credentialsFile}`);
  const beforeCredentials = framesOf("credentials/reference-updated").length;
  writeFileSync(credentialsFile, withProbeRef(readFileSync(credentialsFile, "utf8")), "utf8");
  const arrivedCredentials = await waitFor(
    () => framesOf("credentials/reference-updated").length > beforeCredentials,
    "credentials/reference-updated 帧",
  );
  const credentialFrame = framesOf("credentials/reference-updated").at(-1);
  check(
    arrivedCredentials && credentialFrame?.args[0] === "DSH_CHAT_PROBE",
    "credentials.yaml 外部编辑 → credentials/reference-updated(ref)",
    `收到：${JSON.stringify(credentialFrame ?? null)}`,
  );

  // ---------- 3. 改模型思考档位：服务端目录必须跟着变 ----------
  //
  // 用户 2026-09-12 报的现场：改模型配置里某个模型的 `reasoningEfforts`（删掉一档），
  // 模型选择框里的档位不变。这一步先钉住**服务端事实**：`session/modelCatalog`
  // 到底跟不跟——不跟就不是客户端的事；跟了，则问题在「客户端有没有重取目录」。
  //
  // 写法与第 1 节同一条链路：改的是**当前 profile 的 patch 层**（那条 `llm-pi-ai`
  // 行），只是这次改的是它 `config.providers` 里的探针路由。探针路由进不了目录时
  // （patch 的整条 config 覆盖不通过插件 schema 校验），后面两条档位断言与第 4 节
  // 的拓扑断言都无从谈起——那时明确报「本次无法验证」，而不是让它们假红。
  console.log(`\n3) 改模型的思考档位（llm-pi-ai 的探针路由）`);
  writeSettingsPatch(home, "llm-pi-ai", probeProviderConfig(["low", "high"]));
  const twoTiers = await waitForCatalog((tiers) => tiers.includes("low") && tiers.includes("high"));
  console.log(`   写入两档（low/high）→ 目录读到：${JSON.stringify(twoTiers)}`);
  const routeMaterialized = twoTiers.includes("low") && twoTiers.includes("high");
  check(
    routeMaterialized,
    "服务端目录反映设置文档声明的档位",
    `目录：${JSON.stringify(twoTiers)}`,
  );

  const framesBeforeTierEdit = emits.length;
  let tierFrames: { event: string; args: unknown[] }[] = [];
  if (routeMaterialized) {
    writeSettingsPatch(home, "llm-pi-ai", probeProviderConfig(["high"]));
    const oneTier = await waitForCatalog((tiers) => !tiers.includes("low") && tiers.includes("high"));
    console.log(`   删掉 low 档 → 目录读到：${JSON.stringify(oneTier)}`);
    tierFrames = emits.slice(framesBeforeTierEdit);
    check(
      !oneTier.includes("low") && oneTier.includes("high"),
      "删档后服务端目录只剩声明的那一档（客户端重取就能看到）",
      `目录：${JSON.stringify(oneTier)}；这一步到达的帧：${JSON.stringify(tierFrames)}`,
    );
  } else {
    console.log("   ! 探针路由没进目录：本节的档位断言与第 4 节的拓扑断言跳过（不是产品回归）");
  }

  // ---------- 4. 真实帧驱动了重读 ----------
  await router.settled();
  console.log("\n4) 真实帧 → ConfigChangeRouter");
  check(reloads.includes("settings"), "设置层被重读（设置面板 / busyEnter / 图片能力 / 默认模型）", `动作：${reloads.join(", ")}`);

  // 只把「删档」那一批帧喂给一个**干净**的路由器：这批帧里没有
  // llm/adapters-updated（路由集合没变），修复前它就只会重读设置、
  // 不重取目录——这正是模型选择框档位不变的根因。
  if (!routeMaterialized) {
    console.log("   ! 没有真实帧可喂：拓扑断言本次跳过（见上一节的说明）");
  } else {
    const tierReloads: string[] = [];
    const tierRouter = new ConfigChangeRouter(
      {
        reloadSettings: async () => void tierReloads.push("settings"),
        reloadModelTopology: async () => void tierReloads.push("topology"),
        reloadCommandCatalogs: async () => undefined,
      },
      () => {},
    );
    for (const frame of tierFrames) tierRouter.handle(frame.event, frame.args);
    await tierRouter.settled();
    check(
      tierReloads.includes("topology"),
      "只有 settings/document-updated（删档不发 llm/adapters-updated）也会重取模型目录",
      `删档帧：${JSON.stringify(tierFrames.map((frame) => frame.event))}；动作：${tierReloads.join(", ") || "（无）"}`,
    );
  }

  console.log(`\n$events 上收到的 emit 帧：${emits.length} 条`);
  for (const frame of emits) console.log(`   - ${frame.event} ${JSON.stringify(frame.args)}`);
} catch (error) {
  // 探针自己抛错也必须算失败：只设 exitCode 的话，下面那句「链路成立」的汇总
  // 会照样打出来（曾经真的这么假绿过一次）。
  console.error("\n探针本身出错：", error);
  failures.push(`探针本身出错：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
  // 断言全过就删掉临时 home；有失败则保留现场（日志里已打印路径）供复查
  if (failures.length === 0 && process.exitCode !== 1) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      console.log(`[probe] 临时 home 清理失败（不影响结论）：${String(error)}`);
    }
  } else {
    console.log(`\n[probe] 现场保留在 ${home}`);
  }
}

console.log(
  failures.length === 0
    ? "\n✓ 配置文件热重载链路成立：外部编辑 → 转发帧 → 重读动作"
    : `\n✗ ${failures.length} 条断言失败：\n   - ${failures.join("\n   - ")}`,
);
if (failures.length) process.exitCode = 1;

/**
 * 覆盖当前 profile patch 层里的**一条** `- id:` 行，返回被改的文件路径。
 *
 * 为什么不是「整份写」：patch 层是**顶层 YAML 数组**，同级的每条 `- id:` 行各管一个
 * 插件条目；整份覆盖会把别的行连同 bundle 层要用的内容一起抹掉。所以这里读出现有
 * 文档，只替换/追加目标 id 的那一行。
 *
 * `[]` 必须剔掉：profile 模板的形状是「注释头 + 空数组 `[]`」，直接往后追加 `- id:`
 * 会让同一个文档出现两条根节点，服务端 `parse overlay` 抛错、一个帧都不发
 * （本探针旧版踩过，现场是 `YAMLException: end of the stream or a document
 * separator is expected`）。
 *
 * @param home - 临时 DSH_HOME（profile 目录由 dsh 首次启动时建好）。
 * @param ns - 要覆盖的条目 id；省略时只做「剔掉 `[]`」这一步，不改任何条目。
 * @param config - 写进该条目 `config:` 的原始配置对象。
 * @returns 被改的 `cordis.patch.yml` 绝对路径。
 */
function writeSettingsPatch(home: string, ns?: string, config?: Record<string, unknown>): string {
  const path = join(home, "profiles", "web", "cordis.patch.yml");
  const kept = (existsSync(path) ? readFileSync(path, "utf8") : "")
    .split("\n")
    .filter((line) => line.trim() !== "[]")
    .join("\n")
    .trimEnd();
  if (ns === undefined) {
    writeFileSync(path, `${kept}\n`, "utf8");
    return path;
  }
  const block = `- id: ${ns}\n  config:\n${indent(yamlScalar(config ?? {}), 4)}`;
  const lines = kept.split("\n");
  const at = lines.findIndex((line) => line === `- id: ${ns}`);
  if (at < 0) {
    writeFileSync(path, `${kept}\n${block}\n`, "utf8");
    return path;
  }
  // 那条行的范围：到下一个顶层 `- id:` 行为止（含其后的空行，保持文档留白不乱）
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    if (/^- /.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  lines.splice(at, end - at, ...block.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === "")));
  writeFileSync(path, `${lines.join("\n").trimEnd()}\n`, "utf8");
  return path;
}

/**
 * 读 `settings/describe` 里某个命名空间下某个字段的**生效值**。
 * @param namespaces - `settings/describe` 的命名空间视图。
 * @param ns - 命名空间（= profile patch 里的条目 id）。
 * @param field - 字段名。
 * @returns 生效值；命名空间或字段不存在时 undefined。
 */
function settingsLeaf(namespaces: { ns: string; value?: unknown }[], ns: string, field: string): unknown {
  const item = namespaces.find((row) => row.ns === ns);
  const value = item?.value as Record<string, unknown> | undefined;
  return value && typeof value === "object" ? value[field] : undefined;
}

/**
 * 找一个「写进去一定合法」的命名空间：值里有布尔叶子字段即可
 * （布尔字段没有枚举/下界，翻转一定过 schema）。
 * @param namespaces - `settings/describe` 的命名空间视图。
 * @returns 目标命名空间与要写进它 `config:` 的对象，找不到时为 undefined。
 */
function pickBooleanTarget(
  namespaces: { ns: string; value?: unknown }[],
): { ns: string; config: Record<string, unknown> } | undefined {
  for (const item of namespaces) {
    const value = item.value as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, leaf] of Object.entries(value)) {
      if (typeof leaf !== "boolean") continue;
      return { ns: item.ns, config: { [key]: !leaf } };
    }
  }
  return undefined;
}

/**
 * 探针路由的 `llm-pi-ai` 配置：一条不指向任何真实服务的路由，只带一个模型与给定的
 * 思考档位。目录是从设置解析出来的，不需要网络。
 * @param levels - 要声明的思考档位（`THINKING_LEVELS` 的名字）；`off` 恒定附带。
 * @returns 写进 patch 行 `config:` 的对象。
 */
function probeProviderConfig(levels: string[]): Record<string, unknown> {
  return {
    providers: {
      "dsh-chat-probe": {
        displayName: "DSH Chat Probe",
        apiKeyEnv: "DSH_CHAT_PROBE_KEY",
        api: "openai-completions",
        baseURL: "http://127.0.0.1:9/v1",
        reasoning: "high",
        models: [
          {
            id: "probe-model",
            name: "Probe Model",
            contextWindow: 128000,
            reasoningEfforts: Object.fromEntries([...levels, "off"].map((level) => [level, level])),
          },
        ],
      },
    },
  };
}

/** 把一段 YAML 文本整体缩进（空行保持为空）。 */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

/** 极简 YAML 序列化：只覆盖本探针用到的对象 / 数组 / 标量，避免为此引依赖。 */
function yamlScalar(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = yamlScalar(item, depth + 1);
        return typeof item === "object" && item !== null
          ? `${pad}-\n${rendered}`
          : `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        if (typeof item === "object" && item !== null) {
          return `${pad}${key}:\n${yamlScalar(item, depth + 1)}`;
        }
        return `${pad}${key}: ${formatScalar(item)}`;
      })
      .join("\n");
  }
  return `${pad}${formatScalar(value)}`;
}

/** 标量渲染：字符串一律引号包住（这些值里可能有 `:` 与 `/`）。 */
function formatScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * 轮询 `session/modelCatalog` 直到探针模型的档位满足条件。
 * @param predicate - 收到档位 id 列表后判断是否到位。
 * @returns 最后一次读到的档位 id 列表（超时也返回，交给断言判）。
 */
async function waitForCatalog(predicate: (tiers: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  let tiers: string[] = [];
  while (Date.now() < deadline) {
    tiers = await probeTiers();
    if (predicate(tiers)) return tiers;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return tiers;
}

/** 读一次探针模型声明的档位。 */
async function probeTiers(): Promise<string[]> {
  try {
    const catalog = await client!.modelCatalog();
    const group = (catalog.groups ?? []).find((item) => item.id === "dsh-chat-probe");
    const model = group?.models.find((item) => item.id === "probe-model");
    return (model?.reasoning?.efforts ?? []).map((effort) => effort.id);
  } catch {
    return [];
  }
}

/**
 * 往凭据文档的 `refs:` 下插一行探针引用，其余内容逐字保留。
 * @param text - 当前文档文本（探针启动时已写成 `version: 1 / refs: {}`）。
 * @returns 新文档文本。
 */
function withProbeRef(text: string): string {
  const lines = text.split(/\r?\n/);
  const refsAt = lines.findIndex((line) => /^refs:/.test(line));
  if (refsAt < 0) return `${text.replace(/\s*$/, "")}\nrefs:\n  DSH_CHAT_PROBE: probe\n`;
  if (/^refs:\s*\{\s*\}\s*$/.test(lines[refsAt])) {
    lines[refsAt] = "refs:";
    lines.splice(refsAt + 1, 0, "  DSH_CHAT_PROBE: probe");
  } else {
    lines.splice(refsAt + 1, 0, "  DSH_CHAT_PROBE: probe");
  }
  return lines.join("\n");
}
