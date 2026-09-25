/**
 * DSH 兼容性追踪工具（命令行入口）。
 *
 * ## 用途
 *
 * 官方发新版后，用它回答三个问题：**有没有新版本、新版动了什么、要不要跟着更新**。
 * 全部离线（除取版本号与下载发布产物）——不装 DSH、不起服务器、不花 token。
 *
 * ## 命令
 *
 * - `watch`：列出**当前对齐基准之后**尚未核对的官方版本（渠道、是否已在 npm、是否有快照），
 *   并提示已过移除期限的兼容代码。
 * - `snapshot <版本>`：抓该版本的契约面，落盘到 `docs/dsh-contract/<版本>.json`。
 * - `diff <旧版本> <新版本>`：两个快照求差，按 P0/P1/P2 分级。
 * - `check <版本>`：`snapshot` + `diff` + **发布去向判定**（只有 npm `latest` 指向的版本
 *   才推扩展商店，其余只发 GitHub Release），并提示核对完成后怎么推进基准行。
 *
 * ## 依据
 *
 * 渠道口径与发布去向见 `docs/dsh-compat.md`；分级规则与抽取逻辑见 `scripts/dshContract.ts`。
 * 契约来自官方 npm 产物：每个 api 包都带 `lib/typert.host.js`（描述符）与 `lib/**\/*.d.ts`（类型面）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  compareDshVersions,
  diffSnapshots,
  extractTypertContract,
  extractTypeContract,
  parseDshVersion,
  renderReport,
  SNAPSHOT_FORMAT_VERSION,
  summarize,
  versionFromTag,
  type ConsumptionSurface,
  type ContractSnapshot,
  type PackageContract,
} from "./dshContract";
import { PROJECTION_KEYS } from "../src/dsh/projectionIngest";
import { CONSUMED_EVENT_TYPES, RENDERED_EVENT_TYPES, SILENT_EVENT_TYPES } from "../src/dsh/protocol";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = join(ROOT, "docs", "dsh-contract");
const COMPAT_DOC = join(ROOT, "docs", "dsh-compat.md");
const CACHE_DIR = join(ROOT, ".agent", "temp", "dsh-contract-cache");
const UPSTREAM_REPO = "https://github.com/deepseek-ai/deepseek-harness.git";
const REGISTRY = "https://registry.npmjs.org";

/**
 * 抓哪些包。取舍：本扩展真正消费的契约都在这几个包的描述符里——会话/命令/技能/子代理在
 * `api-session-controller`，鉴权与传输在 `client-connection`，网关帧在 `api-gateway`，
 * 后台任务在 `api-job-controller`，设置、工作区、预设、权限、模型目录各有其包。取不到的包
 * 会被记进快照的 `missing`（缺证据不等于没影响，报告里会显式列出，不静默当「无变化」）。
 *
 * **包名会随官方重构搬家**：`agentPresets/*` 端点在 0.1.7-alpha.1 随包改名从
 * `dsh-agent-presets` 迁到 `dsh-agent-preset-registry`（旧包不再发布）。那时报告会把
 * 旧包报成 `package-removed`，而端点其实还在——所以这里必须跟着改名，否则会得到一条
 * 假的 P0（0.1.7-rc.1 的核对里就撞上过）。**两个名字都留在表里**：只留新名会让旧版本
 * 的快照丢掉那个包的全部端点与类型（它当时确实叫旧名），核对旧版本时就少了证据。
 */
const CONTRACT_PACKAGES = [
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-api-settings-controller",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-api-job-controller",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-file-upload",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-agent-presets",
  "@deepseek-ai/dsh-agent-preset-registry",
  "@deepseek-ai/dsh-permission-presets",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-goal",
  "@deepseek-ai/dsh-plan-mode",
  "@deepseek-ai/dsh-subagent",
];

// ---------------------------------------------------------------- 官方版本清单

interface RegistryFacts {
  /** 全部已发布版本。 */
  readonly versions: readonly string[];
  /** dist-tag → 版本。 */
  readonly distTags: Record<string, string>;
}

/** 官方 git tag（`dsh-v*`）。这是**最早**能知道有新版本的地方：npm 发布是手动触发的。 */
function fetchUpstreamTags(): string[] {
  const output = execFileSync("git", ["ls-remote", "--tags", UPSTREAM_REPO], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const versions = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /refs\/tags\/(dsh-v\S+?)(\^\{\})?$/.exec(line.trim());
    if (match === null) continue;
    const version = versionFromTag(match[1]);
    if (version !== undefined) versions.add(version);
  }
  return [...versions].sort(compareDshVersions);
}

async function fetchRegistryFacts(): Promise<RegistryFacts> {
  const response = await fetch(`${REGISTRY}/@deepseek-ai%2Fdsh`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`registry 取 @deepseek-ai/dsh 失败：HTTP ${String(response.status)}`);
  const packument = (await response.json()) as { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> };
  return { versions: Object.keys(packument.versions ?? {}), distTags: packument["dist-tags"] ?? {} };
}

// ---------------------------------------------------------------- 发布产物

/** 取一个包某版本的 tarball URL（registry 是唯一权威来源，不猜 URL 形状）。 */
async function tarballUrl(pkg: string, version: string): Promise<string | undefined> {
  const response = await fetch(`${REGISTRY}/${pkg.replace("/", "%2F")}/${version}`, { headers: { accept: "application/json" } });
  if (!response.ok) return undefined;
  const manifest = (await response.json()) as { dist?: { tarball?: string } };
  return manifest.dist?.tarball;
}

async function downloadTarball(pkg: string, version: string): Promise<Buffer | undefined> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, `${pkg.replace(/[@/]/g, "_")}-${version}.tgz`);
  if (existsSync(cached)) return readFileSync(cached);
  const url = await tarballUrl(pkg, version);
  if (url === undefined) return undefined;
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(cached, bytes);
  return bytes;
}

/** 最小 tar 读取器：只认 ustar 头，够读 npm tarball（无 GNU 长名、无稀疏文件）。 */
function readTarEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = cString(header, 0, 100);
    if (name === "") break;
    const size = parseInt(cString(header, 124, 12).trim() || "0", 8);
    const prefix = cString(header, 345, 155);
    // typeflag：0x30('0') 普通文件、0x00 早期 tar 的普通文件；目录与扩展头一律跳过。
    const typeflag = header[156];
    const start = offset + 512;
    if (typeflag === 0x30 || typeflag === 0x00) {
      entries.set(prefix === "" ? name : `${prefix}/${name}`, buffer.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function cString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8").trim();
}

/** 一个版本的契约快照：逐包抓 tarball → 抽端点/事件/类型面。 */
async function buildSnapshot(version: string): Promise<ContractSnapshot> {
  const packages: Record<string, PackageContract> = {};
  const missing: string[] = [];
  for (const pkg of CONTRACT_PACKAGES) {
    const tarball = await downloadTarball(pkg, version);
    if (tarball === undefined) {
      missing.push(pkg);
      continue;
    }
    const files = readTarEntries(gunzipSync(tarball));
    const typertEntry = files.get("package/lib/typert.host.js");
    const typert = extractTypertContract(typertEntry === undefined ? "" : typertEntry.toString("utf8"));
    const declarations = [...files.entries()]
      .filter(([path]) => path.startsWith("package/lib/") && path.endsWith(".d.ts"))
      .map(([path, data]) => ({ path, text: data.toString("utf8") }));
    packages[pkg] = {
      endpoints: typert.endpoints,
      events: typert.events,
      types: extractTypeContract(declarations),
    };
    process.stdout.write(`  取到 ${pkg}：端点 ${String(Object.keys(typert.endpoints).length)}、事件 ${String(typert.events.length)}、类型 ${String(Object.keys(packages[pkg].types).length)}\n`);
  }
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, version, generatedAt: new Date().toISOString(), packages, missing };
}

function snapshotPath(version: string): string {
  return join(CONTRACT_DIR, `${version}.json`);
}

function loadSnapshot(version: string): ContractSnapshot | undefined {
  const path = snapshotPath(version);
  if (!existsSync(path)) return undefined;
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as ContractSnapshot;
  // 抽取规则变过（格式版本不同）时当作没有：拿两套规则的结果做差会凭空多出一堆「变化」
  return snapshot.formatVersion === SNAPSHOT_FORMAT_VERSION ? snapshot : undefined;
}

async function ensureSnapshot(version: string): Promise<ContractSnapshot> {
  const existing = loadSnapshot(version);
  if (existing !== undefined) return existing;
  process.stdout.write(`抓契约快照 ${version} …\n`);
  const snapshot = await buildSnapshot(version);
  mkdirSync(CONTRACT_DIR, { recursive: true });
  writeFileSync(snapshotPath(version), `${JSON.stringify(snapshot, undefined, 2)}\n`);
  return snapshot;
}

// ---------------------------------------------------------------- 本扩展的消费面

/** 源码文本里出现过的端点字面量（`"session/list"` 这类），与官方端点表求交即调用面。 */
function endpointsUsedInSource(): Set<string> {
  const used = new Set<string>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/"([A-Za-z$][A-Za-z0-9_$]*\/[A-Za-z][A-Za-z0-9_$]*)"/g)) used.add(match[1]);
  }
  return used;
}

/**
 * 源码与契约笔记里引用过的标识符（用于判断「这个契约类型我们到底碰没碰」）。
 *
 * 除了三个源码目录，还扫 `docs/dsh-server-api.md`：那份文档是本扩展逐字摘抄出来的契约参考，
 * 里面点名的类型（如 `PermissionSelect`、`AgentPresetRoster`）就是我们在用的那批——即使源码
 * 按字段内联读值、没有显式写出类型名，类型一改名也该被认出来。
 */
function identifiersUsedInSource(): Set<string> {
  const used = new Set<string>();
  const files = ["src/dsh", "src/shared", "src/webview"].flatMap((directory) => sourceFiles(join(ROOT, directory)));
  const notes = join(ROOT, "docs", "dsh-server-api.md");
  if (existsSync(notes)) files.push(notes);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_$]{2,})\b/g)) used.add(match[1]);
  }
  return used;
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/**
 * 从仓库已有登记点组装消费面——不另立清单（投影键、事件表、端点调用点各只有一处）。
 *
 * 传**两个快照**：类型名要在「旧 + 新」的并集里认。只在旧快照里存在的类型正是「这一版被删掉了」
 * 的那一类，拿新快照去求交会永远认不出它——被删掉的类型于是被报成 P2（无关），而它恰恰是最该
 * 报 P0 的（实测 `PermissionSelect` 就这么漏过一次）。
 */
function consumptionSurface(from: ContractSnapshot, to: ContractSnapshot): ConsumptionSurface {
  const endpoints = endpointsUsedInSource();
  const events = new Set([...RENDERED_EVENT_TYPES, ...CONSUMED_EVENT_TYPES, ...SILENT_EVENT_TYPES]);
  const identifiers = identifiersUsedInSource();
  const types = new Set<string>();
  for (const snapshot of [from, to]) {
    for (const contract of Object.values(snapshot.packages)) {
      for (const name of Object.keys(contract.types)) {
        if (identifiers.has(name)) types.add(name);
      }
      for (const [endpoint, shape] of Object.entries(contract.endpoints)) {
        if (!endpoints.has(endpoint)) continue;
        for (const symbol of shape.types) {
          const name = symbol.split("#")[1];
          if (name !== undefined && !name.includes(":")) types.add(name);
        }
      }
    }
  }
  return { endpoints, events, types };
}

// ---------------------------------------------------------------- 基准行与兼容层

const BASELINE_MARK = "<!-- dsh-compat:baseline -->";
const LAYER_START = "<!-- dsh-compat:layers:start -->";
const LAYER_END = "<!-- dsh-compat:layers:end -->";

/**
 * 读「当前对齐基准」：`docs/dsh-compat.md` 里带锚点标记的那一行（反引号里是版本号）。
 *
 * 文档里**只记当前基准，不记历史台账**（逐版本结论归提交说明与 CHANGELOG）：本扩展是从某个版本
 * 开始对齐的，它之前的官方版本不需要核对——从最早的 tag 补起会把二十多个历史版本全变成待办。
 * 基准行只在「那一版的差异处理完」之后才推进，于是没处理完的版本会一直留在待办里。
 */
function readBaseline(): string | undefined {
  if (!existsSync(COMPAT_DOC)) return undefined;
  const line = readFileSync(COMPAT_DOC, "utf8")
    .split("\n")
    .find((candidate) => candidate.includes(BASELINE_MARK));
  if (line === undefined) return undefined;
  const match = /`([^`]+)`/.exec(line);
  if (match === null) return undefined;
  const version = match[1].trim();
  return parseDshVersion(version) === undefined ? undefined : version;
}

interface LayerRow {
  readonly item: string;
  readonly span: string;
  readonly place: string;
  readonly since: string;
  readonly deadline: string;
}

/** 兼容层登记：每条兼容代码都带移除期限（用户口径：加入起两个月后移除）。 */
function readLayers(): LayerRow[] {
  return readTable(LAYER_START, LAYER_END)
    .filter((cells) => cells.length >= 5 && /^\d{4}-\d{2}-\d{2}$/.test(cells[4]))
    .map((cells) => ({ item: cells[0], span: cells[1], place: cells[2], since: cells[3], deadline: cells[4] }));
}

function readTable(start: string, end: string): string[][] {
  if (!existsSync(COMPAT_DOC)) return [];
  const text = readFileSync(COMPAT_DOC, "utf8");
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return [];
  return text
    .slice(from + start.length, to)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^-{2,}$/.test(cell) || cell === ""));
}

// ---------------------------------------------------------------- 命令

async function commandWatch(): Promise<void> {
  const tags = fetchUpstreamTags();
  const registry = await fetchRegistryFacts();
  const published = new Set(registry.versions);
  const latest = registry.distTags["latest"];
  // 基准来自 `docs/dsh-compat.md` 的「当前对齐基准」行（文档只记当前版本，不记历史台账）。
  // 它之后的版本才是待办：本扩展从基准那一版开始对齐，之前的版本不需要核对。
  const baseline = readBaseline();
  const pending = tags.filter((version) => baseline === undefined || compareDshVersions(version, baseline) > 0);

  process.stdout.write(`官方 tag ${String(tags.length)} 个；当前对齐基准 ${baseline ?? "（未登记）"}；基准之后未核对 ${String(pending.length)} 个。\n`);
  process.stdout.write(`npm dist-tag：${Object.entries(registry.distTags).map(([tag, version]) => `${tag}=${version}`).join("  ")}\n`);
  process.stdout.write(`扩展商店对齐基准（npm latest）：${latest ?? "（无）"}\n\n`);
  if (pending.length === 0) {
    process.stdout.write(baseline === undefined ? "没读到基准行：在 docs/dsh-compat.md 的「当前对齐基准」一节记一行。\n" : "基准之后没有新的官方版本。\n");
  } else {
    process.stdout.write("| 版本 | 渠道 | 已在 npm | 是 latest | 已有快照 |\n| --- | --- | --- | --- | --- |\n");
    for (const version of pending.slice(0, 15)) {
      const channel = parseDshVersion(version)?.channel ?? "other";
      process.stdout.write(
        `| ${version} | ${channel} | ${published.has(version) ? "是" : "否（仅 GitHub）"} | ${version === latest ? "是" : ""} | ${existsSync(snapshotPath(version)) ? "是" : ""} |\n`,
      );
    }
    if (pending.length > 15) process.stdout.write(`\n（只列最早 15 个，共 ${String(pending.length)} 个未核对）\n`);
    process.stdout.write(`\n下一步：npm run dsh:check -- ${pending[0]}\n（从未核对的**最早**一个开始，逐版本往前推，差异才有明确的基准）\n`);
  }
  reportOverdueLayers();
}

function reportOverdueLayers(): void {
  const today = new Date().toISOString().slice(0, 10);
  const layers = readLayers();
  const overdue = layers.filter((layer) => layer.deadline <= today);
  process.stdout.write(`\n兼容层登记 ${String(layers.length)} 条，已到移除期限 ${String(overdue.length)} 条。\n`);
  for (const layer of overdue) process.stdout.write(`  · ${layer.item}（${layer.place}，期限 ${layer.deadline}）\n`);
}

async function commandSnapshot(version: string): Promise<void> {
  await ensureSnapshot(version);
  process.stdout.write(`已写入 ${relative(ROOT, snapshotPath(version))}\n`);
}

async function commandDiff(from: string, to: string): Promise<void> {
  const before = loadSnapshot(from);
  const after = await ensureSnapshot(to);
  if (before === undefined) {
    process.stderr.write(`缺 ${from} 的快照，先跑：npm run dsh:snapshot -- ${from}\n`);
    process.exitCode = 1;
    return;
  }
  const changes = diffSnapshots(before, after, consumptionSurface(before, after));
  process.stdout.write(`${renderReport(from, to, changes)}\n`);
  process.stdout.write(`结论：${summarize(changes)}\n`);
  process.exitCode = changes.some((change) => change.level === "P0") ? 2 : 0;
}

async function commandCheck(version: string): Promise<void> {
  const registry = await fetchRegistryFacts();
  const published = new Set(registry.versions);
  const baseline = readBaseline();
  const after = await ensureSnapshot(version);
  const tags = fetchUpstreamTags();
  const channel = parseDshVersion(version)?.channel ?? "other";
  const latest = registry.distTags["latest"];

  process.stdout.write(`\n版本 ${version}（渠道 ${channel}）\n`);
  process.stdout.write(`  · 官方 tag：${tags.includes(version) ? "有" : "没有（可能在 tag 之前就拿到了产物）"}\n`);
  process.stdout.write(`  · npm：${published.has(version) ? "已发布" : "未发布（仅 GitHub）"}\n`);
  process.stdout.write(`  · 是 npm latest：${version === latest ? "是 → 扩展同步发扩展商店 + GitHub Release" : `否（latest = ${latest ?? "无"}）→ 扩展只发 GitHub Release`}\n`);

  if (baseline === undefined) {
    process.stdout.write("\n没读到基准行，无法给差异——先在 docs/dsh-compat.md 的「当前对齐基准」一节记一行。\n");
    process.exitCode = 1;
    return;
  }
  if (compareDshVersions(baseline, version) >= 0) {
    process.stdout.write(`\n当前对齐基准是 ${baseline}，不比 ${version} 更早，没有可求差的基准。\n要看两个历史版本之间的差异：npm run dsh:diff -- <旧版本> <新版本>\n`);
    process.exitCode = 1;
    return;
  }
  const before = await ensureSnapshot(baseline);
  const changes = diffSnapshots(before, after, consumptionSurface(before, after));
  process.stdout.write(`\n基准 ${baseline} → ${version}\n\n`);
  process.stdout.write(`${renderReport(baseline, version, changes)}\n`);
  process.stdout.write(`结论：${summarize(changes)}\n`);
  if (after.missing.length > 0) {
    process.stdout.write(`\n⚠ 有 ${String(after.missing.length)} 个包没取到（${after.missing.join(", ")}）——缺证据不等于没影响，需人工确认。\n`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const hasP0 = changes.some((change) => change.level === "P0");
  // 基准行只在差异处理完之后才推进：没推进的版本会一直被 `watch` 列出来，直到有人收尾。
  if (hasP0) {
    process.stdout.write(`\n有 P0：先按上面的条目改代码并跑过三件套，**改完再**把 docs/dsh-compat.md 的「当前对齐基准」行推进到 ${version}。\n`);
  } else {
    process.stdout.write(`\n没有破坏：把 docs/dsh-compat.md 的「当前对齐基准」行改成 \`${version}\`（核对日期 ${today}）即算核对完成。\n`);
  }
  process.exitCode = hasP0 ? 2 : 0;
}

function usage(): void {
  process.stdout.write(
    [
      "用法：node build/dsh-compat.mjs <命令>",
      "",
      "  watch                 列出基准之后尚未核对的官方版本、发布去向基准、已过期的兼容代码",
      "  snapshot <版本>       抓该版本的契约快照（docs/dsh-contract/<版本>.json）",
      "  diff <旧> <新>        两个快照求差，按 P0/P1/P2 分级",
      "  check <版本>          快照 + 差异 + 发布去向判定 + 基准行推进提示",
      "",
    ].join("\n"),
  );
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "watch") await commandWatch();
  else if (command === "snapshot" && rest[0] !== undefined) await commandSnapshot(rest[0]);
  else if (command === "diff" && rest[0] !== undefined && rest[1] !== undefined) await commandDiff(rest[0], rest[1]);
  else if (command === "check" && rest[0] !== undefined) await commandCheck(rest[0]);
  else usage();
} catch (error) {
  process.stderr.write(`失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
