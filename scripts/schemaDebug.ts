import { buildSettingsSection } from "../src/dsh/settingsSchema";

// 用真实 schema（从 dump-settings 保存的）离线调试转换逻辑
import { readFileSync } from "node:fs";
const raw = JSON.parse(readFileSync("build/settings-schema.json", "utf8"));

for (const ns of ["permission", "ui-theme", "agent-default-model", "web-search-deepseek"]) {
  const entry = raw[ns];
  if (!entry) {
    console.log(`${ns}: 不在 dump 里`);
    continue;
  }
  console.log(`\n── ${ns}`);
  console.log(`   schema keys = ${Object.keys(entry.schema ?? {}).join(", ")}`);
  console.log(`   schema.uid = ${entry.schema?.uid}, refs 数 = ${Object.keys(entry.schema?.refs ?? {}).length}`);
  // 手工走一遍，确认结构判断没错
  const root: any = entry.schema;
  const rootNode = root.refs?.[String(root.uid)];
  console.log(`   root 节点 type=${rootNode?.type} dict=${JSON.stringify(rootNode?.dict)}`);
  console.log(`   root 自身 type=${root.type} dict=${JSON.stringify(root.dict)}`);
  const section = buildSettingsSection(entry);
  console.log(`   → fields ${section.fields.length}, jsonFields ${section.jsonFields.length}`);
  for (const field of section.fields) {
    const flags = [
      field.secret ? `密钥→${field.secretRef ?? "?"}` : "",
      field.secretSet ? "已配置" : "",
      field.overridden ? "已修改" : "",
    ]
      .filter(Boolean)
      .join("/");
    console.log(
      `      ${field.type.padEnd(8)} ${field.label} = ${JSON.stringify(field.value)}${flags ? ` [${flags}]` : ""}`,
    );
  }
  for (const json of section.jsonFields) {
    console.log(`      json     ${json.label}`);
  }
}
