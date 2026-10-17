/**
 * `@` 候选的**目录列举补全**：服务器一次只回 20 条（`DEFAULT_FILE_SEARCH_MAX_RESULTS`，
 * 是 dsh 插件的配置、不是请求参数），宿主按官方同一套语义把被截掉的尾巴补回来。
 *
 * 用户 2026-10-10 报「@ 文件列表显示不全，感觉像有个上限值」——那个上限就是它。
 * 这一组断言钉四件事：
 *
 * 1. **纯函数**（第 1 节，真盘上建临时目录）：目录在前 / 文件在后、同组按 path 的
 *    **原始 code-unit** 排序（不是 locale）、点开头的条目跳过（但用户已经进去的
 *    点目录照常列）、被排除的目录名跳过、目录行不带结尾斜杠；
 * 2. **只补目录列举**（第 2 节）：fragment 非空（用户在目录里打了筛选字）一律不补——
 *    那一半由服务器按 fuzzy 分数排序，本地复现不出来；
 * 3. **失败静默**（第 3 节）：目录不存在 / 越出工作目录 / 服务器回空表，都只是「不补」，
 *    绝不抛错、也绝不把服务器那 20 条弄丢；
 * 4. **宿主链路**（第 4 节，驱动真 `ChatController`，offline stub）：`files/list` 帧里
 *    既有服务器那几条（顺序位置一个不动），也有补齐的尾巴。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listingTarget, missingDirectoryEntries, type FileRefEntry } from "../src/dsh/fileRefListing";

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

// ---------- 2. 只补目录列举 ----------
{
  assert.deepStrictEqual(listingTarget(""), { directory: "", fragment: "" }, "空查询是根目录列举");
  assert.deepStrictEqual(listingTarget("sub/"), { directory: "sub/", fragment: "" }, "以 / 结尾是目录列举");
  assert.deepStrictEqual(listingTarget("sub\\"), { directory: "sub/", fragment: "" }, "反斜杠同样归一后再判");
  assert.strictEqual(listingTarget("sub/a"), undefined, "目录前缀后还有筛选词 ⇒ 不是目录列举（服务器按 fuzzy 打分）");
  for (const query of ["a", "sub/a", "sub/ab", "alp"]) {
    assert.strictEqual(listingTarget(query), undefined, `"${query}" 不是目录列举（fragment 非空）`);
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
    "越出会话工作目录的路径不列（拿不到证据就不动手）",
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

  function lastItems(frames: { target: string; frame: Record<string, unknown> }[], viewId: string, query: string) {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const { target, frame } = frames[i];
      if (target === viewId && frame.type === "files/list" && frame.query === query) {
        return (frame.items ?? []) as FileRefEntry[];
      }
    }
    return undefined;
  }

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
    const items = lastItems(frames, "v1", "");
    assert.deepStrictEqual(paths(items ?? []), ROOT_LISTING, "宿主把目录列举补全后再发帧（用户报的「显示不全」）");
    assert.deepStrictEqual(
      paths((items ?? []).slice(0, serverItems.length)),
      paths(serverItems),
      "服务器那几条的顺序与位置一个都不动（只往后追加）",
    );
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
      paths(lastItems(frames, "v1", "") ?? []),
      ["only.ts"],
      "枚举失败时静默退回服务器结果（列表不许变空、也不许抛错上抛）",
    );
  }
}

await rm(root, { recursive: true, force: true });

console.log("fileRefListing: 目录列举补全（排序 / 只补列举 / 失败静默 / 宿主链路） ✓");
