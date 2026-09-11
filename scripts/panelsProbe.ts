/**
 * 新面板数据源验证：对真实服务器拉取各面板依赖的接口。
 *   node build/panels-probe.mjs
 */
import { DshClient } from "../src/dsh/client";
import { ServerManager } from "../src/dsh/serverManager";
import { buildSettingsSection } from "../src/dsh/settingsSchema";

const server = new ServerManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log: () => {} });
const info = await server.ensure();
const client = new DshClient(info.baseUrl, info.token, () => {});
await client.authenticate();
client.connect();

// 拿一个已有内容的会话来测（新建的空会话没有子代理/任务）
const list = await client.listSessions();
const sessions = (list.items ?? []).slice().sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
const session = sessions[0] as any;
console.log(`用会话 ${session?.sessionId}（cwd=${session?.cwd}）\n`);

let failures = 0;
const check = async (label: string, run: () => Promise<string>) => {
  try {
    console.log(`✓ ${label}：${await run()}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${label}：${error instanceof Error ? error.message : String(error)}`);
  }
};

await check("commands/list（斜杠命令菜单）", async () => {
  const rows = await client.request<any[]>("commands/list", { agentId: session.sessionId });
  const names = (rows ?? []).map((r) => `/${r.name}`);
  if (!names.length) throw new Error("返回空列表");
  return `${names.length} 条 → ${names.slice(0, 8).join(" ")}`;
});

await check("fileReferences/list（@ 提及）", async () => {
  const rows = await client.request<any[]>("fileReferences/list", {
    agentId: session.sessionId,
    query: "src",
  });
  const files = (rows ?? []).filter((r) => r.kind === "file").length;
  const dirs = (rows ?? []).filter((r) => r.kind === "directory").length;
  if (!rows?.length) throw new Error("返回空列表");
  return `${rows.length} 条（文件 ${files} / 目录 ${dirs}）→ ${rows.slice(0, 4).map((r) => r.path).join(", ")}`;
});

await check("subagents/list（子代理面板）", async () => {
  const result = await client.request<any>("subagents/list", { parentSessionId: session.sessionId });
  const children = (result.entries ?? []).filter((e: any) => e.kind === "child");
  return `${children.length} 个子代理，parentAvailable=${result.parentAvailable}`;
});

await check("settings/describe → 表单字段（设置页）", async () => {
  const described = await client.settingsDescribe();
  const sections = (described.namespaces ?? []).map((ns: any) => buildSettingsSection(ns));
  const totalFields = sections.reduce((sum: number, s: any) => sum + s.fields.length, 0);
  const totalJson = sections.reduce((sum: number, s: any) => sum + s.jsonFields.length, 0);
  const withSecrets = sections.filter((s: any) => s.fields.some((f: any) => f.secret)).map((s: any) => s.ns);
  const restart = sections.filter((s: any) => s.applies === "restart").map((s: any) => s.ns);
  if (totalFields === 0) throw new Error("解析出 0 个表单字段（schema 结构判断有误）");
  return (
    `${sections.length} 个命名空间，${totalFields} 个表单字段 + ${totalJson} 个 JSON 字段；` +
    `密钥字段在 ${withSecrets.join(",") || "无"}；需重启 ${restart.join(",") || "无"}`
  );
});

// 密钥写入的 ref 属于 CredentialRef 空间（POSIX 环境变量名），
// 而 schema 里 role=credential-ref 的字段（如 apiKeyEnv）就是那个名字。
await check("credentials/describe（密钥 ref 格式）", async () => {
  const described = await client.settingsDescribe();
  const ns = (described.namespaces ?? []).find((item: any) => (item.secrets ?? []).length > 0) as any;
  if (!ns) return "本机没有带密钥的命名空间，跳过";

  // 从 schema 里找 role=credential-ref 的字段拿默认引用名
  const refsFromSchema = new Set<string>();
  const collect = (node: any) => {
    for (const child of Object.values<any>(node?.refs ?? {})) {
      if (child?.meta?.role === "credential-ref" && typeof child.meta.default === "string") {
        refsFromSchema.add(child.meta.default);
      }
    }
  };
  collect(ns.schema);
  const candidates = [...refsFromSchema, "DEEPSEEK_API_KEY"];

  for (const ref of candidates) {
    try {
      const result = await client.request<any>("credentials/describe", { refs: [ref] });
      console.log(`     ref="${ref}" → ${JSON.stringify(result)}`);
    } catch (error) {
      console.log(`     ref="${ref}" → 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return `试了 ${candidates.length} 个候选 ref`;
});

await check("session/control 的 jobs 帧（后台任务面板）", async () => {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("12s 内没有收到 jobs 帧")), 12_000);
    client.followControl({
      onItem: (value: any) => {
        if (value?.type === "baseline") {
          const jobs = value.value?.jobs?.[session.sessionId] ?? [];
          clearTimeout(timer);
          resolve(`baseline 里有 ${jobs.length} 个任务${jobs.length ? ` → ${jobs.map((j: any) => `${j.kind}:${j.status}`).join(", ")}` : ""}`);
        }
      },
      onError: (error: any) => {
        clearTimeout(timer);
        reject(new Error(`${error.code} ${error.message}`));
      },
    });
  });
});

console.log(failures === 0 ? "\n✓ 全部数据源可用" : `\n✗ ${failures} 项失败`);
client.dispose();
server.stop();

