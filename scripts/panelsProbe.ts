/**
 * 【探针定位】工具型 · 零 token —— 只读拉取面板数据源形状，不发消息，可自由运行。
 *
 * 新面板数据源验证：对真实服务器拉取各面板依赖的接口。
 *   node build/panels-probe.mjs
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[panels] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const server = new SupervisorManager({ url: "", command: "dsh", log: () => {} });
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

