/**
 * 【探针定位】工具型 · 零 token —— 只读打印模型目录的思考档位清单（排版依据），
 *   不发消息，可自由运行。
 *
 * 探针：打印模型目录里每个模型实际有几个思考档位、叫什么名字。
 *
 * 「4 档一行」的排版取决于真实档位数量与文案宽度，不能凭猜。
 *
 * 运行：npm run build:scripts && node build/effort-probe.mjs
 */
// 必须排在最前：会合目录与 DSH_HOME 都指到本次探针专用的临时目录（见 supervisorProbeEnv）。
// 自检放这里还有一层作用：真的用到导出值，esbuild 才不会把副作用 import 摇掉。
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[effort] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}
import { DshClient } from "../src/dsh/client";
import { SupervisorManager } from "../src/dsh/supervisorManager";

const log = () => {};
const server = new SupervisorManager({ url: "", command: "dsh", log });

let client: DshClient | undefined;
try {
  const info = await server.ensure();
  client = new DshClient(info.baseUrl, info.token, log);
  await client.authenticate();
  client.connect();
  await client.listSessions();

  const catalog = await client.modelCatalog();
  for (const group of catalog.groups ?? []) {
    for (const model of group.models ?? []) {
      const efforts = model.reasoning?.efforts ?? [];
      console.log(
        `${group.id}/${model.id}` +
          `\n    档位数=${efforts.length}  defaultEffort=${model.reasoning?.defaultEffort ?? "(无)"}` +
          `\n    档位=${efforts.map((e) => `${JSON.stringify(e.id)}=${JSON.stringify(e.name)}`).join(", ") || "(无)"}`,
      );
    }
  }
} catch (error) {
  console.error("探针失败：", error);
  process.exitCode = 1;
} finally {
  client?.dispose();
  server.stop();
}
