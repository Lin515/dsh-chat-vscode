/** 子代理 rc.2 / 旧代契约协商；仅本地 HTTP stub，不启动 DSH 或调用模型。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DshClient } from "../src/dsh/client";

type Hit = { method: string; args: Record<string, unknown> };
type Failure = { code: string; details?: unknown };
const promptBoundary: Failure = {
  code: "gateway/input-invalid",
  details: { endpoint: "subagents/prompt", field: "request" },
};
const absent: Failure = { code: "gateway/endpoint-not-found" };
const content = [{ type: "text", text: "continue" }];

async function stub() {
  let generation: "current" | "legacy" = "current";
  let failure: Failure | number | undefined;
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const sent = JSON.parse(Buffer.concat(chunks).toString()) as {
        rpcId: string; method: string; payload: { args: Record<string, unknown> };
      };
      const { method, payload: { args } } = sent;
      hits.push({ method, args });
      if (typeof failure === "number") { res.writeHead(failure).end(); return; }
      let error = failure;
      if (!error && method === "subagents/prompt") {
        const request = args.request as Record<string, unknown>;
        const legacy = "parentSessionId" in request;
        if (legacy !== (generation === "legacy")) error = promptBoundary;
      } else if (!error && method !== (generation === "current"
        ? "subagents/interruptByUser" : "subagents/interruptByParent")) {
        error = absent;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "server-response", rpcId: sent.rpcId,
        result: error ? { ok: false, error: { ...error, message: error.code } }
          : { ok: true, value: method === "subagents/prompt" ? { messageId: "message" } : { accepted: true } },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new DshClient(`http://127.0.0.1:${address.port}`, undefined, () => {});
  const prompt = () => client.promptSubagent("parent", "child", content, "steer", "stable-request");
  const interrupt = () => client.interruptSubagent("child", "parent");
  return {
    hits, prompt, interrupt,
    generation: (value: typeof generation) => { generation = value; },
    failure: (value: typeof failure) => { failure = value; },
    clear: () => { hits.length = 0; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections(); server.close(() => resolve());
    }),
  };
}

// 首次仅发新请求；旧代协商一次后复用，服务端升级与回滚可重新协商。
{
  const s = await stub();
  try {
    await s.prompt();
    assert.equal(s.hits.length, 1);
    const current = (s.hits[0].args.request as Record<string, unknown>);
    assert.deepEqual(Object.keys(current).sort(), ["childSessionId", "clientTimeZone", "content", "delivery", "requestId"]);
    assert.equal(current.childSessionId, "child");
    assert.equal(current.delivery, "steer");
    assert.deepEqual(current.content, content);
    assert.equal(typeof current.clientTimeZone, "string");
    for (const generation of ["legacy", "current", "legacy"] as const) {
      s.generation(generation); s.clear();
      await s.prompt();
      assert.equal(s.hits.length, 2);
      for (const hit of s.hits) assert.equal((hit.args.request as Record<string, unknown>).requestId, "stable-request");
      const request = s.hits[1].args.request as Record<string, unknown>;
      assert.equal("parentSessionId" in request, generation === "legacy");
      if (generation === "legacy") {
        assert.equal(request.parentSessionId, "parent"); assert.equal(request.mode, "continuable");
      }
      s.clear(); await s.prompt(); assert.equal(s.hits.length, 1);
    }
  } finally { await s.close(); }
}

{
  const s = await stub();
  try {
    await s.interrupt();
    assert.deepEqual(s.hits, [{ method: "subagents/interruptByUser", args: { childSessionId: "child" } }]);
    for (const generation of ["legacy", "current", "legacy"] as const) {
      s.generation(generation); s.clear(); await s.interrupt();
      assert.equal(s.hits.length, 2);
      assert.deepEqual(s.hits[1], generation === "legacy"
        ? { method: "subagents/interruptByParent", args: { childSessionId: "child", parentSessionId: "parent", mode: "continuable" } }
        : { method: "subagents/interruptByUser", args: { childSessionId: "child" } });
      s.clear(); await s.interrupt(); assert.equal(s.hits.length, 1);
    }
  } finally { await s.close(); }
}

// 业务、认证、传输及其他参数错误均不得重发变更请求。
for (const failure of [
  401, 403, 500,
  { code: "session/not-found" }, { code: "subagent/not-continuable" },
  { code: "gateway/arguments-invalid" }, { code: "gateway/input-invalid" },
  { code: "gateway/input-invalid", details: { endpoint: "other", field: "request" } },
  { code: "gateway/input-invalid", details: { endpoint: "subagents/prompt", field: "other" } },
] satisfies (Failure | number)[]) {
  const s = await stub();
  try {
    s.failure(failure);
    await assert.rejects(s.prompt); assert.equal(s.hits.length, 1);
    s.clear(); await assert.rejects(s.interrupt); assert.equal(s.hits.length, 1);
    s.failure(undefined); s.clear(); await s.prompt(); assert.equal(s.hits.length, 1);
    s.clear(); await s.interrupt(); assert.equal(s.hits.length, 1);
  } finally { await s.close(); }
}

// HTTP 缺路由与网关缺路由同样可以回退；失败的回退不能写入代际记忆。
for (const [operation, failure] of [["prompt", promptBoundary], ["interrupt", absent], ["interrupt", 404], ["interrupt", 405]] as const) {
  const s = await stub();
  try {
    s.failure(failure);
    await assert.rejects(s[operation]); assert.equal(s.hits.length, 2);
    s.failure(undefined); s.clear(); await s[operation](); assert.equal(s.hits.length, 1);
    assert.equal(s.hits[0].method, operation === "prompt" ? "subagents/prompt" : "subagents/interruptByUser");
    if (operation === "prompt") assert.equal("parentSessionId" in (s.hits[0].args.request as object), false);
  } finally { await s.close(); }
}
console.log("subagentContract: rc.2 新载荷、旧代记忆、升级回滚及安全重试边界 ✓");
