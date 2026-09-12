/**
 * 配置文件热重载的端到端证据。
 *
 *   node build/config-reload-probe.mjs
 *
 * 用**独立的临时 `DSH_HOME`** 起一个真实的 `dsh web`（完全不碰用户的 `~/.dsh`），
 * 然后直接改磁盘上的配置文件，断言它们真的以转发帧到达客户端：
 *
 *   1. `settings.yaml` 的外部编辑 → `$events` 收到
 *      `{type:'emit', event:'settings/document-updated', args:[ns, revision]}`
 *      （宿主侧链路：dsh-settings-file 的 chokidar → reconcileFromDisk → publish
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
 * 为什么用临时 home：热重载的配置是**用户级**的，探针必须能改文件而不能碰
 * 用户的设置与凭据。临时 home 里 dsh 会按随附模板自动初始化 `web` profile
 * （`loadProfile` 找不到 profile 目录时用 `PROFILE_TEMPLATES` 建一个），
 * bundle 从安装锚点解析，不需要装依赖。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../src/dsh/client";
import { ConfigChangeRouter, type ConfigChangeActions } from "../src/dsh/configChanges";
import { ServerManager } from "../src/dsh/serverManager";

const home = mkdtempSync(join(tmpdir(), "dsh-chat-config-probe-"));
process.env.DSH_HOME = home;

const settingsFile = join(home, "settings.yaml");
const credentialsFile = join(home, ".credentials.yaml");
// 起进程**之前**就把两份文档放好：watcher 直接盯住已存在的文件，
// 少一个「文件晚于 watcher 出现」的可变因素
writeFileSync(settingsFile, "# dsh-chat config-reload probe\n", "utf8");
writeFileSync(credentialsFile, "version: 1\nrefs: {}\n", "utf8");

const log = (line: string) => console.log(`[probe] ${line}`);
const server = new ServerManager({ url: "", command: "dsh", startTimeoutMs: 180_000, log });
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

  // ---------- 1. settings.yaml 的外部编辑 ----------
  //
  // 用 `ui-conversation.busyEnter`（DSH Chat 真读的字段，取值 queue/steer）；
  // 临时 home 里没有这个命名空间时退到第一个能安全写布尔值的（改的是临时
  // home，怎么写都不影响用户）。
  const target = namespaces.includes("ui-conversation")
    ? { ns: "ui-conversation", body: "ui-conversation:\n  busyEnter: steer\n" }
    : pickBooleanTarget(described.namespaces ?? []);
  console.log(`1) 直接改 ${settingsFile}`);
  console.log(`   目标：${target ? target.ns : "（找不到可安全改写的命名空间）"}`);
  if (target) {
    const before = framesOf("settings/document-updated").length;
    writeFileSync(settingsFile, target.body, "utf8");
    const arrived = await waitFor(
      () => framesOf("settings/document-updated").length > before,
      "settings/document-updated 帧",
    );
    const frame = framesOf("settings/document-updated").at(-1);
    check(
      arrived && frame?.args[0] === target.ns && typeof frame?.args[1] === "number",
      `settings.yaml 外部编辑 → settings/document-updated(ns, revision)`,
      `收到：${JSON.stringify(frame ?? null)}`,
    );
  } else {
    check(false, "settings.yaml 热重载", "本机 web profile 里没有可安全改写的命名空间");
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
  // 用户 2026-09-12 报的现场：改 `settings.yaml` 里某个模型的 `reasoningEfforts`
  // （删掉一档），模型选择框里的档位不变。这一步先钉住**服务端事实**：
  // `session/modelCatalog` 到底跟不跟——不跟就不是客户端的事；
  // 跟了，则问题在「客户端有没有重取目录」。
  console.log(`\n3) 改模型的思考档位（llm-pi-ai 的探针路由）`);
  writeFileSync(settingsFile, probeProviderYaml(["low", "high"]), "utf8");
  const twoTiers = await waitForCatalog((tiers) => tiers.includes("low") && tiers.includes("high"));
  console.log(`   写入两档（low/high）→ 目录读到：${JSON.stringify(twoTiers)}`);
  check(
    twoTiers.includes("low") && twoTiers.includes("high"),
    "服务端目录反映 settings.yaml 声明的档位",
    `目录：${JSON.stringify(twoTiers)}`,
  );

  const framesBeforeTierEdit = emits.length;
  writeFileSync(settingsFile, probeProviderYaml(["high"]), "utf8");
  const oneTier = await waitForCatalog((tiers) => !tiers.includes("low") && tiers.includes("high"));
  console.log(`   删掉 low 档 → 目录读到：${JSON.stringify(oneTier)}`);
  const tierFrames = emits.slice(framesBeforeTierEdit);
  check(
    !oneTier.includes("low") && oneTier.includes("high"),
    "删档后服务端目录只剩声明的那一档（客户端重取就能看到）",
    `目录：${JSON.stringify(oneTier)}；这一步到达的帧：${JSON.stringify(tierFrames)}`,
  );

  // ---------- 4. 真实帧驱动了重读 ----------
  await router.settled();
  console.log("\n4) 真实帧 → ConfigChangeRouter");
  check(reloads.includes("settings"), "设置层被重读（设置面板 / busyEnter / 图片能力 / 默认模型）", `动作：${reloads.join(", ")}`);

  // 只把「删档」那一批帧喂给一个**干净**的路由器：这批帧里没有
  // llm/adapters-updated（路由集合没变），修复前它就只会重读设置、
  // 不重取目录——这正是模型选择框档位不变的根因。
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

  console.log(`\n$events 上收到的 emit 帧：${emits.length} 条`);
  for (const frame of emits) console.log(`   - ${frame.event} ${JSON.stringify(frame.args)}`);
} catch (error) {
  console.error("\n探针本身出错：", error);
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
 * 找一个「写进 settings.yaml 一定合法」的命名空间：值里有布尔叶子字段即可
 * （布尔字段没有枚举/下界，翻转一定过 schema）。
 * @param namespaces - `settings/describe` 的命名空间视图。
 * @returns 目标命名空间与要写进去的整段 YAML，找不到时为 undefined。
 */
function pickBooleanTarget(
  namespaces: { ns: string; value?: unknown }[],
): { ns: string; body: string } | undefined {
  for (const item of namespaces) {
    const value = item.value as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, leaf] of Object.entries(value)) {
      if (typeof leaf !== "boolean") continue;
      return { ns: item.ns, body: `${item.ns}:\n  ${key}: ${leaf ? "false" : "true"}\n` };
    }
  }
  return undefined;
}

/**
 * 探针路由的 settings.yaml 内容：一条不指向任何真实服务的 `llm-pi-ai` 路由，
 * 只带一个模型与给定的思考档位。目录是从设置解析出来的，不需要网络。
 * @param levels - 要声明的思考档位（THINKING_LEVELS 的名字）；`off` 恒定附带。
 * @returns 整份 settings.yaml 文本。
 */
function probeProviderYaml(levels: string[]): string {
  const efforts = [...levels, "off"].map((level) => `            ${level}: ${level}`).join("\n");
  return [
    "llm-pi-ai:",
    "  providers:",
    "    dsh-chat-probe:",
    "      displayName: DSH Chat Probe",
    "      apiKeyEnv: DSH_CHAT_PROBE_KEY",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:9/v1",
    "      reasoning: high",
    "      models:",
    "        - id: probe-model",
    "          name: Probe Model",
    "          contextWindow: 128000",
    "          reasoningEfforts:",
    efforts,
    "",
  ].join("\n");
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
