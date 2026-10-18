/**
 * `@` 候选的**本地目录列举**：工作区内的尾巴补全与工作区外的发现（M1 / M3）。
 *
 * 服务器一次只回 20 条（`DEFAULT_FILE_SEARCH_MAX_RESULTS`，是 dsh 插件的配置、不是请求
 * 参数），宿主按官方同一套语义把被截掉的尾巴补回来（用户 2026-10-10 报「@ 文件列表显示
 * 不全，感觉像有个上限值」——那个上限就是它）。工作区外那一半由本扩展自己出清单：
 * 官方 `@` 发现以工作目录为根，越界查询在服务端恒为空，所以本地给出的就是唯一一份。
 *
 * 这一组断言钉六件事：
 *
 * 1. **纯函数**（第 1 节，真盘上建临时目录）：目录在前 / 文件在后、同组按 path 的
 *    **原始 code-unit** 排序（不是 locale）、点开头的条目跳过（但用户已经进去的
 *    点目录照常列）、被排除的目录名跳过、目录行不带结尾斜杠；
 * 2. **只补目录列举**（第 2 节）：工作区内的 fragment 非空（用户在目录里打了筛选字）
 *    一律不补——那一半由服务器按 fuzzy 分数排序，本地复现不出来；
 * 3. **失败静默**（第 3 节）：目录不存在 / 越出工作目录 / 服务器回空表，都只是「不补」，
 *    绝不抛错、也绝不把服务器那 20 条弄丢；
 * 4. **宿主链路**（第 4 节，驱动真 `ChatController`，offline stub）：`files/list` 帧里
 *    既有服务器那几条（顺序位置一个不动），也有补齐的尾巴；
 * 5. **工作区外**（第 5 节，真盘上另建一棵树）：绝对路径（M1）与相对 `..`（M3）的列举、
 *    越大界筛选的五档顺序、点开头与排除目录照旧、失败静默；
 * 6. **路径解析的边界**（第 6 节，**注入 fs**，不碰真实磁盘 / 网络）：盘符与 UNC 的形态、
 *    逐段拒绝符号链接（含 `link/..` 那种、`path.resolve` 会先吃掉 link 的写法）、
 *    `..` 退到盘根就停、不完整的 UNC（`//server/`）**连一次 FS 调用都不发**、
 *    「上一层」行的取值与盘根边界。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listingTarget,
  missingDirectoryEntries,
  parentDirectoryEntry,
  outsideRank,
  type FileRefEntry,
} from "../src/dsh/fileRefListing";
import { LocalFsBudget, type FsProbe } from "../src/dsh/localAccess";

process.on("unhandledRejection", (error) => {
  console.error("[fileRefListing] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const paths = (entries: readonly FileRefEntry[]): string[] => entries.map((entry) => entry.path);

/** 临时工作目录：目录在前 / 文件在后、组内 code-unit 序（大写 < `_` < 小写）。 */
const root = await mkdtemp(join(tmpdir(), "dsh-file-ref-"));
// 目录（其中两个必须被跳过：被排除的目录名、点开头的名字）
for (const dir of ["Dir1", "adir", "node_modules", ".git", ".cache", "sub", join("sub", "inner"), "big"]) {
  await mkdir(join(root, ...dir.split("/")), { recursive: true });
}
// 病态大的目录（1200 条 > 补全的兜底上限）：用来钉「一帧不会把整份列举都塞进去」
await Promise.all(
  Array.from({ length: 1200 }, (_value, index) =>
    writeFile(join(root, "big", `f${String(index).padStart(4, "0")}.txt`), "x\n"),
  ),
);
// 文件（`.hidden` 必须被跳过；`Zeta.ts` / `_under.ts` 用来钉 code-unit 序而不是 locale 序）
for (const file of [
  "Zeta.ts",
  "_under.ts",
  "alpha.ts",
  "beta.ts",
  "gamma.ts",
  ".hidden",
  "sub/A.txt",
  "sub/b.txt",
  "sub/.dot",
  ".cache/inside.ts",
  ".cache/.hidden",
]) {
  await writeFile(join(root, ...file.split("/")), "x\n");
}

/** 期望的整份目录列举（根目录）：与官方 listDirectory + rankCandidates 的产物逐字一致。 */
const ROOT_LISTING = [
  "Dir1",
  "adir",
  "big",
  "sub",
  "Zeta.ts",
  "_under.ts",
  "alpha.ts",
  "beta.ts",
  "gamma.ts",
];

/**
 * 工作区外的那棵树（`root` 的兄弟目录）：`@<它的绝对路径>/` 就是 M1，`cwd` 放在
 * `root/sub` 里敲 `../` 就能列到 `root` 的内容（M3）。
 */
const outside = await mkdtemp(join(tmpdir(), "dsh-file-ref-out-"));
// 注意：Windows 文件名大小写不敏感，`OutDir` 与 `outdir` 会是**同一个**目录，
// 所以这里的两个目录名必须在忽略大小写之后仍然不同（`OutDir` / `adir`）
for (const dir of ["OutDir", "adir", "sub2", join("sub2", "qqdir")]) {
  await mkdir(join(outside, ...dir.split("/")), { recursive: true });
}
for (const file of ["Zeta.ts", "alpha.ts", "sub2/qq", "sub2/qqnotes.txt", "sub2/anoqq.txt", "sub2/q1q.txt", "sub2/x.txt", "sub2/.hidden"]) {
  await writeFile(join(outside, ...file.split("/")), "x\n");
}
/** 绝对形态的前缀（正斜杠）：与 `missingDirectoryEntries` 产出的 path 同形。 */
const outsidePrefix = `${outside.replaceAll("\\", "/")}/`;
const OUTSIDE_LISTING = ["OutDir", "adir", "sub2", "Zeta.ts", "alpha.ts"];
/** `sub2` 这一层：目录在前、再按 code-unit（`.` 开头的条目在筛选词为空时跳过）。 */
const SUB2_LISTING = ["qqdir", "anoqq.txt", "q1q.txt", "qq", "qqnotes.txt", "x.txt"];

console.log("fileRefListing: 目录列举补全（真盘临时目录 + 真控制器）");

// ---------- 1. 枚举与排序 ----------
{
  const all = await missingDirectoryEntries({ cwd: root, query: "", known: [] });
  assert.deepStrictEqual(
    paths(all),
    ROOT_LISTING,
    "目录列举要「目录在前、文件在后」+ 组内 code-unit 序，并跳过点开头与被排除的目录名",
  );
  assert.deepStrictEqual(
    all.slice(0, 2).map((entry) => entry.kind),
    ["directory", "directory"],
    "目录行在前",
  );
  assert.ok(
    all.every((entry) => !entry.path.endsWith("/")),
    "候选路径不带结尾斜杠（界面侧再补，见 shared/mentions.ts）——带了会让 path 去重对不上",
  );

  // 服务器只回了前 3 条（真实场景是它的 20 条上限）：尾巴按同一顺序追加在后面
  const known = ROOT_LISTING.slice(0, 3).map((path) => ({ path, kind: path.includes(".") ? ("file" as const) : ("directory" as const) }));
  const tail = await missingDirectoryEntries({ cwd: root, query: "", known });
  assert.deepStrictEqual(
    paths(tail),
    ROOT_LISTING.slice(3),
    "补齐的尾巴必须是整份列举里还没被服务器列出的那一段（顺序一致）",
  );
  assert.deepStrictEqual(
    [...paths(known), ...paths(tail)],
    ROOT_LISTING,
    "「服务器结果 + 补齐的尾巴」拼起来就是完整且正确的字母序列表",
  );

  // 服务器给的不是前缀时也只按 path 去重：它那几条一条不动，其余按序补在后面
  const partial: FileRefEntry[] = [{ path: "alpha.ts", kind: "file" }];
  const rest = await missingDirectoryEntries({ cwd: root, query: "", known: partial });
  assert.ok(!paths(rest).includes("alpha.ts"), "服务器已经给过的 path 不再重复补（按 path 去重）");
  assert.deepStrictEqual(
    [...paths(partial), ...paths(rest)],
    ["alpha.ts", "Dir1", "adir", "big", "sub", "Zeta.ts", "_under.ts", "beta.ts", "gamma.ts"],
    "服务器结果的顺序与位置一个都不动，补齐的条目按自己的排序跟在后面",
  );

  // 子目录列举：路径带上前缀，且用户已经进去的点目录照常列（点开头的跳过只针对条目名）
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: root, query: "sub/", known: [] })),
    ["sub/inner", "sub/A.txt", "sub/b.txt"],
    "进了子目录时列的是它的内容（前缀带上、'.dot' 跳过、目录不带结尾斜杠）",
  );
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: root, query: ".cache/", known: [] })),
    [".cache/inside.ts"],
    "用户已经进去的点目录照常列（跳过点开头只针对**条目名**，不是用户进去的那个目录）",
  );
  // 反斜杠写法（Windows 提示符下用户手输 / 服务端先归一）：与正斜杠逐字同一条路
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: root, query: "sub\\", known: [] })),
    ["sub/inner", "sub/A.txt", "sub/b.txt"],
    "反斜杠先归一成 `/` 再切目录前缀（候选路径一律正斜杠，官方同样先归一）",
  );

  // 一次补全的**兜底**上限（防「几万条的目录把整份列举塞进一帧」）：界面自己那道渲染上限
  // 更小（`CANDIDATE_LIST_LIMIT`），所以这个界只在病态大的目录上生效，不影响正常目录补全
  const big = await missingDirectoryEntries({ cwd: root, query: "big/", known: [] });
  assert.strictEqual(big.length, 1000, `一次最多补 1000 条（兜底上限），现在补了 ${big.length} 条`);
  assert.strictEqual(big[0].path, "big/f0000.txt", "兜底截断保留的是排序之后的**前**一段");
  assert.strictEqual(big[big.length - 1].path, "big/f0999.txt", "截断点落在排序过的顺序里（不是读盘顺序）");
}

// ---------- 2. 工作区内只补目录列举 ----------
{
  assert.deepStrictEqual(
    listingTarget(""),
    { scope: "inside", directory: "", prefix: "", fragment: "" },
    "空查询是根目录列举",
  );
  assert.deepStrictEqual(
    listingTarget("sub/"),
    { scope: "inside", directory: "sub/", prefix: "sub/", fragment: "" },
    "以 / 结尾是目录列举",
  );
  assert.deepStrictEqual(
    listingTarget("sub\\"),
    { scope: "inside", directory: "sub/", prefix: "sub/", fragment: "" },
    "反斜杠同样归一后再判",
  );
  assert.strictEqual(listingTarget("sub/a"), undefined, "目录前缀后还有筛选词 ⇒ 不是目录列举（服务器按 fuzzy 打分）");
  for (const query of ["a", "sub/a", "sub/ab", "alp"]) {
    assert.strictEqual(listingTarget(query), undefined, `"${query}" 不是本地补全（fragment 非空，工作区内）`);
    assert.deepStrictEqual(
      await missingDirectoryEntries({ cwd: root, query, known: [] }),
      [],
      `"${query}" 由服务器按 fuzzy 分数排序，本地不补（补了就是两段不同规则的清单）`,
    );
  }
}

// ---------- 3. 失败一律静默退回 ----------
{
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: root, query: "nope/", known: [] }),
    [],
    "目录不存在时不抛错，只是不补",
  );
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: root, query: "../", known: [] }),
    [],
    "信任门没通过时越界路径不列（拿不到「执行世界就是本机」的证据就不动手）",
  );
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: root, query: `${outsidePrefix}`, known: [], outsideAllowed: true })),
    OUTSIDE_LISTING.map((path) => `${outsidePrefix}${path}`),
    "信任门通过后绝对路径照列（M1）——这是越界发现的正题",
  );
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: root, query: "node_modules/", known: [] }),
    [],
    "被排除的目录前缀：服务器对这次查询直接回空表，本地也不许把它捞回来",
  );
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: "", query: "", known: [] }),
    [],
    "没有会话工作目录就无从列举（不是错误，是不补）",
  );
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: join(root, "nope"), query: "", known: [] }),
    [],
    "工作目录本身不存在时也不抛错",
  );
  // 服务器回空表 + 不是目录列举 ⇒ 结果仍是空表（不许凭本地枚举把列表「补」出来）
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: root, query: "zzz", known: [] }),
    [],
    "服务器回空表时原样返回（不抛错、也不凭空造候选）",
  );
}

// ---------- 4. 宿主链路：真 ChatController + offline stub ----------
{
  const { ChatController } = await import("../src/dsh/controller");

  /** 假服务端：只认自己建过的 agent id（两个 RPC 都是 `@RemoteScope('agent')`）。 */
  function fakeClient(serverItems: FileRefEntry[]) {
    const rows: { sessionId: string; cwd: string; blank: boolean; updatedAt: number; running: boolean }[] = [];
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    return {
      rows,
      calls,
      async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
        calls.push({ method: "session/create" });
        // 指名复用一条已有会话（`session/create` 的第二个位置参数，见 controller 的
        // `adoptBlankShell`）：服务端认得它就**还是那条**
        if (reuse !== undefined && rows.some((row) => row.sessionId === reuse)) return { sessionId: reuse };
        const sessionId = `session-${rows.length + 1}`;
        rows.push({ sessionId, cwd: target.cwd ?? "", blank: true, updatedAt: Date.now() + rows.length, running: false });
        return { sessionId };
      },
      async listSessions() {
        calls.push({ method: "session/list" });
        return { items: rows.map((row) => ({ ...row })) };
      },
      async request(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "agentPresets/list") return { presets: [] };
        if (method === "subagents/list") return { entries: [] };
        if (method === "session/projections") return { values: {} };
        const agentId = String(params?.agentId ?? "");
        if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
        if (method === "fileReferences/list") return serverItems.map((entry) => ({ ...entry }));
        if (method === "sessionReferenceResolver/candidates") return [];
        if (method === "commands/list") return [];
        if (method === "skills/list") return { skills: [] };
        return undefined;
      },
      async sessionProjections() {
        return { values: {} };
      },
      async getJson() {
        return undefined;
      },
      async settingsDescribe() {
        return { namespaces: [] };
      },
      followSession() {
        return { cancel() {} };
      },
      followJobs() {
        return { cancel() {} };
      },
      followControl() {
        return { cancel() {} };
      },
    };
  }

  const fakeServer = () => ({
    externalUrl: undefined,
    onHeartbeat() {},
    snapshot() {
      return { status: { info: undefined }, supervisorAlive: false };
    },
  });
  const fakeMemento = () => {
    const map = new Map<string, unknown>();
    return {
      get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      keys: () => [...map.keys()],
    };
  };

  function makeController(cwd: string, serverItems: FileRefEntry[]) {
    const controller = new ChatController(
      fakeServer() as never,
      () => undefined,
      fakeMemento() as never,
      fakeMemento() as never,
      { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
    );
    const frames: { target: string; frame: Record<string, unknown> }[] = [];
    (
      controller as never as { subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown }
    ).subscribe((target, frame) => frames.push({ target, frame }));
    const c = controller as unknown as {
      client: unknown;
      connection: string;
      viewSessions: Map<string, string>;
      newSessionCwd?: string;
      bindView(viewId: string): void;
      newSession(viewId?: string): Promise<void>;
      handle(message: Record<string, unknown>, viewId: string): Promise<void>;
    };
    c.newSessionCwd = cwd;
    const client = fakeClient(serverItems);
    c.client = client as never;
    c.connection = "connected";
    return { c, frames, client };
  }

  function lastFrame(frames: { target: string; frame: Record<string, unknown> }[], viewId: string, query: string) {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const { target, frame } = frames[i];
      if (target === viewId && frame.type === "files/list" && frame.query === query) return frame;
    }
    return undefined;
  }
  const lastItems = (frames: { target: string; frame: Record<string, unknown> }[], viewId: string, query: string) =>
    (lastFrame(frames, viewId, query)?.items ?? []) as FileRefEntry[];

  // 4a. 服务器只回前 3 条（真实场景是它的 20 条上限）→ 帧里是完整列表，且服务器那 3 条在前
  {
    const serverItems = ROOT_LISTING.slice(0, 3).map((path) => ({
      path,
      kind: path.includes(".") ? ("file" as const) : ("directory" as const),
    }));
    const { c, frames } = makeController(root, serverItems);
    c.bindView("v1");
    await c.newSession("v1");
    frames.length = 0;
    await c.handle({ type: "queryFiles", query: "" }, "v1");
    const frame = lastFrame(frames, "v1", "");
    assert.deepStrictEqual(paths((frame?.items ?? []) as FileRefEntry[]), ROOT_LISTING, "宿主把目录列举补全后再发帧（用户报的「显示不全」）");
    assert.deepStrictEqual(
      paths(((frame?.items ?? []) as FileRefEntry[]).slice(0, serverItems.length)),
      paths(serverItems),
      "服务器那几条的顺序与位置一个都不动（只往后追加）",
    );
    // 帧里带会话 cwd：界面拿它把候选 / 「上一层」行的展示路径解析成完整绝对路径（悬停标题）
    assert.strictEqual(frame?.cwd, root, "files/list 帧要带上这次查询的会话 cwd（悬停完整路径的解析基准）");
  }

  // 4b. 服务器回空表 + fragment 非空 → 帧里就是空表（不抛错、不凭空补）
  {
    const { c, frames } = makeController(root, []);
    c.bindView("v1");
    await c.newSession("v1");
    frames.length = 0;
    await c.handle({ type: "queryFiles", query: "zzz" }, "v1");
    assert.deepStrictEqual(lastItems(frames, "v1", "zzz"), [], "模糊查询（fragment 非空）那一路保持服务器结果");
  }

  // 4c. 目录列举但本地枚举失败（工作目录不存在）→ 原样发服务器结果
  {
    const serverItems: FileRefEntry[] = [{ path: "only.ts", kind: "file" }];
    const { c, frames } = makeController(join(root, "gone"), serverItems);
    c.bindView("v1");
    await c.newSession("v1");
    frames.length = 0;
    await c.handle({ type: "queryFiles", query: "" }, "v1");
    assert.deepStrictEqual(
      paths(lastItems(frames, "v1", "")),
      ["only.ts"],
      "枚举失败时静默退回服务器结果（列表不许变空、也不许抛错上抛）",
    );
  }

  // 4d. 宿主链路里的 M1：绝对路径查询由本地补出清单（服务器对越界查询恒为空表）
  {
    const { c, frames, client } = makeController(root, []);
    c.bindView("v1");
    await c.newSession("v1");
    frames.length = 0;
    await c.handle({ type: "queryFiles", query: outsidePrefix }, "v1");
    assert.deepStrictEqual(
      paths(lastItems(frames, "v1", outsidePrefix)),
      OUTSIDE_LISTING.map((path) => `${outsidePrefix}${path}`),
      "信任门通过（cwd 是本机真目录）时，绝对路径查询的候选由本地出",
    );
    assert.ok(
      client.calls.some((call) => call.method === "fileReferences/list"),
      "本地补全与服务器那一路并存（服务器对这些查询回空表，照样要问一次）",
    );
  }
}

// ---------- 5. 工作区外：M1 与 M3（真盘另一棵树） ----------
{
  // M1：绝对路径目录列举（前缀是那条绝对路径，目录行不带结尾斜杠）
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: root, query: outsidePrefix, known: [], outsideAllowed: true })),
    OUTSIDE_LISTING.map((path) => `${outsidePrefix}${path}`),
    "绝对路径列举：目录在前、文件在后，路径前缀就是查询里那一段",
  );
  // 反斜杠写法同样归一（Windows 手输）
  assert.deepStrictEqual(
    paths(
      await missingDirectoryEntries({
        cwd: root,
        query: outside.replaceAll("/", "\\") + "\\",
        known: [],
        outsideAllowed: true,
      }),
    ),
    OUTSIDE_LISTING.map((path) => `${outsidePrefix}${path}`),
    "反斜杠写的绝对路径归一后再列（候选路径一律正斜杠）",
  );
  // M3：相对 `..` 允许越出 cwd（cwd 在 root/sub 里，`../` 列的是 root）
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: join(root, "sub"), query: "../", known: [], outsideAllowed: true })),
    ROOT_LISTING.map((path) => `../${path}`),
    "相对 `..` 越出工作目录：列的是 cwd 的父目录，前缀保留 `../`",
  );
  // `..` 只在段的位置上才算：`a..b/` 是普通目录名
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: join(root, "sub"), query: "a..b/", known: [], outsideAllowed: true }),
    [],
    "名字里含 `..` 但不是 `..` 段：仍走工作区内那条路（目录不存在 → 空表）",
  );
  // 五档筛选：用 `../sub2/` 这条**固定的**相对前缀（`cwd` 放在 sub2 里），展示路径与
  // 临时目录名无关——「路径包含」那一档才只可能来自候选自己的路径
  const sub2Cwd = join(outside, "sub2");
  const filtered = paths(
    await missingDirectoryEntries({ cwd: sub2Cwd, query: "../sub2/qq", known: [], outsideAllowed: true }),
  );
  assert.deepStrictEqual(
    filtered,
    ["../sub2/qq", "../sub2/qqdir", "../sub2/qqnotes.txt", "../sub2/anoqq.txt", "../sub2/q1q.txt"],
    "五档近似：完全相等 > 名字前缀（同档目录优先）> 名字包含 > 路径包含 > 子序列，不匹配的不列",
  );
  assert.ok(
    !filtered.some((path) => path.endsWith("x.txt")),
    "哪个档都不匹配的条目不出现（不因先截断后过滤而漏掉匹配项）",
  );
  // 文件名以 `.` 开头：筛选词本身以 `.` 开头时照列（官方 `!fragment.startsWith('.')` 同判据）
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: sub2Cwd, query: "../sub2/.h", known: [], outsideAllowed: true })),
    ["../sub2/.hidden"],
    "筛选词以 `.` 开头时点开头的条目照列（与官方同判据）",
  );
  assert.deepStrictEqual(
    paths(await missingDirectoryEntries({ cwd: sub2Cwd, query: "../sub2/", known: [], outsideAllowed: true })),
    SUB2_LISTING.map((path) => `../sub2/${path}`),
    "筛选词为空时点开头的条目跳过（`.hidden` 不在），目录仍排在前面",
  );
  // 目录前缀命中排除目录名 → 不列（与服务器同判据：`node_modules` 里的东西不出现在列表里）
  await mkdir(join(outside, "node_modules"), { recursive: true });
  await writeFile(join(outside, "node_modules", "dep.js"), "x\n");
  assert.deepStrictEqual(
    await missingDirectoryEntries({ cwd: root, query: `${outsidePrefix}node_modules/`, known: [], outsideAllowed: true }),
    [],
    "越界侧同样不把被排除的目录捞回来（要引用具体路径仍可把完整路径打全）",
  );
  // 盘符裸写：只在 Windows 形态下归一到盘根（纯函数断言，不去列真实盘根）
  assert.deepStrictEqual(
    listingTarget("D:", "win32"),
    { scope: "absolute", directory: "D:/", prefix: "D:/", fragment: "" },
    "`@D:` 按 `D:/` 列盘根（M1 的盘符裸写）",
  );
  assert.strictEqual(listingTarget("D:", "posix"), undefined, "POSIX 宿主上 `D:` 不是盘符（只是普通名字片段）");
  assert.deepStrictEqual(
    listingTarget("D:/dev/other/no", "win32"),
    { scope: "absolute", directory: "D:/dev/other/", prefix: "D:/dev/other/", fragment: "no" },
    "绝对路径的筛选词查询：越界侧由本地按档位筛",
  );
  assert.deepStrictEqual(
    listingTarget("../no", "win32"),
    { scope: "up", directory: "../", prefix: "../", fragment: "no" },
    "相对 `..` 的筛选词查询走 `up`",
  );
  // 不支持的根 / 盘符形态：`listingTarget` **当场判假**，三条路（absolute / inside / up）
  // 一条都不走。放它们进 `inside` / `up` 会得到两种错误解释：`win32.resolve` 把 `/foo/`
  // 按**当前盘**根解析、把 `D:foo/` 接到 D 盘当前目录；或者 cwd 恰好有同名祖先时把
  // `/foo/` 当成 `cwd/foo` 列出一份根本不是用户指的那一层的清单。
  for (const query of ["/foo/", "\\foo\\", "D:foo/", "D:foo/bar", "//server/", "//?/UNC/server/share/"]) {
    assert.strictEqual(listingTarget(query, "win32"), undefined, `"${query}" 不做本地解释（Windows 宿主）`);
  }
  assert.strictEqual(listingTarget("D:foo/", "posix"), undefined, "POSIX 宿主上盘符写法同样不解释");
  assert.deepStrictEqual(
    listingTarget("/foo/", "posix"),
    { scope: "absolute", directory: "/foo/", prefix: "/foo/", fragment: "" },
    "POSIX 宿主上 `/foo/` 是原生绝对形态（不受 Windows 那几条限制影响）",
  );
  assert.deepStrictEqual(
    listingTarget("../", "posix"),
    { scope: "up", directory: "../", prefix: "../", fragment: "" },
    "普通相对形态不受影响（POSIX 宿主同理）",
  );
}

/* ==================== 注入 fs 的路径解析边界（第 6 节） ==================== */

/** 一条假条目的种类。 */
type FakeKind = "dir" | "file" | "symlink";

/**
 * 记账的假 FS：只回答「这段路径是什么」，并记下每次调用。
 *
 * UNC / 符号链接 / 盘根这些用例必须能在**不碰真实磁盘、不连网络共享**的前提下断言
 * 「解析到哪、拒绝了什么、有没有发出不该发的探测」，所以 FS 从这里注入。
 */
function fakeFs(options: {
  stats: Record<string, FakeKind>;
  listing?: Record<string, { name: string; kind: "dir" | "file" }[]>;
}) {
  const calls = { stat: [] as string[], lstat: [] as string[], readdir: [] as string[] };
  /** 归一后的查表键：分隔符统一、并同时接受带不带尾斜杠的写法（`D:\` 与 `D:/` 是同一个根）。 */
  const keysOf = (path: string): string[] => {
    const normalized = path.replaceAll("\\", "/");
    const stripped = normalized.replace(/\/+$/u, "");
    return stripped === normalized ? [normalized] : [normalized, stripped];
  };
  const lookup = <T>(table: Record<string, T> | undefined, path: string): T | undefined => {
    for (const key of keysOf(path)) {
      const value = table?.[key];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const statsOf = (kind: FakeKind) => ({
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  });
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const probe: FsProbe = {
    async stat(path: string) {
      calls.stat.push(path);
      const kind = lookup(options.stats, path);
      if (!kind || kind === "symlink") throw missing();
      return statsOf(kind);
    },
    async lstat(path: string) {
      calls.lstat.push(path);
      const kind = lookup(options.stats, path);
      if (!kind) throw missing();
      return statsOf(kind);
    },
    async readdir(path: string) {
      calls.readdir.push(path);
      const entries = lookup(options.listing, path);
      if (entries === undefined) throw missing();
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.kind === "dir",
        isFile: () => entry.kind === "file",
      }));
    },
  };
  return { calls, probe };
}

const WINDOWS = "win32" as const;
const budget = () => new LocalFsBudget();

{
  // 不支持的根 / 盘符形态：**一次 FS 调用都不发**。这是「纯字符串判据」的可见后果——
  // `win32.resolve(cwd, "/foo/")` 会落到当前盘根去探测一个用户没指的位置。
  const noProbe = fakeFs({
    stats: { "D:/": "dir", "D:/foo": "dir" },
    listing: { "D:/": [{ name: "foo", kind: "dir" }], "D:/foo": [{ name: "x.txt", kind: "file" }] },
  });
  for (const query of ["/foo/", "D:foo/", "//server/"]) {
    assert.deepStrictEqual(
      await missingDirectoryEntries({
        cwd: "D:/",
        query,
        known: [],
        outsideAllowed: true,
        platform: WINDOWS,
        fs: noProbe.probe,
        budget: budget(),
      }),
      [],
      `"${query}" 不做本地列举`,
    );
  }
  assert.deepStrictEqual(
    { stat: noProbe.calls.stat, lstat: noProbe.calls.lstat, readdir: noProbe.calls.readdir },
    { stat: [], lstat: [], readdir: [] },
    "不支持的形态连一次 FS 调用都不发（含 lstat 与 readdir）",
  );

  // 不完整的 UNC：`//server` / `//server/` 都不是可列举的根（win32 会把它们解析到当前盘），
  // 形态判据直接判假，**一次 FS 调用都不许发**——「不探测未输入的共享」在形态这一层成立
  const bare = fakeFs({ stats: { "/": "dir" } });
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "//server/share",
      query: "//server/",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: bare.probe,
      budget: budget(),
    }),
    [],
    "不完整的 UNC（`//server/`）不是列举根",
  );
  assert.deepStrictEqual(bare.calls.lstat, [], "不完整 UNC 连一次 lstat 都不发（绝不探测未输入的共享）");
  assert.deepStrictEqual(bare.calls.readdir, [], "更不会去 readdir");

  // 完整的 UNC：`//server/share/dev/` 用注入的 fs 解析（不连真实共享）
  const unc = fakeFs({
    stats: { "//server/share": "dir", "//server/share/dev": "dir" },
    listing: { "//server/share/dev": [{ name: "note.txt", kind: "file" }] },
  });
  assert.deepStrictEqual(
    paths(
      await missingDirectoryEntries({
        cwd: "//server/share",
        query: "//server/share/dev/",
        known: [],
        outsideAllowed: true,
        platform: WINDOWS,
        fs: unc.probe,
        budget: budget(),
      }),
    ),
    ["//server/share/dev/note.txt"],
    "显式写全的 UNC 走同一条逐段检查（前缀保留用户写的 UNC 形态）",
  );
  assert.deepStrictEqual(unc.calls.readdir.length, 1, "只读了一次目录（列举根本身）");

  // 设备 / 扩展长度命名空间本轮不支持：显式判假，绝不按普通 UNC 去探测 `\\?\UNC\`
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "D:/dev",
      query: "//?/UNC/server/share/",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: unc.probe,
      budget: budget(),
    }),
    [],
    "`\\\\?\\UNC\\…` 这类扩展命名空间不支持（解析根不是共享名，探测它会走错地方）",
  );

  // 符号链接段：绝对路径里任一段是链接就整条拒绝（不跟随），且不许先 resolve 把 link 吃掉
  const link = fakeFs({
    stats: { "D:/": "dir", "D:/link": "symlink", "D:/link/other": "dir" },
    listing: { "D:/link/other": [{ name: "x.txt", kind: "file" }] },
  });
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "D:/proj",
      query: "D:/link/other/",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: link.probe,
      budget: budget(),
    }),
    [],
    "绝对路径的中间段是符号链接 → 拒绝（哪怕后面还有一段目录）",
  );
  assert.deepStrictEqual(link.calls.readdir, [], "拒绝之后不再 readdir");
  // `link/..` 那种写法：`path.resolve` 会先吃掉 link，逐段检查必须自己处理 `..`
  const linkUp = fakeFs({ stats: { "D:/": "dir", "D:/link": "symlink", "D:/link/other": "dir" } });
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "D:/proj",
      query: "D:/link/other/../",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: linkUp.probe,
      budget: budget(),
    }),
    [],
    "绝对路径里 `link/other/..` 也不能绕过逐段检查（`path.resolve` 会把 link 吃掉）",
  );

  // 相对 `..`：父目录本身是符号链接同样拒绝（`dirname` 之后仍要 lstat）
  const linkParent = fakeFs({ stats: { "D:/link": "symlink", "D:/link/proj": "dir" } });
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "D:/link/proj",
      query: "../",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: linkParent.probe,
      budget: budget(),
    }),
    [],
    "`../` 的父级是符号链接 → 拒绝（父目录本身也要 lstat，不跟随）",
  );
  assert.deepStrictEqual(linkParent.calls.readdir, [], "拒绝之后不再 readdir");

  // `..` 退到盘根就停：多退了四层也只停在 `D:/`（不会越出盘根，也不会报错）
  const rootStop = fakeFs({
    stats: { "D:/": "dir", "D:/dev": "dir", "D:/dev/proj": "dir" },
    listing: { "D:/": [{ name: "Windows", kind: "dir" }] },
  });
  assert.deepStrictEqual(
    paths(
      await missingDirectoryEntries({
        cwd: "D:/dev/proj",
        query: "../../../../",
        known: [],
        outsideAllowed: true,
        platform: WINDOWS,
        fs: rootStop.probe,
        budget: budget(),
      }),
    ),
    ["../../../../Windows"],
    "`..` 退到盘根就停（`path.resolve` 语义）：每一层都 lstat 过，最终列的是盘根",
  );
  assert.deepStrictEqual(rootStop.calls.readdir, ["D:\\"], "列举的根就是盘根 D:\\");

  // 不存在的目录：静默空表，不抛错
  assert.deepStrictEqual(
    await missingDirectoryEntries({
      cwd: "D:/dev",
      query: "D:/nope/",
      known: [],
      outsideAllowed: true,
      platform: WINDOWS,
      fs: rootStop.probe,
      budget: budget(),
    }),
    [],
    "越界目录不存在时静默回退空表（弹层照旧显示「没有匹配的文件」与可用的 `..` 行）",
  );
}

{
  // M2「上一层」行：cwd 的父目录（绝对形态）；盘根 / 共享根不发；父级不是目录不发
  const parent = fakeFs({ stats: { "D:/": "dir", "D:/dev": "dir", "D:/dev/proj": "dir" } });
  assert.deepStrictEqual(
    await parentDirectoryEntry({ cwd: "D:/dev/proj", platform: WINDOWS, fs: parent.probe, budget: budget() }),
    { path: "D:/dev", kind: "directory" },
    "工作区根那一层的「上一层」行：目标是 cwd 的父目录，绝对形态",
  );
  assert.deepStrictEqual(
    await parentDirectoryEntry({ cwd: "D:\\dev\\proj", platform: WINDOWS, fs: parent.probe, budget: budget() }),
    { path: "D:/dev", kind: "directory" },
    "反斜杠形态的 cwd 同样归一成正斜杠（候选路径与界面拼写同一条）",
  );
  assert.deepStrictEqual(
    await parentDirectoryEntry({ cwd: "D:/dev", platform: WINDOWS, fs: parent.probe, budget: budget() }),
    { path: "D:/", kind: "directory" },
    "父目录是盘根时照发（`@D:/` 是可浏览的一层）",
  );
  const rootCwd = fakeFs({ stats: { "D:/": "dir" } });
  assert.strictEqual(
    await parentDirectoryEntry({ cwd: "D:/", platform: WINDOWS, fs: rootCwd.probe, budget: budget() }),
    undefined,
    "cwd 就是盘根时没有上一层（不发那一行）",
  );
  assert.deepStrictEqual(rootCwd.calls.stat, [], "盘根那一层连一次 stat 都不发（本地就没有这一行）");
  const shareRoot = fakeFs({ stats: { "//server/share": "dir" } });
  assert.strictEqual(
    await parentDirectoryEntry({ cwd: "//server/share", platform: WINDOWS, fs: shareRoot.probe, budget: budget() }),
    undefined,
    "UNC 共享根同样没有上一层",
  );
  assert.deepStrictEqual(shareRoot.calls.stat, [], "共享根也不发 stat");
  const posixShape = fakeFs({ stats: { "/": "dir" } });
  assert.strictEqual(
    await parentDirectoryEntry({ cwd: "/home/u/proj", platform: WINDOWS, fs: posixShape.probe, budget: budget() }),
    undefined,
    "POSIX 形态的 cwd 在 Windows 宿主上不发「上一层」（形状判据不过）",
  );
  const fileParent = fakeFs({ stats: { "D:/": "dir", "D:/dev": "file" } });
  assert.strictEqual(
    await parentDirectoryEntry({ cwd: "D:/dev/proj", platform: WINDOWS, fs: fileParent.probe, budget: budget() }),
    undefined,
    "父路径存在但不是目录 → 不发（拿不到「它是目录」的肯定证据）",
  );
}

{
  // 排序的档位纯函数：同档内目录优先、再 code-unit 由 `missingDirectoryEntries` 收口，
  // 这里钉档位本身（越界侧的五档近似）
  const file = (path: string): FileRefEntry => ({ path, kind: "file" });
  assert.strictEqual(outsideRank(file("D:/x/no"), "no"), 0);
  assert.strictEqual(outsideRank(file("D:/x/notes"), "no"), 1);
  assert.strictEqual(outsideRank(file("D:/x/ano"), "no"), 2);
  assert.strictEqual(outsideRank(file("D:/no/x"), "no"), 3);
  assert.strictEqual(outsideRank(file("D:/x/n1o"), "no"), 4);
  assert.strictEqual(outsideRank(file("D:/x/y"), "no"), undefined);
}

await rm(root, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });

console.log("fileRefListing: 目录列举补全（排序 / 只补列举 / 失败静默 / 宿主链路 / 越界 / 边界） ✓");
