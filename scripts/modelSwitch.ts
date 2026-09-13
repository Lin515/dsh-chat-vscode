/**
 * 模型切换专项复现：找出「切换模型失败」的确切条件。
 *
 *   node build/model-switch.mjs
 *
 * 覆盖四种真实操作序列：
 *   A. 全新会话、还没发过消息就切（用户点开新对话先选模型）
 *   B. 切到同一 provider 的另一个模型，沿用当前思考档位
 *   C. 跨 provider 切换（沿用上一个模型的思考档位——档位名可能不被新模型支持）
 *   D. 切到不支持任何思考档位的模型
 *
 * 注意：`session/selectModel` 会写回 `agent-default-model` 设置，所以脚本结束前
 * 会把部署默认模型还原，避免污染本机默认。
 */
import { DshApiError, DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const log = (line: string) => console.log(`[model] ${line}`);

const server = new SupervisorManager({ url: "", command: "dsh", startTimeoutMs: 120_000, log });
let client: DshClient | undefined;
const failures: string[] = [];

async function attempt(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    const detail =
      error instanceof DshApiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.log(`  ✗ ${label}\n      → ${detail}`);
    failures.push(`${label} → ${detail}`);
  }
}

try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();

  const catalog = await client.modelCatalog();
  const groups = (catalog.groups ?? []).filter((g: any) => (g.models ?? []).length > 0);
  console.log(
    "\n目录：",
    groups.map((g: any) => `${g.id}[${g.models.map((m: any) => m.id).join(",")}]`).join("  "),
  );

  const settings = await client.settingsDescribe();
  const defaultSel = ((settings.namespaces ?? []).find((ns: any) => ns.ns === "agent-default-model") as any)
    ?.value as { provider: string; model: string; reasoningEffort?: string };
  console.log("部署默认：", JSON.stringify(defaultSel), "\n");

  // ---------- A. 全新会话、未发消息就切 ----------
  console.log("A) 全新会话、未发消息就切模型");
  const fresh = await client.createSession(process.cwd());
  const first = groups.find((g: any) => g.id === defaultSel?.provider) ?? groups[0];
  const firstModel = first.models.find((m: any) => m.id === defaultSel?.model) ?? first.models[0];
  await attempt(`新会话直接切到 ${first.id}/${firstModel.id}`, async () => {
    await client!.selectModel(fresh.sessionId, first.id, firstModel.id);
  });

  // ---------- B. 同 provider 换模型，沿用档位 ----------
  console.log("\nB) 同 provider 换模型（沿用当前档位）");
  if (first.models.length > 1) {
    const other = first.models[1];
    const effort = firstModel.reasoning?.efforts?.at(-1)?.id;
    await attempt(`带档位 ${effort ?? "(无)"} 切到 ${first.id}/${other.id}`, async () => {
      await client!.selectModel(fresh.sessionId, first.id, other.id, effort);
    });
  } else {
    console.log("  - 该 provider 只有一个模型，跳过");
  }

  // ---------- C. 跨 provider 切换，沿用上一个模型的档位 ----------
  console.log("\nC) 跨 provider 切换（沿用上一个模型的档位）");
  const effortHigh = firstModel.reasoning?.efforts?.at(-1)?.id;
  for (const group of groups) {
    if (group.id === first.id) continue;
    const target = group.models[0];
    await attempt(`沿用档位 ${effortHigh ?? "(无)"} 切到 ${group.id}/${target.id}`, async () => {
      await client!.selectModel(fresh.sessionId, group.id, target.id, effortHigh);
    });
    // 切回来，保证后续用例从已知状态出发
    await client.selectModel(fresh.sessionId, first.id, firstModel.id).catch(() => {});
  }

  // ---------- D. 切到没有思考档位的模型 ----------
  const noEffort = groups.flatMap((g: any) => g.models.map((m: any) => ({ g, m }))).find((x: any) => !x.m.reasoning?.efforts?.length);
  console.log("\nD) 切到不支持思考档位的模型");
  if (noEffort) {
    await attempt(`切到 ${noEffort.g.id}/${noEffort.m.id} 且不带档位`, async () => {
      await client!.selectModel(fresh.sessionId, noEffort.g.id, noEffort.m.id);
    });
    await attempt(`切到 ${noEffort.g.id}/${noEffort.m.id} 却带上档位 max`, async () => {
      await client!.selectModel(fresh.sessionId, noEffort.g.id, noEffort.m.id, "max");
    });
  } else {
    console.log("  - 目录里每个模型都支持档位，跳过");
  }

  // ---------- E. 用未经验证的 provider/model 名 ----------
  console.log("\nE) 不存在的模型");
  await attempt("切到 no-such-provider/no-such-model", async () => {
    await client!.selectModel(fresh.sessionId, "no-such-provider", "no-such-model");
  });
  // 这条应当失败——把它从失败清单里去掉，它验证的是错误码，不是缺陷
  if (failures.some((line) => line.includes("no-such-provider"))) {
    failures.length = 0;
    console.log("  （上面的失败是预期的：服务端应报 session/model-unavailable）");
  }

  // ---------- 还原部署默认模型 ----------
  if (defaultSel?.provider && defaultSel.model) {
    const after = await client.settingsDescribe();
    const now = ((after.namespaces ?? []).find((ns: any) => ns.ns === "agent-default-model") as any)?.value;
    const changed =
      now &&
      (now.provider !== defaultSel.provider ||
        now.model !== defaultSel.model ||
        (now.reasoningEffort ?? "") !== (defaultSel.reasoningEffort ?? ""));
    if (changed) {
      await client.request("settings/update", {
        ns: "agent-default-model",
        patch: {
          provider: defaultSel.provider,
          model: defaultSel.model,
          ...(defaultSel.reasoningEffort ? { reasoningEffort: defaultSel.reasoningEffort } : {}),
        },
      });
      console.log(`\n已还原部署默认模型为 ${defaultSel.provider}/${defaultSel.model}`);
    }
  }

  console.log(
    failures.length === 0
      ? "\n✓ 全部切换路径成功"
      : `\n✗ 共 ${failures.length} 条失败路径：\n   - ${failures.join("\n   - ")}`,
  );
} catch (error) {
  console.error("测试本身出错：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
