/**
 * 二进制一元 RPC 的响应解码（官方 `parseBinaryResponse` 同款）行为断言。
 *
 * 这条通道承载 `workspaceFiles/readBytes` 的原始字节：信封里的 `data` 是 null
 * 占位，附件按 `path` 回填。测试不启动 DSH，直接构造 `FormData`，逐条钉住
 * 「坏形状整份丢弃」——重复字段 / 重复 part / 越界或原型链路径 / 非 null 占位 /
 * 多余字段都必须抛，不能把半份响应当成文件内容。
 */
import assert from "node:assert";
import { decodeBinaryRpcResponse } from "../src/dsh/binaryRpc";

/** 一份合法信封：`value.data` 是附件占位。 */
function envelope(overrides: {
  rpcId?: string;
  value?: unknown;
  attachments?: unknown;
} = {}): unknown {
  return {
    type: "server-response",
    rpcId: overrides.rpcId ?? "r1",
    result: {
      ok: true,
      value: overrides.value ?? {
        absolutePath: "/w/a.bin",
        version: "v1",
        bytes: 3,
        offset: 0,
        data: null,
        eof: true,
      },
    },
    attachments: overrides.attachments ?? [{ codec: "bytes", part: "bytes-0", path: ["data"] }],
  };
}

function form(metadata: unknown, parts: Record<string, Uint8Array> = {}): FormData {
  const body = new FormData();
  body.append("metadata", JSON.stringify(metadata));
  for (const [name, bytes] of Object.entries(parts)) {
    body.append(name, new Blob([bytes], { type: "application/octet-stream" }), name);
  }
  return body;
}

// ---------- 1. 回填字节并保留其余字段 ----------
{
  const decoded = await decodeBinaryRpcResponse(
    form(envelope(), { "bytes-0": new Uint8Array([1, 2, 3]) }),
  );
  assert.strictEqual(decoded.rpcId, "r1");
  const value = decoded.value as { data: Uint8Array; offset: number; eof: boolean; version: string };
  assert.ok(value.data instanceof Uint8Array);
  assert.deepStrictEqual([...value.data], [1, 2, 3]);
  assert.strictEqual(value.offset, 0);
  assert.strictEqual(value.eof, true);
  assert.strictEqual(value.version, "v1");
}
console.log("binary-rpc: 附件按 path 回填为 Uint8Array ✓");

// ---------- 2. 数组下标路径（嵌套结构里的字节） ----------
{
  const nested = envelope({
    value: { files: [{ data: null, name: "a" }] },
    attachments: [{ codec: "bytes", part: "bytes-0", path: ["files", 0, "data"] }],
  });
  const decoded = await decodeBinaryRpcResponse(form(nested, { "bytes-0": new Uint8Array([7]) }));
  const value = decoded.value as { files: { data: Uint8Array }[] };
  assert.deepStrictEqual([...value.files[0]!.data], [7]);
}
console.log("binary-rpc: 数组下标路径 ✓");

// ---------- 3. 坏形状整份丢弃 ----------
{
  const cases: { name: string; body: FormData }[] = [];

  const duplicateMetadata = new FormData();
  duplicateMetadata.append("metadata", JSON.stringify(envelope()));
  duplicateMetadata.append("metadata", JSON.stringify(envelope()));
  cases.push({ name: "重复字段", body: duplicateMetadata });

  const noMetadata = new FormData();
  noMetadata.append("bytes-0", new Blob([new Uint8Array([1])]), "bytes-0");
  cases.push({ name: "缺 metadata", body: noMetadata });

  const badJson = new FormData();
  badJson.append("metadata", "{not json");
  cases.push({ name: "metadata 不是 JSON", body: badJson });

  cases.push({
    name: "信封类型不对",
    body: form({ type: "client-request", rpcId: "r1", result: { ok: true, value: {} } }),
  });
  cases.push({
    name: "result 非 ok",
    body: form({ type: "server-response", rpcId: "r1", result: { ok: false, error: {} } }),
  });
  cases.push({ name: "无附件声明", body: form(envelope({ attachments: [] }), {}) });
  cases.push({
    name: "附件 codec 不对",
    body: form(
      envelope({ attachments: [{ codec: "json", part: "bytes-0", path: ["data"] }] }),
      { "bytes-0": new Uint8Array([1]) },
    ),
  });
  cases.push({
    name: "附件 part 缺失",
    body: form(envelope(), {}),
  });
  cases.push({
    name: "附件 part 撞 metadata",
    body: form(
      envelope({ attachments: [{ codec: "bytes", part: "metadata", path: ["data"] }] }),
      {},
    ),
  });
  cases.push({
    name: "路径指向非 null",
    body: form(envelope({ value: { data: "already" } }), { "bytes-0": new Uint8Array([1]) }),
  });
  cases.push({
    name: "路径不存在",
    body: form(
      envelope({ value: { other: null } }),
      { "bytes-0": new Uint8Array([1]) },
    ),
  });
  cases.push({
    name: "原型链路径",
    body: form(
      envelope({ attachments: [{ codec: "bytes", part: "bytes-0", path: ["__proto__"] }] }),
      { "bytes-0": new Uint8Array([1]) },
    ),
  });
  cases.push({
    name: "数组下标越界",
    body: form(
      envelope({
        value: { files: [{ data: null }] },
        attachments: [{ codec: "bytes", part: "bytes-0", path: ["files", 2, "data"] }],
      }),
      { "bytes-0": new Uint8Array([1]) },
    ),
  });
  cases.push({
    name: "数组下标不是整数",
    body: form(
      envelope({
        value: { files: [{ data: null }] },
        attachments: [{ codec: "bytes", part: "bytes-0", path: ["files", 0.5, "data"] }],
      }),
      { "bytes-0": new Uint8Array([1]) },
    ),
  });
  cases.push({
    name: "重复附件路径",
    body: form(
      envelope({
        attachments: [
          { codec: "bytes", part: "bytes-0", path: ["data"] },
          { codec: "bytes", part: "bytes-1", path: ["data"] },
        ],
      }),
      { "bytes-0": new Uint8Array([1]), "bytes-1": new Uint8Array([2]) },
    ),
  });
  cases.push({
    name: "多余字段",
    body: (() => {
      const body = form(envelope(), { "bytes-0": new Uint8Array([1]) });
      body.append("extra", new Blob([new Uint8Array([9])]), "extra");
      return body;
    })(),
  });
  cases.push({
    name: "part 不是字节",
    body: (() => {
      const body = new FormData();
      body.append("metadata", JSON.stringify(envelope()));
      body.append("bytes-0", "text");
      return body;
    })(),
  });

  for (const item of cases) {
    await assert.rejects(
      () => decodeBinaryRpcResponse(item.body),
      /binary rpc/u,
      `${item.name} 必须整份拒绝`,
    );
  }
}
console.log("binary-rpc: 重复/缺字段/坏路径/非 null 占位/多余字段全部拒绝 ✓");

console.log("\nbinary-rpc: all assertions passed");
