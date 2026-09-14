/**
 * 转储各设置命名空间的 schema JSON，用于设计设置页的表单渲染。
 *   node build/dump-settings.mjs [baseUrl] [token]
 * 不给参数时自行拉起一个临时服务器。
 */
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { writeFileSync } from "node:fs";

let baseUrl = process.argv[2];
let token = process.argv[3];
let server: SupervisorManager | undefined;

if (!baseUrl) {
  server = new SupervisorManager({ url: "", command: "dsh", log: () => {} });
  const info = await server.ensure();
  baseUrl = info.baseUrl;
  token = info.token;
}

const client = new DshClient(baseUrl, token || undefined, () => {});
await client.authenticate();
client.connect();

const described = await client.settingsDescribe();
console.log(`writable=${described.writable} hasDocument=${described.hasDocument} namespaces=${described.namespaces?.length ?? 0}\n`);

const out: Record<string, unknown> = {};
for (const ns of described.namespaces ?? []) {
  out[ns.ns] = ns;
  const schema = ns.schema as any;
  console.log(`── ${ns.ns}  applies=${ns.applies} secrets=${ns.secrets?.length ?? 0} revision=${ns.revision}`);
  console.log(`   value   = ${JSON.stringify(ns.value)}`);
  if (ns.user !== undefined) console.log(`   user    = ${JSON.stringify(ns.user)}`);
  console.log(`   schema  = ${JSON.stringify(schema)?.slice(0, 700)}`);
}

writeFileSync("build/settings-schema.json", JSON.stringify(out, null, 2), "utf8");
console.log("\n完整内容已写入 build/settings-schema.json");

client.dispose();
server?.stop();
