/**
 * Connection 二进制一元 RPC 的响应解码（官方 `parseBinaryResponse` 同款）。
 *
 * 为什么需要它：`workspaceFiles/readBytes` 的 `data` 是原始字节，不能塞进 JSON
 * 信封。服务端把响应体换成 `multipart/form-data`：一条 `metadata` 字段装着
 * `server-response` 信封（`result.value` 里的字节位置是 `null` 占位），其余字段
 * 是 `codec: "bytes"` 的附件；附件的 `path` 指明占位在值里的位置。
 *
 * 这里**逐字段验形**，并原样复刻官方的拒绝条件（重复字段、重复 part、非
 * `Uint8Array` 的字段、越界 / 原型链路径、非 null 占位、多余字段）。它不信任
 * 服务端，也不做「猜一个 JSON base64」的兜底：形状不合规就整份丢弃。
 *
 * 纯函数、不 import `vscode`，也不碰网络：调用方把 `Response.formData()` 的结果
 * 交进来，行为断言见 `scripts/binaryRpc.test.ts`。
 */

import { isRecord } from "../shared/jsonValue";

/** 解出的一条二进制响应：信封里的 rpcId 与已回填字节的值。 */
export interface BinaryRpcResponse {
  readonly rpcId: string;
  readonly value: unknown;
}

/** 官方信封的形状收窄：只接受 `type: "server-response"` + ok:true。 */
function parseEnvelope(value: unknown): { rpcId: string; value: unknown } {
  if (!isRecord(value) || value.type !== "server-response" || typeof value.rpcId !== "string") {
    throw new TypeError("binary rpc: invalid server-response envelope");
  }
  const result = value.result;
  if (!isRecord(result)) throw new TypeError("binary rpc: invalid server-response result");
  if (result.ok !== true) throw new TypeError("binary rpc: invalid binary response result");
  return { rpcId: value.rpcId, value: result.value };
}

/** 一个附件声明：`codec` 只认 bytes，`path` 是值内索引路径，`part` 是表单字段名。 */
function isAttachment(value: unknown): value is {
  readonly codec: "bytes";
  readonly part: string;
  readonly path: readonly (string | number)[];
} {
  if (!isRecord(value)) return false;
  return (
    value.codec === "bytes" &&
    typeof value.part === "string" &&
    Array.isArray(value.path)
  );
}

/**
 * 解码一份二进制 RPC 响应。
 *
 * @param form 响应的 `FormData`（测试可直接构造）。
 * @returns 信封里的 rpcId 与回填后的值；调用方负责比对 rpcId。
 */
export async function decodeBinaryRpcResponse(form: FormData): Promise<BinaryRpcResponse> {
  const fields = new Map<string, string | Blob>();
  for (const [name, value] of form) {
    // 同名表单字段会让「哪一个是 metadata / 附件」失去唯一答案
    if (fields.has(name)) throw new TypeError("binary rpc: duplicate field");
    fields.set(name, value);
  }

  const metadata = fields.get("metadata");
  fields.delete("metadata");
  if (typeof metadata !== "string") throw new TypeError("binary rpc: missing metadata");
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(metadata);
  } catch {
    throw new TypeError("binary rpc: metadata is not JSON");
  }
  const envelope = parseEnvelope(rawEnvelope);
  if (!isRecord(rawEnvelope)) throw new TypeError("binary rpc: invalid binary response result");
  const attachments = rawEnvelope.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    throw new TypeError("binary rpc: invalid binary response result");
  }

  const root = { value: envelope.value };
  for (const attachment of attachments) {
    if (!isAttachment(attachment)) throw new TypeError("binary rpc: invalid attachment");
    const data = fields.get(attachment.part);
    // 取走以证明「每个附件只对应一个字段」；留下未消费的字段同样是坏形状
    fields.delete(attachment.part);
    if (!(data instanceof Blob)) throw new TypeError("binary rpc: attachment part is not bytes");

    let parent: object = root;
    let key: string | number = "value";
    for (const segment of attachment.path) {
      const value: unknown = Reflect.get(parent, key);
      if (typeof value !== "object" || value === null) {
        throw new TypeError("binary rpc: invalid attachment path");
      }
      if (Array.isArray(value)) {
        if (
          typeof segment !== "number" ||
          !Number.isSafeInteger(segment) ||
          segment < 0 ||
          segment >= value.length
        ) {
          throw new TypeError("binary rpc: invalid attachment path");
        }
      } else if (typeof segment !== "string") {
        throw new TypeError("binary rpc: invalid attachment path");
      }
      // 只走自有键：`__proto__` / `constructor` 这类原型链名字不是数据位置
      if (!Object.hasOwn(value, segment)) throw new TypeError("binary rpc: invalid attachment path");
      parent = value;
      key = segment;
    }
    // 服务端声明这里应有字节，信封里就必须正是 `null` 占位
    if (Reflect.get(parent, key) !== null) {
      throw new TypeError("binary rpc: invalid attachment placeholder");
    }
    Object.defineProperty(parent, key, {
      value: new Uint8Array(await data.arrayBuffer()),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  // 声明之外的字段没有去处：多出来的字节字段说明这份响应不属于我们认识的协议
  if (fields.size !== 0) throw new TypeError("binary rpc: unexpected fields");

  return { rpcId: envelope.rpcId, value: root.value };
}
