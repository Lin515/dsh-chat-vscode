/**
 * 恢复默认模型设置（一次性的环境修复脚本）。
 *
 * 背景：`session/selectModel` 会把选择写回 `agent-default-model` 设置，
 * 冒烟测试里的切换因此改了本机的部署默认模型。这个脚本把它改回去。
 *
 *   node build/set-default-model.mjs <baseUrl> <token> <provider> <model> [effort]
 */
import { DshClient } from "../src/dsh/client";

const [baseUrl, token, provider, model, effort] = process.argv.slice(2);
if (!baseUrl || !provider || !model) {
  console.error("用法：node build/set-default-model.mjs <baseUrl> <token> <provider> <model> [effort]");
  process.exit(1);
}

const client = new DshClient(baseUrl, token || undefined, (line) => console.log(line));
await client.authenticate();
client.connect();

const before = await client.settingsDescribe();
const section = (before.namespaces ?? []).find((ns) => ns.ns === "agent-default-model");
console.log(`当前默认模型：${JSON.stringify(section?.value ?? null)}`);

const patch: Record<string, unknown> = { provider, model };
if (effort) patch.reasoningEffort = effort;

await client.request("settings/update", { ns: "agent-default-model", patch });
console.log(`已写回：${JSON.stringify(patch)}`);

const after = await client.settingsDescribe();
const updated = (after.namespaces ?? []).find((ns) => ns.ns === "agent-default-model");
console.log(`写入后：${JSON.stringify(updated?.value ?? null)}`);

client.dispose();
